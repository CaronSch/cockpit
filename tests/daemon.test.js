import { test, describe, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHistory } from '../daemon/history.js';
import { createHub } from '../daemon/hub.js';
import { createAttachments } from '../daemon/attachments.js';
import { createScratchpads } from '../daemon/scratchpad.js';
import { createWorkspaces } from '../daemon/workspace.js';
import { createDaemon, createDaemonServer, loopbackListener } from '../daemon/server.js';
import { createRemoteAccess } from '../daemon/remote.js';
import { loadToken } from '../daemon/token.js';
import { loadUnread } from '../daemon/unread.js';
import { loadSettings } from '../daemon/settings.js';
import { loadPins } from '../daemon/pins.js';
import { createForker, loadForks } from '../daemon/forks.js';
import { nameFork } from '../daemon/fork-title.js';
import { createGithub } from '../daemon/github.js';
import { createDelivery } from '../daemon/deliver.js';
import { loadBugbot } from '../daemon/bugbot.js';
import { loadSchedule, scheduleTools } from '../daemon/schedule.js';
import { askReviewer, createDecisionReviews } from '../daemon/decisions.js';
import { askAgent } from '../daemon/ask.js';
import { createSetup } from '../daemon/setup.js';
import { createTerminals } from '../daemon/terminals.js';
/** @import { RemoteState, RpcResponse, StreamEvent, SessionEvent, SessionMeta } from '../daemon/wire.js' */
/** @import { DaemonOptions } from '../daemon/server.js' */
/** @import { RemoteAccess } from '../daemon/remote.js' */

const ROOT = resolve(import.meta.dir, '..');
const FAKE_OMP = join(ROOT, 'tests/fixtures/fake-omp.js');
const FAKE_GH = join(ROOT, 'tests/fixtures/fake-gh.js');
const FAKE_TAILSCALE = join(ROOT, 'tests/fixtures/fake-tailscale.js');
const TOKEN = 'a'.repeat(64);
/** The fake Tailscale's `status --json` while it runs: this Mac at 127.0.0.1, owned by owner@example.com. */
const RUNNING_TAILSCALE = {
  BackendState: 'Running',
  Self: { TailscaleIPs: ['127.0.0.1', 'fd7a::1'], DNSName: 'mac.example.ts.net.', UserID: 1 },
  User: { 1: { LoginName: 'owner@example.com', DisplayName: 'Owner' } },
};

/** @type {ReturnType<typeof createDaemonServer>} */
let server;
/** @type {ReturnType<typeof createHub>} */
let hub;
/** @type {import('../daemon/unread.js').UnreadStore} */
let unread;
/** @type {import('../daemon/settings.js').SettingsStore} */
let settings;
/** @type {import('../daemon/pins.js').PinsStore} */
let pins;
/** @type {import('../daemon/forks.js').ForksStore} */
let forks;
/** @type {import('../daemon/forks.js').Forker} */
let forker;
/** @type {import('../daemon/github.js').Github} */
let github;
/** @type {import('../daemon/deliver.js').Delivery} */
let delivery;
/** @type {import('../daemon/bugbot.js').BugbotStore} */
let bugbot;
/** @type {import('../daemon/schedule.js').Schedule} */
let schedule;
/** @type {import('../daemon/decisions.js').DecisionReviews} */
let decisions;
/** @type {import('../daemon/setup.js').Setup} */
let setup;
/** Phone access of the suite's daemon, on the fake Tailscale. @type {RemoteAccess} */
let remote;
/** The suite's terminals: plain `sh`, whatever the user's shell. @type {import('../daemon/terminals.js').Terminals} */
let terminals;
/** What the suite's daemon is made of, for other daemons on the same sessions. @type {DaemonOptions} */
let daemonOptions;
/** The file the fake Tailscale's `status --json` prints. */
let tailscaleStatus = '';
let port = 0;
let cwd = '';

/**
 * A request to the suite's daemon, or to the listener on port `daemon`, named `name` (its Host,
 * and its Origin when one is sent) as a page there names it.
 * @param {{ method?: string, path: string, headers?: Record<string, string>, body?: unknown, raw?: string, auth?: boolean, origin?: boolean, daemon?: number, name?: string }} options
 * @returns {Promise<{ status: number, headers: Headers, text: string, json: any }>}
 */
async function call({ method = 'GET', path, headers = {}, body, raw, auth = true, origin = method !== 'GET', daemon = port, name = '127.0.0.1' }) {
  const res = await fetch(`http://127.0.0.1:${daemon}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      host: `${name}:${daemon}`,
      ...(auth ? { cookie: `ac_token=${TOKEN}` } : {}),
      ...(origin ? { origin: `http://${name}:${daemon}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, text, json };
}

/**
 * Connects to the event stream as a page does (resuming after `lastEventId`, if given). Once
 * it resolves, the daemon sends this connection everything new, so whatever happens next is
 * on it; `until` reads until `done` holds. `daemon` is the port of a daemon other than the
 * suite's; `query` is the stream's (`?follow=…`).
 * @param {{ lastEventId?: string, daemon?: number, query?: string }} [options]
 */
async function openStream({ lastEventId, daemon = port, query = '' } = {}) {
  /** @type {StreamEvent[]} */
  const events = [];
  /** @type {string[]} */
  const ids = [];
  const headers = { cookie: `ac_token=${TOKEN}`, ...(lastEventId ? { 'last-event-id': lastEventId } : {}) };
  const connection = new AbortController();
  const res = await fetch(`http://127.0.0.1:${daemon}/api/stream${query}`, { headers, signal: connection.signal });
  assert.equal(res.status, 200);
  return {
    /** @param {(events: StreamEvent[], ids: string[]) => boolean} done @returns {Promise<{ events: StreamEvent[], ids: string[] }>} */
    async until(done) {
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for await (const bytes of /** @type {ReadableStream<Uint8Array>} */ (res.body)) {
          buffer += decoder.decode(bytes, { stream: true });
          let end;
          while ((end = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            for (const l of block.split('\n')) {
              if (l.startsWith('id: ')) ids.push(l.slice(4));
              if (l.startsWith('data: ')) events.push(JSON.parse(l.slice(6)));
            }
          }
          if (done(events, ids)) return { events, ids };
        }
      } finally {
        connection.abort();
      }
      throw new Error('the event stream ended');
    },
  };
}

/**
 * Reads the event stream until `done` holds.
 * @param {{ lastEventId?: string, done: (events: StreamEvent[], ids: string[]) => boolean }} options
 */
const readStream = async ({ lastEventId, done }) => (await openStream({ lastEventId })).until(done);

/** The session's meta once it has reached `status`. @param {string} id @param {SessionMeta['status']} status @returns {Promise<SessionMeta>} */
async function waitForStatus(id, status) {
  const event = await logged((e) => e.session === id && e.kind === 'session' && e.meta.status === status);
  return /** @type {SessionMeta} */ (event.kind === 'session' && event.meta);
}

/**
 * The first event in the daemon's log, already there or still to come, that `match` accepts.
 * @param {(event: SessionEvent) => boolean} match @returns {Promise<SessionEvent>}
 */
function logged(match) {
  const found = hub.since(0).find(match);
  if (found) return Promise.resolve(found);
  return new Promise((resolve) => {
    const stop = hub.subscribe((event) => {
      if (!match(event)) return;
      stop();
      resolve(event);
    });
  });
}

/**
 * Sends `command` to session `id`: the daemon accepts it at once (202, with the id it gave
 * the command), and omp's response arrives on the log.
 * @param {string} id @param {Record<string, unknown>} command @returns {Promise<RpcResponse>}
 */
async function rpc(id, command) {
  const res = await call({ method: 'POST', path: `/api/sessions/${id}/rpc`, body: command });
  assert.equal(res.status, 202);
  const answer = await logged((e) => e.session === id && e.kind === 'frame' && e.frame.type === 'response' && e.frame.id === res.json.id);
  return /** @type {RpcResponse} */ (answer.kind === 'frame' && answer.frame);
}

/** @param {StreamEvent[]} events @param {string} session @returns {SessionEvent[]} */
const forSession = (events, session) =>
  /** @type {SessionEvent[]} */ (events.filter((e) => e.kind !== 'hello' && e.kind !== 'scratchpad' && e.kind !== 'history' && e.kind !== 'unread' && e.kind !== 'pins' && e.kind !== 'forks' && e.kind !== 'decisions' && e.kind !== 'settings' && e.kind !== 'bugbot' && e.kind !== 'schedule' && e.kind !== 'login' && e.kind !== 'activity' && e.kind !== 'remote' && e.kind !== 'terminals' && e.kind !== 'terminal' && e.session === session));

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'ac-daemon-test-'));
  unread = await loadUnread({ file: join(cwd, 'state', 'unread.json') });
  settings = await loadSettings({ file: join(cwd, 'state', 'settings.json') });
  pins = await loadPins({ file: join(cwd, 'state', 'pins.json') });
  forks = await loadForks({ file: join(cwd, 'state', 'forks.json') });
  decisions = createDecisionReviews({
    dir: join(cwd, 'state', 'decisions'),
    on: () => settings.all().decisionReview,
    ask: (turn) => askReviewer(turn, { ompPath: FAKE_OMP }),
  });
  hub = createHub({ ompPath: FAKE_OMP, unread, onRewoundId: (from, to) => void forks.moved(from, to), onTurnEnded: decisions.turnEnded, hostTools: scheduleTools(() => schedule) });
  forker = createForker({ hub, forks, scratchDir: join(cwd, 'state', 'fork-sources'), nameFork: (prompt, title) => nameFork(prompt, title, { ompPath: FAKE_OMP }) });
  const history = createHistory({ root: join(cwd, 'omp-sessions'), archive: join(cwd, 'state', 'archive', 'sessions') });
  github = createGithub({ ghPath: FAKE_GH });
  delivery = createDelivery({ hub, isArchived: (file) => history.isArchived(file) });
  bugbot = await loadBugbot({ file: join(cwd, 'state', 'bugbot.json'), github, delivery, pollMs: 100 });
  schedule = await loadSchedule({ file: join(cwd, 'state', 'schedule.json'), deliver: delivery.deliver, archivedFrom: (file) => history.archivedFrom(file) });
  // Setup's fake omp keeps who is signed in in a file of the suite's own, with nobody to start with.
  setup = createSetup({ ompPath: FAKE_OMP, ghPath: FAKE_GH, tailscalePath: FAKE_TAILSCALE, env: { ...process.env, FAKE_OMP_AUTH: join(cwd, 'fake-omp-auth') } });
  tailscaleStatus = join(cwd, 'tailscale-status.json');
  await writeFile(tailscaleStatus, JSON.stringify(RUNNING_TAILSCALE));
  remote = createRemoteAccess({
    tailscale: FAKE_TAILSCALE,
    port: 0,
    token: TOKEN,
    settings,
    serve: (listener) => daemon.serve(listener),
    env: { ...process.env, FAKE_TAILSCALE_STATUS_FILE: tailscaleStatus },
    checkEveryMs: 100,
  });
  terminals = createTerminals({ shell: '/bin/sh' });
  daemonOptions = {
    hub,
    unread,
    pins,
    forks,
    forker,
    decisions,
    settings,
    history,
    github,
    delivery,
    bugbot,
    schedule,
    setup,
    remote,
    terminals,
    ask: (question) => askAgent(question, { ompPath: FAKE_OMP, history }),
    scratchpads: createScratchpads({ dir: join(cwd, 'state', 'scratchpads') }),
    attachments: createAttachments({ dir: join(cwd, 'state', 'attachments') }),
    workspaces: createWorkspaces({ dir: join(cwd, 'state', 'workspaces') }),
    token: TOKEN,
    root: ROOT,
    config: { defaultCwd: cwd, home: cwd, scratchpadDir: join(cwd, 'state', 'scratchpads'), idleCompactAfterMs: 60_000 },
  };
  const daemon = createDaemon(daemonOptions);
  server = daemon.serve(loopbackListener(0));
  port = /** @type {number} */ (server.port);
});

afterAll(async () => {
  await remote.stop();
  await terminals.closeAll();
  bugbot.stop();
  schedule.stop();
  await hub.closeAll();
  await server.stop(true);
});

describe('loopback guard', () => {
  test('API requests without the token cookie are refused', async () => {
    const res = await call({ path: '/api/config', auth: false });
    assert.equal(res.status, 401);
  });

  test('a page on another origin cannot act, even if the browser attached the cookie', async () => {
    const res = await call({ method: 'POST', path: '/api/sessions', body: { cwd }, headers: { origin: 'http://evil.example' } });
    assert.equal(res.status, 403);
    assert.equal(hub.list().length, 0);
  });

  test('state-changing requests must name their Origin', async () => {
    const res = await call({ method: 'POST', path: '/api/sessions', body: { cwd }, origin: false });
    assert.equal(res.status, 403);
    assert.equal(res.json.error, 'missing Origin header');
  });

  test('a DNS-rebinding Host is refused for API and static files alike', async () => {
    for (const path of ['/api/config', '/']) {
      const res = await call({ path, headers: { host: `evil.example:${port}` } });
      assert.equal(res.status, 403, path);
    }
  });

  test('the workbench answers at cockpit.localhost, pages and API alike', async () => {
    const name = `cockpit.localhost:${port}`;
    const headers = { host: name, origin: `http://${name}` };
    assert.equal((await call({ path: '/', headers })).status, 200);
    assert.equal((await call({ path: '/api/config', headers })).status, 200);
    const created = await call({ method: 'POST', path: '/api/sessions', body: { cwd }, headers });
    assert.equal(created.status, 201);
    await call({ method: 'DELETE', path: `/api/sessions/${created.json.session.id}`, headers });
  });

  test('look-alikes of cockpit.localhost are refused as Host and as Origin', async () => {
    const sessionsBefore = hub.list().length;
    const lookAlikes = [`evil.localhost:${port}`, `cockpit.localhost.evil.com:${port}`, `cockpit.localhost:${port + 1}`];
    for (const name of lookAlikes) {
      for (const path of ['/api/config', '/']) {
        assert.equal((await call({ path, headers: { host: name } })).status, 403, `Host ${name} ${path}`);
      }
      const res = await call({ method: 'POST', path: '/api/sessions', body: { cwd }, headers: { origin: `http://${name}` } });
      assert.equal(res.status, 403, `Origin ${name}`);
    }
    assert.equal(hub.list().length, sessionsBefore);
  });

  test('a shell starts, and is typed into, only with the token cookie and the page’s own Origin', async () => {
    const body = { cwd, cols: 80, rows: 24 };
    assert.equal((await call({ method: 'POST', path: '/api/terminals', body, auth: false })).status, 401);
    assert.equal((await call({ method: 'POST', path: '/api/terminals', body, headers: { origin: 'http://evil.example' } })).status, 403);
    assert.equal((await call({ method: 'POST', path: '/api/terminals', body, origin: false })).status, 403);
    assert.equal(terminals.list().length, 0);
    const started = await call({ method: 'POST', path: '/api/terminals', body });
    assert.equal(started.status, 201);
    const input = `/api/terminals/${started.json.terminal.id}/input`;
    assert.equal((await call({ method: 'POST', path: input, body: { data: 'id\r' }, headers: { origin: 'http://evil.example' } })).status, 403);
    assert.equal((await call({ method: 'POST', path: input, body: { data: 'id\r' }, auth: false })).status, 401);
    assert.equal((await call({ method: 'DELETE', path: `/api/terminals/${started.json.terminal.id}` })).status, 204);
    assert.equal(terminals.list().length, 0);
  });

  test('the token link sets an HttpOnly, SameSite=Strict cookie and drops only the token from the URL', async () => {
    const res = await call({ path: `/?token=${TOKEN}&workspace=side`, auth: false });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/?workspace=side');
    const cookie = String(res.headers.get('set-cookie'));
    assert.match(cookie, new RegExp(`^ac_token=${TOKEN};`));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.equal((await call({ path: '/?token=wrong', auth: false })).status, 403);
  });

  test('the token file ends up owner-only, even when an unusable one was readable by others', async () => {
    const stateDir = join(cwd, 'token-state');
    await mkdir(stateDir);
    const file = join(stateDir, 'token');
    await writeFile(file, 'not a token\n');
    await chmod(file, 0o644);
    const token = await loadToken(stateDir);
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal((await Bun.file(file).text()).trim(), token);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    await chmod(file, 0o644);
    assert.equal(await loadToken(stateDir), token, 'a valid token is kept');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  });

  test('static serving stays inside the UI directories, and of node_modules serves only the listed vendor files', async () => {
    assert.equal((await call({ path: '/src/main.js', auth: false })).status, 200);
    const vendor = await call({ path: '/vendor/temml.mjs', auth: false });
    assert.equal(vendor.status, 200);
    assert.match(vendor.headers.get('content-type') ?? '', /^text\/javascript/);
    const outside = [
      '/src/../daemon/token.js',
      '/src/%2e%2e/daemon/token.js',
      '/src/..%2fdaemon/token.js',
      '/src/..%2f..%2findex.html',
      '/daemon/token.js',
      '/package.json',
      '/node_modules/temml/dist/temml.mjs',
      '/vendor/temml.js',
      '/vendor/..%2fpackage.json',
    ];
    for (const path of outside) {
      assert.equal((await call({ path, auth: false })).status, 404, path);
    }
  });
});

describe('Phone access', () => {
  let phoneRoot = '';
  beforeAll(async () => {
    phoneRoot = await mkdtemp(join(cwd, 'phone-root-'));
    await writeFile(join(phoneRoot, 'index.html'), '<!doctype html><title>Workbench</title>');
    await writeFile(join(phoneRoot, 'phone.html'), '<!doctype html><title>Phone</title>');
  });

  /** Resolves once `access` is in state `want`. @param {RemoteAccess} access @param {RemoteState['state']} want */
  const reaches = (access, want) =>
    new Promise((resolve) => {
      const off = access.subscribe((state) => {
        if (state.state !== want) return;
        off();
        resolve(undefined);
      });
      if (access.state().state === want) {
        off();
        resolve(undefined);
      }
    });
  /** The port `access` listens on now. @param {RemoteAccess} [access] */
  const remotePort = (access = remote) => Number(new URL(String(access.info().url)).port);
  /** Switches the suite's Phone access from the Mac, and waits for it to come up or go. @param {boolean} on */
  async function switchRemote(on) {
    assert.equal((await call({ method: 'PUT', path: '/api/settings', body: { remote: on } })).status, 200);
    await remote.settled();
  }
  /**
   * Another daemon on the suite's sessions with Phone access on (its own settings), serving
   * `phoneRoot`, whose fake Tailscale runs with `env` added.
   * @param {{ env?: Record<string, string>, whoisTimeoutMs?: number }} [options]
   */
  async function phoneDaemon({ env = {}, whoisTimeoutMs } = {}) {
    const own = await loadSettings({ file: join(await mkdtemp(join(cwd, 'phone-state-')), 'settings.json') });
    await own.set({ remote: true });
    const access = createRemoteAccess({
      tailscale: FAKE_TAILSCALE,
      port: 0,
      token: TOKEN,
      settings: own,
      serve: (listener) => app.serve(listener),
      env: { ...process.env, ...env },
      ...(whoisTimeoutMs ? { whoisTimeoutMs } : {}),
    });
    const app = createDaemon({ ...daemonOptions, settings: own, remote: access, root: phoneRoot });
    await access.settled();
    assert.equal(access.state().state, 'on');
    return { access, app, port: remotePort(access) };
  }

  test('off by default: Config hears it is off, with no address', async () => {
    assert.deepEqual((await call({ path: '/api/remote' })).json, { state: 'off', error: null, url: null, login: null, qr: null });
    const { events } = await readStream({ done: (events) => events.some((e) => e.kind === 'hello') });
    const hello = events.find((e) => e.kind === 'hello');
    assert.deepEqual(hello?.kind === 'hello' && hello.remote, { state: 'off', error: null });
  });

  test('switched on from the Mac, the tailnet listener comes up; Config gets its URL, owner and sign-in QR code', async () => {
    const stream = await openStream();
    await switchRemote(true);
    try {
      const info = (await call({ path: '/api/remote' })).json;
      assert.equal(info.state, 'on');
      assert.equal(info.error, null);
      assert.match(info.url, /^http:\/\/127\.0\.0\.1:\d+\/phone$/);
      assert.equal(info.login, 'owner@example.com');
      assert.match(info.qr, /^<svg/);
      const { events } = await stream.until((events) => events.some((e) => e.kind === 'remote' && e.state === 'on'));
      const told = events.flatMap((e) => (e.kind === 'remote' ? [e] : []));
      assert.deepEqual(told, [{ kind: 'remote', state: 'starting', error: null }, { kind: 'remote', state: 'on', error: null }], 'no address, no token');
      assert.equal((await call({ daemon: remotePort(), name: 'mac.example.ts.net', path: '/api/config' })).status, 200);
    } finally {
      await switchRemote(false);
    }
  });

  test('the tailnet listener answers to the Mac’s tailnet names only, and wants the token and Origin as loopback does', async () => {
    await switchRemote(true);
    try {
      const rp = remotePort();
      const same = { setupDone: settings.all().setupDone };
      for (const name of ['mac.example.ts.net', 'mac', '127.0.0.1']) {
        assert.equal((await call({ daemon: rp, name, path: '/api/config' })).status, 200, name);
        assert.equal((await call({ daemon: rp, name, path: '/api/config', auth: false })).status, 401, name);
        assert.equal((await call({ daemon: rp, name, method: 'PUT', path: '/api/settings', body: same })).status, 200, name);
        assert.equal((await call({ daemon: rp, name, method: 'PUT', path: '/api/settings', body: same, origin: false })).status, 403, name);
      }
      for (const name of ['localhost', 'cockpit.localhost', 'evil.example', 'mac.example.ts.net.evil.example']) {
        for (const path of ['/api/config', '/phone']) assert.equal((await call({ daemon: rp, name, path })).status, 403, `${name} ${path}`);
      }
      const foreign = await call({ daemon: rp, name: 'mac', method: 'PUT', path: '/api/settings', body: same, headers: { origin: `http://localhost:${rp}` } });
      assert.equal(foreign.status, 403);
      // Loopback, for its part, does not answer to the tailnet's names.
      for (const name of ['mac.example.ts.net', 'mac']) {
        for (const path of ['/api/config', '/']) assert.equal((await call({ name, path })).status, 403, `loopback ${name} ${path}`);
      }
      const tailnetOrigin = await call({ method: 'PUT', path: '/api/settings', body: same, headers: { origin: `http://mac.example.ts.net:${port}` } });
      assert.equal(tailnetOrigin.status, 403);
    } finally {
      await switchRemote(false);
    }
  });

  test('on the tailnet, Phone access is neither told nor switched, and / is the phone’s page', async () => {
    await switchRemote(true);
    try {
      const at = { daemon: remotePort(), name: 'mac.example.ts.net' };
      assert.equal((await call({ ...at, path: '/api/remote' })).status, 404);
      const refused = await call({ ...at, method: 'PUT', path: '/api/settings', body: { remote: false } });
      assert.equal(refused.status, 403);
      assert.equal(refused.json.error, 'Phone access is switched on the Mac');
      assert.equal(settings.all().remote, true);
      const home = await call({ ...at, path: '/', auth: false });
      assert.equal(home.status, 302);
      assert.equal(home.headers.get('location'), '/phone');
      const signIn = await call({ ...at, path: `/phone?token=${TOKEN}`, auth: false });
      assert.equal(signIn.status, 302);
      assert.equal(signIn.headers.get('location'), '/phone', 'the QR code’s link lands on the phone’s page, without the token');
      assert.match(String(signIn.headers.get('set-cookie')), new RegExp(`^ac_token=${TOKEN};.*SameSite=Strict`));
      assert.equal((await call({ path: '/api/remote' })).json.state, 'on', 'the Mac still tells');
    } finally {
      await switchRemote(false);
    }
  });

  test('/phone is the phone’s page, on both listeners', async () => {
    const phone = await phoneDaemon();
    const loopback = phone.app.serve(loopbackListener(0));
    try {
      for (const [daemon, name] of /** @type {const} */ ([[phone.port, 'mac.example.ts.net'], [Number(loopback.port), '127.0.0.1']])) {
        const page = await call({ daemon, name, path: '/phone', auth: false });
        assert.equal(page.status, 200, name);
        assert.match(page.headers.get('content-type') ?? '', /^text\/html/);
        assert.match(page.text, /<title>Phone<\/title>/);
      }
      assert.match((await call({ daemon: Number(loopback.port), path: '/', auth: false })).text, /<title>Workbench<\/title>/, 'loopback keeps the workbench at /');
    } finally {
      await loopback.stop(true);
      await phone.access.stop();
    }
  });

  test('the whois gate: nothing at all for any device but the owner’s own untagged ones', async () => {
    /** @type {Array<[string, Record<string, string>, number?]>} */
    const strangers = [
      ['another login', { FAKE_TAILSCALE_PEERS: JSON.stringify({ '127.0.0.1': { login: 'other@example.com' } }) }],
      ['a tagged node', { FAKE_TAILSCALE_PEERS: JSON.stringify({ '127.0.0.1': { login: 'owner@example.com', tags: ['tag:server'] } }) }],
      ['an address whois does not know', { FAKE_TAILSCALE_PEERS: '{}' }],
      ['a whois that does not answer in time', { FAKE_TAILSCALE_WHOIS_DELAY_MS: '3000' }, 500],
    ];
    for (const [who, env, whoisTimeoutMs] of strangers) {
      const phone = await phoneDaemon({ env, whoisTimeoutMs });
      try {
        for (const path of ['/phone', `/phone?token=${TOKEN}`, '/', '/api/config', '/api/stream', '/api/sessions']) {
          const res = await call({ daemon: phone.port, name: 'mac.example.ts.net', path });
          assert.equal(res.status, 403, `${who}: ${path}`);
          assert.match(res.headers.get('content-type') ?? '', /^text\/plain/, `${who}: ${path}`);
          assert.equal(res.headers.get('set-cookie'), null, `${who}: ${path}`);
        }
      } finally {
        await phone.access.stop();
      }
    }
    const owner = await phoneDaemon();
    try {
      assert.equal((await call({ daemon: owner.port, name: 'mac.example.ts.net', path: '/phone', auth: false })).status, 200);
      assert.equal((await call({ daemon: owner.port, name: 'mac.example.ts.net', path: '/api/config' })).status, 200);
    } finally {
      await owner.access.stop();
    }
  }, 30_000);

  test('a verdict is kept a minute per address, and one lookup serves every request waiting on it', async () => {
    const log = join(cwd, 'tailscale-calls.log');
    const phone = await phoneDaemon({ env: { FAKE_TAILSCALE_LOG: log } });
    try {
      const at = { daemon: phone.port, name: 'mac.example.ts.net', path: '/api/config' };
      const together = await Promise.all(Array.from({ length: 5 }, () => call(at)));
      assert.deepEqual(together.map((res) => res.status), [200, 200, 200, 200, 200]);
      for (let i = 0; i < 3; i++) assert.equal((await call(at)).status, 200);
      const lookups = (await Bun.file(log).text()).split('\n').filter((line) => line.startsWith('whois'));
      assert.deepEqual(lookups, ['whois --json 127.0.0.1']);
    } finally {
      await phone.access.stop();
    }
  });

  test('switched off, the tailnet listener ends its open streams and stops accepting', async () => {
    await switchRemote(true);
    const rp = remotePort();
    const stream = await openStream({ daemon: rp });
    const ended = assert.rejects(stream.until(() => false));
    await switchRemote(false);
    await ended;
    await assert.rejects(fetch(`http://127.0.0.1:${rp}/phone`));
    assert.deepEqual((await call({ path: '/api/remote' })).json, { state: 'off', error: null, url: null, login: null, qr: null });
  });

  test('Tailscale stopping takes the listener down, with the reason; running again brings it back', async () => {
    await switchRemote(true);
    try {
      const before = remotePort();
      await writeFile(tailscaleStatus, JSON.stringify({ ...RUNNING_TAILSCALE, BackendState: 'Stopped' }));
      await reaches(remote, 'error');
      assert.equal(remote.state().error, 'Tailscale is not connected (Stopped)');
      assert.deepEqual((await call({ path: '/api/remote' })).json, { state: 'error', error: 'Tailscale is not connected (Stopped)', url: null, login: null, qr: null });
      await assert.rejects(fetch(`http://127.0.0.1:${before}/phone`));
      await writeFile(tailscaleStatus, JSON.stringify(RUNNING_TAILSCALE));
      await reaches(remote, 'on');
      assert.equal((await call({ daemon: remotePort(), name: 'mac', path: '/api/config' })).status, 200);
    } finally {
      await writeFile(tailscaleStatus, JSON.stringify(RUNNING_TAILSCALE));
      await switchRemote(false);
    }
  });
});
