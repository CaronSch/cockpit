/**
 * Setup (the Setup window, src/widgets/setup.js): what this machine needs before a first agent
 * can start, and what Phone access would need, checked whenever the window asks, and omp's own
 * `omp login` run for the window, so a model provider can be signed in to from the browser.
 *
 * Without credentials for any provider `omp --mode rpc-ui` exits at once ("No default model
 * selected"), so an agent window cannot sign in from a session of its own (its Accounts needs one
 * awake): the first login has to happen outside a session. `omp login` is omp's terminal login: it
 * lists the providers to pick from by number, opens the provider's sign-in page in the default
 * browser, and finishes once the browser comes back to its local callback (a few providers ask
 * for a code to paste instead). It reads its answers from stdin line by line, so the window shows
 * its output as it comes and sends what its user types as lines. One login runs at a time, for
 * every page.
 */
import { readTailnet } from './remote.js';
/** @import { Subprocess } from 'bun' */

const CHECK_TIMEOUT_MS = 30_000;
/** How much of a login's output is kept: its last part, which a long provider list cannot push out. */
const MAX_LOGIN_OUTPUT = 64 * 1024;
/** A provider id as omp names one (`anthropic`, `openai-codex`): never a flag. */
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]*$/i;
/** Terminal colour codes, which omp writes even to a pipe when its environment forces colour. */
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/** One thing Setup checks: whether it is there, and what to say about it. @typedef {{ ok: boolean, detail: string }} SetupCheck */

/**
 * `omp`: omp runs (its version); `models`: omp has models it may use, i.e. credentials for a
 * provider; `gh`: GitHub's CLI is signed in (only pull request windows need it); `tailscale`:
 * Tailscale runs on this Mac, which belongs to a person (only Phone access needs it,
 * daemon/remote.js).
 * @typedef {{ omp: SetupCheck, models: SetupCheck, gh: SetupCheck, tailscale: SetupCheck }} SetupStatus
 */

/**
 * The `omp login` the window runs: its output so far, whether it still runs, and how it ended.
 * @typedef {{ running: boolean, output: string, exitCode: number | null }} LoginState
 */

/** A login could not do what was asked: another one runs or none does (409), or a provider is not one (400). */
export class LoginRefused extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** The environment Setup's commands run in. @typedef {Record<string, string | undefined>} Env */

/**
 * What `argv` printed and how it ended; null when it could not be run at all.
 * @param {string[]} argv @param {Env} env @returns {Promise<{ out: string, err: string, code: number } | null>}
 */
async function run(argv, env) {
  try {
    const proc = Bun.spawn(argv, { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: CHECK_TIMEOUT_MS });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { out, err, code };
  } catch {
    return null;
  }
}

/** The last line a failed command wrote, as its reason. @param {{ out: string, err: string, code: number }} result */
const reason = (result) => (result.err || result.out).replace(ANSI, '').trim().split('\n').at(-1) || `exited with ${result.code}`;

/** The omp at `ompPath`'s version (`omp --version`), or null if it does not run. @param {string} ompPath @param {Env} [env] */
export async function ompVersion(ompPath, env = process.env) {
  const result = await run([ompPath, '--version'], env);
  return result?.code === 0 ? result.out.trim() || null : null;
}

/**
 * The providers omp has chat models for (`omp models --json`: only those it has credentials
 * for), as a check.
 * @param {string} ompPath @param {Env} env @returns {Promise<SetupCheck>}
 */
async function checkModels(ompPath, env) {
  const result = await run([ompPath, 'models', '--json'], env);
  if (!result) return { ok: false, detail: `omp is not installed ("${ompPath}")` };
  if (result.code !== 0) return { ok: false, detail: reason(result) };
  /** @type {unknown} */
  let models;
  try {
    models = JSON.parse(result.out)?.models;
  } catch {
    return { ok: false, detail: 'omp models --json did not print JSON' };
  }
  const chat = Array.isArray(models) ? models.filter((m) => m?.kind === 'chat' && typeof m.provider === 'string') : [];
  if (chat.length === 0) return { ok: false, detail: 'No model provider signed in' };
  const providers = [...new Set(chat.map((m) => /** @type {string} */ (m.provider)))].sort();
  return { ok: true, detail: `${providers.join(', ')} (${chat.length} model${chat.length === 1 ? '' : 's'})` };
}

/** Who `gh` is signed in as (`gh api user`), as a check. @param {string} ghPath @param {Env} env @returns {Promise<SetupCheck>} */
async function checkGh(ghPath, env) {
  const result = await run([ghPath, 'api', 'user', '--jq', '.login'], env);
  if (!result) return { ok: false, detail: `GitHub CLI not installed ("${ghPath}")` };
  if (result.code !== 0) return { ok: false, detail: reason(result) };
  return { ok: true, detail: `Signed in as ${result.out.trim()}` };
}

/**
 * Whether Phone access could come on: Tailscale connected on this Mac, and whose devices it would
 * let in, as a check.
 * @param {string} tailscalePath @param {Env} env @returns {Promise<SetupCheck>}
 */
async function checkTailscale(tailscalePath, env) {
  try {
    return { ok: true, detail: `Connected as ${(await readTailnet(tailscalePath, env)).login}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * `env`: what Setup's commands run in, the daemon's own unless given.
 * @param {{ ompPath: string, ghPath: string, tailscalePath: string, env?: Env }} options
 */
export function createSetup({ ompPath, ghPath, tailscalePath, env = process.env }) {
  /** @type {LoginState | null} */
  let login = null;
  /** @type {Subprocess<'pipe', 'pipe', 'pipe'> | null} */
  let proc = null;
  /** @type {Set<(login: LoginState | null) => void>} */
  const listeners = new Set();
  /** @param {Partial<LoginState>} patch */
  const update = (patch) => {
    login = { .../** @type {LoginState} */ (login), ...patch };
    for (const fn of listeners) fn(login);
  };
  /** @param {string} text */
  const append = (text) => update({ output: (/** @type {LoginState} */ (login).output + text.replace(ANSI, '')).slice(-MAX_LOGIN_OUTPUT) });

  /** Copies `stream` into the login's output as it comes. @param {ReadableStream<Uint8Array>} stream */
  async function follow(stream) {
    const decoder = new TextDecoder();
    for await (const bytes of stream) append(decoder.decode(bytes, { stream: true }));
  }

  return {
    /** @returns {Promise<SetupStatus>} */
    async check() {
      const version = await ompVersion(ompPath, env);
      const [models, gh, tailscale] = await Promise.all([
        version ? checkModels(ompPath, env) : Promise.resolve({ ok: false, detail: 'Needs omp' }),
        checkGh(ghPath, env),
        checkTailscale(tailscalePath, env),
      ]);
      return { omp: version ? { ok: true, detail: version } : { ok: false, detail: `omp not found ("${ompPath}")` }, models, gh, tailscale };
    },
    login: {
      state: () => login,
      /**
       * Starts `omp login`, for `provider` if named (else omp lists them to pick from).
       * @param {string | null} provider
       */
      start(provider) {
        if (login?.running) throw new LoginRefused(409, 'a login is already running');
        if (provider !== null && !PROVIDER_ID.test(provider)) throw new LoginRefused(400, `not a provider id: ${provider}`);
        /** @type {Subprocess<'pipe', 'pipe', 'pipe'>} */
        let started;
        try {
          started = Bun.spawn([ompPath, 'login', ...(provider ? [provider] : [])], { env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
        } catch (err) {
          login = { running: false, output: `could not run ${ompPath}: ${err instanceof Error ? err.message : err}\n`, exitCode: null };
          for (const fn of listeners) fn(login);
          return;
        }
        proc = started;
        login = { running: true, output: '', exitCode: null };
        for (const fn of listeners) fn(login);
        void Promise.all([follow(started.stdout), follow(started.stderr), started.exited]).then(([, , code]) => {
          if (proc === started) proc = null;
          update({ running: false, exitCode: code });
        });
      },
      /** Sends `line` to the running login, as typed at its prompt, and shows it as a terminal echoes it. @param {string} line */
      input(line) {
        if (!proc || !login?.running) throw new LoginRefused(409, 'no login is running');
        append(`${line}\n`);
        proc.stdin.write(`${line}\n`);
        void proc.stdin.flush();
      },
      /** Ends the running login, if there is one. */
      cancel() {
        proc?.kill();
      },
      /** Hears every change to the login. @param {(login: LoginState | null) => void} fn */
      subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    },
  };
}

/** @typedef {ReturnType<typeof createSetup>} Setup */
