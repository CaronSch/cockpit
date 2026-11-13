/**
 * Updates to Cockpit itself: whether its own checkout is behind the newest `main` on GitHub, and
 * taking that update from the workbench (the top bar's Update, src/ui/update-notice.js).
 *
 * Every hour, and when the daemon starts, it fetches `origin/main` and counts the commits the
 * checkout lacks. The count is redone from the refs already fetched whenever a page asks
 * (`refresh`), so a `git pull` made by hand stops the offer without waiting an hour.
 *
 * Updating fast-forwards the checkout to `origin/main`, then restarts the daemon (restart.js), so
 * both the daemon and the pages run the new code. It refuses, saying why (`blocked`), whenever
 * that would not be a plain fast-forward of clean `main`: the checkout is on another branch, has
 * uncommitted changes, or commits `origin/main` does not have. It also refuses an update that
 * changes the dependencies (`package.json`, `bun.lock`): installing them takes the Bun the
 * repository names (`packageManager`), which need not be the one running the daemon.
 */
/** @import { UpdateState } from './wire.js' */

const REMOTE = 'origin';
const BRANCH = 'main';
const UPSTREAM = `${REMOTE}/${BRANCH}`;
/** How often GitHub is asked for a newer `main`. */
export const CHECK_EVERY_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 60_000;
const GIT_TIMEOUT_MS = 10_000;
/** Files whose change means installing dependencies, which an update from the workbench does not do. */
const DEPENDENCY_FILES = ['package.json', 'bun.lock'];

/** An update refused: `status` 409 when there is none to take or it is blocked, 500 when git failed. */
export class UpdateRefused extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * @param {{ root: string, restart: () => void, git?: string, checkEveryMs?: number }} options
 * `root`: the checkout the daemon runs from; `restart`: restarts the daemon (main.js).
 */
export function createUpdates({ root, restart, git = 'git', checkEveryMs = CHECK_EVERY_MS }) {
  /** Null until known, and while the checkout is no git checkout of a repository with `origin/main`. @type {UpdateState | null} */
  let state = null;
  /** @type {Set<(state: UpdateState | null) => void>} */
  const listeners = new Set();
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;
  /** Every look at the checkout, and the update, one after another. @type {Promise<unknown>} */
  let queue = Promise.resolve();

  /** @param {UpdateState | null} next */
  function set(next) {
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    state = next;
    for (const fn of listeners) fn(state);
  }

  /**
   * Runs git in the checkout. A fetch may not stop to ask for credentials: nobody would answer.
   * @param {string[]} args @param {number} [timeout] @returns {Promise<{ out: string, err: string, code: number }>}
   */
  async function run(args, timeout = GIT_TIMEOUT_MS) {
    try {
      const proc = Bun.spawn([git, ...args], {
        cwd: root,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes' },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        timeout,
      });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { out: out.trim(), err: err.trim(), code };
    } catch (err) {
      return { out: '', err: String(err), code: -1 };
    }
  }

  /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  function serial(fn) {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  }

  /** Why the checkout cannot take the update by itself; null if it can. @param {string} branch */
  async function blockedBy(branch) {
    if (branch !== BRANCH) return `Cockpit's checkout is on ${branch === 'HEAD' ? 'a detached HEAD' : branch}, not ${BRANCH}`;
    if ((await run(['status', '--porcelain', '--untracked-files=no'])).out) return "Cockpit's checkout has uncommitted changes";
    if ((await run(['merge-base', '--is-ancestor', 'HEAD', UPSTREAM])).code !== 0) return `Cockpit's checkout has commits ${UPSTREAM} does not`;
    const changed = await run(['diff', '--name-only', 'HEAD', UPSTREAM, '--', ...DEPENDENCY_FILES]);
    if (changed.code !== 0 || changed.out) return 'The update changes dependencies: pull it, run `bun install`, and restart the daemon';
    return null;
  }

  /** The checkout as git sees it now, after fetching `main` when `fetch` says so. @param {boolean} fetch @returns {Promise<UpdateState | null>} */
  async function inspect(fetch) {
    const head = await run(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (head.code !== 0) return null; // no git checkout: nothing to fetch
    if (fetch) {
      const fetched = await run(['fetch', '--quiet', REMOTE, BRANCH], FETCH_TIMEOUT_MS);
      // Offline, or signed out of GitHub: what was fetched before still counts.
      if (fetched.code !== 0) console.error(`[daemon] could not fetch ${UPSTREAM} to look for updates: ${fetched.err || `git exited ${fetched.code}`}`);
    }
    const count = await run(['rev-list', '--count', `HEAD..${UPSTREAM}`]);
    if (count.code !== 0) return null;
    const behind = Number(count.out) || 0;
    return { behind, blocked: behind ? await blockedBy(head.out) : null, updating: false, error: state?.error ?? null };
  }

  /** Looks again, fetching first when `fetch` says so; not while the update is under way. @param {boolean} fetch */
  const look = (fetch) =>
    serial(async () => {
      if (!state?.updating) set(await inspect(fetch));
      return state;
    });

  return {
    /** @returns {UpdateState | null} */
    state: () => state,
    /** @param {(state: UpdateState | null) => void} fn */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Fetches `main` and looks again (what the hourly check does). */
    check: () => look(true),
    /** Looks again at what was fetched last, without asking GitHub. */
    refresh: () => look(false),
    /**
     * Takes the update: fetches `main`, fast-forwards the checkout to it and restarts the daemon.
     * Throws `UpdateRefused` when there is none, it is blocked, or git fails; the state says why.
     */
    apply: () =>
      serial(async () => {
        if (state?.updating) throw new UpdateRefused(409, 'Cockpit is already updating');
        const found = await inspect(true);
        set(found);
        if (!found || found.behind === 0) throw new UpdateRefused(409, 'Cockpit is up to date');
        if (found.blocked) throw new UpdateRefused(409, found.blocked);
        set({ ...found, updating: true, error: null });
        const merged = await run(['merge', '--ff-only', '--quiet', UPSTREAM]);
        if (merged.code !== 0) {
          const error = `git merge --ff-only ${UPSTREAM} failed: ${merged.err || `exit ${merged.code}`}`;
          set({ ...found, updating: false, error });
          throw new UpdateRefused(500, error);
        }
        console.log(`[daemon] updated Cockpit to ${UPSTREAM} (${found.behind} commit${found.behind === 1 ? '' : 's'}); restarting`);
        restart();
        return state;
      }),
    /** Checks now and then every `checkEveryMs`. */
    start() {
      if (timer) return;
      void look(true);
      timer = setInterval(() => void look(true), checkEveryMs);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer ?? undefined);
      timer = null;
    },
  };
}

/** @typedef {ReturnType<typeof createUpdates>} Updates */
