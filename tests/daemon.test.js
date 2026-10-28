import { test, describe, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { createHistory } from '../daemon/history.js';
import { createHub } from '../daemon/hub.js';
import { createAttachments } from '../daemon/attachments.js';
import { createScratchpads } from '../daemon/scratchpad.js';
import { createWorkspaces } from '../daemon/workspace.js';
import { createDaemonServer } from '../daemon/server.js';
import { listDirectory } from '../daemon/files.js';
import { loadToken } from '../daemon/token.js';
import { loadUnread } from '../daemon/unread.js';
import { loadSettings } from '../daemon/settings.js';
import { loadPins } from '../daemon/pins.js';
import { APPEND_SYSTEM_PROMPT, HISTORY_COMMAND, SETUP_COMMANDS } from '../daemon/omp-session.js';
/** @import { RpcResponse, StreamEvent, SessionEvent, SessionMeta } from '../daemon/wire.js' */

const ROOT = resolve(import.meta.dir, '..');
const FAKE_OMP = join(ROOT, 'tests/fixtures/fake-omp.js');
const TOKEN = 'a'.repeat(64);

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
let port = 0;
let cwd = '';

/**
 * @param {{ method?: string, path: string, headers?: Record<string, string>, body?: unknown, raw?: string, auth?: boolean, origin?: boolean }} options
 * @returns {Promise<{ status: number, headers: Headers, text: string, json: any }>}
 */
async function call({ method = 'GET', path, headers = {}, body, raw, auth = true, origin = method !== 'GET' }) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      host: `127.0.0.1:${port}`,
      ...(auth ? { cookie: `ac_token=${TOKEN}` } : {}),
      ...(origin ? { origin: `http://127.0.0.1:${port}` } : {}),
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
 * suite's.
 * @param {{ lastEventId?: string, daemon?: number }} [options]
 */
async function openStream({ lastEventId, daemon = port } = {}) {
  /** @type {StreamEvent[]} */
  const events = [];
  /** @type {string[]} */
  const ids = [];
  const headers = { cookie: `ac_token=${TOKEN}`, ...(lastEventId ? { 'last-event-id': lastEventId } : {}) };
  const connection = new AbortController();
  const res = await fetch(`http://127.0.0.1:${daemon}/api/stream`, { headers, signal: connection.signal });
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
  /** @type {SessionEvent[]} */ (events.filter((e) => e.kind !== 'hello' && e.kind !== 'scratchpad' && e.kind !== 'history' && e.kind !== 'unread' && e.kind !== 'pins' && e.kind !== 'settings' && e.session === session));

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'ac-daemon-test-'));
  unread = await loadUnread({ file: join(cwd, 'state', 'unread.json') });
  settings = await loadSettings({ file: join(cwd, 'state', 'settings.json') });
  pins = await loadPins({ file: join(cwd, 'state', 'pins.json') });
  hub = createHub({ ompPath: FAKE_OMP, unread });
  server = createDaemonServer({
    hub,
    unread,
    pins,
    settings,
    history: createHistory({ root: join(cwd, 'omp-sessions'), archive: join(cwd, 'state', 'archive', 'sessions') }),
    scratchpads: createScratchpads({ dir: join(cwd, 'state', 'scratchpads') }),
    attachments: createAttachments({ dir: join(cwd, 'state', 'attachments') }),
    workspaces: createWorkspaces({ dir: join(cwd, 'state', 'workspaces') }),
    token: TOKEN,
    root: ROOT,
    config: { defaultCwd: cwd, home: cwd, scratchpadDir: join(cwd, 'state', 'scratchpads') },
    port: 0,
  });
  port = /** @type {number} */ (server.port);
});

afterAll(async () => {
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
    const seen = hub.since(0).length;
    const first = await readStream({ done: (_, ids) => ids.length >= seen });
    const last = /** @type {string} */ (first.ids.at(-1));
    assert.equal(last, `${hub.bootId}:${seen}`);

    const { json } = await call({ method: 'POST', path: '/api/sessions', body: { cwd } }); // something to miss
    await waitForStatus(json.session.id, 'ready');
    const missed = hub.since(seen).length;
    const resumed = await readStream({ lastEventId: last, done: (_, ids) => ids.length >= missed });
    assert.equal(resumed.events[0].kind, 'hello');
    assert.equal(resumed.ids[0], `${hub.bootId}:${seen + 1}`, 'nothing it had seen');

    const stale = await readStream({ lastEventId: `other-boot:${seen}`, done: (_, ids) => ids.length > 0 });
    assert.equal(stale.ids[0], `${hub.bootId}:1`, 'everything');
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
    const from = hub.since(0).length;
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
      settings,
      history: createHistory({ root: join(cwd, 'omp-sessions'), archive: join(cwd, 'state', 'archive', 'sessions') }),
      scratchpads: createScratchpads({ dir: join(cwd, 'state', 'scratchpads') }),
      attachments: createAttachments({ dir: join(cwd, 'state', 'attachments') }),
      workspaces: createWorkspaces({ dir: join(cwd, 'state', 'workspaces') }),
      token: TOKEN,
      root: ROOT,
      config: { defaultCwd: cwd, home: cwd, scratchpadDir: join(cwd, 'state', 'scratchpads') },
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
  test('every page hears them first thing and after each change, which the next daemon starts with', async () => {
    const stream = await openStream();
    const changed = await call({ method: 'PUT', path: '/api/settings', body: { idleCompaction: false } });
    assert.equal(changed.status, 200);
    assert.deepEqual(changed.json, { idleCompaction: false });
    const { events } = await stream.until((events) => events.some((e) => e.kind === 'settings'));
    assert.deepEqual(events[0].kind === 'hello' && events[0].settings, { idleCompaction: true });
    assert.deepEqual(events.find((e) => e.kind === 'settings'), { kind: 'settings', settings: { idleCompaction: false } });
    assert.deepEqual((await loadSettings({ file: join(cwd, 'state', 'settings.json') })).all(), { idleCompaction: false });
    assert.equal((await call({ method: 'PUT', path: '/api/settings', body: { idleCompaction: true } })).status, 200);
  });

  test('only known settings with values of their type are taken; like every API route they need the token and Origin', async () => {
    for (const body of [{ idleCompaction: 'no' }, { sleepy: true }, [true], null]) {
      assert.equal((await call({ method: 'PUT', path: '/api/settings', body })).status, 400, JSON.stringify(body));
    }
    assert.equal((await call({ method: 'PUT', path: '/api/settings', body: { idleCompaction: false }, auth: false })).status, 401);
    assert.equal((await call({ method: 'PUT', path: '/api/settings', body: { idleCompaction: false }, origin: false })).status, 403);
    assert.deepEqual(settings.all(), { idleCompaction: true });
  });

  test('a settings file the daemon cannot read stops it rather than being replaced', async () => {
    const file = join(cwd, 'bad-settings.json');
    await Bun.write(file, '{"version":1,"settings":{"idleCompaction":"off"}}');
    await assert.rejects(loadSettings({ file }), /not a settings file/);
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
   * @param {number} after
   */
  function sleepyHub(after) {
    const sleepy = createHub({ ompPath: FAKE_OMP, unread, sleepAfterMs: after });
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

  test('an image file is served for a reply to show, never run as a page; anything else is a 404', async () => {
    const png = join(cwd, 'images', 'chart.png');
    await Bun.write(png, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    const image = (/** @type {string} */ path) => call({ path: `/api/image?path=${encodeURIComponent(path)}` });
    const shown = await image(png);
    assert.equal(shown.status, 200);
    assert.equal(shown.headers.get('content-type'), 'image/png');
    assert.match(shown.headers.get('content-security-policy') ?? '', /sandbox/);
    assert.equal(shown.headers.get('cache-control'), 'no-store', 'redrawn under the same name, it shows anew');
    assert.equal((await image(join(project, 'notes with space.md'))).status, 404);
    assert.equal((await image(join(project, 'missing.png'))).status, 404);
    assert.equal((await call({ path: `/api/image?path=${encodeURIComponent(png)}`, auth: false })).status, 401);
    assert.equal((await call({ path: `/api/image?path=${encodeURIComponent(png)}`, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
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
