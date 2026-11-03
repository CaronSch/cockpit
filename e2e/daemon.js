/**
 * Where the e2e daemon listens and keeps its state, shared by the Playwright config and the specs.
 *
 * Each run has a free port and a temporary directory of its own, so runs in two checkouts at
 * once never meet. The runner process decides when it loads the config; its workers inherit
 * the choice through the environment.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A port nothing listens on now. @returns {Promise<number>} */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
      server.close(() => resolve(port));
    });
  });
}

process.env.COCKPIT_E2E_PORT ??= String(await freePort());
process.env.COCKPIT_E2E_DIR ??= mkdtempSync(join(tmpdir(), 'cockpit-e2e-'));

export const E2E_PORT = Number(process.env.COCKPIT_E2E_PORT);
export const E2E_STATE_DIR = join(process.env.COCKPIT_E2E_DIR, 'state');
/**
 * The e2e daemon's home directory (its `HOME`), so what it lists and suggests from home is the
 * test's own: the omp spec lays out folders here.
 */
export const E2E_HOME = join(process.env.COCKPIT_E2E_DIR, 'home');
mkdirSync(E2E_HOME, { recursive: true });
/** Stands in for ~/.omp/agent/sessions; the Sessions spec writes its journals here. */
export const E2E_OMP_SESSIONS = join(process.env.COCKPIT_E2E_DIR, 'omp-sessions');
/** Where the fake gh finds a repository named outright (tests/fixtures/fake-gh.js): `<owner>/<name>/`. */
export const E2E_GH_ROOT = join(process.env.COCKPIT_E2E_DIR, 'github');
mkdirSync(E2E_GH_ROOT, { recursive: true });

/** The token the e2e daemon wrote on startup. */
export const e2eToken = () => readFileSync(join(E2E_STATE_DIR, 'token'), 'utf8').trim();

/**
 * A workspace no other test uses: the specs share one daemon and run in parallel, so each
 * test lays out its screens in a workspace of its own.
 */
export const newWorkspace = () => `e2e-${randomUUID().slice(0, 8)}`;

/**
 * The workbench in `workspace`, through the token link (which leaves `?workspace=` in place)
 * unless the page is to stay signed out.
 * @param {string} workspace @param {{ signIn?: boolean }} [options]
 */
export const workbenchPath = (workspace, { signIn = true } = {}) =>
  `/?${signIn ? `token=${e2eToken()}&` : ''}workspace=${workspace}`;

/** The file the daemon keeps `workspace` in. @param {string} workspace */
export const workspaceFile = (workspace) => join(E2E_STATE_DIR, 'workspaces', `${workspace}.json`);

/**
 * The layout the daemon keeps for a workspace that one window uses: its only screen's tree,
 * or null when it keeps none.
 * @param {import('@playwright/test').APIRequestContext} request @param {string} workspace @returns {Promise<any>}
 */
export async function savedLayout(request, workspace) {
  const { screens } = await (await request.get(`/api/workspaces/${workspace}`)).json();
  if (screens.length > 1) throw new Error(`workspace ${workspace} has ${screens.length} screens, not one`);
  return screens[0]?.tree ?? null;
}

/**
 * omp's answer to the rpc the page sent as `request`. The daemon accepts a command with the
 * id it gave it, and the answer arrives on the event stream, read here as a page reads it.
 * @param {import('@playwright/test').Request} request @returns {Promise<any>}
 */
export async function rpcAnswer(request) {
  const { id } = await (await /** @type {Promise<import('@playwright/test').Response>} */ (request.response())).json();
  const session = decodeURIComponent(new URL(request.url()).pathname.split('/')[3]);
  const stream = new AbortController();
  const res = await fetch(`http://127.0.0.1:${E2E_PORT}/api/stream`, { headers: { cookie: `ac_token=${e2eToken()}` }, signal: stream.signal });
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for await (const bytes of /** @type {ReadableStream<Uint8Array>} */ (res.body)) {
      buffer += decoder.decode(bytes, { stream: true });
      const lines = buffer.split('\n');
      buffer = /** @type {string} */ (lines.pop());
      for (const line of lines) {
        const event = line.startsWith('data: ') ? JSON.parse(line.slice(6)) : null;
        if (event?.session === session && event.kind === 'frame' && event.frame.type === 'response' && event.frame.id === id) return event.frame;
      }
    }
  } finally {
    stream.abort();
  }
  throw new Error(`the stream ended before omp answered ${id}`);
}

/**
 * A daemon of a test's own, beside the shared one, for a test that restarts it: the real
 * daemon with the fake omp and fake gh, keeping its state in `stateDir` and reading journals from
 * `sessionsDir`, with `env` added to its environment. Resolves once it answers; `stop()` ends
 * it as Ctrl+C does.
 * @param {{ port: number, stateDir: string, sessionsDir: string, env?: Record<string, string> }} options
 */
export async function startDaemon({ port, stateDir, sessionsDir, env = {} }) {
  const child = spawn('bun', ['daemon/main.js', '--port', String(port), '--omp', 'tests/fixtures/fake-omp.js', '--gh', 'tests/fixtures/fake-gh.js'], {
    env: { ...process.env, HOME: E2E_HOME, COCKPIT_STATE_DIR: stateDir, COCKPIT_OMP_SESSIONS: sessionsDir, FAKE_GH_ROOT: E2E_GH_ROOT, ...env },
    stdio: 'ignore',
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  for (let tries = 0; ; tries++) {
    const up = await fetch(`http://127.0.0.1:${port}/`).then(
      () => true,
      () => false,
    );
    if (up) break;
    if (tries > 100 || child.exitCode !== null) throw new Error(`the daemon on port ${port} did not start`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    /** The URL that signs a page in to this daemon, in `workspace`. @param {string} workspace */
    url: (workspace) => `http://127.0.0.1:${port}/?token=${readFileSync(join(stateDir, 'token'), 'utf8').trim()}&workspace=${workspace}`,
    async stop() {
      child.kill('SIGTERM');
      await exited;
    },
  };
}
