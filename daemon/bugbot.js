/**
 * Bugbot reviews asked for from the pull request window: `bugbot go` is commented on the pull
 * request as the user, and the daemon watches it until Cursor Bugbot's review answers
 * (src/github/bugbot.js), then sends the review, every finding with where it is, to the
 * conversation the window reviews for (deliver.js). A review that never comes stops being
 * watched after an hour.
 *
 * The watches are kept in one small file in the state directory (state-file.js), so one asked
 * for before a daemon restart is still watched after it, and every page shows how each is
 * doing. Finished ones are kept for a day, so a window opened later still says what happened.
 *
 * `<file>`: `{ version: 1, watches: [BugbotWatch, …] }`, oldest first.
 */
import { randomBytes } from 'node:crypto';
import { loadStateFile } from './state-file.js';
import { BUGBOT_COMMAND, bugbotMessage, bugbotReviewSince } from '../src/github/bugbot.js';
/** @import { BugbotWatch, ConversationTarget } from './wire.js' */
/** @import { Github } from './github.js' */
/** @import { Delivery } from './deliver.js' */

const VERSION = 1;
export const BUGBOT_POLL_MS = 30_000;
const GIVE_UP_MS = 60 * 60 * 1000;
const KEEP_FINISHED_MS = 24 * 60 * 60 * 1000;

/** @param {any} t @returns {t is ConversationTarget} */
const isTarget = (t) => (t?.sessionFile === null || typeof t?.sessionFile === 'string') && (t.session === null || typeof t.session === 'string') && typeof t.cwd === 'string';

/** @param {any} w @returns {w is BugbotWatch} */
const isWatch = (w) =>
  typeof w?.id === 'string' &&
  typeof w.repo === 'string' &&
  Number.isInteger(w.number) &&
  typeof w.url === 'string' &&
  typeof w.since === 'string' &&
  isTarget(w.target) &&
  ['watching', 'delivered', 'timed-out', 'failed'].includes(w.status) &&
  (w.error === null || typeof w.error === 'string') &&
  Number.isFinite(w.at);

/**
 * Loads the watches kept in `file` and goes on watching those still open.
 * @param {{ file: string, github: Pick<Github, 'comment' | 'reviews' | 'reviewComments'>, delivery: Delivery, pollMs?: number, now?: () => number }} options
 */
export async function loadBugbot({ file, github, delivery, pollMs = BUGBOT_POLL_MS, now = Date.now }) {
  const store = await loadStateFile({
    file,
    what: 'a Bugbot watches file',
    initial: /** @type {readonly BugbotWatch[]} */ ([]),
    read: (data) =>
      data?.version === VERSION && Array.isArray(data.watches) && data.watches.every(isWatch) ? /** @type {readonly BugbotWatch[]} */ (data.watches) : null,
    write: (watches) => ({ version: VERSION, watches }),
  });

  /** @param {string} id @param {Partial<BugbotWatch>} patch */
  function change(id, patch) {
    void store.set(store.get().map((w) => (w.id === id ? { ...w, ...patch, at: now() } : w)));
  }

  /** Watches being polled now, so a slow poll is never run twice at once. @type {Set<string>} */
  const polling = new Set();

  /** Looks once for the review `watch` waits on; sends it on when it is there. @param {BugbotWatch} watch */
  async function poll(watch) {
    if (polling.has(watch.id)) return;
    polling.add(watch.id);
    try {
      const review = bugbotReviewSince(await github.reviews(watch.repo, watch.number), watch.since);
      if (!review) {
        if (now() - Date.parse(watch.since) > GIVE_UP_MS) change(watch.id, { status: 'timed-out', error: null });
        else if (watch.error) change(watch.id, { error: null });
        return;
      }
      const comments = await github.reviewComments(watch.repo, watch.number, review.id);
      const message = bugbotMessage({ number: watch.number, url: watch.url, review, comments });
      try {
        await delivery.deliver(watch.target, message);
        change(watch.id, { status: 'delivered', error: null });
      } catch (err) {
        change(watch.id, { status: 'failed', error: `Bugbot reviewed, but the review did not reach the agent: ${err instanceof Error ? err.message : err}` });
      }
    } catch (err) {
      // GitHub could not be asked this time: say so, and ask again next time.
      change(watch.id, { error: err instanceof Error ? err.message : String(err) });
    } finally {
      polling.delete(watch.id);
    }
  }

  function sweep() {
    const at = now();
    const kept = store.get().filter((w) => w.status === 'watching' || at - w.at < KEEP_FINISHED_MS);
    if (kept.length !== store.get().length) void store.set(kept);
    for (const watch of kept) if (watch.status === 'watching') void poll(watch);
  }
  const timer = setInterval(sweep, pollMs);
  timer.unref();

  return {
    all: store.get,
    subscribe: store.subscribe,
    /**
     * Comments `bugbot go` on pull request `number` of `repo`, and watches for Bugbot's
     * review, to send it to `target`'s conversation.
     * @param {{ repo: string, number: number, target: ConversationTarget }} request @returns {Promise<BugbotWatch>}
     */
    async start({ repo, number, target }) {
      const posted = await github.comment(repo, number, BUGBOT_COMMAND);
      /** @type {BugbotWatch} */
      const watch = {
        id: randomBytes(6).toString('hex'),
        repo,
        number,
        url: posted.url.replace(/#.*$/, ''),
        since: posted.createdAt,
        target,
        status: 'watching',
        error: null,
        at: now(),
      };
      await store.set([...store.get(), watch]);
      return watch;
    },
    stop: () => clearInterval(timer),
  };
}

/** @typedef {Awaited<ReturnType<typeof loadBugbot>>} BugbotStore */
