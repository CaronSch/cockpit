/**
 * Browser side of the daemon connection: one event stream per page, shared by every widget.
 *
 * Widgets subscribe per session and first receive everything still needed of it (see
 * omp/event-log.js), so a window mounted late (or after a reload) renders the same history as
 * one that was open all along. When the daemon restarts, its sessions are gone: buffers are cleared and
 * `onReset` listeners fire before any event from the new daemon is delivered.
 *
 * It keeps which conversations are unread (daemon/unread.js), pinned (daemon/pins.js) and forked from which (daemon/forks.js), the daemon's settings
 * (daemon/settings.js), its Bugbot watches (daemon/bugbot.js), the prompts agents scheduled (daemon/schedule.js), how each awake session is doing (`activity`) and whether
 * Phone access is on (`remote`), as the daemon last said: every window reads them here, so all of
 * them, and every page, agree. So are the decision reviews (daemon/decisions.js) of the conversations windows show,
 * asked for when a window first shows one, and again after a reconnect.
 *
 * A scoped client (the phone's, `useScopedDaemon`) hears only the sessions its windows subscribed
 * to since the page loaded, besides every session's status: subscribing to another reopens the
 * stream with how far it got in each (`?follow=<id>:<seq>,…`), so the daemon sends only what
 * is new to it, and nothing is delivered twice.
 *
 * `replayed` tells events the daemon replays on (re)connecting, which happened before this
 * page heard of them, from those happening now: the replay is everything up to the `hello`'s
 * seq. While a replay is still arriving (the `hello` says how many events it holds), `replaying`
 * is true, and `afterReplay` waits for its end, so a window draws a conversation once instead
 * of typing it out again event by event.
 *
 * It also tracks the UI files' version (see daemon/ui-files.js): the first one the daemon
 * reports is the code this page loaded, and `onUiChange` hears when the files served stop
 * being, or become again, those.
 *
 * Terminals (daemon/terminals.js) come on the same stream: every page hears which are running,
 * and the output of those its windows watch. Watching one has the daemon send its scrollback
 * first (`replay`), on this connection; a new connection (a reconnect, a daemon restart) watches
 * them again. What is typed into a terminal is sent one request at a time, keystrokes typed
 * meanwhile together, so it arrives in order.
 */
import { withoutSpent } from '../omp/event-log.js';
/** @import { BugbotWatch, Conversation, ConversationTarget, DaemonConfig, DirListing, HelloEvent, PastSession, Pull, PullList, RemoteInfo, RemoteState, RepoList, RpcResponse, ScheduledTask, Scratchpad, ScratchpadSummary, Screen, SessionActivity, SessionEvent, SessionMeta, StreamEvent, TerminalEvent, TerminalInfo, TextFile, Workspace } from '../../daemon/wire.js' */
/** @import { Tree } from '../layout/grid-model.js' */
/** @import { Unread } from '../../daemon/unread.js' */
/** @import { Pinned } from '../../daemon/pins.js' */
/** @import { Forks } from '../../daemon/forks.js' */
/** @import { DaemonSettings } from '../../daemon/settings.js' */
/** @import { Reviews } from '../omp/decisions.js' */
/** @import { LoginState, SetupStatus } from '../../daemon/setup.js' */
/** @typedef {{ ok: true, rev: string } | { ok: false, current: Scratchpad }} ScratchpadSave */
/** @typedef {{ ok: true, rev: number | null } | { ok: false, current: Screen | null }} ScreenSave */

/** @typedef {'connecting' | 'open' | 'down' | 'unauthorized'} ConnectionStatus */

const RECONNECT_MS = 1500;
const KEEPALIVE_MAX_BYTES = 60_000;

export class DaemonError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * @typedef {{
 *   status(): ConnectionStatus,
 *   onStatus(fn: (status: ConnectionStatus) => void): () => void,
 *   onReset(fn: () => void): () => void,
 *   subscribe(session: string, fn: (event: SessionEvent) => void): () => void,
 *   replayed(event: SessionEvent): boolean,
 *   replaying(): boolean,
 *   afterReplay(fn: () => void): void,
 *   meta(session: string): SessionMeta | null,
 *   sessions(): SessionMeta[],
 *   onSessions(fn: () => void): () => void,
 *   onHistory(fn: () => void): () => void,
 *   unreadSince(ompId: string | null): number | null,
 *   onUnread(fn: () => void): () => void,
 *   markRead(ompId: string, at: number): Promise<void>,
 *   markUnread(ompId: string): Promise<void>,
 *   isPinned(ompId: string | null): boolean,
 *   onPins(fn: () => void): () => void,
 *   pin(ompId: string, pinned: boolean): Promise<void>,
 *   forks(): Forks,
 *   onForks(fn: () => void): () => void,
 *   decisions(ompId: string | null): Reviews | null,
 *   onDecisions(fn: () => void): () => void,
 *   settings(): DaemonSettings | null,
 *   onSettings(fn: () => void): () => void,
 *   changeSettings(patch: Partial<DaemonSettings>): Promise<void>,
 *   history(query?: string, options?: { archived?: boolean }): Promise<PastSession[]>,
 *   ask(question: string): Promise<{ answer: string, sessions: PastSession[] }>,
 *   conversation(file: string): Promise<Conversation>,
 *   archivePastSession(file: string): Promise<string>,
 *   restorePastSession(file: string): Promise<string>,
 *   scratchpads(): Promise<ScratchpadSummary[]>,
 *   scratchpad(id: string): Promise<Scratchpad>,
 *   saveScratchpad(id: string, text: string, base: string, options?: { keepalive?: boolean }): Promise<ScratchpadSave>,
 *   deleteScratchpad(id: string): Promise<void>,
 *   uploadScratchpadFile(id: string, file: Blob, name: string): Promise<string>,
 *   uploadAttachment(file: Blob, name: string): Promise<string>,
 *   onScratchpad(fn: (id: string, pad: Scratchpad) => void): () => void,
 *   workspace(name: string): Promise<Workspace>,
 *   saveScreen(workspace: string, id: string, tree: Tree, base: number | null, options?: { keepalive?: boolean }): Promise<ScreenSave>,
 *   config(): Promise<DaemonConfig>,
 *   createSession(options: { cwd: string, resume?: string, fork?: string, prompt?: string }): Promise<SessionMeta>,
 *   seen(session: string): Promise<void>,
 *   end(session: string): Promise<void>,
 *   rpc(session: string, command: Record<string, unknown>): Promise<RpcResponse>,
 *   respondUi(session: string, response: Record<string, unknown>): Promise<void>,
 *   listFiles(dir: string): Promise<DirListing>,
 *   textFile(path: string): Promise<TextFile>,
 *   saveTextFile(path: string, text: string, base: string): Promise<{ ok: true, file: TextFile } | { ok: false, current: TextFile }>,
 *   onUiChange(fn: (outdated: boolean) => void): () => void,
 *   checkUi(): Promise<void>,
 *   pulls(at: { repo: string } | { cwd: string }): Promise<PullList>,
 *   repos(cwd: string): Promise<RepoList>,
 *   pull(at: { repo: string } | { cwd: string }, number: number): Promise<Pull>,
 *   deliver(target: ConversationTarget, message: string): Promise<string>,
 *   bugbot(): readonly BugbotWatch[],
 *   onBugbot(fn: () => void): () => void,
 *   askBugbot(request: { repo: string, number: number, target: ConversationTarget }): Promise<BugbotWatch>,
 *   schedule(): readonly ScheduledTask[],
 *   onSchedule(fn: () => void): () => void,
 *   editScheduled(id: string, patch: { prompt?: string, dueAt?: number }): Promise<ScheduledTask>,
 *   unschedule(id: string): Promise<void>,
 *   setup(): Promise<SetupStatus>,
 *   login(): LoginState | null,
 *   onLogin(fn: () => void): () => void,
 *   startLogin(provider?: string): Promise<void>,
 *   answerLogin(line: string): Promise<void>,
 *   cancelLogin(): Promise<void>,
 *   activity(session: string): SessionActivity | null,
 *   onActivity(fn: () => void): () => void,
 *   remote(): RemoteState | null,
 *   onRemote(fn: () => void): () => void,
 *   remoteInfo(): Promise<RemoteInfo>,
 *   terminals(): readonly TerminalInfo[],
 *   onTerminals(fn: () => void): () => void,
 *   startTerminal(options: { cwd: string, cols: number, rows: number }): Promise<TerminalInfo>,
 *   endTerminal(id: string): Promise<void>,
 *   watchTerminal(id: string, fn: (event: TerminalEvent) => void): () => void,
 *   typeInto(id: string, data: string, binary?: boolean): void,
 *   resizeTerminal(id: string, cols: number, rows: number): Promise<void>,
 * }} DaemonClient
 */

/** The browser globals the client uses, injectable for tests. @typedef {{ fetch: typeof fetch, EventSource: typeof EventSource, setTimeout: typeof setTimeout }} ClientEnv */

/**
 * @param {Partial<ClientEnv>} [env]
 * @param {{ scoped?: boolean }} [options] scoped: hear only the sessions subscribed to (see above)
 * @returns {DaemonClient}
 */
function createDaemonClient(env = {}, { scoped = false } = {}) {
  const { fetch: doFetch, EventSource: Source, setTimeout: later } = {
    fetch: globalThis.fetch.bind(globalThis),
    EventSource: globalThis.EventSource,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    ...env,
  };

  /** @type {ConnectionStatus} */
  let status = 'connecting';
  /** @type {string | null} */
  let bootId = null;
  /** The newest event's seq when this connection opened: the events up to it are a replay. */
  let replayedTo = 0;
  /** How many events of the replay this connection opened with are still to come. */
  let replayLeft = 0;
  /** Called once the replay is in. @type {Set<() => void>} */
  const replayWaiters = new Set();
  function replayDone() {
    const waiting = [...replayWaiters];
    replayWaiters.clear();
    for (const fn of waiting) fn();
  }
  /** Counts one replayed event in; the last one calls those waiting for the replay. */
  function replayArrived() {
    if (replayLeft > 0 && --replayLeft === 0) replayDone();
  }
  /** @type {Map<string, SessionEvent[]>} */
  const buffers = new Map();
  /** @type {Map<string, SessionMeta>} */
  const metas = new Map();
  /** @type {Map<string, Set<(event: SessionEvent) => void>>} */
  const subscribers = new Map();
  /**
   * Scoped: the sessions followed, each with the seq of the last of its events received (0
   * before any): where the stream picks it up when reopened. Never shrinks before a reload.
   * @type {Map<string, number>}
   */
  const cursors = new Map();
  /** The stream open now, if any. @type {EventSource | null} */
  let source = null;
  /** A reopen is due at the end of this task, for the sessions subscribed to in it. */
  let reopening = false;
  /** @type {Set<(status: ConnectionStatus) => void>} */
  const statusListeners = new Set();
  /** @type {Set<() => void>} */
  const resetListeners = new Set();
  /** @type {Set<() => void>} */
  const sessionListeners = new Set();
  /** @type {Set<(id: string, pad: Scratchpad) => void>} */
  const scratchpadListeners = new Set();
  /** @type {Set<() => void>} */
  const historyListeners = new Set();
  /** @type {Unread} */
  let unread = {};
  /** @type {Set<() => void>} */
  const unreadListeners = new Set();
  /** @param {Unread} marks */
  const setUnread = (marks) => {
    unread = marks;
    for (const fn of unreadListeners) fn();
  };
  /** @type {Set<string>} */
  let pinned = new Set();
  /** @type {Set<() => void>} */
  const pinsListeners = new Set();
  /** @param {Pinned} ids */
  const setPins = (ids) => {
    pinned = new Set(ids);
    for (const fn of pinsListeners) fn();
  };
  /** @type {Forks} */
  let forks = {};
  /** @type {Set<() => void>} */
  const forksListeners = new Set();
  /** @param {Forks} next */
  const setForks = (next) => {
    forks = next;
    for (const fn of forksListeners) fn();
  };
  /** Null until the daemon first says. @type {DaemonSettings | null} */
  let settings = null;
  /** @type {Set<() => void>} */
  const settingsListeners = new Set();
  /** @param {DaemonSettings} next */
  const setSettings = (next) => {
    settings = next;
    for (const fn of settingsListeners) fn();
  };
  /** @type {readonly BugbotWatch[]} */
  let watches = [];
  /** @type {Set<() => void>} */
  const bugbotListeners = new Set();
  /** @param {readonly BugbotWatch[]} next */
  const setWatches = (next) => {
    watches = next;
    for (const fn of bugbotListeners) fn();
  };
  /** @type {readonly ScheduledTask[]} */
  let scheduled = [];
  /** @type {Set<() => void>} */
  const scheduleListeners = new Set();
  /** @param {readonly ScheduledTask[]} next */
  const setScheduled = (next) => {
    scheduled = next;
    for (const fn of scheduleListeners) fn();
  };
  /** @type {LoginState | null} */
  let login = null;
  /** @type {Set<() => void>} */
  const loginListeners = new Set();
  /** @param {LoginState | null} next */
  const setLogin = (next) => {
    login = next;
    for (const fn of loginListeners) fn();
  };
  /** The decision reviews of the conversations asked about, by omp id. @type {Map<string, Reviews>} */
  const decisions = new Map();
  /** Conversations whose reviews are being asked for. @type {Set<string>} */
  const askingDecisions = new Set();
  /** @type {Set<() => void>} */
  const decisionsListeners = new Set();
  const decisionsChanged = () => {
    for (const fn of decisionsListeners) fn();
  };
  /** @type {Set<(outdated: boolean) => void>} */
  const uiListeners = new Set();
  /** The UI version this page loaded: the first one heard. @type {string | null} */
  let loadedUi = null;
  /** The UI version served, as last heard. @type {string | null} */
  let servedUi = null;
  /** @type {Promise<DaemonConfig> | null} */
  let config = null;
  /** How each awake session is doing, by session id. @type {Map<string, SessionActivity>} */
  let activities = new Map();
  /** @type {Set<() => void>} */
  const activityListeners = new Set();
  const activityChanged = () => {
    for (const fn of activityListeners) fn();
  };
  /** Null until the daemon first says. @type {RemoteState | null} */
  let remote = null;
  /** @type {Set<() => void>} */
  const remoteListeners = new Set();
  /** @param {RemoteState} next */
  const setRemote = (next) => {
    remote = next;
    for (const fn of remoteListeners) fn();
  };
  /** The terminals running, as the daemon last said. @type {readonly TerminalInfo[]} */
  let terminals = [];
  /** @type {Set<() => void>} */
  const terminalsListeners = new Set();
  /** @param {readonly TerminalInfo[]} next */
  const setTerminals = (next) => {
    terminals = next;
    for (const fn of terminalsListeners) fn();
  };
  /** What the stream open now is called, for watching terminals on it (`hello`'s `stream`). @type {string | null} */
  let streamId = null;
  /** The windows showing each terminal: they hear its output. @type {Map<string, Set<(event: TerminalEvent) => void>>} */
  const terminalViewers = new Map();
  /** What is waiting to be typed into each terminal, in pieces of one kind (`binary` or not). @type {Map<string, Array<{ data: string, binary: boolean }>>} */
  const typing = new Map();
  const terminalPath = (/** @type {string} */ id) => `/api/terminals/${encodeURIComponent(id)}`;
  /** Has the daemon send terminal `id`'s scrollback, then its output, on this page's stream. @param {string} id */
  function watchOn(id) {
    // A terminal that has ended is not watched (404): the list tells its windows so.
    if (streamId) request(`${terminalPath(id)}/watchers/${streamId}`, { method: 'PUT' }).catch(() => {});
  }
  /** Sends what waits to be typed into `id`, one request at a time, until nothing does. @param {string} id @param {Array<{ data: string, binary: boolean }>} queue */
  async function sendTyping(id, queue) {
    for (let next = queue[0]; next; next = queue[0]) {
      await request(`${terminalPath(id)}/input`, { method: 'POST', body: JSON.stringify(next) }).catch(() => {});
      queue.shift();
    }
    typing.delete(id);
  }
  const sessionsChanged = () => {
    for (const fn of sessionListeners) fn();
  };

  /** @param {unknown} version */
  function noteUi(version) {
    if (typeof version !== 'string' || version === servedUi) return;
    servedUi = version;
    if (loadedUi === null) loadedUi = version;
    else for (const fn of uiListeners) fn(version !== loadedUi);
  }

  /** @param {ConnectionStatus} next */
  function setStatus(next) {
    if (next === status) return;
    status = next;
    for (const fn of statusListeners) fn(next);
  }

  /** @param {HelloEvent} hello */
  function onHello(hello) {
    if (bootId !== null && hello.bootId !== bootId) {
      buffers.clear();
      metas.clear();
      config = null;
      // The new daemon's seqs start over.
      for (const id of cursors.keys()) cursors.set(id, 0);
      for (const fn of resetListeners) fn();
    }
    bootId = hello.bootId;
    replayedTo = hello.seq;
    // A daemon from before `replay` says nothing: nothing to wait for.
    replayLeft = hello.replay > 0 ? hello.replay : 0;
    if (replayLeft === 0) replayDone();
    for (const meta of hello.sessions) metas.set(meta.id, meta);
    noteUi(hello.ui);
    streamId = hello.stream;
    setTerminals(hello.terminals);
    setStatus('open');
    sessionsChanged();
    setUnread(hello.unread);
    setPins(hello.pinned);
    setForks(hello.forks);
    setSettings(hello.settings);
    setWatches(hello.bugbot);
    setScheduled(hello.schedule);
    setLogin(hello.login);
    activities = new Map(Object.entries(hello.activity));
    activityChanged();
    setRemote(hello.remote);
    // Changes made while this page was away were not heard: ask again.
    decisions.clear();
    decisionsChanged();
    // A new connection: the terminals shown are watched on it, from their scrollback again.
    for (const id of terminalViewers.keys()) watchOn(id);
  }

  /** @param {StreamEvent} event */
  function onEvent(event) {
    if (event.kind === 'hello') return onHello(event);
    if (event.kind === 'scratchpad') {
      for (const fn of scratchpadListeners) fn(event.id, { text: event.text, rev: event.rev });
      return;
    }
    if (event.kind === 'history') {
      for (const fn of historyListeners) fn();
      return;
    }
    if (event.kind === 'unread') return setUnread(event.unread);
    if (event.kind === 'pins') return setPins(event.pinned);
    if (event.kind === 'forks') return setForks(event.forks);
    if (event.kind === 'settings') return setSettings(event.settings);
    if (event.kind === 'bugbot') return setWatches(event.watches);
    if (event.kind === 'schedule') return setScheduled(event.tasks);
    if (event.kind === 'login') return setLogin(event.login);
    if (event.kind === 'remote') return setRemote({ state: event.state, error: event.error });
    if (event.kind === 'terminals') return setTerminals(event.terminals);
    if (event.kind === 'terminal') {
      for (const fn of terminalViewers.get(event.id) ?? []) fn(event);
      return;
    }
    if (event.kind === 'activity') {
      if (event.activity) activities.set(event.session, event.activity);
      else activities.delete(event.session);
      return activityChanged();
    }
    if (event.kind === 'decisions') {
      decisions.set(event.ompId, event.reviews);
      return decisionsChanged();
    }
    replayArrived();
    const cursor = cursors.get(event.session);
    // Scoped, a reopened stream may repeat what the last one delivered.
    if (cursor !== undefined) {
      if (event.seq <= cursor) return;
      cursors.set(event.session, event.seq);
    }
    if (event.kind === 'session') {
      metas.set(event.session, event.meta);
      sessionsChanged();
    }
    // Scoped, only a followed session's events are kept: the others' come for their status alone.
    if (scoped && cursor === undefined) return;
    let buffer = buffers.get(event.session);
    if (!buffer) buffers.set(event.session, (buffer = []));
    buffer.push(event);
    buffers.set(event.session, withoutSpent(buffer, event));
    for (const fn of subscribers.get(event.session) ?? []) fn(event);
  }

  /** The stream's address: scoped, with each followed session and how far it got. */
  const streamUrl = () =>
    scoped ? `/api/stream?follow=${[...cursors].map(([id, seq]) => `${encodeURIComponent(id)}:${seq}`).join(',')}` : '/api/stream';

  function open() {
    const opened = new Source(streamUrl());
    source = opened;
    opened.onmessage = (message) => onEvent(JSON.parse(message.data));
    opened.onerror = () => {
      if (opened.readyState === Source.CLOSED) {
        source = null;
        setStatus('down');
        later(connect, RECONNECT_MS);
      } else {
        setStatus('down'); // the browser reconnects by itself, resuming after the last event id
      }
    };
  }

  /** Scoped: follows `session` from its start, reopening the stream once for all those subscribed to in this task. @param {string} session */
  function addFollowed(session) {
    if (cursors.has(session)) return;
    cursors.set(session, 0);
    if (reopening) return;
    reopening = true;
    queueMicrotask(() => {
      reopening = false;
      // No stream yet (or between retries): the next one opens with every session followed.
      if (!source) return;
      source.close();
      open();
    });
  }

  async function connect() {
    // EventSource cannot report an HTTP status, so probe authentication first.
    try {
      const res = await doFetch('/api/config');
      if (res.status === 401 || res.status === 403) return setStatus('unauthorized');
    } catch {
      setStatus('down');
      later(connect, RECONNECT_MS);
      return;
    }
    open();
  }

  /** The daemon's JSON answer, or null when it has none. @param {Response} res @returns {Promise<any>} */
  const readJson = (res) => res.json().catch(() => null);

  /** `body`, unless the daemon answered with an error: that throws. @param {Response} res @param {any} body */
  function check(res, body) {
    if (!res.ok) throw new DaemonError(res.status, body?.error ?? `daemon answered ${res.status}`);
    return body;
  }

  /** @param {string} path @param {RequestInit} [init] */
  async function request(path, init) {
    const res = await doFetch(path, {
      ...init,
      headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    });
    if (res.status === 204) return null;
    return check(res, await readJson(res));
  }

  /** Posts a file as the raw body; the daemon answers with where it stored it. @param {string} path @param {Blob} file @param {string} name @returns {Promise<string>} */
  async function upload(path, file, name) {
    const res = await doFetch(path, {
      method: 'POST',
      headers: { 'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(name) },
      body: file,
    });
    return check(res, await readJson(res)).path;
  }

  /**
   * PUTs `payload` as JSON: the daemon's answer, or `{ conflict }` when it refused the save
   * as made from an older version (409).
   * @param {string} path @param {unknown} payload @param {boolean} keepalive
   * @returns {Promise<{ answer: any } | { conflict: any }>}
   */
  async function save(path, payload, keepalive) {
    const body = JSON.stringify(payload);
    const res = await doFetch(path, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body,
      // Browsers refuse keepalive bodies over 64 KiB outright; a plain request may still land.
      keepalive: keepalive && new TextEncoder().encode(body).length <= KEEPALIVE_MAX_BYTES,
    });
    const answer = await readJson(res);
    if (res.status === 409 && answer && 'current' in answer) return { conflict: answer.current };
    return { answer: check(res, answer) };
  }

  const sessionPath = (/** @type {string} */ session) => `/api/sessions/${encodeURIComponent(session)}`;
  const padPath = (/** @type {string} */ id) => `/api/scratchpads/${encodeURIComponent(id)}`;
  const workspacePath = (/** @type {string} */ name) => `/api/workspaces/${encodeURIComponent(name)}`;
  const unreadPath = (/** @type {string} */ ompId) => `/api/unread/${encodeURIComponent(ompId)}`;

  /** @param {string} session @param {(event: SessionEvent) => void} fn @returns {() => void} */
  function subscribe(session, fn) {
    if (scoped) addFollowed(session);
    for (const event of buffers.get(session) ?? []) fn(event);
    let set = subscribers.get(session);
    if (!set) subscribers.set(session, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  /**
   * omp's answer to the command the daemon accepted as `id`. It arrives on the stream like
   * every frame, possibly already; the request fails if omp or the daemon goes away first.
   * @param {string} session @param {string} id @returns {Promise<RpcResponse>}
   */
  function streamedResponse(session, id) {
    return new Promise((resolve, reject) => {
      let done = false;
      let stop = () => {};
      /** @param {() => void} settle */
      const finish = (settle) => {
        if (done) return;
        done = true;
        stop();
        resetListeners.delete(onReset);
        settle();
      };
      const onReset = () => finish(() => reject(new DaemonError(409, 'the daemon restarted before the agent answered')));
      resetListeners.add(onReset);
      stop = subscribe(session, (event) => {
        if (event.kind === 'frame' && event.frame.type === 'response' && event.frame.id === id) {
          finish(() => resolve(/** @type {RpcResponse} */ (event.frame)));
        } else if (event.kind === 'session' && (event.meta.status === 'exited' || event.meta.status === 'failed')) {
          finish(() => reject(new DaemonError(409, 'the agent exited before answering')));
        }
      });
      if (done) stop(); // settled during the synchronous replay, before `stop` was assigned
    });
  }

  void connect();

  return {
    status: () => status,
    onStatus(fn) {
      statusListeners.add(fn);
      return () => statusListeners.delete(fn);
    },
    onReset(fn) {
      resetListeners.add(fn);
      return () => resetListeners.delete(fn);
    },
    subscribe,
    replayed: (event) => event.seq <= replayedTo,
    replaying: () => replayLeft > 0,
    afterReplay(fn) {
      if (replayLeft > 0) replayWaiters.add(fn);
      else fn();
    },
    meta: (session) => metas.get(session) ?? null,
    sessions: () => [...metas.values()],
    onSessions(fn) {
      sessionListeners.add(fn);
      return () => sessionListeners.delete(fn);
    },
    onHistory(fn) {
      historyListeners.add(fn);
      return () => historyListeners.delete(fn);
    },
    /** When conversation `ompId` became unread (daemon time), or null while it is read. */
    unreadSince: (ompId) => (ompId !== null && Object.hasOwn(unread, ompId) ? unread[ompId] : null),
    onUnread(fn) {
      unreadListeners.add(fn);
      return () => unreadListeners.delete(fn);
    },
    async markRead(ompId, at) {
      await request(`${unreadPath(ompId)}/read`, { method: 'POST', body: JSON.stringify({ at }) });
    },
    async markUnread(ompId) {
      await request(unreadPath(ompId), { method: 'PUT' });
    },
    /** Whether conversation `ompId` is pinned to the top of the Sessions list. */
    isPinned: (ompId) => ompId !== null && pinned.has(ompId),
    onPins(fn) {
      pinsListeners.add(fn);
      return () => pinsListeners.delete(fn);
    },
    async pin(ompId, on) {
      await request(`/api/pins/${encodeURIComponent(ompId)}`, { method: on ? 'PUT' : 'DELETE' });
    },
    /** Which conversation each fork came from, by omp id (daemon/forks.js). */
    forks: () => forks,
    onForks(fn) {
      forksListeners.add(fn);
      return () => forksListeners.delete(fn);
    },
    /** Conversation `ompId`'s decision reviews; null until the daemon has said (asking it, if no one has). */
    decisions(ompId) {
      if (ompId === null) return null;
      const known = decisions.get(ompId);
      if (known || askingDecisions.has(ompId) || status !== 'open') return known ?? null;
      askingDecisions.add(ompId);
      request(`/api/decisions/${encodeURIComponent(ompId)}`)
        // News heard meanwhile is newer than this answer. One that failed is not asked again until a reconnect.
        .then((body) => !decisions.has(ompId) && decisions.set(ompId, body.reviews))
        .catch(() => !decisions.has(ompId) && decisions.set(ompId, {}))
        .finally(() => {
          askingDecisions.delete(ompId);
          decisionsChanged();
        });
      return null;
    },
    onDecisions(fn) {
      decisionsListeners.add(fn);
      return () => decisionsListeners.delete(fn);
    },
    settings: () => settings,
    onSettings(fn) {
      settingsListeners.add(fn);
      return () => settingsListeners.delete(fn);
    },
    async changeSettings(patch) {
      await request('/api/settings', { method: 'PUT', body: JSON.stringify(patch) });
    },
    async history(query = '', { archived = false } = {}) {
      const params = new URLSearchParams({ ...(query ? { q: query } : {}), ...(archived ? { archived: '1' } : {}) });
      const body = await request(`/api/history${params.size ? `?${params}` : ''}`);
      return body.sessions;
    },
    ask: (question) => request('/api/ask', { method: 'POST', body: JSON.stringify({ question }) }),
    conversation: (file) => request(`/api/conversation?file=${encodeURIComponent(file)}`),
    async archivePastSession(file) {
      return (await request('/api/history/archive', { method: 'POST', body: JSON.stringify({ file }) })).file;
    },
    async restorePastSession(file) {
      return (await request('/api/history/restore', { method: 'POST', body: JSON.stringify({ file }) })).file;
    },
    async scratchpads() {
      return (await request('/api/scratchpads')).pads;
    },
    scratchpad: (id) => request(padPath(id)),
    async saveScratchpad(id, text, base, { keepalive = false } = {}) {
      const result = await save(padPath(id), { text, base }, keepalive);
      return 'conflict' in result ? { ok: false, current: result.conflict } : { ok: true, rev: result.answer.rev };
    },
    async deleteScratchpad(id) {
      await request(padPath(id), { method: 'DELETE' });
    },
    uploadScratchpadFile(id, file, name) {
      return upload(`${padPath(id)}/assets`, file, name);
    },
    uploadAttachment(file, name) {
      return upload('/api/attachments', file, name);
    },
    onScratchpad(fn) {
      scratchpadListeners.add(fn);
      return () => scratchpadListeners.delete(fn);
    },
    workspace: (name) => request(workspacePath(name)),
    async saveScreen(workspace, id, tree, base, { keepalive = false } = {}) {
      const result = await save(`${workspacePath(workspace)}/screens/${encodeURIComponent(id)}`, { tree, base }, keepalive);
      return 'conflict' in result ? { ok: false, current: result.conflict } : { ok: true, rev: result.answer.rev };
    },
    onUiChange(fn) {
      uiListeners.add(fn);
      return () => uiListeners.delete(fn);
    },
    /** Asks which UI version is served now: files can change under a running daemon. */
    async checkUi() {
      const body = await request('/api/ui').catch(() => null);
      noteUi(body?.version);
    },
    config() {
      // Fixed for the daemon's lifetime: asked once, and again after a failure or a restart.
      config ??= request('/api/config').catch((err) => {
        config = null;
        throw err;
      });
      return config;
    },
    async createSession({ cwd, resume, fork, prompt }) {
      const body = await request('/api/sessions', { method: 'POST', body: JSON.stringify({ cwd, resume, fork, prompt }) });
      // The stream may have told of the session already, and newer: its answer is the oldest news.
      if (!metas.has(body.session.id)) {
        metas.set(body.session.id, body.session);
        sessionsChanged();
      }
      return metas.get(body.session.id) ?? body.session;
    },
    async seen(session) {
      await request(`${sessionPath(session)}/seen`, { method: 'POST' });
    },
    async end(session) {
      await request(sessionPath(session), { method: 'DELETE' });
    },
    async rpc(session, command) {
      const { id } = await request(`${sessionPath(session)}/rpc`, { method: 'POST', body: JSON.stringify(command) });
      return streamedResponse(session, id);
    },
    async respondUi(session, response) {
      await request(`${sessionPath(session)}/ui`, { method: 'POST', body: JSON.stringify(response) });
    },
    // A folder is found relative to home, as a new session's directory is.
    listFiles: (dir) => request(`/api/files?dir=${encodeURIComponent(dir)}`),
    textFile: (path) => request(`/api/text?path=${encodeURIComponent(path)}`),
    async saveTextFile(path, text, base) {
      const result = await save('/api/text', { path, text, base }, false);
      return 'conflict' in result ? { ok: false, current: result.conflict } : { ok: true, file: result.answer };
    },
    pulls: (at) => request(`/api/github/pulls?${new URLSearchParams(at)}`),
    repos: (cwd) => request(`/api/github/repos?cwd=${encodeURIComponent(cwd)}`),
    pull: (at, number) => request(`/api/github/pull?${new URLSearchParams({ ...at, number: String(number) })}`),
    async deliver(target, message) {
      return (await request('/api/deliver', { method: 'POST', body: JSON.stringify({ target, message }) })).session;
    },
    bugbot: () => watches,
    onBugbot(fn) {
      bugbotListeners.add(fn);
      return () => bugbotListeners.delete(fn);
    },
    askBugbot: ({ repo, number, target }) => request('/api/github/bugbot', { method: 'POST', body: JSON.stringify({ repo, number, target }) }),
    schedule: () => scheduled,
    onSchedule(fn) {
      scheduleListeners.add(fn);
      return () => scheduleListeners.delete(fn);
    },
    editScheduled: (id, patch) => request(`/api/schedule/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    async unschedule(id) {
      await request(`/api/schedule/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
    setup: () => request('/api/setup'),
    login: () => login,
    onLogin(fn) {
      loginListeners.add(fn);
      return () => loginListeners.delete(fn);
    },
    // The login's output and end arrive on the stream, for every page.
    async startLogin(provider) {
      await request('/api/setup/login', { method: 'POST', body: JSON.stringify(provider ? { provider } : {}) });
    },
    async answerLogin(line) {
      await request('/api/setup/login/input', { method: 'POST', body: JSON.stringify({ line }) });
    },
    async cancelLogin() {
      await request('/api/setup/login', { method: 'DELETE' });
    },
    /** How awake session `session` is doing, or null when the daemon tells of none (it is asleep, or not heard of yet). */
    activity: (session) => activities.get(session) ?? null,
    onActivity(fn) {
      activityListeners.add(fn);
      return () => activityListeners.delete(fn);
    },
    remote: () => remote,
    onRemote(fn) {
      remoteListeners.add(fn);
      return () => remoteListeners.delete(fn);
    },
    // Answered on the Mac's own (loopback) address only: it carries the sign-in QR code.
    remoteInfo: () => request('/api/remote'),
    terminals: () => terminals,
    onTerminals(fn) {
      terminalsListeners.add(fn);
      return () => terminalsListeners.delete(fn);
    },
    async startTerminal({ cwd, cols, rows }) {
      return (await request('/api/terminals', { method: 'POST', body: JSON.stringify({ cwd, cols, rows }) })).terminal;
    },
    async endTerminal(id) {
      await request(terminalPath(id), { method: 'DELETE' });
    },
    /** Has `fn` hear terminal `id`'s output: its scrollback first (`replay`), then as it comes; again from the scrollback after a reconnect, or when another window of this page starts watching it. */
    watchTerminal(id, fn) {
      let viewers = terminalViewers.get(id);
      if (!viewers) terminalViewers.set(id, (viewers = new Set()));
      viewers.add(fn);
      watchOn(id);
      return () => {
        viewers.delete(fn);
        if (viewers.size || terminalViewers.get(id) !== viewers) return;
        terminalViewers.delete(id);
        if (streamId) request(`${terminalPath(id)}/watchers/${streamId}`, { method: 'DELETE' }).catch(() => {});
      };
    },
    typeInto(id, data, binary = false) {
      let queue = typing.get(id);
      if (!queue) typing.set(id, (queue = []));
      // The first piece is on its way: what is typed meanwhile joins the next one.
      const last = queue.length > 1 ? queue[queue.length - 1] : undefined;
      if (last && last.binary === binary) last.data += data;
      else queue.push({ data, binary });
      if (queue.length === 1) void sendTyping(id, queue);
    },
    async resizeTerminal(id, cols, rows) {
      await request(`${terminalPath(id)}/size`, { method: 'POST', body: JSON.stringify({ cols, rows }) });
    },
  };
}

/** @type {DaemonClient | null} */
let shared = null;

/** The page's one connection, opened on first use. */
export const getDaemon = () => (shared ??= createDaemonClient());

/** Makes the page's one connection a scoped one (the phone's): call before anything uses `getDaemon`. */
export function useScopedDaemon() {
  if (shared) throw new Error('the page’s daemon connection is already open');
  shared = createDaemonClient({}, { scoped: true });
}
