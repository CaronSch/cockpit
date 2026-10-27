/**
 * Browser side of the daemon connection: one event stream per page, shared by every widget.
 *
 * Widgets subscribe per session and first receive everything already seen for it, so a
 * window mounted late (or after a reload) renders the same history as one that was open
 * all along. When the daemon restarts, its sessions are gone: buffers are cleared and
 * `onReset` listeners fire before any event from the new daemon is delivered.
 *
 * It keeps which conversations are unread (daemon/unread.js), and the daemon's settings
 * (daemon/settings.js), as the daemon last said: every window reads them here, so all of
 * them, and every page, agree.
 *
 * `replayed` tells events the daemon replays on (re)connecting, which happened before this
 * page heard of them, from those happening now: the replay is everything up to the `hello`'s
 * seq.
 *
 * It also tracks the UI files' version (see daemon/ui-files.js): the first one the daemon
 * reports is the code this page loaded, and `onUiChange` hears when the files served stop
 * being, or become again, those.
 */
/** @import { Conversation, DaemonConfig, DirListing, HelloEvent, PastSession, RpcResponse, Scratchpad, ScratchpadSummary, Screen, SessionEvent, SessionMeta, StreamEvent, Workspace } from '../../daemon/wire.js' */
/** @import { Tree } from '../layout/grid-model.js' */
/** @import { Unread } from '../../daemon/unread.js' */
/** @import { DaemonSettings } from '../../daemon/settings.js' */
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
 *   meta(session: string): SessionMeta | null,
 *   sessions(): SessionMeta[],
 *   onSessions(fn: () => void): () => void,
 *   onHistory(fn: () => void): () => void,
 *   unreadSince(ompId: string | null): number | null,
 *   onUnread(fn: () => void): () => void,
 *   markRead(ompId: string, at: number): Promise<void>,
 *   markUnread(ompId: string): Promise<void>,
 *   settings(): DaemonSettings | null,
 *   onSettings(fn: () => void): () => void,
 *   changeSettings(patch: Partial<DaemonSettings>): Promise<void>,
 *   history(query?: string, options?: { archived?: boolean }): Promise<PastSession[]>,
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
 *   createSession(options: { cwd: string, resume?: string, fork?: string }): Promise<SessionMeta>,
 *   seen(session: string): Promise<void>,
 *   end(session: string): Promise<void>,
 *   rpc(session: string, command: Record<string, unknown>): Promise<RpcResponse>,
 *   respondUi(session: string, response: Record<string, unknown>): Promise<void>,
 *   listFiles(dir: string): Promise<DirListing>,
 *   onUiChange(fn: (outdated: boolean) => void): () => void,
 *   checkUi(): Promise<void>,
 * }} DaemonClient
 */

/** The browser globals the client uses, injectable for tests. @typedef {{ fetch: typeof fetch, EventSource: typeof EventSource, setTimeout: typeof setTimeout }} ClientEnv */

/**
 * @param {Partial<ClientEnv>} [env]
 * @returns {DaemonClient}
 */
export function createDaemonClient(env = {}) {
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
  /** @type {Map<string, SessionEvent[]>} */
  const buffers = new Map();
  /** @type {Map<string, SessionMeta>} */
  const metas = new Map();
  /** @type {Map<string, Set<(event: SessionEvent) => void>>} */
  const subscribers = new Map();
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
  /** Null until the daemon first says. @type {DaemonSettings | null} */
  let settings = null;
  /** @type {Set<() => void>} */
  const settingsListeners = new Set();
  /** @param {DaemonSettings} next */
  const setSettings = (next) => {
    settings = next;
    for (const fn of settingsListeners) fn();
  };
  /** @type {Set<(outdated: boolean) => void>} */
  const uiListeners = new Set();
  /** The UI version this page loaded: the first one heard. @type {string | null} */
  let loadedUi = null;
  /** The UI version served, as last heard. @type {string | null} */
  let servedUi = null;
  /** @type {Promise<DaemonConfig> | null} */
  let config = null;
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
      for (const fn of resetListeners) fn();
    }
    bootId = hello.bootId;
    replayedTo = hello.seq;
    for (const meta of hello.sessions) metas.set(meta.id, meta);
    noteUi(hello.ui);
    setStatus('open');
    sessionsChanged();
    setUnread(hello.unread);
    setSettings(hello.settings);
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
    if (event.kind === 'settings') return setSettings(event.settings);
    if (event.kind === 'session') {
      metas.set(event.session, event.meta);
      sessionsChanged();
    }
    let buffer = buffers.get(event.session);
    if (!buffer) buffers.set(event.session, (buffer = []));
    buffer.push(event);
    for (const fn of subscribers.get(event.session) ?? []) fn(event);
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
    const source = new Source('/api/stream');
    source.onmessage = (message) => onEvent(JSON.parse(message.data));
    source.onerror = () => {
      if (source.readyState === Source.CLOSED) {
        setStatus('down');
        later(connect, RECONNECT_MS);
      } else {
        setStatus('down'); // the browser reconnects by itself, resuming after the last event id
      }
    };
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
    async createSession({ cwd, resume, fork }) {
      const body = await request('/api/sessions', { method: 'POST', body: JSON.stringify({ cwd, resume, fork }) });
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
  };
}

/** @type {DaemonClient | null} */
let shared = null;

/** The page's one connection, opened on first use. */
export const getDaemon = () => (shared ??= createDaemonClient());
