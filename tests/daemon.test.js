import { test, describe, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { createHistory } from '../daemon/history.js';
import { createHub } from '../daemon/hub.js';
import { createAttachments } from '../daemon/attachments.js';
import { createScratchpads } from '../daemon/scratchpad.js';
import { createWorkspaces } from '../daemon/workspace.js';
import { createDaemon, createDaemonServer, loopbackListener } from '../daemon/server.js';
import { createRemoteAccess } from '../daemon/remote.js';
import { listDirectory, readTextFile } from '../daemon/files.js';
import { loadToken } from '../daemon/token.js';
import { loadUnread } from '../daemon/unread.js';
import { loadSettings } from '../daemon/settings.js';
import { loadPins } from '../daemon/pins.js';
import { createForker, loadForks } from '../daemon/forks.js';
import { nameFork } from '../daemon/fork-title.js';
import { createGithub } from '../daemon/github.js';
import { createDelivery } from '../daemon/deliver.js';
import { loadBugbot } from '../daemon/bugbot.js';
import { askReviewer, createDecisionReviews } from '../daemon/decisions.js';
import { APPEND_SYSTEM_PROMPT, HISTORY_COMMAND, SETUP_COMMANDS } from '../daemon/omp-session.js';
import { withAdhdRules } from '../daemon/adhd.js';
import { browserEnv } from '../daemon/browser.js';
import { createSetup } from '../daemon/setup.js';
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
/** @type {import('../daemon/decisions.js').DecisionReviews} */
let decisions;
/** @type {import('../daemon/setup.js').Setup} */
let setup;
/** Phone access of the suite's daemon, on the fake Tailscale. @type {RemoteAccess} */
let remote;
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
  /** @type {SessionEvent[]} */ (events.filter((e) => e.kind !== 'hello' && e.kind !== 'scratchpad' && e.kind !== 'history' && e.kind !== 'unread' && e.kind !== 'pins' && e.kind !== 'forks' && e.kind !== 'decisions' && e.kind !== 'settings' && e.kind !== 'bugbot' && e.kind !== 'login' && e.kind !== 'activity' && e.kind !== 'remote' && e.session === session));

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
  hub = createHub({ ompPath: FAKE_OMP, unread, onRewoundId: (from, to) => void forks.moved(from, to), onTurnEnded: decisions.turnEnded });
  forker = createForker({ hub, forks, scratchDir: join(cwd, 'state', 'fork-sources'), nameFork: (prompt, title) => nameFork(prompt, title, { ompPath: FAKE_OMP }) });
  const history = createHistory({ root: join(cwd, 'omp-sessions'), archive: join(cwd, 'state', 'archive', 'sessions') });
  github = createGithub({ ghPath: FAKE_GH });
  delivery = createDelivery({ hub, isArchived: (file) => history.isArchived(file) });
  bugbot = await loadBugbot({ file: join(cwd, 'state', 'bugbot.json'), github, delivery, pollMs: 100 });
  // Setup's fake omp keeps who is signed in in a file of the suite's own, with nobody to start with.
  setup = createSetup({ ompPath: FAKE_OMP, ghPath: FAKE_GH, env: { ...process.env, FAKE_OMP_AUTH: join(cwd, 'fake-omp-auth') } });
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
    setup,
    remote,
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
  bugbot.stop();
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

describe('sessions', () => {
  test('a session becomes ready only after the daemon sent its setup commands', async () => {
    const created = await call({ method: 'POST', path: '/api/sessions', body: { cwd } });
    assert.equal(created.status, 201);
    const id = created.json.session.id;
    await waitForStatus(id, 'ready');

    const mine = forSession(hub.since(0), id);
    const readyAt = mine.findIndex((e) => e.kind === 'session' && e.meta.status === 'ready');
    const sent = mine.slice(0, readyAt).flatMap((e) => (e.kind === 'sent' ? [e.command.type] : []));
    assert.deepEqual(sent, SETUP_COMMANDS.map((c) => c.type));
  });

  test('every session is asked to say what it is doing as it works', async () => {
    const { json } = await call({ method: 'POST', path: '/api/sessions', body: { cwd } });
    await waitForStatus(json.session.id, 'ready');
    const state = await rpc(json.session.id, { type: 'get_state' });
    assert.equal(state.data.appendedPrompt, APPEND_SYSTEM_PROMPT);
  });

  test('a session started from a journal has its earlier history in the log before it is ready', async () => {
    const journal = join(cwd, 'history-first.jsonl');
    const lines = [
      { type: 'session', version: 3, id: 'history-first', timestamp: '2026-10-01T10:00:00.000Z', cwd },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'earlier question' }] } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }] } },
    ];
    await Bun.write(journal, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    const { json } = await call({ method: 'POST', path: '/api/sessions', body: { cwd, resume: journal } });
    const id = json.session.id;
    await waitForStatus(id, 'ready');

    const mine = forSession(hub.since(0), id);
    const readyAt = mine.findIndex((e) => e.kind === 'session' && e.meta.status === 'ready');
    const before = mine.slice(0, readyAt);
    assert.deepEqual(
      before.flatMap((e) => (e.kind === 'sent' ? [e.command.type] : [])),
      [...SETUP_COMMANDS, HISTORY_COMMAND].map((c) => c.type),
    );
    const history = before.find((e) => e.kind === 'frame' && e.frame.command === 'get_messages');
    assert.ok(history?.kind === 'frame' && history.frame.data.messages.length === 2, 'its answer too');
  });

  test('a session started from a compacted journal shows the whole conversation, not just what omp kept', async () => {
    const journal = join(cwd, 'compacted.jsonl');
    const lines = [
      { type: 'session', version: 3, id: 'compacted', timestamp: '2026-10-01T10:00:00.000Z', cwd },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'long ago' }] } },
      { type: 'compaction', summary: 'we talked', shortSummary: 'Compaction', tokensBefore: 9 },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'lately' }] } },
    ];
    await Bun.write(journal, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    const id = (await call({ method: 'POST', path: '/api/sessions', body: { cwd, resume: journal } })).json.session.id;
    await waitForStatus(id, 'ready');
    assert.equal((await rpc(id, { type: 'get_messages' })).data.messages.length, 1, 'omp itself keeps only what came after the compaction');
    const history = forSession(hub.since(0), id).find((e) => e.kind === 'frame' && e.frame.command === 'get_messages');
    assert.deepEqual(
      history?.kind === 'frame' && history.frame.data.messages.map((/** @type {any} */ m) => m.role),
      ['user', 'compactionSummary', 'user'],
    );
  });

  test('the daemon asks omp for its state again after anything that changes it, once for every window', async () => {
    const { json } = await call({ method: 'POST', path: '/api/sessions', body: { cwd } });
    const id = json.session.id;
    await waitForStatus(id, 'ready');
    const after = forSession(hub.since(0), id).at(-1)?.seq ?? 0;

    await rpc(id, { type: 'set_thinking_level', level: 'high' });
    const stated = await logged((e) => e.session === id && e.seq > after && e.kind === 'frame' && e.frame.command === 'get_state');
    assert.ok(stated.kind === 'frame' && stated.frame.data.thinkingLevel === 'high');
    const sent = forSession(hub.since(0), id).flatMap((e) => (e.kind === 'sent' && e.seq > after ? [e.command.type] : []));
    assert.deepEqual(sent.slice(0, 2), ['set_thinking_level', 'get_state']);
  });

  test('commands return omp’s response, and everything omp prints lands in the log in order', async () => {
    const { json } = await call({ method: 'POST', path: '/api/sessions', body: { cwd } });
    const id = json.session.id;
    await waitForStatus(id, 'ready');

    const state = await rpc(id, { type: 'get_state', id: 'mine' });
    assert.equal(state.command, 'get_state');
    assert.equal(state.data.model.id, 'fake-model');
    assert.notEqual(state.id, 'mine', 'the daemon owns request ids');

    await call({ method: 'POST', path: `/api/sessions/${id}/rpc`, body: { type: 'prompt', message: 'mystery garble' } });
    const { events } = await readStream({
      done: (all) => forSession(all, id).some((e) => e.kind === 'frame' && e.frame.type === 'session_settled'),
    });
    const mine = forSession(events, id);
    const frameTypes = mine.flatMap((e) => (e.kind === 'frame' ? [e.frame.type] : []));
    assert.ok(frameTypes.includes('mystery_frame'), 'unknown frame types are relayed, not filtered');
    const garbled = mine.find((e) => e.kind === 'garbled');
    assert.ok(garbled?.kind === 'garbled' && garbled.line === 'this line is not json');
    const seqs = mine.map((e) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  });

  test('every stream connection opens with the version of the UI files served, as /api/ui reports it', async () => {
    const { events } = await readStream({ done: (all) => all.length > 0 });
    const { json } = await call({ path: '/api/ui' });
    assert.match(json.version, /^[0-9a-f]{16}$/);
    assert.deepEqual(events[0]?.kind === 'hello' && events[0].ui, json.version);
  });

  test('a reconnect with the current boot id gets only what it missed; a stale boot id gets everything', async () => {
    const seen = hub.latest();
    const first = await readStream({ done: (_, ids) => ids.at(-1) === `${hub.bootId}:${seen}` });
    const last = /** @type {string} */ (first.ids.at(-1));
    assert.equal(last, `${hub.bootId}:${seen}`);

    const { json } = await call({ method: 'POST', path: '/api/sessions', body: { cwd } }); // something to miss
    await waitForStatus(json.session.id, 'ready');
    const missed = hub.since(seen).length;
    const resumed = await readStream({ lastEventId: last, done: (_, ids) => ids.length >= missed });
    assert.equal(resumed.events[0].kind, 'hello');
    assert.equal(resumed.ids[0], `${hub.bootId}:${seen + 1}`, 'nothing it had seen');

    const stale = await readStream({ lastEventId: `other-boot:${seen}`, done: (_, ids) => ids.length > 0 });
    assert.equal(stale.ids[0], `${hub.bootId}:${hub.since(0)[0].seq}`, 'everything');
  });

  test('a command is accepted at once, and omp’s answer, however slow, arrives on the stream', async () => {
    const { json } = await call({ method: 'POST', path: '/api/sessions', body: { cwd } });
    const id = json.session.id;
    await waitForStatus(id, 'ready');
    const res = await call({ method: 'POST', path: `/api/sessions/${id}/rpc`, body: { type: 'bash', command: 'sleep 1' } });
    assert.equal(res.status, 202);
    assert.deepEqual(Object.keys(res.json), ['id']);
    const answered = (/** @type {SessionEvent} */ e) => e.kind === 'frame' && e.frame.id === res.json.id;
    assert.ok(!forSession(hub.since(0), id).some(answered), 'the request was released before omp answered');
    const { events } = await readStream({
      done: (all) => forSession(all, id).some((e) => e.kind === 'frame' && e.frame.id === res.json.id),
    });
    const answer = forSession(events, id).find((e) => e.kind === 'frame' && e.frame.id === res.json.id);
    assert.ok(answer?.kind === 'frame');
    assert.equal(answer.frame.command, 'bash');
    assert.equal(answer.frame.data.output, 'hi\n');
  });

  test('dialog answers reach omp', async () => {
    const { json } = await call({ method: 'POST', path: '/api/sessions', body: { cwd } });
    const id = json.session.id;
    await waitForStatus(id, 'ready');
    await call({ method: 'POST', path: `/api/sessions/${id}/rpc`, body: { type: 'prompt', message: 'ask me' } });
    const asked = await readStream({
      done: (all) => forSession(all, id).some((e) => e.kind === 'frame' && e.frame.method === 'ask'),
    });
    const request = forSession(asked.events, id).find((e) => e.kind === 'frame' && e.frame.method === 'ask');
    assert.ok(request?.kind === 'frame');
    const answered = await call({
      method: 'POST',
      path: `/api/sessions/${id}/ui`,
      body: { id: request.frame.id, answers: [{ id: 'db', selectedOptions: ['SQLite'] }] },
    });
    assert.equal(answered.status, 204);
    const { events } = await readStream({
      done: (all) => forSession(all, id).some((e) => e.kind === 'frame' && e.frame.type === 'session_settled'),
    });
    const reply = forSession(events, id).findLast((e) => e.kind === 'frame' && e.frame.type === 'message_end');
    assert.ok(reply?.kind === 'frame');
    assert.match(JSON.stringify(reply.frame.message.content), /SQLite/);
  });

  test('the log keeps what windows still need: no finished stream\'s deltas, and of an ended session only how it ended', async () => {
    const { json } = await call({ method: 'POST', path: '/api/sessions', body: { cwd } });
    const { id } = json.session;
    await waitForStatus(id, 'ready');
    await rpc(id, { type: 'prompt', message: 'hello' });
    await logged((e) => e.session === id && e.kind === 'frame' && e.frame.type === 'session_settled');
    const log = forSession(hub.since(0), id);
    assert.ok(log.some((e) => e.kind === 'frame' && e.frame.type === 'message_end' && e.frame.message.role === 'assistant'), 'the reply is there');
    assert.ok(!log.some((e) => e.kind === 'frame' && e.frame.assistantMessageEvent?.type === 'text_delta'), 'its deltas are not');

    await call({ method: 'DELETE', path: `/api/sessions/${id}` });
    await waitForStatus(id, 'exited');
    const after = forSession(hub.since(0), id);
    assert.equal(after.length, 1);
    assert.equal(after[0].kind === 'session' && after[0].meta.status, 'exited');
  });

  test('closing a session stops omp and reports it exited', async () => {
    const { json } = await call({ method: 'POST', path: '/api/sessions', body: { cwd } });
    const id = json.session.id;
    await waitForStatus(id, 'ready');
    assert.equal((await call({ method: 'DELETE', path: `/api/sessions/${id}` })).status, 204);
    const meta = await waitForStatus(id, 'exited');
    assert.equal(meta.pid, null);
    assert.equal((await call({ method: 'POST', path: `/api/sessions/${id}/rpc`, body: { type: 'get_state' } })).status, 409);
  });

  test('each session reports the journal it writes, so a window can tell a past session is open', async () => {
    const journal = join(cwd, 'earlier.jsonl');
    await Bun.write(journal, '');
    const resumed = await call({ method: 'POST', path: '/api/sessions', body: { cwd, resume: journal } });
    assert.equal(resumed.json.session.sessionFile, journal, 'known from the start for a resumed session');

    const fresh = await call({ method: 'POST', path: '/api/sessions', body: { cwd } });
    assert.equal(fresh.json.session.sessionFile, null);
    const ready = await waitForStatus(fresh.json.session.id, 'ready');
    assert.match(String(ready.sessionFile), /\.jsonl$/, 'learned from omp’s get_state before ready');
  });

  test('resuming a journal a running session writes hands over that session, never a second omp', async () => {
    const journal = join(cwd, 'shared.jsonl');
    await Bun.write(journal, '');
    const first = await call({ method: 'POST', path: '/api/sessions', body: { cwd, resume: journal } });
    assert.equal(first.status, 201);
    const again = await call({ method: 'POST', path: '/api/sessions', body: { cwd, resume: journal } });
    assert.equal(again.status, 200);
    assert.equal(again.json.session.id, first.json.session.id);

    await call({ method: 'DELETE', path: `/api/sessions/${first.json.session.id}` });
    await waitForStatus(first.json.session.id, 'exited');
    const after = await call({ method: 'POST', path: '/api/sessions', body: { cwd, resume: journal } });
    assert.equal(after.status, 201, 'once it stopped, resuming starts omp again');
    assert.notEqual(after.json.session.id, first.json.session.id);
    await call({ method: 'DELETE', path: `/api/sessions/${after.json.session.id}` });
  });

  test('a resumed session is named by its journal’s omp id, a new one by the id omp gives it', async () => {
    const journal = join(cwd, 'named.jsonl');
    await Bun.write(journal, `${JSON.stringify({ type: 'session', version: 3, id: 'conv-named', timestamp: '2026-10-01T10:00:00.000Z', cwd })}\n`);
    const resumed = (await call({ method: 'POST', path: '/api/sessions', body: { cwd, resume: journal } })).json.session;
    assert.equal(resumed.ompId, null, 'unknown until omp says');
    assert.equal((await waitForStatus(resumed.id, 'ready')).ompId, 'conv-named');
    const fresh = (await call({ method: 'POST', path: '/api/sessions', body: { cwd } })).json.session;
    assert.match(String((await waitForStatus(fresh.id, 'ready')).ompId), /^[\w-]+$/);
    await call({ method: 'DELETE', path: `/api/sessions/${resumed.id}` });
    await call({ method: 'DELETE', path: `/api/sessions/${fresh.id}` });
  });

  test('a fork runs a new session on a copy of the journal and leaves the journal alone', async () => {
    const journal = join(cwd, 'to-fork.jsonl');
    const lines = [
      { type: 'title', v: 1, title: 'Login work' },
      { type: 'session', version: 3, id: 'source', timestamp: '2026-10-01T10:00:00.000Z', cwd },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'fix the login bug' }] } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'fixed it' }] } },
    ];
    const original = `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
    await Bun.write(journal, original);

    const { status, json } = await call({ method: 'POST', path: '/api/sessions', body: { cwd, fork: journal } });
    assert.equal(status, 201);
    assert.equal(json.session.fork, journal);
    assert.equal(json.session.resume, null);
    const id = json.session.id;
    const ready = await waitForStatus(id, 'ready');
    assert.ok(ready.sessionFile && ready.sessionFile !== journal, 'the fork writes a journal of its own');
    const copied = await rpc(id, { type: 'get_messages' });
    const texts = copied.data.messages.map((/** @type {any} */ m) => m.content[0].text);
    assert.deepEqual(texts, ['fix the login bug', 'fixed it'], 'the conversation so far');

    await turn(id, 'now add tests');
    assert.equal(await Bun.file(journal).text(), original, 'the source journal is untouched');
    assert.match(await Bun.file(ready.sessionFile).text(), /now add tests/);
    await rm(ready.sessionFile);
  });

  test('a fork needs an existing journal, and cannot also resume one', async () => {
    const journal = join(cwd, 'fork-me.jsonl');
    await Bun.write(journal, '');
    const before = hub.list().length;
    /** @type {Array<[Record<string, unknown>, RegExp]>} */
    const refused = [
      [{ cwd, fork: join(cwd, 'missing.jsonl') }, /^fork is not an existing file/],
      [{ cwd, fork: cwd }, /^fork is not an existing file/],
      [{ cwd, fork: ' ' }, /^fork is required/],
      [{ cwd, fork: journal, resume: journal }, /^resume and fork cannot be combined/],
    ];
    for (const [body, error] of refused) {
      const res = await call({ method: 'POST', path: '/api/sessions', body });
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match(res.json.error, error);
    }
    assert.equal(hub.list().length, before, 'nothing was launched');
  });

  /**
   * Sends `message` in session `id` and waits until its turn has settled, then until omp has
   * answered a `get_state` sent after it: the daemon handles omp's frames in order, so
   * anything it sends in reply to the settled turn is in the log before that. Returns the
   * session's whole log so far.
   * @param {string} id @param {string} message
   */
  async function turn(id, message) {
    const from = hub.latest();
    await rpc(id, { type: 'prompt', message });
    await logged((e) => e.seq > from && e.session === id && e.kind === 'frame' && e.frame.type === 'session_settled');
    await rpc(id, { type: 'get_state' });
    return forSession(hub.since(0), id);
  }

  /** @param {SessionEvent[]} log @returns {string[]} what the daemon sent after the log's first prompt */
  const sentAfterPrompt = (log) =>
    log.slice(log.findIndex((e) => e.kind === 'sent' && e.command.type === 'prompt')).flatMap((e) => (e.kind === 'sent' ? [String(e.command.message ?? e.command.type)] : []));

  test('once the first prompt of a session with no name is in, the daemon asks omp for a title, once', async () => {
    const { json } = await call({ method: 'POST', path: '/api/sessions', body: { cwd } });
    const id = json.session.id;
    await waitForStatus(id, 'ready');
    const from = hub.since(0).length;
    assert.deepEqual(
      sentAfterPrompt(await turn(id, 'hi')),
      ['hi', '/rename', 'get_state', 'get_state'],
      'the title request while the turn runs, the state refresh after it, then the test’s own get_state',
    );
    await logged((e) => e.seq > from && e.session === id && e.kind === 'frame' && e.frame.type === 'command_output');
    assert.equal(hub.since(from).filter((e) => e.session === id && e.kind === 'frame' && e.frame.type === 'session_info_update').length, 0, '"hi" is too little to name');
    const log = await turn(id, 'fix the login bug');
    assert.equal(sentAfterPrompt(log).filter((m) => m === '/rename').length, 1, 'a failed title is not asked for again');
  });

  test('after omp rewinds (`branch`), the daemon asks it for the conversation as it now stands', async () => {
    const { json } = await call({ method: 'POST', path: '/api/sessions', body: { cwd } });
    const id = json.session.id;
    await waitForStatus(id, 'ready');
    await turn(id, 'first question');
    await turn(id, 'second question');
    const listed = /** @type {any} */ (await rpc(id, { type: 'get_branch_messages' })).data.messages;
    assert.deepEqual(listed.map((/** @type {any} */ m) => m.text), ['first question', 'second question']);
    const from = hub.since(0).length;
    const branched = await rpc(id, { type: 'branch', entryId: listed[1].entryId });
    assert.equal(/** @type {any} */ (branched).data.text, 'second question');
    const history = await logged((e) => e.seq > from && e.session === id && e.kind === 'frame' && e.frame.type === 'response' && e.frame.command === 'get_messages');
    const messages = history.kind === 'frame' ? history.frame.data.messages : [];
    assert.deepEqual(messages.map((/** @type {any} */ m) => m.role), ['user', 'assistant'], 'the first turn only');
  });

  test('a session that already has a name is never asked for a title', async () => {
    const journal = join(cwd, 'titled.jsonl');
    await Bun.write(journal, `${JSON.stringify({ type: 'title', v: 1, title: 'Earlier work' })}\n`);
    const id = (await call({ method: 'POST', path: '/api/sessions', body: { cwd, resume: journal } })).json.session.id;
    await waitForStatus(id, 'ready');
    assert.deepEqual(sentAfterPrompt(await turn(id, 'fix the login bug')), ['fix the login bug', 'get_state', 'get_state']);
  });

  /** A journal holding `messages` (user and assistant texts, alternating), under omp id `id` and `title`. @param {string} name @param {string} id @param {string | null} title @param {string[]} [messages] */
  async function journalOf(name, id, title, messages = []) {
    const file = join(cwd, `${name}.jsonl`);
    const lines = [
      ...(title ? [{ type: 'title', v: 1, title }] : []),
      { type: 'session', version: 3, id, timestamp: '2026-10-01T10:00:00.000Z', cwd },
      ...messages.map((text, i) => ({ type: 'message', message: { role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text }], ...(i % 2 ? { stopReason: 'stop' } : {}) } })),
    ];
    await Bun.write(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    return file;
  }

  /** Resolves once the daemon has sent session `id` the prompt `message`. @param {string} id @param {string} message */
  const sentTo = (id, message) => logged((e) => e.session === id && e.kind === 'sent' && e.command.type === 'prompt' && e.command.message === message);

  test('a fork is named by its own first prompt, not its source’s title; once', async () => {
    const journal = await journalOf('titled-parent', 'titled-parent', 'Earlier work');
    const id = (await call({ method: 'POST', path: '/api/sessions', body: { cwd, fork: journal } })).json.session.id;
    await waitForStatus(id, 'ready');
    await turn(id, 'try the other approach');
    await sentTo(id, '/rename Forked: try the other approach');
    const log = await turn(id, 'and test it');
    assert.deepEqual(
      sentAfterPrompt(log).filter((m) => m.startsWith('/rename')),
      ['/rename Forked: try the other approach'],
      'the title model’s words, without its quotes and full stop; never omp’s own title, which reads the source’s opening request',
    );
    assert.equal((await rpc(id, { type: 'get_state' })).data.sessionName, 'Forked: try the other approach');
  });

  test('a fork of an untitled conversation is not titled by omp (from its source’s opening), and without the title model, by its first prompt’s first line', async () => {
    const journal = await journalOf('untitled-parent', 'untitled-parent', null);
    const id = (await call({ method: 'POST', path: '/api/sessions', body: { cwd, fork: journal } })).json.session.id;
    await waitForStatus(id, 'ready');
    await turn(id, 'keep it untitled\nand then more');
    await sentTo(id, '/rename keep it untitled');
    const log = await turn(id, 'and test it');
    assert.deepEqual(sentAfterPrompt(log).filter((m) => m.startsWith('/rename')), ['/rename keep it untitled']);
  });

  test('a fork given a prompt gets it once ready, and is known as a fork of its source', async () => {
    const journal = await journalOf('prompted-parent', 'prompted-parent', 'Login work', ['fix the login bug', 'fixed it']);
    const { status, json } = await call({ method: 'POST', path: '/api/sessions', body: { cwd, fork: journal, prompt: 'go another way' } });
    assert.equal(status, 201);
    const id = json.session.id;
    const ready = await waitForStatus(id, 'ready');
    await sentTo(id, 'go another way');
    const forkId = String(ready.ompId);
    assert.deepEqual(forks.all()[forkId], { parent: 'prompted-parent', title: 'go another way' }, 'titled by its prompt until the model has');
    await sentTo(id, '/rename Forked: go another way');
    assert.deepEqual(forks.all()[forkId], { parent: 'prompted-parent', title: 'Forked: go another way' });
    await rpc(id, { type: 'prompt', message: '/rename Kept by hand' });
    await logged((e) => e.session === id && e.kind === 'frame' && e.frame.type === 'session_info_update' && e.frame.title === 'Kept by hand');
    assert.equal(forks.all()[forkId].title, 'Kept by hand', 'renamed by the user: listed so');
    const refused = await call({ method: 'POST', path: '/api/sessions', body: { cwd, prompt: 'no fork to send it to' } });
    assert.equal(refused.status, 400, 'a prompt goes with a fork only');
  });

  test('a conversation forked while its agent works is copied as of its last completed response', async () => {
    const parent = (await call({ method: 'POST', path: '/api/sessions', body: { cwd } })).json.session.id;
    await waitForStatus(parent, 'ready');
    await turn(parent, 'first question');
    const from = hub.latest();
    void rpc(parent, { type: 'prompt', message: 'slow, then answer' });
    // Mid-turn: the prompt and an intermediate reply (asking for a tool) are in the journal.
    await logged((e) => e.seq > from && e.session === parent && e.kind === 'frame' && e.frame.type === 'message_end' && e.frame.message?.stopReason === 'toolUse');
    const file = String(hub.get(parent)?.meta().sessionFile);
    assert.match(await Bun.file(file).text(), /slow, then answer/);

    const id = (await call({ method: 'POST', path: '/api/sessions', body: { cwd, fork: file } })).json.session.id;
    const ready = await waitForStatus(id, 'ready');
    const copied = /** @type {any[]} */ ((await rpc(id, { type: 'get_messages' })).data.messages);
    assert.deepEqual(copied.map((m) => m.role), ['user', 'assistant'], 'the first turn only: the turn under way stays with the source');
    assert.equal(copied[0].content[0].text, 'first question');
    assert.equal(copied[1].stopReason, 'stop');
    assert.equal(forks.all()[String(ready.ompId)].parent, hub.get(parent)?.meta().ompId);
    await logged((e) => e.seq > from && e.session === parent && e.kind === 'frame' && e.frame.type === 'agent_end');
    assert.match(await Bun.file(file).text(), /You said: \**slow, then answer/, 'the source’s turn goes on');
    assert.deepEqual(await readdir(join(cwd, 'state', 'fork-sources')), [], 'the cut copy is gone once the fork is up');
  });

  test('a rewound conversation keeps its forks under its new id', async () => {
    const parent = (await call({ method: 'POST', path: '/api/sessions', body: { cwd } })).json.session.id;
    await waitForStatus(parent, 'ready');
    await turn(parent, 'first question');
    await turn(parent, 'second question');
    const before = String(hub.get(parent)?.meta().ompId);
    const fork = (await call({ method: 'POST', path: '/api/sessions', body: { cwd, fork: String(hub.get(parent)?.meta().sessionFile) } })).json.session.id;
    const forkId = String((await waitForStatus(fork, 'ready')).ompId);
    assert.equal(forks.all()[forkId].parent, before);

    const listed = /** @type {any} */ (await rpc(parent, { type: 'get_branch_messages' })).data.messages;
    await rpc(parent, { type: 'branch', entryId: listed[1].entryId });
    const moved = await logged((e) => e.session === parent && e.kind === 'session' && e.meta.ompId !== null && e.meta.ompId !== before);
    const after = moved.kind === 'session' ? moved.meta.ompId : null;
    assert.equal(forks.all()[forkId].parent, after);
  });

  test('a missing omp binary fails the session with the reason instead of hanging', async () => {
    const missing = createHub({ ompPath: join(cwd, 'no-such-omp'), unread });
    /** @type {Promise<void>} */
    const settled = new Promise((resolve) => missing.subscribe((e) => e.kind === 'session' && e.meta.status !== 'starting' && resolve()));
    const meta = missing.create({ cwd, resume: null, fork: null });
    await settled;
    const [after] = missing.list();
    assert.equal(after.id, meta.id);
    assert.equal(after.status, 'failed');
    assert.match(String(after.error), /ENOENT/);
  });

  test('a cwd that is not a directory is rejected before anything is launched', async () => {
    const before = hub.list().length;
    const res = await call({ method: 'POST', path: '/api/sessions', body: { cwd: join(cwd, 'missing') } });
    assert.equal(res.status, 400);
    assert.equal(hub.list().length, before);
  });
});

describe('unread conversations', () => {
  /** A ready session on a journal of its own, named `ompId`. @param {string} ompId */
  async function sessionOn(ompId) {
    const journal = join(cwd, `${ompId}.jsonl`);
    await Bun.write(journal, `${JSON.stringify({ type: 'session', version: 3, id: ompId, timestamp: '2026-10-01T10:00:00.000Z', cwd })}\n`);
    const { json } = await call({ method: 'POST', path: '/api/sessions', body: { cwd, resume: journal } });
    await waitForStatus(json.session.id, 'ready');
    return /** @type {string} */ (json.session.id);
  }
  /** The event at which session `id` handed its turn back. @param {string} id */
  const turnEnded = (id) => logged((e) => e.session === id && e.kind === 'frame' && e.frame.type === 'agent_end');

  test('a finished turn makes its conversation unread for every page, whether a window looked or not', async () => {
    const id = await sessionOn('conv-done');
    const stream = await openStream();
    await rpc(id, { type: 'prompt', message: 'hello' });
    const ended = await turnEnded(id);
    const { events } = await stream.until((events) => events.some((e) => e.kind === 'unread' && 'conv-done' in e.unread));
    const news = /** @type {import('../daemon/wire.js').UnreadEvent} */ (events.findLast((e) => e.kind === 'unread'));
    assert.equal(news.unread['conv-done'], ended.at, 'unread since the turn ended, in daemon time');
    assert.ok(events.findIndex((e) => e.kind === 'unread') > events.findIndex((e) => e.kind === 'frame' && e.frame.type === 'agent_end'), 'after the news itself');
    await call({ method: 'DELETE', path: `/api/sessions/${id}` });
    await waitForStatus(id, 'exited');
    assert.equal(unread.all()['conv-done'], ended.at, 'a stopped session is still unread');
  });

  test('a question makes it unread before the turn ends', async () => {
    const id = await sessionOn('conv-ask');
    await rpc(id, { type: 'prompt', message: 'ask me' });
    const asked = await logged((e) => e.session === id && e.kind === 'frame' && e.frame.type === 'extension_ui_request' && e.frame.method === 'ask');
    assert.equal(unread.all()['conv-ask'], asked.at);
    await call({ method: 'DELETE', path: `/api/sessions/${id}` });
  });

  test('reading clears the mark only up to what was read; marking unread sets it again', async () => {
    const id = await sessionOn('conv-read');
    await rpc(id, { type: 'prompt', message: 'hello' });
    const { at } = await turnEnded(id);
    assert.equal((await call({ method: 'POST', path: '/api/unread/conv-read/read', body: { at: at - 1 } })).status, 204);
    assert.equal(unread.all()['conv-read'], at, 'a window that had not heard of this news does not clear it');
    assert.equal((await call({ method: 'POST', path: '/api/unread/conv-read/read', body: { at } })).status, 204);
    assert.equal('conv-read' in unread.all(), false);
    assert.equal((await call({ method: 'PUT', path: '/api/unread/conv-read' })).status, 204);
    assert.ok(unread.all()['conv-read'] > at, 'unread since the user marked it, after any news');
    assert.equal((await call({ method: 'POST', path: '/api/unread/conv-read/read', body: { at } })).status, 204);
    assert.ok('conv-read' in unread.all(), 'a read from before the mark leaves it');
    await call({ method: 'DELETE', path: `/api/sessions/${id}` });
  });

  test('marks survive a daemon restart: the next daemon’s pages hear them first thing', async () => {
    assert.equal((await call({ method: 'PUT', path: '/api/unread/conv-kept' })).status, 204);
    const marks = await loadUnread({ file: join(cwd, 'state', 'unread.json') });
    const nextHub = createHub({ ompPath: FAKE_OMP, unread: marks });
    const next = createDaemonServer({
      hub: nextHub,
      unread: marks,
      pins,
      forks,
      forker: createForker({ hub: nextHub, forks, scratchDir: join(cwd, 'state', 'fork-sources'), nameFork: async () => 'unused' }),
      decisions,
      settings,
      history: createHistory({ root: join(cwd, 'omp-sessions'), archive: join(cwd, 'state', 'archive', 'sessions') }),
      scratchpads: createScratchpads({ dir: join(cwd, 'state', 'scratchpads') }),
      attachments: createAttachments({ dir: join(cwd, 'state', 'attachments') }),
      workspaces: createWorkspaces({ dir: join(cwd, 'state', 'workspaces') }),
      github,
      delivery,
      bugbot,
      setup,
      remote,
      token: TOKEN,
      root: ROOT,
      config: { defaultCwd: cwd, home: cwd, scratchpadDir: join(cwd, 'state', 'scratchpads'), idleCompactAfterMs: 60_000 },
      port: 0,
    });
    try {
      const { events } = await (await openStream({ daemon: next.port })).until((events) => events.some((e) => e.kind === 'hello'));
      const hello = events.find((e) => e.kind === 'hello');
      assert.equal(hello?.kind === 'hello' && hello.unread['conv-kept'], unread.all()['conv-kept']);
    } finally {
      await next.stop(true);
    }
  });

  test('like every API route, marks need the token and the page’s Origin; an id that is not one is a 404', async () => {
    for (const [method, path, body] of [['PUT', '/api/unread/conv-guard', undefined], ['POST', '/api/unread/conv-guard/read', { at: Date.now() }]]) {
      const request = { method: /** @type {string} */ (method), path: /** @type {string} */ (path), body };
      assert.equal((await call({ ...request, auth: false })).status, 401);
      assert.equal((await call({ ...request, origin: false })).status, 403);
      assert.equal((await call({ ...request, headers: { origin: 'http://evil.example' } })).status, 403);
    }
    assert.equal('conv-guard' in unread.all(), false, 'nothing was marked');
    assert.equal((await call({ method: 'PUT', path: '/api/unread/a%20b' })).status, 404);
    assert.equal((await call({ method: 'POST', path: '/api/unread/conv-guard/read', body: { at: 'later' } })).status, 400);
  });
});

describe('pins', () => {
  test('every page hears them first thing and after each change, which the next daemon starts with', async () => {
    const stream = await openStream();
    assert.equal((await call({ method: 'PUT', path: '/api/pins/conv-a' })).status, 204);
    assert.equal((await call({ method: 'PUT', path: '/api/pins/conv-b' })).status, 204);
    assert.equal((await call({ method: 'DELETE', path: '/api/pins/conv-a' })).status, 204);
    const { events } = await stream.until((events) => events.filter((e) => e.kind === 'pins').length === 3);
    assert.deepEqual(events[0].kind === 'hello' && events[0].pinned, []);
    assert.deepEqual(events.filter((e) => e.kind === 'pins'), [
      { kind: 'pins', pinned: ['conv-a'] },
      { kind: 'pins', pinned: ['conv-a', 'conv-b'] },
      { kind: 'pins', pinned: ['conv-b'] },
    ]);
    assert.deepEqual((await loadPins({ file: join(cwd, 'state', 'pins.json') })).all(), ['conv-b']);
    assert.equal((await call({ method: 'DELETE', path: '/api/pins/conv-b' })).status, 204);
  });

  test('like every API route, pins need the token and the page’s Origin; an id that is not one is a 404', async () => {
    assert.equal((await call({ method: 'PUT', path: '/api/pins/conv-guard', auth: false })).status, 401);
    assert.equal((await call({ method: 'PUT', path: '/api/pins/conv-guard', origin: false })).status, 403);
    assert.equal((await call({ method: 'PUT', path: '/api/pins/a%20b' })).status, 404);
    assert.deepEqual(pins.all(), []);
  });

  test('a pins file the daemon cannot read stops it rather than being replaced', async () => {
    const file = join(cwd, 'bad-pins.json');
    for (const text of ['not json', '{"version":1,"pinned":["../x"]}', '{"version":2,"pinned":[]}']) {
      await writeFile(file, text);
      await assert.rejects(loadPins({ file }), /not a pins file/);
    }
  });
});

describe('settings', () => {
  const DEFAULTS = Object.freeze({ idleCompaction: true, decisionReview: false, adhd: false, browser: 'isolated', setupDone: false, remote: false });

  test('every page hears them first thing and after each change, which the next daemon starts with', async () => {
    const stream = await openStream();
    const changed = await call({ method: 'PUT', path: '/api/settings', body: { idleCompaction: false, browser: 'relay' } });
    assert.equal(changed.status, 200);
    const after = { ...DEFAULTS, idleCompaction: false, browser: 'relay' };
    assert.deepEqual(changed.json, after);
    const { events } = await stream.until((events) => events.some((e) => e.kind === 'settings'));
    assert.deepEqual(events[0].kind === 'hello' && events[0].settings, DEFAULTS);
    assert.deepEqual(events.find((e) => e.kind === 'settings'), { kind: 'settings', settings: after });
    assert.deepEqual((await loadSettings({ file: join(cwd, 'state', 'settings.json') })).all(), after);
    assert.equal((await call({ method: 'PUT', path: '/api/settings', body: { idleCompaction: true, browser: 'isolated' } })).status, 200);
  });

  test('only known settings with values they may take are taken; like every API route they need the token and Origin', async () => {
    for (const body of [{ idleCompaction: 'no' }, { sleepy: true }, { browser: 'firefox' }, { browser: true }, { setupDone: 'yes' }, [true], null]) {
      assert.equal((await call({ method: 'PUT', path: '/api/settings', body })).status, 400, JSON.stringify(body));
    }
    assert.equal((await call({ method: 'PUT', path: '/api/settings', body: { idleCompaction: false }, auth: false })).status, 401);
    assert.equal((await call({ method: 'PUT', path: '/api/settings', body: { idleCompaction: false }, origin: false })).status, 403);
    assert.deepEqual(settings.all(), DEFAULTS);
  });

  test('a settings file the daemon cannot read stops it rather than being replaced', async () => {
    const file = join(cwd, 'bad-settings.json');
    for (const text of ['{"version":1,"settings":{"idleCompaction":"off"}}', '{"version":1,"settings":{"browser":"firefox"}}']) {
      await Bun.write(file, text);
      await assert.rejects(loadSettings({ file }), /not a settings file/);
    }
  });
});

describe('setup', () => {
  /** Reads the stream until the login's state passes `done`. @param {Awaited<ReturnType<typeof openStream>>} stream @param {(login: import('../daemon/setup.js').LoginState) => boolean} done */
  async function loginUntil(stream, done) {
    const { events } = await stream.until((events) => events.some((e) => e.kind === 'login' && e.login !== null && done(e.login)));
    const found = events.findLast((e) => e.kind === 'login');
    return /** @type {import('../daemon/setup.js').LoginState} */ (found?.kind === 'login' && found.login);
  }

  test('a machine without a model sign-in is not ready; omp login, answered from the page, signs it in', async () => {
    const before = await call({ path: '/api/setup' });
    assert.equal(before.status, 200);
    assert.deepEqual(before.json, {
      omp: { ok: true, detail: 'omp/fake' },
      models: { ok: false, detail: 'No model provider signed in' },
      gh: { ok: true, detail: 'Signed in as octocat' },
    });

    const stream = await openStream();
    const started = await call({ method: 'POST', path: '/api/setup/login', body: {} });
    assert.equal(started.status, 202);
    assert.equal((await call({ method: 'POST', path: '/api/setup/login', body: {} })).status, 409, 'one login at a time');
    const picking = await loginUntil(stream, (login) => login.output.includes('Enter number'));
    assert.match(picking.output, /1\. Fake Cloud/);
    assert.equal(picking.running, true);

    const coding = await openStream();
    assert.equal((await call({ method: 'POST', path: '/api/setup/login/input', body: { line: '1' } })).status, 204);
    const asked = await loginUntil(coding, (login) => login.output.includes('Paste the authorization code'));
    assert.match(asked.output, /Enter number \(1-2\): 1\n/, 'the answer shows where it was typed, as a terminal echoes it');
    assert.match(asked.output, /https:\/\/login\.fake\.example\/fake-cloud/);

    const ending = await openStream();
    assert.equal((await call({ method: 'POST', path: '/api/setup/login/input', body: { line: 'good' } })).status, 204);
    const ended = await loginUntil(ending, (login) => !login.running);
    assert.equal(ended.exitCode, 0);
    assert.match(ended.output, /Logged in to Fake Cloud/);

    const after = await call({ path: '/api/setup' });
    assert.deepEqual(after.json.models, { ok: true, detail: 'fake-cloud (2 models)' });
    assert.equal((await call({ method: 'POST', path: '/api/setup/login/input', body: { line: 'late' } })).status, 409, 'no login runs now');
  });

  test('a login that fails says so, and a page that connects later hears how it ended', async () => {
    const stream = await openStream();
    assert.equal((await call({ method: 'POST', path: '/api/setup/login', body: { provider: 'keyed' } })).status, 202);
    await loginUntil(stream, (login) => login.output.includes('Paste the authorization code'));
    const ending = await openStream();
    assert.equal((await call({ method: 'POST', path: '/api/setup/login/input', body: { line: 'wrong' } })).status, 204);
    const ended = await loginUntil(ending, (login) => !login.running);
    assert.equal(ended.exitCode, 1);
    assert.match(ended.output, /Login failed: invalid authorization code/);
    const { events } = await (await openStream()).until((events) => events.some((e) => e.kind === 'hello'));
    assert.deepEqual(events[0].kind === 'hello' && events[0].login, ended);
  });

  test('a provider that is not an id, an answer of two lines, or a request without the token is refused', async () => {
    assert.equal((await call({ method: 'POST', path: '/api/setup/login', body: { provider: '--help' } })).status, 400);
    assert.equal((await call({ method: 'POST', path: '/api/setup/login', body: { provider: 3 } })).status, 400);
    assert.equal((await call({ method: 'POST', path: '/api/setup/login/input', body: { line: 'a\nb' } })).status, 400);
    assert.equal((await call({ path: '/api/setup', auth: false })).status, 401);
    assert.equal((await call({ method: 'POST', path: '/api/setup/login', body: {}, origin: false })).status, 403);
  });

  test('without omp, Setup says so, and the model step waits for it', async () => {
    const missing = createSetup({ ompPath: join(cwd, 'no-such-omp'), ghPath: join(cwd, 'no-such-gh') });
    assert.deepEqual(await missing.check(), {
      omp: { ok: false, detail: `omp not found ("${join(cwd, 'no-such-omp')}")` },
      models: { ok: false, detail: 'Needs omp' },
      gh: { ok: false, detail: `GitHub CLI not installed ("${join(cwd, 'no-such-gh')}")` },
    });
  });
});

describe('decision reviews', () => {
  /** A ready session on a journal of its own, named `ompId`. @param {string} ompId */
  async function sessionOn(ompId) {
    const journal = join(cwd, `${ompId}.jsonl`);
    await Bun.write(journal, `${JSON.stringify({ type: 'session', version: 3, id: ompId, timestamp: '2026-10-01T10:00:00.000Z', cwd })}\n`);
    const { json } = await call({ method: 'POST', path: '/api/sessions', body: { cwd, resume: journal } });
    await waitForStatus(json.session.id, 'ready');
    return /** @type {string} */ (json.session.id);
  }
  /**
   * Prompts session `id` and waits for the page to hear its review end; the prompt's time names it.
   * @param {string} id @param {string} ompId @param {string} message
   */
  async function reviewed(id, ompId, message) {
    const stream = await openStream();
    const from = hub.latest();
    await rpc(id, { type: 'prompt', message });
    const prompt = await logged((e) => e.seq > from && e.session === id && e.kind === 'frame' && e.frame.type === 'message_end' && e.frame.message.role === 'user');
    const at = String(prompt.kind === 'frame' && prompt.frame.message.timestamp);
    const { events } = await stream.until((events) =>
      events.some((e) => e.kind === 'decisions' && e.ompId === ompId && e.reviews[at] && e.reviews[at].status !== 'pending'),
    );
    const heard = events.filter((e) => e.kind === 'decisions' && e.ompId === ompId).map((e) => e.kind === 'decisions' && e.reviews[at]);
    return { at, heard };
  }

  test('off by default; turned on, each turn the agent hands back is reviewed by a one-shot omp, without the turns before it', async () => {
    const id = await sessionOn('conv-decide');
    const before = hub.latest();
    await rpc(id, { type: 'prompt', message: 'decide on a database' });
    await logged((e) => e.seq > before && e.session === id && e.kind === 'frame' && e.frame.type === 'agent_end');
    assert.deepEqual((await call({ path: '/api/decisions/conv-decide' })).json, { reviews: {} }, 'not reviewed while off');

    await settings.set({ decisionReview: true });
    try {
      // "decide" earns the fake reviewer's decisions: had it read the turn before, it would list them here.
      const quiet = await reviewed(id, 'conv-decide', 'hello');
      assert.deepEqual(quiet.heard, [{ status: 'pending' }, { status: 'done', decisions: [] }]);

      const busy = await reviewed(id, 'conv-decide', 'now decide the schema');
      const done = { status: 'done', decisions: ['Picked SQLite over Postgres, as nothing needs a server.', 'Kept the old API as an alias.'] };
      assert.deepEqual(busy.heard, [{ status: 'pending' }, done]);
      const reviews = { [quiet.at]: { status: 'done', decisions: [] }, [busy.at]: done };
      assert.deepEqual((await call({ path: '/api/decisions/conv-decide' })).json, { reviews });
      // Kept in the state directory: the next daemon starts with them.
      const next = createDecisionReviews({ dir: join(cwd, 'state', 'decisions'), on: () => true, ask: () => Promise.reject(new Error('not asked')) });
      assert.deepEqual(await next.reviews('conv-decide'), reviews);
    } finally {
      await settings.set({ decisionReview: false });
      await call({ method: 'DELETE', path: `/api/sessions/${id}` });
    }
  });

  test('a reviewer that fails leaves the reason under the turn', async () => {
    const id = await sessionOn('conv-review-fails');
    await settings.set({ decisionReview: true });
    try {
      const { heard } = await reviewed(id, 'conv-review-fails', 'the reviewer fails here');
      assert.deepEqual(heard.at(-1), { status: 'failed', error: 'Error: 529 overloaded' });
    } finally {
      await settings.set({ decisionReview: false });
      await call({ method: 'DELETE', path: `/api/sessions/${id}` });
    }
  });

  test('like every API route, reviews need the token; an id that is not one is a 404', async () => {
    assert.equal((await call({ path: '/api/decisions/conv-decide', auth: false })).status, 401);
    assert.equal((await call({ path: '/api/decisions/a%20b' })).status, 404);
  });
});

describe('text files', () => {
  test('a text file is read for the file window, resolved, with its size; any other file, or none, is a 404', async () => {
    const dir = join(cwd, 'texts');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'jobs.json'), '{ "jobs": 4 }\n');
    await writeFile(join(dir, 'secret.env'), 'TOKEN=x\n');
    await writeFile(join(dir, 'blob.txt'), 'a\u0000b');
    const res = await call({ path: `/api/text?path=${encodeURIComponent(join(dir, 'sub', '..', 'jobs.json'))}` });
    assert.equal(res.status, 200);
    assert.deepEqual(
      { ...res.json, modifiedAt: 0, rev: typeof res.json.rev },
      { path: join(dir, 'jobs.json'), text: '{ "jobs": 4 }\n', size: 14, truncated: false, editable: true, modifiedAt: 0, rev: 'string' },
    );
    for (const name of ['secret.env', 'blob.txt', 'missing.md', '']) {
      assert.equal((await call({ path: `/api/text?path=${encodeURIComponent(join(dir, name))}` })).status, 404, name);
    }
    assert.equal((await call({ path: `/api/text?path=${encodeURIComponent(join(dir, 'jobs.json'))}`, auth: false })).status, 401);
  });

  test('a file past the cap is read up to it, and says so', async () => {
    const file = join(cwd, 'texts', 'long.log');
    await writeFile(file, 'x'.repeat(100));
    const read = await readTextFile(file, 10);
    assert.deepEqual([read.text, read.size, read.truncated, read.editable], ['x'.repeat(10), 100, true, false]);
  });

  test('an edit is saved from the version it began at; from an older one it is refused with what the file holds now', async () => {
    const file = join(cwd, 'texts', 'plan.md');
    await writeFile(file, '# Plan\n');
    await chmod(file, 0o640);
    const { json: read } = await call({ path: `/api/text?path=${encodeURIComponent(file)}` });
    const saved = await call({ method: 'PUT', path: '/api/text', body: { path: file, text: '# Plan\n\nship it\n', base: read.rev } });
    assert.equal(saved.status, 200);
    assert.deepEqual([saved.json.text, saved.json.size], ['# Plan\n\nship it\n', 16]);
    assert.notEqual(saved.json.rev, read.rev);
    assert.equal(await Bun.file(file).text(), '# Plan\n\nship it\n');
    assert.equal((await stat(file)).mode & 0o777, 0o640, 'written in place: the file keeps its permissions');

    const stale = await call({ method: 'PUT', path: '/api/text', body: { path: file, text: 'mine', base: read.rev } });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.current.text, '# Plan\n\nship it\n');
    assert.equal(stale.json.current.rev, saved.json.rev);
    assert.equal(await Bun.file(file).text(), '# Plan\n\nship it\n', 'the newer text stays');
  });

  test('only a text file the window shows, already there and read whole as UTF-8, is saved', async () => {
    const dir = join(cwd, 'texts');
    const latin = join(dir, 'latin.txt');
    await writeFile(latin, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])); // "café\n" in Latin-1
    const { json: read } = await call({ path: `/api/text?path=${encodeURIComponent(latin)}` });
    assert.equal(read.editable, false);
    assert.equal((await call({ method: 'PUT', path: '/api/text', body: { path: latin, text: 'cafe\n', base: read.rev } })).status, 422);
    assert.deepEqual([...(await Bun.file(latin).bytes())], [0x63, 0x61, 0x66, 0xe9, 0x0a], 'its bytes are untouched');

    const json = join(dir, 'jobs.json');
    const { json: jobs } = await call({ path: `/api/text?path=${encodeURIComponent(json)}` });
    assert.equal((await call({ method: 'PUT', path: '/api/text', body: { path: json, text: 'a\u0000b', base: jobs.rev } })).status, 422);
    for (const name of ['secret.env', 'missing.md']) {
      assert.equal((await call({ method: 'PUT', path: '/api/text', body: { path: join(dir, name), text: 'x', base: 'x' } })).status, 404, name);
    }
    assert.equal(await Bun.file(join(dir, 'missing.md')).exists(), false, 'a save never makes a file');
    assert.equal((await call({ method: 'PUT', path: '/api/text', body: { path: json, text: 4, base: jobs.rev } })).status, 400);
    assert.equal((await call({ method: 'PUT', path: '/api/text', body: { path: json, text: 'x', base: jobs.rev }, auth: false })).status, 401);
    assert.equal((await call({ method: 'PUT', path: '/api/text', body: { path: json, text: 'x', base: jobs.rev }, origin: false })).status, 403);
    assert.equal(await Bun.file(json).text(), '{ "jobs": 4 }\n');
  });
});

describe('scratchpads', () => {
  test('a save from the current version lands, and every open page hears which pad changed', async () => {
    const before = await call({ path: '/api/scratchpads/notes' });
    assert.equal(before.status, 200);
    const stream = await openStream();
    const saved = await call({ method: 'PUT', path: '/api/scratchpads/notes', body: { text: 'remember the milk', base: before.json.rev } });
    assert.equal(saved.status, 200);

    const { events, ids } = await stream.until((all) => all.some((e) => e.kind === 'scratchpad'));
    const heard = events.find((e) => e.kind === 'scratchpad');
    assert.deepEqual(heard, { kind: 'scratchpad', id: 'notes', text: 'remember the milk', rev: saved.json.rev });
    assert.equal(ids.length, events.filter((e) => e.kind !== 'hello' && e.kind !== 'scratchpad').length, 'not part of the replayable log');
    assert.deepEqual((await call({ path: '/api/scratchpads/notes' })).json, { text: 'remember the milk', rev: saved.json.rev });
    assert.deepEqual(
      (await call({ path: '/api/scratchpads' })).json.pads.map((/** @type {any} */ p) => [p.id, p.title]),
      [['notes', 'remember the milk']],
    );
  });

  test('a save from an older version is refused with what is there now', async () => {
    const { json: current } = await call({ path: '/api/scratchpads/race' });
    await call({ method: 'PUT', path: '/api/scratchpads/race', body: { text: 'first', base: current.rev } });
    const stale = await call({ method: 'PUT', path: '/api/scratchpads/race', body: { text: 'second', base: current.rev } });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.current.text, 'first');
    assert.equal((await call({ path: '/api/scratchpads/race' })).json.text, 'first');
  });

  test('a malformed save is a 400, and a pad id that is not one is a 404', async () => {
    assert.equal((await call({ method: 'PUT', path: '/api/scratchpads/notes', body: { text: 42 } })).status, 400);
    assert.equal((await call({ path: '/api/scratchpads/..%2Ftoken' })).status, 404);
    assert.equal((await call({ path: '/api/scratchpads/Notes' })).status, 404);
  });

  test('a stored screenshot is served as an image; anything else downloads and can never run', async () => {
    const up = await call({ method: 'POST', path: '/api/scratchpads/shots/assets', headers: { 'x-file-name': encodeURIComponent('my shot.png') }, raw: 'PNGDATA' });
    assert.equal(up.status, 201);
    assert.match(up.json.path, /^shots\.assets\/[a-z0-9]+-my-shot\.png$/);
    const image = await call({ path: `/api/scratchpads/shots/assets/${up.json.path.split('/')[1]}` });
    assert.equal(image.status, 200);
    assert.equal(image.text, 'PNGDATA');
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.match(String(image.headers.get('content-security-policy')), /sandbox/);
    assert.equal(image.headers.get('content-disposition'), null);

    const page = await call({ method: 'POST', path: '/api/scratchpads/shots/assets', headers: { 'x-file-name': 'evil.html' }, raw: '<script>alert(1)</script>' });
    const served = await call({ path: `/api/scratchpads/shots/assets/${page.json.path.split('/')[1]}` });
    assert.equal(served.headers.get('content-type'), 'application/octet-stream');
    assert.equal(served.headers.get('content-disposition'), 'attachment');
    assert.match(String(served.headers.get('content-security-policy')), /sandbox/);
    assert.equal((await call({ path: '/api/scratchpads/shots/assets/nope.png' })).status, 404);
  });

  test('deleting a pad removes it and its files', async () => {
    const { json } = await call({ path: '/api/scratchpads/doomed' });
    await call({ method: 'PUT', path: '/api/scratchpads/doomed', body: { text: 'bye', base: json.rev } });
    const up = await call({ method: 'POST', path: '/api/scratchpads/doomed/assets', headers: { 'x-file-name': 'a.png' }, raw: 'x' });
    assert.equal((await call({ method: 'DELETE', path: '/api/scratchpads/doomed' })).status, 204);
    assert.equal((await call({ path: '/api/scratchpads/doomed' })).json.text, '');
    assert.equal((await call({ path: `/api/scratchpads/doomed/assets/${up.json.path.split('/')[1]}` })).status, 404);
    assert.ok(!(await call({ path: '/api/scratchpads' })).json.pads.some((/** @type {any} */ p) => p.id === 'doomed'));
  });
});

describe('workspaces', () => {
  const tree = { kind: 'leaf', id: 'w_1', widget: 'pane' };
  const screen = '/api/workspaces/desk/screens/s_0000000a';

  test('like every API route, workspaces need the token, and saving one needs the page’s Origin', async () => {
    assert.equal((await call({ path: '/api/workspaces/desk', auth: false })).status, 401);
    assert.equal((await call({ method: 'PUT', path: screen, body: { tree, base: null }, auth: false })).status, 401);
    assert.equal((await call({ method: 'PUT', path: screen, body: { tree, base: null }, origin: false })).status, 403);
    assert.deepEqual((await call({ path: '/api/workspaces/desk' })).json, { screens: [] }, 'nothing was saved');
  });

  test('a screen is stored by its first save, refused from an older rev, and deleted when emptied', async () => {
    assert.deepEqual((await call({ method: 'PUT', path: screen, body: { tree, base: null } })).json, { rev: 1 });
    assert.deepEqual((await call({ path: '/api/workspaces/desk' })).json, { screens: [{ id: 's_0000000a', rev: 1, tree }] });
    const stale = await call({ method: 'PUT', path: screen, body: { tree: null, base: null } });
    assert.equal(stale.status, 409);
    assert.deepEqual(stale.json.current, { id: 's_0000000a', rev: 1, tree });
    assert.deepEqual((await call({ method: 'PUT', path: screen, body: { tree: null, base: 1 } })).json, { rev: null });
    assert.deepEqual((await call({ path: '/api/workspaces/desk' })).json, { screens: [] });
  });

  test('a layout that is not one is a 400; a name or screen id that is not one is a 404', async () => {
    for (const body of [{ tree: { kind: 'leaf', id: 7 }, base: null }, { tree, base: 0 }, { tree, base: '1' }, { tree }, []]) {
      assert.equal((await call({ method: 'PUT', path: screen, body })).status, 400, JSON.stringify(body));
    }
    assert.equal((await call({ path: '/api/workspaces/..%2Ftoken' })).status, 404);
    assert.equal((await call({ path: '/api/workspaces/Desk' })).status, 404);
    assert.equal((await call({ method: 'PUT', path: '/api/workspaces/desk/screens/..%2Fx', body: { tree, base: null } })).status, 404);
    assert.deepEqual((await call({ path: '/api/workspaces/desk' })).json, { screens: [] });
  });

  test('a corrupt workspace file is reported, not replaced', async () => {
    const file = join(cwd, 'state', 'workspaces', 'broken.json');
    await Bun.write(file, '{not json');
    const read = await call({ path: '/api/workspaces/broken' });
    assert.equal(read.status, 500);
    assert.match(read.json.error, /broken\.json is not a workspace file/);
    assert.equal((await call({ method: 'PUT', path: '/api/workspaces/broken/screens/s_0000000a', body: { tree, base: null } })).status, 500);
    assert.equal(await Bun.file(file).text(), '{not json');
  });
});

describe('sleep', () => {
  /**
   * A hub of the test's own whose sessions sleep after `after` ms, and a way to wait for one
   * of its sessions to reach a status.
   * @param {number} after @param {{ launchWith?: () => import('../daemon/omp-session.js').LaunchWith }} [options]
   */
  function sleepyHub(after, options = {}) {
    const sleepy = createHub({ ompPath: FAKE_OMP, unread, sleepAfterMs: after, ...options });
    /** @type {SessionEvent[]} */
    const events = [];
    /** @type {Set<() => void>} */
    const waiters = new Set();
    sleepy.subscribe((e) => {
      events.push(e);
      for (const fn of waiters) fn();
    });
    /** @param {(e: SessionEvent) => boolean} match @returns {Promise<SessionEvent>} */
    const next = (match) =>
      new Promise((resolve) => {
        const check = () => {
          const found = events.find(match);
          if (!found) return;
          waiters.delete(check);
          resolve(found);
        };
        waiters.add(check);
        check();
      });
    /** @param {string} id @param {string} status */
    const reaches = (id, status) => next((e) => e.session === id && e.kind === 'session' && e.meta.status === status);
    return { sleepy, events, next, reaches };
  }

  test('an idle session nobody uses goes to sleep; being used keeps it awake', async () => {
    const { sleepy, reaches } = sleepyHub(400);
    const id = sleepy.create({ cwd, resume: null, fork: null }).id;
    await reaches(id, 'ready');
    // Used every 100 ms for a while: still awake.
    for (let i = 0; i < 8; i++) {
      await Bun.sleep(100);
      sleepy.seen(id);
    }
    assert.equal(sleepy.get(id)?.meta().status, 'ready');
    assert.equal(sleepy.idle(id), true, 'nothing under way');
    await reaches(id, 'exited');
    await sleepy.closeAll();
  });

  test('a session never sleeps while its agent works, and does once it is done', async () => {
    const { sleepy, events, next, reaches } = sleepyHub(300);
    const id = sleepy.create({ cwd, resume: null, fork: null }).id;
    await reaches(id, 'ready');
    // "slow" keeps the turn running for 1.5 s: five times the wait before sleep.
    sleepy.get(id)?.command({ type: 'prompt', message: 'slow' });
    await next((e) => e.session === id && e.kind === 'frame' && e.frame.type === 'agent_start');
    assert.equal(sleepy.idle(id), false);
    await next((e) => e.session === id && e.kind === 'frame' && e.frame.type === 'session_settled');
    const settled = events.length;
    assert.equal(sleepy.get(id)?.meta().status, 'ready', 'awake all through the turn');
    await reaches(id, 'exited');
    assert.ok(events.length > settled);
    await sleepy.closeAll();
  });

  /** What session `id` of `of` reports of how it was launched (the fake reports it). @param {import('../daemon/hub.js').Hub} of @param {string} id */
  const stateOf = async (of, id) => (await /** @type {import('../daemon/omp-session.js').OmpSession} */ (of.get(id)).command({ type: 'get_state' }).response).data;
  /** What session `id` of `of` has appended to omp's system prompt. @param {import('../daemon/hub.js').Hub} of @param {string} id */
  const appendedTo = async (of, id) => (await stateOf(of, id)).appendedPrompt;
  /** @param {boolean} adhd */
  const withRules = (adhd) => ({ appendSystemPrompt: withAdhdRules(APPEND_SYSTEM_PROMPT, adhd), env: {} });

  test('switching "I have ADHD" puts idle sessions started the other way to sleep; they wake with the rules', async () => {
    let adhd = false;
    const { sleepy, reaches } = sleepyHub(60_000, { launchWith: () => withRules(adhd) });
    const before = sleepy.create({ cwd, resume: null, fork: null }).id;
    await reaches(before, 'ready');
    assert.equal(await appendedTo(sleepy, before), APPEND_SYSTEM_PROMPT);
    sleepy.launchChanged();
    await Bun.sleep(200);
    assert.equal(sleepy.get(before)?.meta().status, 'ready', 'nothing changed: still awake');

    adhd = true;
    sleepy.launchChanged();
    await reaches(before, 'exited');
    const after = sleepy.create({ cwd, resume: null, fork: null }).id;
    await reaches(after, 'ready');
    const appended = await appendedTo(sleepy, after);
    assert.ok(appended.startsWith(`${APPEND_SYSTEM_PROMPT}\n\nADHD MODE ACTIVE.`), 'the workbench’s prompt, then the rules');
    assert.match(appended, /### 1\. Lead with the next action/);
    assert.doesNotMatch(appended, /disable-model-invocation/, 'without the skill’s frontmatter');
    sleepy.launchChanged();
    await Bun.sleep(200);
    assert.equal(sleepy.get(after)?.meta().status, 'ready', 'started with the rules: stays awake');
    await sleepy.closeAll();
  });

  test('a session working when the switch changes finishes its turn, then sleeps', async () => {
    let adhd = false;
    const { sleepy, events, next, reaches } = sleepyHub(60_000, { launchWith: () => withRules(adhd) });
    const id = sleepy.create({ cwd, resume: null, fork: null }).id;
    await reaches(id, 'ready');
    sleepy.get(id)?.command({ type: 'prompt', message: 'slow' });
    await next((e) => e.session === id && e.kind === 'frame' && e.frame.type === 'agent_start');
    adhd = true;
    sleepy.launchChanged();
    await Bun.sleep(300);
    assert.equal(sleepy.get(id)?.meta().status, 'ready', 'never cut off mid-turn');
    const exited = await reaches(id, 'exited');
    const answered = events.findIndex((e) => e.session === id && e.kind === 'frame' && e.frame.type === 'message_end' && e.frame.message?.stopReason === 'stop');
    assert.ok(answered >= 0 && answered < events.indexOf(exited), 'asleep once the turn has its answer');
    await sleepy.closeAll();
  });

  test('omp runs with the browser chosen; switching it puts idle sessions to sleep, and they wake with the new one', async () => {
    /** @type {import('../daemon/browser.js').BrowserChoice} */
    let browser = 'isolated';
    const { sleepy, reaches } = sleepyHub(60_000, { launchWith: () => ({ appendSystemPrompt: APPEND_SYSTEM_PROMPT, env: browserEnv(browser) }) });
    const before = sleepy.create({ cwd, resume: null, fork: null }).id;
    await reaches(before, 'ready');
    assert.deepEqual((await stateOf(sleepy, before)).browserEnv, { PI_BROWSER_RELAY: '0', PI_BROWSER_CMUX: '0', PI_BROWSER_TERN: '0' }, 'relay, cmux and Tern off');

    browser = 'relay';
    sleepy.launchChanged();
    await reaches(before, 'exited');
    const relayed = sleepy.create({ cwd, resume: null, fork: null }).id;
    await reaches(relayed, 'ready');
    assert.deepEqual((await stateOf(sleepy, relayed)).browserEnv, { PI_BROWSER_RELAY: '1' });

    browser = 'omp';
    sleepy.launchChanged();
    await reaches(relayed, 'exited');
    const own = sleepy.create({ cwd, resume: null, fork: null }).id;
    await reaches(own, 'ready');
    assert.deepEqual((await stateOf(sleepy, own)).browserEnv, {}, 'omp’s own settings: nothing set');
    await sleepy.closeAll();
  });
});

test('a rewind moves the session onto a new journal; the hub tells which one it left', async () => {
  /** @type {string[]} */
  const left = [];
  const rewinding = createHub({ ompPath: FAKE_OMP, unread, onRewound: (file) => left.push(file) });
  /** @type {SessionEvent[]} */
  const events = [];
  /** @type {() => void} */
  let heard = () => {};
  rewinding.subscribe((e) => {
    events.push(e);
    heard();
  });
  /** @param {(e: SessionEvent) => boolean} match */
  const next = async (match) => {
    while (!events.some(match)) await new Promise((r) => (heard = () => r(undefined)));
    return /** @type {SessionEvent} */ (events.find(match));
  };
  const id = rewinding.create({ cwd, resume: null, fork: null }).id;
  await next((e) => e.kind === 'session' && e.meta.status === 'ready');
  const session = /** @type {import('../daemon/omp-session.js').OmpSession} */ (rewinding.get(id));
  for (const message of ['first', 'second']) {
    const settled = events.length;
    session.command({ type: 'prompt', message });
    await next((e) => events.indexOf(e) >= settled && e.kind === 'frame' && e.frame.type === 'session_settled');
  }
  const before = String(session.meta().sessionFile);
  const listed = await session.command({ type: 'get_branch_messages' }).response;
  const answered = await session.command({ type: 'branch', entryId: listed.data.messages[1].entryId }).response;
  assert.equal(answered.data.text, 'second');
  await next((e) => e.kind === 'session' && e.meta.sessionFile !== null && e.meta.sessionFile !== before);
  assert.deepEqual(left, [before]);
  assert.notEqual(session.meta().sessionFile, before);
  assert.ok(await Bun.file(before).exists(), 'the old journal keeps the path set aside');
  await rewinding.closeAll();
});

describe('conversations from their journals', () => {
  const journalsDir = () => join(cwd, 'omp-sessions', '-conv');

  test('a listed journal reads back as its conversation, without starting omp', async () => {
    const file = join(journalsDir(), 'read-me.jsonl');
    const lines = [
      { type: 'title', v: 1, title: 'Read me' },
      { type: 'session', version: 3, id: 'read-me', timestamp: '2026-10-01T10:00:00.000Z', cwd },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
    ];
    await mkdir(journalsDir(), { recursive: true });
    await Bun.write(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    const before = hub.list().length;
    const res = await call({ path: `/api/conversation?file=${encodeURIComponent(file)}` });
    assert.equal(res.status, 200);
    assert.deepEqual({ id: res.json.id, title: res.json.title, cwd: res.json.cwd, messages: res.json.messages.length }, { id: 'read-me', title: 'Read me', cwd, messages: 1 });
    assert.equal(hub.list().length, before, 'no omp was started');
  });

  test('a journal a session of this daemon wrote reads back wherever it is; any other path is refused', async () => {
    const created = (await call({ method: 'POST', path: '/api/sessions', body: { cwd } })).json.session;
    await waitForStatus(created.id, 'ready');
    const from = hub.since(0).length;
    await rpc(created.id, { type: 'prompt', message: 'hello' });
    await logged((e) => e.seq > from && e.session === created.id && e.kind === 'frame' && e.frame.type === 'session_settled');
    const file = String(hub.get(created.id)?.meta().sessionFile);
    const res = await call({ path: `/api/conversation?file=${encodeURIComponent(file)}` });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.messages.map((/** @type {any} */ m) => m.role), ['user', 'assistant']);

    const outside = join(cwd, 'state', 'not-a-journal.jsonl');
    await Bun.write(outside, 'secret');
    assert.equal((await call({ path: `/api/conversation?file=${encodeURIComponent(outside)}` })).status, 400);
    assert.equal((await call({ path: `/api/conversation?file=${encodeURIComponent(join(journalsDir(), 'missing.jsonl'))}` })).status, 404);
    assert.equal((await call({ path: '/api/conversation?file=x', auth: false })).status, 401);
    await call({ method: 'DELETE', path: `/api/sessions/${created.id}` });
  });

  test('a window being used keeps its session awake (POST seen); an unknown session is a 404', async () => {
    const created = (await call({ method: 'POST', path: '/api/sessions', body: { cwd } })).json.session;
    assert.equal((await call({ method: 'POST', path: `/api/sessions/${created.id}/seen` })).status, 204);
    assert.equal((await call({ method: 'POST', path: '/api/sessions/nope/seen' })).status, 404);
    await call({ method: 'DELETE', path: `/api/sessions/${created.id}` });
  });
});

describe('session archive', () => {
  const sessionsDir = () => join(cwd, 'omp-sessions', '-p');
  const archiveDir = () => join(cwd, 'state', 'archive', 'sessions', '-p');
  /** A journal the Sessions window lists, with a subagent folder beside it. @param {string} name */
  async function pastSession(name) {
    const file = join(sessionsDir(), `${name}.jsonl`);
    const lines = [
      { type: 'session', version: 3, id: name, timestamp: '2026-10-01T10:00:00.000Z', cwd },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: `work on ${name}` }] } },
    ];
    await Bun.write(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    await Bun.write(join(sessionsDir(), name, 'Explorer.jsonl'), '');
    return file;
  }
  /** @param {boolean} [archived] */
  const ids = async (archived = false) =>
    (await call({ path: `/api/history${archived ? '?archived=1' : ''}` })).json.sessions.map((/** @type {any} */ s) => s.id).sort();

  test('like every API route, archive and restore need the token and the page’s Origin', async () => {
    const file = await pastSession('guarded');
    for (const path of ['/api/history/archive', '/api/history/restore']) {
      assert.equal((await call({ method: 'POST', path, body: { file }, auth: false })).status, 401);
      assert.equal((await call({ method: 'POST', path, body: { file }, origin: false })).status, 403);
      assert.equal((await call({ method: 'POST', path, body: { file }, headers: { origin: 'http://evil.example' } })).status, 403);
    }
    assert.ok(await Bun.file(file).exists(), 'nothing moved');
    await rm(file);
    await rm(join(sessionsDir(), 'guarded'), { recursive: true });
  });

  test('an archived session leaves the list for the archived list, and restore brings it back', async () => {
    const file = await pastSession('shelved');
    const archived = await call({ method: 'POST', path: '/api/history/archive', body: { file } });
    assert.equal(archived.status, 200);
    assert.equal(archived.json.file, join(archiveDir(), 'shelved.jsonl'));
    assert.ok(await Bun.file(join(archiveDir(), 'shelved', 'Explorer.jsonl')).exists(), 'its folder went with it');
    assert.ok(!(await Bun.file(file).exists()));
    assert.ok(!(await ids()).includes('shelved'));
    assert.ok((await ids(true)).includes('shelved'));

    const restored = await call({ method: 'POST', path: '/api/history/restore', body: { file: archived.json.file } });
    assert.deepEqual(restored.json, { file });
    assert.ok((await ids()).includes('shelved'));
    assert.ok(!(await ids(true)).includes('shelved'));
  });

  test('an archived conversation can be read but not resumed', async () => {
    const file = await pastSession('readonly');
    const { json } = await call({ method: 'POST', path: '/api/history/archive', body: { file } });
    const read = await call({ path: `/api/conversation?file=${encodeURIComponent(json.file)}` });
    assert.equal(read.status, 200);
    assert.equal(read.json.archived, true);
    assert.equal((await call({ path: `/api/conversation?file=${encodeURIComponent((await pastSession('current')))}` })).json.archived, false);
    const resumed = await call({ method: 'POST', path: '/api/sessions', body: { cwd, resume: json.file } });
    assert.equal(resumed.status, 409);
    assert.match(resumed.json.error, /archived/);
  });

  test('restore refuses to replace a journal that is back at the same place', async () => {
    const file = await pastSession('twice');
    const { json } = await call({ method: 'POST', path: '/api/history/archive', body: { file } });
    await Bun.write(file, 'newer');
    const res = await call({ method: 'POST', path: '/api/history/restore', body: { file: json.file } });
    assert.equal(res.status, 409);
    assert.match(res.json.error, /already there, not replaced/);
    assert.equal(await Bun.file(file).text(), 'newer');
    assert.ok(await Bun.file(json.file).exists());
  });

  test('a conversation whose agent works is not archived until it is done; one idle goes to sleep and moves', async () => {
    const file = await pastSession('busy');
    const { json } = await call({ method: 'POST', path: '/api/sessions', body: { cwd, resume: file } });
    const id = json.session.id;
    await waitForStatus(id, 'ready');
    const from = hub.since(0).length;
    await call({ method: 'POST', path: `/api/sessions/${id}/rpc`, body: { type: 'prompt', message: 'slow' } });
    await logged((e) => e.seq > from && e.session === id && e.kind === 'frame' && e.frame.type === 'agent_start');
    const refused = await call({ method: 'POST', path: '/api/history/archive', body: { file } });
    assert.equal(refused.status, 409);
    assert.match(refused.json.error, /working/);
    assert.ok(await Bun.file(file).exists());

    await logged((e) => e.seq > from && e.session === id && e.kind === 'frame' && e.frame.type === 'session_settled');
    assert.equal((await call({ method: 'POST', path: '/api/history/archive', body: { file } })).status, 200);
    assert.equal(hub.get(id)?.meta().status, 'exited', 'asleep before its journal moved');
  });

  test('only journals the Sessions window lists can move: traversal and other paths are refused', async () => {
    const file = await pastSession('kept');
    const token = join(cwd, 'state', 'token-like.jsonl');
    await Bun.write(token, 'secret');
    /** @type {Array<[string, unknown]>} */
    const refused = [
      ['/api/history/archive', join(sessionsDir(), '..', '..', 'state', 'token-like.jsonl')],
      ['/api/history/archive', `${sessionsDir()}/../../state/token-like.jsonl`],
      ['/api/history/archive', join(sessionsDir(), 'kept', 'Explorer.jsonl')],
      ['/api/history/archive', join(archiveDir(), 'shelved.jsonl')],
      ['/api/history/archive', 'kept.jsonl'],
      ['/api/history/archive', { path: file }],
      ['/api/history/restore', file],
      ['/api/history/restore', join(archiveDir(), '..', '..', '..', 'token-like.jsonl')],
    ];
    for (const [path, target] of refused) {
      const res = await call({ method: 'POST', path, body: { file: target } });
      assert.equal(res.status, 400, `${path} ${JSON.stringify(target)}`);
    }
    assert.equal((await call({ method: 'POST', path: '/api/history/archive', raw: 'nope', headers: { 'content-type': 'application/json' } })).status, 400);
    assert.equal((await call({ method: 'POST', path: '/api/history/archive', body: { file: join(sessionsDir(), 'gone.jsonl') } })).status, 404);
    assert.equal(await Bun.file(token).text(), 'secret');
    assert.ok(await Bun.file(file).exists());
  });
});

describe('attachments', () => {
  test('an attached file is stored, owner-only and intact, at a path omp can read', async () => {
    const headers = { 'x-file-name': encodeURIComponent('Screen Shot 1.png') };
    const first = await call({ method: 'POST', path: '/api/attachments', headers, raw: 'PNG one' });
    const second = await call({ method: 'POST', path: '/api/attachments', headers, raw: 'PNG two' });
    assert.equal(first.status, 201);
    const dir = join(cwd, 'state', 'attachments');
    assert.match(first.json.path, new RegExp(`^${dir}/\\d{4}-\\d\\d-\\d\\d/[a-z0-9]+-Screen-Shot-1\\.png$`));
    assert.notEqual(first.json.path, second.json.path, 'the same name twice is two files');
    assert.equal(await Bun.file(first.json.path).text(), 'PNG one');
    assert.equal(await Bun.file(second.json.path).text(), 'PNG two');
    assert.equal((await stat(first.json.path)).mode & 0o777, 0o600);
    assert.equal((await call({ path: '/api/attachments' })).status, 405);
  });
});

describe('file listings for @ mentions', () => {
  /** @type {string} */
  let project;
  /** @type {string} */
  let files;

  beforeAll(async () => {
    project = join(cwd, 'listing', 'project');
    await mkdir(join(project, 'src'), { recursive: true });
    await Bun.write(join(project, 'notes with space.md'), 'notes');
    await Bun.write(join(project, '.env'), 'X=1');
    await Bun.write(join(cwd, 'listing', 'sibling.txt'), 'hi');
    await symlink(join(project, 'src'), join(project, 'linked'));
    files = '/api/files';
  });

  /** A folder named as an agent window names it: from the conversation's directory. @param {string} dir */
  const list = (dir) => call({ path: `${files}?dir=${encodeURIComponent(`${project}/${dir}`)}` });

  test('like every API route, listings need the token and refuse a foreign page', async () => {
    assert.equal((await call({ path: files, auth: false })).status, 401);
    assert.equal((await call({ path: files, headers: { origin: 'http://evil.example' } })).status, 403);
    assert.equal((await call({ path: files, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  });

  test('a folder in the conversation’s directory is listed, dotfiles and links to folders included', async () => {
    const res = await list('');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, {
      dir: project,
      entries: [
        { name: '.env', isDir: false },
        { name: 'linked', isDir: true },
        { name: 'notes with space.md', isDir: false },
        { name: 'src', isDir: true },
      ],
      truncated: false,
    });
    assert.deepEqual((await list('src/')).json, { dir: join(project, 'src'), entries: [], truncated: false });
  });

  test('a path may leave the conversation’s directory: up, from home, or absolute', async () => {
    const up = await list('../');
    assert.equal(up.json.dir, join(cwd, 'listing'));
    assert.deepEqual(up.json.entries, [
      { name: 'project', isDir: true },
      { name: 'sibling.txt', isDir: false },
    ]);
    assert.equal((await call({ path: `${files}?dir=${encodeURIComponent('~/')}` })).json.dir, homedir());
  });

  test('an image or data file is served for a reply to show, never run as a page; anything else is a 404', async () => {
    const png = join(cwd, 'images', 'chart.png');
    await Bun.write(png, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    const served = (/** @type {string} */ path) => call({ path: `/api/file?path=${encodeURIComponent(path)}` });
    const shown = await served(png);
    assert.equal(shown.status, 200);
    assert.equal(shown.headers.get('content-type'), 'image/png');
    assert.match(shown.headers.get('content-security-policy') ?? '', /sandbox/);
    assert.equal(shown.headers.get('cache-control'), 'no-store', 'redrawn under the same name, it shows anew');
    const series = join(cwd, 'images', 'series.json');
    await Bun.write(series, '[{"p90": 10}]');
    assert.equal((await served(series)).headers.get('content-type'), 'application/json', 'a chart reads its data the same way');
    assert.equal((await served(join(project, 'notes with space.md'))).status, 404);
    assert.equal((await served(join(project, 'missing.png'))).status, 404);
    assert.equal((await call({ path: `/api/file?path=${encodeURIComponent(png)}`, auth: false })).status, 401);
    assert.equal((await call({ path: `/api/file?path=${encodeURIComponent(png)}`, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  });

  test('a relative folder is listed from home, as a new session’s directory is found', async () => {
    const fromHome = (/** @type {string} */ dir) => call({ path: `/api/files?dir=${encodeURIComponent(dir)}` });
    assert.equal((await fromHome('')).json.dir, homedir());
    assert.equal((await fromHome('~/')).json.dir, homedir());
    assert.equal((await fromHome(relative(homedir(), project))).json.dir, project);
    assert.deepEqual((await fromHome(`${project}/`)).json.entries, (await list('')).json.entries);
    assert.equal((await fromHome(join(project, 'missing'))).status, 404);
    assert.equal((await call({ path: '/api/files', auth: false })).status, 401);
    assert.equal((await call({ path: '/api/files', headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);

    const created = await call({ method: 'POST', path: '/api/sessions', body: { cwd: relative(homedir(), project) } });
    assert.equal(created.status, 201);
    assert.equal(created.json.session.cwd, project);
  });

  test('what is not a folder is a 404', async () => {
    assert.equal((await list('notes with space.md')).status, 404);
    assert.equal((await list('missing/')).status, 404);
  });

  test('a huge folder is cut short by name, and says so', async () => {
    assert.deepEqual(await listDirectory(project, 2), {
      entries: [
        { name: '.env', isDir: false },
        { name: 'linked', isDir: true },
      ],
      truncated: true,
    });
  });
});

describe('GitHub', () => {
  /** A checkout of acme/widgets, as the fake gh finds it (tests/fixtures/fake-gh.js). */
  let repo = '';
  const finding = '### Off by one\n\n**Low Severity**\n\n<!-- DESCRIPTION START -->\nThe loop stops a line early.\n<!-- DESCRIPTION END -->\n\n<!-- LOCATIONS START\nsrc/app.js#L3-L7\nLOCATIONS END -->';

  beforeAll(async () => {
    // Checked out where the fake gh finds a repository named outright, as gh finds any on GitHub.
    process.env.FAKE_GH_ROOT = join(cwd, 'github');
    repo = join(cwd, 'github', 'acme', 'widgets');
    await mkdir(join(repo, 'src'), { recursive: true });
    await Bun.write(
      join(repo, '.fake-gh.json'),
      JSON.stringify({
        repo: 'acme/widgets',
        pulls: [
          {
            number: 12,
            title: 'feat: pull request window',
            state: 'OPEN',
            isDraft: false,
            author: 'octo',
            headRefName: 'feat/pr',
            baseRefName: 'main',
            body: 'Adds a window.',
            createdAt: '2026-11-01T09:00:00Z',
            updatedAt: '2026-11-02T09:00:00Z',
            additions: 1,
            deletions: 1,
            comments: [{ author: 'hubot', body: 'Nice', createdAt: '2026-11-01T10:00:00Z', url: 'https://github.com/acme/widgets/pull/12#issuecomment-1' }],
            reviews: [],
            diff: 'diff --git a/src/app.js b/src/app.js\n--- a/src/app.js\n+++ b/src/app.js\n@@ -1,1 +1,1 @@\n-old\n+new\n',
            reviewComments: [{ id: 9, user: { login: 'octo' }, body: 'Why?', path: 'src/app.js', line: 1, start_line: null, side: 'RIGHT', in_reply_to_id: null, created_at: '2026-11-01T11:00:00Z', html_url: 'u' }],
          },
          { number: 7, title: 'docs: readme', state: 'MERGED', isDraft: false, author: 'octo', headRefName: 'docs', url: '', updatedAt: '' },
        ],
        bugbot: { afterMs: 300, body: '<!-- BUGBOT_REVIEW -->\nCursor Bugbot has reviewed your changes and found 1 potential issue.', comments: [{ body: finding, path: 'src/app.js', line: 7, start_line: 3 }] },
      }),
    );
  });

  /** The prompts the daemon sent session `id`. @param {string} id */
  const prompts = (id) => forSession(hub.since(0), id).flatMap((e) => (e.kind === 'sent' && e.command.type === 'prompt' && e.command.message !== '/rename' ? [e.command] : []));

  test('a directory in a GitHub repository lists its pull requests, from any folder of the checkout', async () => {
    const listed = await call({ path: `/api/github/pulls?cwd=${encodeURIComponent(join(repo, 'src'))}` });
    assert.equal(listed.status, 200);
    assert.equal(listed.json.connected, true);
    assert.deepEqual(
      listed.json.pulls.map((/** @type {any} */ p) => [p.number, p.title, p.state, p.author, p.url]),
      [
        [12, 'feat: pull request window', 'OPEN', 'octo', 'https://github.com/acme/widgets/pull/12'],
        [7, 'docs: readme', 'MERGED', 'octo', 'https://github.com/acme/widgets/pull/7'],
      ],
    );
  });

  test('a directory in no repository lists none, and says why in gh’s words', async () => {
    const elsewhere = join(cwd, 'not-a-repo');
    await mkdir(elsewhere, { recursive: true });
    const listed = await call({ path: `/api/github/pulls?cwd=${encodeURIComponent(elsewhere)}` });
    assert.equal(listed.status, 200);
    assert.equal(listed.json.connected, false);
    assert.match(listed.json.reason, /not a git repository/);
  });

  test('the repository a directory is in names its owner’s others, most recently pushed first, whose pull requests list by name', async () => {
    const gadgets = join(cwd, 'github', 'acme', 'gadgets');
    await mkdir(gadgets, { recursive: true });
    await Bun.write(join(gadgets, '.fake-gh.json'), JSON.stringify({ repo: 'acme/gadgets', description: 'Gadgets', pushedAt: '2099-01-01T00:00:00Z', pulls: [{ number: 3, title: 'feat: gadget', state: 'OPEN', isDraft: true, author: 'octo', headRefName: 'g', updatedAt: '' }] }));
    const repos = await call({ path: `/api/github/repos?cwd=${encodeURIComponent(join(repo, 'src'))}` });
    assert.equal(repos.status, 200);
    assert.deepEqual(repos.json, { connected: true, repo: 'acme/widgets', repos: [{ repo: 'acme/gadgets', description: 'Gadgets' }, { repo: 'acme/widgets', description: '' }] });
    const listed = await call({ path: '/api/github/pulls?repo=acme/gadgets' });
    assert.deepEqual(listed.json.pulls.map((/** @type {any} */ p) => [p.number, p.title, p.isDraft]), [[3, 'feat: gadget', true]]);
    assert.equal((await call({ path: '/api/github/pulls?repo=..%2Fx' })).status, 400);
    const elsewhere = await call({ path: `/api/github/repos?cwd=${encodeURIComponent(cwd)}` });
    assert.equal(elsewhere.json.connected, false);
  });

  test('a missing gh lists none, saying where to get it', async () => {
    const missing = createGithub({ ghPath: join(cwd, 'no-such-gh') });
    const listed = await missing.pulls({ cwd: repo });
    assert.equal(listed.connected, false);
    assert.match(listed.connected ? '' : listed.reason, /cli\.github\.com/);
  });

  test('one pull request reads with its conversation, its line comments and its diff', async () => {
    const read = await call({ path: `/api/github/pull?cwd=${encodeURIComponent(repo)}&number=12` });
    assert.equal(read.status, 200);
    assert.equal(read.json.repo, 'acme/widgets');
    assert.equal(read.json.baseRefName, 'main');
    assert.deepEqual(read.json.comments.map((/** @type {any} */ c) => [c.author, c.body]), [['hubot', 'Nice']]);
    assert.deepEqual(read.json.reviewComments.map((/** @type {any} */ c) => [c.author, c.path, c.side, c.line, c.inReplyTo]), [['octo', 'src/app.js', 'RIGHT', 1, null]]);
    assert.match(read.json.diff, /^diff --git a\/src\/app.js/);
    assert.equal(read.json.diffTruncated, false);
    assert.equal((await call({ path: `/api/github/pull?cwd=${encodeURIComponent(repo)}&number=99` })).status, 502);
    assert.equal((await call({ path: `/api/github/pull?cwd=${encodeURIComponent(repo)}&number=x` })).status, 400);
  });

  test('a pull request named by its repository reads wherever that is checked out, or not at all', async () => {
    const read = await call({ path: '/api/github/pull?repo=acme/widgets&number=12' });
    assert.equal(read.status, 200);
    assert.equal(read.json.title, 'feat: pull request window');
    assert.match(read.json.diff, /^diff --git a\/src\/app.js/);
    assert.equal((await call({ path: '/api/github/pull?repo=acme/missing&number=12' })).status, 502);
    for (const bad of ['../x', 'acme/..', '-R/x', 'acme', 'a/b/c']) {
      assert.equal((await call({ path: `/api/github/pull?repo=${encodeURIComponent(bad)}&number=12` })).status, 400, bad);
    }
  });

  test('a message delivered to an asleep conversation wakes it from its journal and reaches the agent, after its turn', async () => {
    const journal = join(cwd, 'deliver-asleep.jsonl');
    await Bun.write(journal, `${JSON.stringify({ type: 'session', version: 3, id: 'deliver-asleep', timestamp: '2026-10-01T10:00:00.000Z', cwd })}\n`);
    const sent = await call({ method: 'POST', path: '/api/deliver', body: { target: { sessionFile: journal, session: null, cwd }, message: 'My review of PR #12' } });
    assert.equal(sent.status, 202);
    const meta = hub.get(sent.json.session)?.meta();
    assert.equal(meta?.resume, journal);
    assert.deepEqual(prompts(sent.json.session), [{ type: 'prompt', message: 'My review of PR #12', streamingBehavior: 'followUp', id: prompts(sent.json.session)[0]?.id }]);
    await call({ method: 'DELETE', path: `/api/sessions/${sent.json.session}` });
  });

  test('a message delivered to an awake conversation goes to the session holding it; one that is gone is a 404', async () => {
    const { json } = await call({ method: 'POST', path: '/api/sessions', body: { cwd } });
    const ready = await waitForStatus(json.session.id, 'ready');
    const sent = await call({ method: 'POST', path: '/api/deliver', body: { target: { sessionFile: ready.sessionFile, session: ready.id, cwd }, message: 'hello there' } });
    assert.equal(sent.status, 202);
    assert.equal(sent.json.session, ready.id);
    assert.deepEqual(prompts(ready.id).map((p) => p.message), ['hello there']);
    await call({ method: 'DELETE', path: `/api/sessions/${ready.id}` });

    const gone = await call({ method: 'POST', path: '/api/deliver', body: { target: { sessionFile: join(cwd, 'missing.jsonl'), session: null, cwd }, message: 'x' } });
    assert.equal(gone.status, 404);
    assert.equal((await call({ method: 'POST', path: '/api/deliver', body: { target: { cwd }, message: 'x' } })).status, 400);
    assert.equal((await call({ method: 'POST', path: '/api/deliver', body: { target: { session: ready.id, cwd }, message: ' ' } })).status, 400);
  });

  test('Bugbot is asked with `bugbot go`, and its review, findings and places, reaches the conversation; every page hears how it went', async () => {
    const { json } = await call({ method: 'POST', path: '/api/sessions', body: { cwd } });
    const ready = await waitForStatus(json.session.id, 'ready');
    const stream = await openStream();
    const asked = await call({ method: 'POST', path: '/api/github/bugbot', body: { repo: 'acme/widgets', number: 12, target: { sessionFile: ready.sessionFile, session: ready.id, cwd } } });
    assert.equal(asked.status, 201);
    assert.equal(asked.json.status, 'watching');
    assert.equal(asked.json.url, 'https://github.com/acme/widgets/pull/12');
    const commented = JSON.parse(await Bun.file(join(repo, '.fake-gh.json')).text()).issueComments;
    assert.deepEqual(commented.map((/** @type {any} */ c) => [c.number, c.body]), [[12, 'bugbot go']]);

    const { events } = await stream.until((events) => events.some((e) => e.kind === 'bugbot' && e.watches.some((w) => w.id === asked.json.id && w.status === 'delivered')));
    assert.ok(events.some((e) => e.kind === 'bugbot' && e.watches.some((w) => w.id === asked.json.id && w.status === 'watching')));
    const [prompt] = prompts(ready.id);
    assert.equal(prompt.streamingBehavior, 'followUp');
    assert.match(prompt.message, /^Cursor Bugbot reviewed PR #12 \(https:\/\/github.com\/acme\/widgets\/pull\/12\): Cursor Bugbot has reviewed your changes and found 1 potential issue\./);
    assert.match(prompt.message, /1\. \*\*Off by one\*\* \(Low Severity\), `src\/app.js#L3-L7`\n\nThe loop stops a line early\./);
    await Bun.sleep(350); // three more polls (every 100 ms here)
    assert.equal(prompts(ready.id).length, 1, 'sent once, however many polls follow');
    await call({ method: 'DELETE', path: `/api/sessions/${ready.id}` });
  });

  test('watches outlive the daemon: the next one reads them from its file', async () => {
    const next = await loadBugbot({ file: join(cwd, 'state', 'bugbot.json'), github, delivery, pollMs: 60_000 });
    assert.deepEqual(next.all(), bugbot.all());
    next.stop();
  });
});

/** A new session the daemon started, once it is ready. */
async function readySession() {
  const { json } = await call({ method: 'POST', path: '/api/sessions', body: { cwd } });
  await waitForStatus(json.session.id, 'ready');
  return /** @type {string} */ (json.session.id);
}

/** The seqs of session `id`'s events in the daemon's log now. @param {string} id */
const loggedSeqs = (id) => forSession(hub.since(0), id).map((e) => e.seq);

describe('session activity', () => {
  test('every page hears how each awake session is doing: first thing, then on each change, and null once it ended', async () => {
    const id = await readySession();
    const first = await readStream({ done: (events) => events.some((e) => e.kind === 'hello') });
    const hello = first.events.find((e) => e.kind === 'hello');
    assert.deepEqual(hello?.kind === 'hello' && hello.activity[id], { working: false, asking: false, work: 0, name: null });

    const stream = await openStream();
    await rpc(id, { type: 'prompt', message: 'ask me' });
    const asked = await logged((e) => e.session === id && e.kind === 'frame' && e.frame.method === 'ask');
    assert.ok(asked.kind === 'frame');
    assert.equal((await call({ method: 'POST', path: `/api/sessions/${id}/ui`, body: { id: asked.frame.id, cancelled: true } })).status, 204);
    await logged((e) => e.session === id && e.kind === 'frame' && e.frame.type === 'agent_end');
    await call({ method: 'DELETE', path: `/api/sessions/${id}` });
    const { events } = await stream.until((events) => events.some((e) => e.kind === 'activity' && e.session === id && e.activity === null));
    const changes = events.flatMap((e) => (e.kind === 'activity' && e.session === id ? [e.activity] : []));
    assert.ok(changes.some((a) => a?.working && !a.asking), 'working');
    assert.ok(changes.some((a) => a?.working && a.asking), 'asking');
    const done = changes.at(-2);
    assert.deepEqual({ working: done?.working, asking: done?.asking, work: done?.work }, { working: false, asking: false, work: 0 });
    assert.equal(typeof done?.name, 'string', 'named by its first prompt, or the title omp gave it');
    for (let i = 1; i < changes.length; i++) assert.notDeepEqual(changes[i], changes[i - 1], 'only changes are told');
    assert.equal(id in hub.activity(), false);
  });
});

describe('scoped event stream', () => {
  let followed = '';
  let other = '';
  beforeAll(async () => {
    [followed, other] = await Promise.all([readySession(), readySession()]);
    for (const id of [followed, other]) {
      await rpc(id, { type: 'prompt', message: 'hello' });
      await logged((e) => e.session === id && e.kind === 'frame' && e.frame.type === 'agent_end');
    }
  });
  afterAll(async () => {
    for (const id of [followed, other]) await call({ method: 'DELETE', path: `/api/sessions/${id}` });
  });

  test('only followed sessions are replayed; live, every session’s metas arrive, and only followed sessions’ other events', async () => {
    const replayed = loggedSeqs(followed);
    const last = /** @type {number} */ (replayed.at(-1));
    const stream = await openStream({ query: `?follow=${followed}:0` });
    const started = await readySession();
    await rpc(followed, { type: 'prompt', message: 'hello again' });
    const ended = await logged((e) => e.seq > last && e.session === followed && e.kind === 'frame' && e.frame.type === 'agent_end');
    const { events } = await stream.until((events) => forSession(events, followed).some((e) => e.seq === ended.seq));
    assert.deepEqual(forSession(events, followed).map((e) => e.seq).filter((seq) => seq <= last), replayed, 'the followed session’s whole history');
    assert.deepEqual(forSession(events, other), [], 'nothing of a session not followed');
    const news = forSession(events, started);
    assert.ok(news.some((e) => e.kind === 'session' && e.meta.status === 'ready'), 'a new session’s metas');
    assert.ok(news.every((e) => e.kind === 'session'), 'and nothing else of it');
    assert.ok(forSession(hub.since(0), started).some((e) => e.kind !== 'session'), 'though it had frames');
    await call({ method: 'DELETE', path: `/api/sessions/${started}` });
  });

  test('a followed session is replayed after its cursor, or after Last-Event-ID when that is later', async () => {
    const log = loggedSeqs(followed);
    const mid = log[Math.floor(log.length / 2)];
    const last = log.at(-1);
    /** The followed session's seqs a stream replays. @param {string} query @param {string} [lastEventId] */
    const replay = async (query, lastEventId) => {
      const { events } = await (await openStream({ query, lastEventId })).until((events) => forSession(events, followed).some((e) => e.seq === last));
      return forSession(events, followed).map((e) => e.seq);
    };
    const after = log.filter((seq) => seq > mid);
    assert.deepEqual(await replay(`?follow=${followed}:${mid}`), after);
    assert.deepEqual(await replay(`?follow=${followed}:0`, `${hub.bootId}:${mid}`), after);
    assert.deepEqual(await replay(`?follow=${followed}:${mid},${other}:${hub.latest()}`, `${hub.bootId}:1`), after, 'the later of the two');
    assert.deepEqual(await replay(`?follow=${followed}:0`, `another-boot:${mid}`), log, 'an id from another boot counts for nothing');
  });

  test('an empty follow sends no session’s events but metas; a malformed one is refused', async () => {
    for (const query of [`?follow=${followed}`, `?follow=${followed}:x`, `?follow=${followed}:1,`, '?follow=a b:1', `?follow=${followed}:-1`]) {
      assert.equal((await call({ path: `/api/stream${query}` })).status, 400, query);
    }
    const stream = await openStream({ query: '?follow=' });
    const started = await readySession();
    const { events } = await stream.until((events) => forSession(events, started).some((e) => e.kind === 'session' && e.meta.status === 'ready'));
    const sessionEvents = events.filter((e) => e.kind === 'session' || e.kind === 'frame' || e.kind === 'sent' || e.kind === 'stderr' || e.kind === 'garbled');
    assert.ok(sessionEvents.length > 0 && sessionEvents.every((e) => e.kind === 'session'));
    await call({ method: 'DELETE', path: `/api/sessions/${started}` });
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

describe('compression', () => {
  test('a large JSON answer is gzipped for a client that accepts it, and plain otherwise; a small one never is', async () => {
    const dir = join(cwd, 'omp-sessions', '-big');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'big.jsonl');
    const text = 'lorem ipsum dolor '.repeat(10_000);
    const lines = [
      { type: 'session', version: 3, id: 'big-one', timestamp: '2026-10-01T10:00:00.000Z', cwd },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } },
    ];
    await Bun.write(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    const path = `/api/conversation?file=${encodeURIComponent(file)}`;
    const zipped = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { cookie: `ac_token=${TOKEN}`, 'accept-encoding': 'gzip' }, decompress: false });
    assert.equal(zipped.status, 200);
    assert.equal(zipped.headers.get('content-encoding'), 'gzip');
    const bytes = await zipped.bytes();
    assert.ok(bytes.length < text.length / 10, `${bytes.length} bytes`);
    assert.ok(new TextDecoder().decode(Bun.gunzipSync(bytes)).includes(text));
    const plain = await call({ path, headers: { 'accept-encoding': 'identity' } });
    assert.equal(plain.headers.get('content-encoding'), null);
    assert.ok(plain.text.includes(text));
    const small = await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { cookie: `ac_token=${TOKEN}`, 'accept-encoding': 'gzip' }, decompress: false });
    assert.equal(small.headers.get('content-encoding'), null);
    assert.equal((await small.json()).home, cwd);
  });

  test('a data file a reply shows is streamed as it is read, never gzipped (it would be read whole first)', async () => {
    const file = join(cwd, 'chart-data.json');
    const body = JSON.stringify({ values: Array.from({ length: 20_000 }, (_, i) => ({ x: i, y: i * 2 })) });
    assert.ok(body.length > 128 * 1024);
    await Bun.write(file, body);
    const res = await fetch(`http://127.0.0.1:${port}/api/file?path=${encodeURIComponent(file)}`, {
      headers: { cookie: `ac_token=${TOKEN}`, 'accept-encoding': 'gzip' },
      decompress: false,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json');
    assert.equal(res.headers.get('content-encoding'), null);
    assert.equal(await res.text(), body);
  });
});
