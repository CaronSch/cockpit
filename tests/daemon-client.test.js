import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { createDaemonClient } from '../src/daemon/client.js';
/** @import { SessionActivity, SessionEvent, SessionMeta, StreamEvent } from '../daemon/wire.js' */

/** A controllable stand-in for the browser's EventSource. */
class FakeSource {
  static CLOSED = 2;
  /** @type {FakeSource[]} */
  static opened = [];
  readyState = 0;
  /** @type {((message: { data: string }) => void) | null} */
  onmessage = null;
  /** @type {(() => void) | null} */
  onerror = null;
  /** @param {string} url */
  constructor(url) {
    this.url = url;
    FakeSource.opened.push(this);
  }
  /** @param {StreamEvent} event */
  deliver(event) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
  close() {
    this.readyState = FakeSource.CLOSED;
  }
}

/** @param {string} id @param {SessionMeta['status']} [status] @returns {SessionMeta} */
const meta = (id, status = 'ready') => ({ id, cwd: '/p', resume: null, fork: null, sessionFile: null, status, pid: 1, exitCode: null, error: null, startedAt: 0, ompId: null });

/** @param {string} session @param {number} seq @returns {SessionEvent} */
const frame = (session, seq) => ({ kind: 'frame', frame: { type: 'agent_start' }, seq, at: 0, session });

/** @param {string} bootId @param {SessionMeta[]} [sessions] @param {string} [ui] @param {Record<string, number>} [unread] @param {number} [seq] @param {Record<string, SessionActivity>} [activity] @returns {StreamEvent} */
const hello = (bootId, sessions = [], ui = 'v1', unread = {}, seq = 0, activity = {}) => ({
  kind: 'hello',
  bootId,
  seq,
  sessions,
  unread,
  pinned: [],
  forks: {},
  settings: { idleCompaction: true, decisionReview: false, adhd: false, browser: 'isolated', setupDone: true, remote: false },
  bugbot: [],
  login: null,
  ui,
  activity,
  remote: { state: 'off', error: null },
});

/** @param {Partial<SessionActivity>} a @returns {SessionActivity} */
const doing = (a) => ({ working: false, asking: false, work: 0, name: null, ...a });

/** Lets the client's queued work run (a scoped client reopens its stream at the end of a task). */
const tick = () => new Promise((r) => setImmediate(r));

/** The daemon's answer to POST /rpc: the id omp's response will carry on the stream. */
const accepted = () => new Response(JSON.stringify({ id: 'ac_7' }), { status: 202 });

/** @param {number} [status] @param {(url: string) => Response | Promise<Response> | null} [route] @param {{ scoped?: boolean }} [options] */
async function connectedClient(status = 200, route = () => null, options = {}) {
  FakeSource.opened = [];
  const client = createDaemonClient(
    {
      fetch: /** @type {typeof fetch} */ (async (/** @type {string} */ url) => route(url) ?? new Response('{}', { status })),
      EventSource: /** @type {typeof EventSource} */ (/** @type {unknown} */ (FakeSource)),
      setTimeout: /** @type {typeof setTimeout} */ (/** @type {unknown} */ (() => 0)),
    },
    options,
  );
  await tick();
  return { client, source: FakeSource.opened[0] };
}

describe('daemon client', () => {
  test('a session the stream told of first keeps the stream’s newer state over the create answer', async () => {
    /** @type {(res: Response) => void} */
    let answer = () => {};
    // The create answer is held while omp starts and the stream says it is ready.
    /** @type {Promise<Response>} */
    const held = new Promise((resolve) => (answer = resolve));
    const { client, source } = await connectedClient(200, (url) => (url === '/api/sessions' ? held : null));
    source.deliver(hello('b1'));
    const created = client.createSession({ cwd: '/p' });
    source.deliver({ kind: 'session', meta: meta('s1', 'starting'), seq: 1, at: 0, session: 's1' });
    source.deliver({ kind: 'session', meta: meta('s1', 'ready'), seq: 2, at: 0, session: 's1' });
    answer(new Response(JSON.stringify({ session: meta('s1', 'starting') }), { status: 201 }));
    assert.equal((await created).status, 'ready');
    assert.equal(client.meta('s1')?.status, 'ready', 'not set back to starting by the late answer');
  });

  test('a window that subscribes late first receives everything already seen for its session', async () => {
    const { client, source } = await connectedClient();
    source.deliver(hello('b1', [meta('s1')]));
    source.deliver(frame('s1', 1));
    source.deliver(frame('s2', 2));
    source.deliver(frame('s1', 3));

    /** @type {number[]} */
    const seen = [];
    client.subscribe('s1', (e) => seen.push(e.seq));
    source.deliver(frame('s1', 4));
    assert.deepEqual(seen, [1, 3, 4]);
  });

  test('a daemon restart clears old history and tells listeners before the new daemon’s events arrive', async () => {
    const { client, source } = await connectedClient();
    source.deliver(hello('b1', [meta('s1')]));
    source.deliver(frame('s1', 1));

    /** @type {string[]} */
    const order = [];
    client.onReset(() => order.push(`reset, s1 known: ${client.meta('s1') !== null}`));
    client.subscribe('s1', (e) => order.push(`event ${e.seq}`));
    order.length = 0; // drop the replayed backlog

    source.deliver(hello('b2'));
    assert.deepEqual(order, ['reset, s1 known: false']);
    /** @type {number[]} */
    const late = [];
    client.subscribe('s1', (e) => late.push(e.seq));
    assert.deepEqual(late, [], 'old events are not replayed into the new boot');
  });

  test('a reconnect to the same daemon keeps history', async () => {
    const { client, source } = await connectedClient();
    let resets = 0;
    client.onReset(() => resets++);
    source.deliver(hello('b1', [meta('s1')]));
    source.deliver(frame('s1', 1));
    source.deliver(hello('b1', [meta('s1')]));
    /** @type {number[]} */
    const seen = [];
    client.subscribe('s1', (e) => seen.push(e.seq));
    assert.equal(resets, 0);
    assert.deepEqual(seen, [1]);
  });

  test('events up to the hello’s seq are a replay of what happened before the page connected; later ones are live', async () => {
    const { client, source } = await connectedClient();
    source.deliver(hello('b1', [meta('s1')], 'v1', {}, 2));
    /** @type {boolean[]} */
    const replayed = [];
    client.subscribe('s1', (e) => replayed.push(client.replayed(e)));
    for (const seq of [1, 2, 3]) source.deliver(frame('s1', seq));
    assert.deepEqual(replayed, [true, true, false]);
    // A reconnect replays what the page missed while away: that is history too.
    source.deliver(hello('b1', [meta('s1')], 'v1', {}, 5));
    for (const seq of [4, 5, 6]) source.deliver(frame('s1', seq));
    assert.deepEqual(replayed.slice(3), [true, true, false]);
  });

  test('a page hears when the UI files it loaded stop being the ones served, and when they are again', async () => {
    let served = 'v1';
    const { client, source } = await connectedClient(200, (url) => (url === '/api/ui' ? Response.json({ version: served }) : null));
    /** @type {boolean[]} */
    const heard = [];
    client.onUiChange((outdated) => heard.push(outdated));
    source.deliver(hello('b1', [], 'v1')); // the files this page loaded
    source.deliver(hello('b1', [], 'v1')); // a reconnect: nothing changed
    served = 'v2';
    await client.checkUi(); // the files changed under the running daemon (a git pull)
    await client.checkUi(); // asked again: said once
    source.deliver(hello('b2', [], 'v3')); // a restart on newer files still
    source.deliver(hello('b3', [], 'v1')); // back on the files this page loaded
    assert.deepEqual(heard, [true, true, false]);
  });

  test('session metadata follows the stream', async () => {
    const { client, source } = await connectedClient();
    source.deliver(hello('b1', [meta('s1', 'starting')]));
    assert.equal(client.meta('s1')?.status, 'starting');
    source.deliver({ kind: 'session', meta: meta('s1', 'exited'), seq: 1, at: 0, session: 's1' });
    assert.equal(client.meta('s1')?.status, 'exited');
  });

  test('without the token cookie the client reports unauthorized and opens no stream', async () => {
    const { client, source } = await connectedClient(401);
    assert.equal(client.status(), 'unauthorized');
    assert.equal(source, undefined);
  });

  test('a command resolves with omp’s answer from the stream', async () => {
    const { client, source } = await connectedClient(200, (url) => (url.endsWith('/rpc') ? accepted() : null));
    source.deliver(hello('b1', [meta('s1')]));
    const answer = client.rpc('s1', { type: 'bash', command: 'sleep 9' });
    await new Promise((r) => setImmediate(r));
    source.deliver({ kind: 'frame', frame: { type: 'response', id: 'ac_6', command: 'get_state', success: true }, seq: 1, at: 0, session: 's1' });
    source.deliver({ kind: 'frame', frame: { type: 'response', id: 'ac_7', command: 'bash', success: true }, seq: 2, at: 0, session: 's1' });
    assert.equal((await answer).id, 'ac_7');
  });

  test('a command whose answer the stream delivered before the request returned resolves with it', async () => {
    /** @type {FakeSource | undefined} */
    let stream;
    const { client, source } = await connectedClient(200, (url) => {
      if (!url.endsWith('/rpc')) return null;
      stream?.deliver({ kind: 'frame', frame: { type: 'response', id: 'ac_7', command: 'get_state', success: true }, seq: 1, at: 0, session: 's1' });
      return accepted();
    });
    stream = source;
    source.deliver(hello('b1', [meta('s1')]));
    assert.equal((await client.rpc('s1', { type: 'get_state' })).command, 'get_state');
  });

  test('a command fails instead of hanging when omp exits before answering', async () => {
    const { client, source } = await connectedClient(200, (url) => (url.endsWith('/rpc') ? accepted() : null));
    source.deliver(hello('b1', [meta('s1')]));
    const answer = client.rpc('s1', { type: 'login', providerId: 'x' });
    await new Promise((r) => setImmediate(r));
    source.deliver({ kind: 'session', meta: meta('s1', 'exited'), seq: 1, at: 0, session: 's1' });
    await assert.rejects(answer, /the agent exited before answering/);
  });
});

describe('unread conversations', () => {
  test('come with every hello and every change, and every listener hears them', async () => {
    const { client, source } = await connectedClient();
    let heard = 0;
    client.onUnread(() => heard++);
    assert.equal(client.unreadSince('c1'), null, 'nothing before the daemon says');
    source.deliver(hello('b1', [], 'v1', { c1: 10 }));
    assert.equal(client.unreadSince('c1'), 10);
    source.deliver({ kind: 'unread', unread: { c2: 20 } });
    assert.equal(client.unreadSince('c1'), null, 'read elsewhere');
    assert.equal(client.unreadSince('c2'), 20);
    assert.equal(client.unreadSince(null), null, 'a session omp has not named yet is never unread');
    assert.equal(client.unreadSince('toString'), null, 'only the daemon’s own marks');
    assert.equal(heard, 2);
  });
});

describe('how sessions are doing and Phone access', () => {
  test('activity comes with every hello and every change, and every listener hears it', async () => {
    const { client, source } = await connectedClient();
    let heard = 0;
    client.onActivity(() => heard++);
    assert.equal(client.activity('s1'), null, 'nothing before the daemon says');
    source.deliver(hello('b1', [meta('s1')], 'v1', {}, 0, { s1: doing({ working: true, name: 'Fix it' }) }));
    assert.deepEqual(client.activity('s1'), doing({ working: true, name: 'Fix it' }));
    source.deliver({ kind: 'activity', session: 's1', activity: doing({ asking: true, work: 2 }) });
    assert.equal(client.activity('s1')?.asking, true);
    assert.equal(client.activity('s1')?.work, 2);
    source.deliver({ kind: 'activity', session: 's1', activity: null });
    assert.equal(client.activity('s1'), null, 'the session ended');
    /** @type {number[]} */
    const seen = [];
    client.subscribe('s1', (e) => seen.push(e.seq));
    assert.deepEqual(seen, [], 'not a session event');
    assert.equal(heard, 3);
  });

  test('Phone access’s state comes with every hello and every change', async () => {
    const { client, source } = await connectedClient();
    let heard = 0;
    client.onRemote(() => heard++);
    assert.equal(client.remote(), null, 'nothing before the daemon says');
    source.deliver(hello('b1'));
    assert.deepEqual(client.remote(), { state: 'off', error: null });
    source.deliver({ kind: 'remote', state: 'error', error: 'Tailscale is not running' });
    assert.deepEqual(client.remote(), { state: 'error', error: 'Tailscale is not running' });
    assert.equal(heard, 2);
  });

  test('its sign-in is asked of the daemon', async () => {
    const info = { state: 'on', error: null, url: 'http://100.64.0.1:4777/phone', login: 'owner@example.com', qr: '<svg/>' };
    const { client } = await connectedClient(200, (url) => (url === '/api/remote' ? Response.json(info) : null));
    assert.deepEqual(await client.remoteInfo(), info);
  });
});

describe('scoped client', () => {
  test('opens the stream following no session', async () => {
    const { source } = await connectedClient(200, () => null, { scoped: true });
    assert.equal(source.url, '/api/stream?follow=');
  });

  test('a subscribe follows the session from its start, reopening the stream once for all those of a task', async () => {
    const { client, source } = await connectedClient(200, () => null, { scoped: true });
    source.deliver(hello('b1', [meta('s1'), meta('s2')]));
    client.subscribe('s1', () => {});
    client.subscribe('s2', () => {});
    client.subscribe('s1', () => {});
    await tick();
    assert.equal(source.readyState, FakeSource.CLOSED);
    assert.deepEqual(
      FakeSource.opened.map((s) => s.url),
      ['/api/stream?follow=', '/api/stream?follow=s1:0,s2:0'],
    );
    client.subscribe('s1', () => {});
    await tick();
    assert.equal(FakeSource.opened.length, 2, 'a session followed already does not reopen it');
  });

  test('a reopen carries how far each session got, and nothing is delivered twice', async () => {
    const { client, source } = await connectedClient(200, () => null, { scoped: true });
    source.deliver(hello('b1', [meta('s1'), meta('s2')]));
    /** @type {number[]} */
    const s1 = [];
    client.subscribe('s1', (e) => s1.push(e.seq));
    await tick();
    const second = FakeSource.opened[1];
    second.deliver(hello('b1', [meta('s1'), meta('s2')], 'v1', {}, 2));
    second.deliver(frame('s1', 1));
    second.deliver(frame('s1', 2));
    /** @type {number[]} */
    const s2 = [];
    client.subscribe('s2', (e) => s2.push(e.seq));
    await tick();
    const third = FakeSource.opened[2];
    assert.equal(third.url, '/api/stream?follow=s1:2,s2:0');
    third.deliver(hello('b1', [meta('s1'), meta('s2')], 'v1', {}, 3));
    third.deliver(frame('s1', 2)); // already delivered on the last stream
    third.deliver(frame('s2', 3));
    third.deliver(frame('s1', 4));
    assert.deepEqual(s1, [1, 2, 4]);
    assert.deepEqual(s2, [3]);
    assert.equal(client.replayed(frame('s2', 3)), true, 'the new session’s history is a replay');
  });

  test('every session’s status follows the stream, but only followed sessions’ events are kept', async () => {
    const { client, source } = await connectedClient(200, () => null, { scoped: true });
    source.deliver(hello('b1', [meta('s1', 'starting')]));
    let heard = 0;
    client.onSessions(() => heard++);
    source.deliver({ kind: 'session', meta: meta('s1', 'ready'), seq: 1, at: 0, session: 's1' });
    assert.equal(client.meta('s1')?.status, 'ready');
    assert.equal(heard, 1);
    source.deliver(frame('s1', 2));
    /** @type {number[]} */
    const seen = [];
    client.subscribe('s1', (e) => seen.push(e.seq));
    assert.deepEqual(seen, [], 'nothing kept from before it was followed');
  });

  test('a daemon restart starts every followed session over', async () => {
    const { client, source } = await connectedClient(200, () => null, { scoped: true });
    source.deliver(hello('b1', [meta('s1')]));
    client.subscribe('s1', () => {});
    await tick();
    const second = FakeSource.opened[1];
    second.deliver(hello('b1', [meta('s1')]));
    second.deliver(frame('s1', 5));
    second.deliver(hello('b2'));
    /** @type {number[]} */
    const seen = [];
    client.subscribe('s1', (e) => seen.push(e.seq));
    second.deliver(frame('s1', 1));
    assert.deepEqual(seen, [1], 'the new daemon’s seqs are not taken for old ones');
  });

  test('an unscoped client keeps one stream with every session', async () => {
    const { client, source } = await connectedClient();
    source.deliver(hello('b1', [meta('s1')]));
    source.deliver(frame('s1', 1));
    /** @type {number[]} */
    const seen = [];
    client.subscribe('s1', (e) => seen.push(e.seq));
    await tick();
    assert.deepEqual(FakeSource.opened.map((s) => s.url), ['/api/stream']);
    assert.deepEqual(seen, [1]);
  });
});
