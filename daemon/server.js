/**
 * HTTP face of the daemon: the workbench's static files, the JSON API and the event stream
 * (routes in `wire.js`), the same on each listener: loopback, and the remote one Phone access
 * opens on the tailnet (remote.js), whose whois gate runs before anything else; then the guard
 * of the listener's names (guard.js) on all of them.
 */
import { homedir } from 'node:os';
import { extname, resolve, sep } from 'node:path';
import { LOOPBACK_HOSTS, TOKEN_COOKIE, checkApiRequest, isAllowedHost, tokensMatch } from './guard.js';
import { JournalRefused, readConversation } from './history.js';
import { SessionNotRunning } from './omp-session.js';
import { OMP_ID } from './unread.js';
import { isSettingsPatch } from './settings.js';
import { TextFileRefused, listDirectory, readTextFile, resolvePath, writeTextFile } from './files.js';
import { DeliveryRefused } from './deliver.js';
import { GithubError } from './github.js';
import { LoginRefused } from './setup.js';
import { REPO } from '../src/github/pr-refs.js';
import { IMAGE_TYPES } from '../src/scratchpad/blocks.js';
import { PAD_ID } from '../src/scratchpad/blocks.js';
import { SCREEN_ID, WORKSPACE_NAME } from '../src/workspace/model.js';
import { isValidTree } from '../src/layout/grid-model.js';
import { CONTENT_TYPES, PAGE_FILES, STATIC_DIRS, VENDOR_FILES, createUiVersion } from './ui-files.js';
/** @import { BunRequest, Server } from 'bun' */
/** @import { BugbotWatch, ConversationTarget, DaemonConfig, RemoteState, Scratchpad, SessionActivity, SessionEvent } from './wire.js' */
/** @import { Hub } from './hub.js' */
/** @import { RemoteAccess } from './remote.js' */
/** @typedef {ReturnType<typeof import('./history.js').createHistory>} History */
/** @typedef {ReturnType<typeof import('./scratchpad.js').createScratchpads>} Scratchpads */
/** @typedef {ReturnType<typeof import('./attachments.js').createAttachments>} Attachments */
/** @typedef {ReturnType<typeof import('./workspace.js').createWorkspaces>} Workspaces */
/** @import { Unread, UnreadStore } from './unread.js' */
/** @import { Pinned, PinsStore } from './pins.js' */
/** @import { Forker, Forks, ForksStore } from './forks.js' */
/** @import { DaemonSettings, SettingsStore } from './settings.js' */
/** @import { Github } from './github.js' */
/** @import { Delivery } from './deliver.js' */
/** @import { BugbotStore } from './bugbot.js' */
/** @import { DecisionReviews } from './decisions.js' */
/** @import { LoginState, Setup } from './setup.js' */
/** @import { Reviews } from '../src/omp/decisions.js' */
/** @typedef {(req: BunRequest, server: Server<undefined>) => Response | Promise<Response>} Handler */
/**
 * Where the daemon listens and for whom: `hosts` are the names it answers to (with the port it
 * is bound to, see guard.js); `admit`, when set, decides first whether the peer may be served at
 * all (remote.js's whois gate); `remote` is the tailnet listener, which neither tells nor changes
 * Phone access and sends `/` to the phone's page.
 * @typedef {{ hostname: string, port: number, hosts: readonly string[], admit: ((req: Request, server: Server<undefined>) => Promise<boolean>) | null, remote: boolean }} Listener
 */

/** Bun refuses (413) any request body larger than this; uploads are the largest. */
const MAX_BODY_BYTES = 25 * 1024 * 1024;
const HEARTBEAT_MS = 15_000;
/** JSON answers this large or larger are gzipped for a client that accepts it. */
const GZIP_FROM_BYTES = 64 * 1024;
/** How much of a body is handed to the compressor at a time, so a large one never holds up the daemon. */
const GZIP_CHUNK_BYTES = 64 * 1024;
const COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;
const BASE_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
};
/**
 * Uploaded files are served from the workbench's own origin, so they must never run: no
 * sniffing, a sandbox for anything opened as a page, and only raster images shown inline.
 * Their names are unique, so they can be cached for good.
 */
const ASSET_HEADERS = {
  ...BASE_HEADERS,
  'cache-control': 'private, max-age=31536000, immutable',
  'content-security-policy': "sandbox; default-src 'none'; img-src 'self'; frame-ancestors 'none'",
};

/** What a reply may show from this machine: images, and the data files a chart reads. */
const LOCAL_FILE_TYPES = /** @type {Record<string, string>} */ ({
  ...IMAGE_TYPES,
  '.json': 'application/json',
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
});

/** A file an agent's reply showed: never run as a page, and read fresh (it may be redrawn). */
const FILE_HEADERS = { ...BASE_HEADERS, 'content-security-policy': ASSET_HEADERS['content-security-policy'] };

class HttpError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** @param {unknown} body @param {number} [status] */
const json = (body, status = 200) => Response.json(body, { status, headers: BASE_HEADERS });
/** @param {string} text @param {number} status */
const text = (text, status) => new Response(text, { status, headers: { ...BASE_HEADERS, 'content-type': 'text/plain; charset=utf-8' } });
const noContent = () => new Response(null, { status: 204, headers: BASE_HEADERS });

/** @param {Request} req @returns {Promise<any>} parsed untrusted JSON */
const readJson = (req) =>
  req.json().catch(() => {
    throw new HttpError(400, 'request body is not JSON');
  });

/** @param {Request} req */
const fileName = (req) => decodeURIComponent(req.headers.get('x-file-name') ?? 'file');

/**
 * The existing directory or file `input` names, relative to home unless it is absolute, as the
 * Directory field's suggestions read it (`listing` with home as `base`).
 * @param {unknown} input @param {'directory' | 'file'} kind @param {string} field
 */
async function existingPath(input, kind, field) {
  if (typeof input !== 'string' || !input.trim()) throw new HttpError(400, `${field} is required`);
  const path = resolvePath(input.trim(), homedir());
  const info = await Bun.file(path).stat().catch(() => null);
  const ok = kind === 'directory' ? info?.isDirectory() : info?.isFile();
  if (!ok) throw new HttpError(400, `${field} is not an existing ${kind}: ${path}`);
  return path;
}

/**
 * The folder the request's `?dir=` names, relative to `base`, listed.
 * @param {Request} req @param {string} base
 */
async function listing(req, base) {
  const dir = resolvePath(new URL(req.url).searchParams.get('dir') ?? '', base);
  const found = await listDirectory(dir).catch(() => {
    throw new HttpError(404, `not a folder that can be read: ${dir}`);
  });
  return json({ dir, ...found });
}

/** @param {any} body */
function asCommand(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.type !== 'string') {
    throw new HttpError(400, 'expected an omp command object with a string `type`');
  }
  return /** @type {Record<string, unknown>} */ (body);
}

/**
 * The conversation a request names to send to (untrusted JSON), checked for shape.
 * @param {any} target @returns {ConversationTarget}
 */
function asTarget(target) {
  const optional = (/** @type {unknown} */ v) => v === null || v === undefined || typeof v === 'string';
  if (!target || typeof target !== 'object' || !optional(target.sessionFile) || !optional(target.session) || typeof target.cwd !== 'string') {
    throw new HttpError(400, 'expected a target { sessionFile, session, cwd }');
  }
  if (!target.sessionFile && !target.session) throw new HttpError(400, 'the target names no conversation');
  return { sessionFile: target.sessionFile ? resolve(target.sessionFile) : null, session: target.session || null, cwd: resolvePath(target.cwd, homedir()) };
}

/** A repository named `owner/name` (untrusted): never a flag or a path `gh` would read otherwise. @param {unknown} value */
function repoName(value) {
  if (typeof value !== 'string' || !REPO.test(value)) throw new HttpError(400, 'expected a repository as owner/name');
  return value;
}

/** Where the request's pull requests are: its `repo`, else the repository its `cwd` is in. @param {URLSearchParams} params */
async function pullAt(params) {
  const repo = params.get('repo');
  return repo !== null ? { repo: repoName(repo) } : { cwd: await existingPath(params.get('cwd'), 'directory', 'cwd') };
}

/** A pull request number (untrusted). @param {unknown} value */
function pullNumber(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new HttpError(400, 'expected a pull request number');
  return number;
}

/**
 * @param {string | null} header @param {string} bootId
 * @returns {number} the last sequence number this client saw in the current boot, else 0
 */
function lastSeenSeq(header, bootId) {
  const [boot, seq] = (header ?? '').split(':');
  const n = Number(seq);
  return boot === bootId && Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * The sessions a scoped stream follows (`?follow=<id>:<seq>,…`), each with the seq it has seen
 * up to; null for a stream that follows every session (no `follow`).
 * @param {URLSearchParams} params @returns {Map<string, number> | null}
 */
function followed(params) {
  const value = params.get('follow');
  if (value === null) return null;
  /** @type {Map<string, number>} */
  const cursors = new Map();
  for (const part of value ? value.split(',') : []) {
    const match = /^([\w-]+):(\d+)$/.exec(part);
    if (!match) throw new HttpError(400, 'expected follow=<session>:<seq>,…');
    cursors.set(match[1], Number(match[2]));
  }
  return cursors;
}

/**
 * `res` gzipped when it is JSON of `GZIP_FROM_BYTES` or more and the request accepts gzip. The
 * body goes to the compressor a chunk at a time, so a large one never holds up the daemon.
 * @param {Request} req @param {Response} res @returns {Promise<Response>}
 */
async function compressed(req, res) {
  if (!res.headers.get('content-type')?.startsWith('application/json') || !/\bgzip\b/.test(req.headers.get('accept-encoding') ?? '')) return res;
  const bytes = await res.bytes();
  const headers = new Headers(res.headers);
  if (bytes.length < GZIP_FROM_BYTES) return new Response(bytes, { status: res.status, headers });
  headers.set('content-encoding', 'gzip');
  headers.delete('content-length');
  let offset = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(offset, (offset += GZIP_CHUNK_BYTES)));
    },
  });
  return new Response(body.pipeThrough(new CompressionStream('gzip')), { status: res.status, headers });
}

/** @param {unknown} err */
function errorResponse(err) {
  const status =
    err instanceof HttpError || err instanceof JournalRefused || err instanceof DeliveryRefused || err instanceof LoginRefused
      ? err.status
      : err instanceof SessionNotRunning
        ? 409
        : err instanceof GithubError
          ? 502
          : 500;
  if (status === 500) console.error('[daemon]', err);
  return json({ error: err instanceof Error ? err.message : String(err) }, status);
}

/** The loopback listener on `port` (0 picks a free one). @param {number} port @returns {Listener} */
export const loopbackListener = (port) => ({ hostname: '127.0.0.1', port, hosts: LOOPBACK_HOSTS, admit: null, remote: false });

/**
 * @typedef {{ hub: Hub, history: History, scratchpads: Scratchpads, attachments: Attachments, workspaces: Workspaces, unread: UnreadStore, pins: PinsStore, forks: ForksStore, forker: Forker, decisions: DecisionReviews, settings: SettingsStore, github: Github, delivery: Delivery, bugbot: BugbotStore, setup: Setup, remote: RemoteAccess, token: string, root: string, config: DaemonConfig }} DaemonOptions
 */

/**
 * The daemon's routes, served on any listener: `serve` starts one (throws if its port is taken).
 * @param {DaemonOptions} options
 */
export function createDaemon({ hub, history, scratchpads, attachments, workspaces, unread, pins, forks, forker, decisions, settings, github, delivery, bugbot, setup, remote, token, root, config }) {
  const rootDir = resolve(root);
  const pageFiles = PAGE_FILES.map((page) => resolve(rootDir, page));
  const staticDirs = STATIC_DIRS.map((dir) => resolve(rootDir, dir));
  const uiVersion = createUiVersion(rootDir);

  /** @type {Handler} */
  async function stream(req, srv) {
    const cursors = followed(new URL(req.url).searchParams);
    srv.timeout(req, 0); // an event stream is idle between events; Bun would close it after 10 s
    const ui = await uiVersion.current();
    /** Whether a scoped stream sends this session event live: every `session` event, the rest only for followed sessions. @param {SessionEvent} event */
    const wanted = (event) => !cursors || event.kind === 'session' || cursors.has(event.session);
    /** @type {() => void} */
    let stop = () => {};
    const body = new ReadableStream({
      start(controller) {
        const write = (/** @type {string} */ chunk) => controller.enqueue(chunk);
        write('retry: 1000\n\n');
        write(`data: ${JSON.stringify({ kind: 'hello', bootId: hub.bootId, seq: hub.latest(), sessions: hub.list(), unread: unread.all(), pinned: pins.all(), forks: forks.all(), settings: settings.all(), bugbot: bugbot.all(), login: setup.login.state(), ui, activity: hub.activity(), remote: remote.state() })}\n\n`);
        const send = (/** @type {SessionEvent} */ event) => write(`id: ${hub.bootId}:${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
        const lastSeen = lastSeenSeq(req.headers.get('last-event-id'), hub.bootId);
        if (!cursors) {
          for (const event of hub.since(lastSeen)) send(event);
        } else if (cursors.size > 0) {
          // Everything up to Last-Event-ID was delivered in order: a followed session's cursor is at least that.
          for (const [id, seq] of cursors) cursors.set(id, Math.max(seq, lastSeen));
          for (const event of hub.since(Math.min(...cursors.values()))) {
            if (event.seq > (cursors.get(event.session) ?? Infinity)) send(event);
          }
        }
        const unsubscribe = hub.subscribe((event) => {
          if (wanted(event)) send(event);
        });
        // No id: scratchpad, history, unread, pins, forks, decisions, settings, bugbot, login, activity and remote events are not part of the replayable log (see wire.js).
        const offScratchpad = scratchpads.subscribe((/** @type {string} */ id, /** @type {Scratchpad} */ pad) =>
          write(`data: ${JSON.stringify({ kind: 'scratchpad', id, ...pad })}\n\n`),
        );
        const offHistory = history.watch(() => write(`data: ${JSON.stringify({ kind: 'history' })}\n\n`));
        const offUnread = unread.subscribe((/** @type {Unread} */ marks) => write(`data: ${JSON.stringify({ kind: 'unread', unread: marks })}\n\n`));
        const offPins = pins.subscribe((/** @type {Pinned} */ pinned) => write(`data: ${JSON.stringify({ kind: 'pins', pinned })}\n\n`));
        const offForks = forks.subscribe((/** @type {Forks} */ all) => write(`data: ${JSON.stringify({ kind: 'forks', forks: all })}\n\n`));
        const offDecisions = decisions.subscribe((/** @type {string} */ ompId, /** @type {Reviews} */ reviews) =>
          write(`data: ${JSON.stringify({ kind: 'decisions', ompId, reviews })}\n\n`),
        );
        const offSettings = settings.subscribe((/** @type {DaemonSettings} */ all) => write(`data: ${JSON.stringify({ kind: 'settings', settings: all })}\n\n`));
        const offBugbot = bugbot.subscribe((/** @type {readonly BugbotWatch[]} */ watches) => write(`data: ${JSON.stringify({ kind: 'bugbot', watches })}\n\n`));
        const offLogin = setup.login.subscribe((/** @type {LoginState | null} */ login) => write(`data: ${JSON.stringify({ kind: 'login', login })}\n\n`));
        const offActivity = hub.onActivity((/** @type {string} */ session, /** @type {SessionActivity | null} */ activity) =>
          write(`data: ${JSON.stringify({ kind: 'activity', session, activity })}\n\n`),
        );
        const offRemote = remote.subscribe((/** @type {RemoteState} */ state) => write(`data: ${JSON.stringify({ kind: 'remote', ...state })}\n\n`));
        const heartbeat = setInterval(() => write(': ping\n\n'), HEARTBEAT_MS);
        stop = () => {
          clearInterval(heartbeat);
          unsubscribe();
          offScratchpad();
          offHistory();
          offUnread();
          offPins();
          offForks();
          offDecisions();
          offSettings();
          offBugbot();
          offLogin();
          offActivity();
          offRemote();
        };
      },
      cancel: () => stop(),
    });
    return new Response(body, { headers: { ...BASE_HEADERS, 'content-type': 'text/event-stream; charset=utf-8' } });
  }

  /** @param {BunRequest} req */
  function sessionOf(req) {
    const session = hub.get(req.params.id);
    if (!session) throw new HttpError(404, 'no such session');
    return session;
  }

  /** @param {BunRequest} req */
  function ompIdOf(req) {
    if (!OMP_ID.test(req.params.id)) throw new HttpError(404, 'no such conversation');
    return req.params.id;
  }

  /** @param {BunRequest} req */
  function padOf(req) {
    if (!PAD_ID.test(req.params.id)) throw new HttpError(404, 'no such scratchpad');
    return req.params.id;
  }

  /** @param {BunRequest} req */
  function workspaceOf(req) {
    if (!WORKSPACE_NAME.test(req.params.name)) throw new HttpError(404, 'no such workspace');
    return req.params.name;
  }

  /** @param {URL} url */
  function bootstrap(url) {
    if (!tokensMatch(url.searchParams.get('token') ?? undefined, token)) {
      return text('This link does not match the running daemon. Use the URL it printed.', 403);
    }
    url.searchParams.delete('token'); // only the token: `?workspace=` must survive signing in
    return new Response(null, {
      status: 302,
      headers: {
        ...BASE_HEADERS,
        'set-cookie': `${TOKEN_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}`,
        location: url.pathname + url.search,
      },
    });
  }

  /** @param {string} pathname */
  async function serveStatic(pathname) {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname === '/' ? '/index.html' : pathname === '/phone' ? '/phone.html' : pathname);
    } catch {
      return text('bad path', 400);
    }
    // Check the allowlist on the resolved file, never the raw path: `/src/..%2f…` passes a
    // prefix test and decodes to a file outside `src/`.
    const vendor = VENDOR_FILES[decoded.slice(1)];
    const path = resolve(rootDir, vendor ?? `.${decoded}`);
    const allowed = vendor !== undefined || pageFiles.includes(path) || staticDirs.some((dir) => path.startsWith(dir + sep));
    const type = CONTENT_TYPES[extname(path)];
    const file = Bun.file(path);
    if (!allowed || !type || !(await file.exists())) return text('not found', 404);
    return new Response(file, { headers: { ...BASE_HEADERS, 'content-type': type } });
  }

  /**
   * Starts serving the routes on `listener`.
   * @param {Listener} listener @returns {Server<undefined>}
   */
  function serve(listener) {
    /** The listener's `host:port` names, at the port it is bound to. @param {Server<undefined>} srv */
    const names = (srv) => listener.hosts.map((host) => `${host}:${srv.port ?? listener.port}`);

    /**
     * An API route: the guard first, then the handler for the request's method; JSON answers
     * compressed for a client that accepts it.
     * @param {Partial<Record<string, Handler>> | Handler} methods @returns {Handler}
     */
    const api = (methods) => async (req, srv) => {
      const verdict = checkApiRequest({ method: req.method, headers: req.headers, names: names(srv), token });
      if (!verdict.ok) return json({ error: verdict.error }, verdict.status);
      const handler = typeof methods === 'function' ? methods : methods[req.method];
      if (!handler) return json({ error: 'method not allowed' }, 405);
      try {
        return await compressed(req, await handler(req, srv));
      } catch (err) {
        return errorResponse(err);
      }
    };

    /**
     * The listener's gate, if it has one, before `handler`: anyone it does not admit gets a
     * plain 403 and nothing else.
     * @template {(req: any, srv: Server<undefined>) => Response | Promise<Response>} H
     * @param {H} handler @returns {H}
     */
    const gated = (handler) => {
      const admit = listener.admit;
      if (!admit) return handler;
      return /** @type {H} */ (
        async (/** @type {Request} */ req, /** @type {Server<undefined>} */ srv) =>
          (await admit(req, srv)) ? handler(req, srv) : text('Forbidden: only the Mac owner’s own devices may connect.', 403)
      );
    };

    /** @type {Record<string, Handler>} */
    const routes = {
        '/api/stream': api({ GET: stream }),
        '/api/config': api({ GET: () => json(config) }),
        '/api/ui': api({ GET: async () => json({ version: await uiVersion.current() }) }),
        '/api/history': api({
          GET: async (req) => {
            const params = new URL(req.url).searchParams;
            return json({ sessions: await history.list(params.get('q') ?? '', { archived: params.get('archived') === '1' }) });
          },
        }),
        '/api/history/archive': api({
          POST: async (req) => {
            const { file } = (await readJson(req)) ?? {};
            // omp must not write a journal while it moves: an idle session goes to sleep first.
            const running = typeof file === 'string' ? hub.writing(resolve(file)) : null;
            if (running && !hub.idle(running.id)) throw new HttpError(409, 'the agent is working on it; archive it once it is done');
            if (running) await hub.get(running.id)?.close();
            return json({ file: await history.archive(file) });
          },
        }),
        '/api/conversation': api({
          GET: async (req) => {
            const file = new URL(req.url).searchParams.get('file') ?? '';
            // A journal this daemon's sessions wrote may be anywhere omp keeps it; others must be listed ones.
            return json(file && hub.wrote(resolve(file)) ? await readConversation(resolve(file)) : await history.conversation(file));
          },
        }),
        '/api/history/restore': api({ POST: async (req) => json({ file: await history.restore((await readJson(req))?.file) }) }),
        '/api/unread/:id': api({
          PUT: async (req) => {
            await unread.unread(ompIdOf(req));
            return noContent();
          },
        }),
        '/api/unread/:id/read': api({
          POST: async (req) => {
            const id = ompIdOf(req);
            const at = (await readJson(req))?.at;
            if (!Number.isFinite(at)) throw new HttpError(400, 'expected { at: a time in daemon milliseconds }');
            await unread.read(id, at);
            return noContent();
          },
        }),
        '/api/pins/:id': api({
          PUT: async (req) => {
            await pins.set(ompIdOf(req), true);
            return noContent();
          },
          DELETE: async (req) => {
            await pins.set(ompIdOf(req), false);
            return noContent();
          },
        }),
        '/api/decisions/:id': api({ GET: async (req) => json({ reviews: await decisions.reviews(ompIdOf(req)) }) }),
        '/api/settings': api({
          PUT: async (req) => {
            const patch = await readJson(req);
            if (!isSettingsPatch(patch)) throw new HttpError(400, "expected some of { idleCompaction: boolean, decisionReview: boolean, adhd: boolean, browser: 'isolated' | 'relay' | 'omp', setupDone: boolean, remote: boolean }");
            // The phone must not lock itself out (or anyone in): Phone access is switched on the Mac.
            if (listener.remote && Object.hasOwn(patch, 'remote')) throw new HttpError(403, 'Phone access is switched on the Mac');
            await settings.set(patch);
            return json(settings.all());
          },
        }),
        '/api/remote': api({
          GET: () => {
            if (listener.remote) throw new HttpError(404, 'no such route');
            return json(remote.info());
          },
        }),
        '/api/setup': api({ GET: async () => json(await setup.check()) }),
        '/api/setup/login': api({
          POST: async (req) => {
            const body = await readJson(req);
            const provider = body?.provider ?? null;
            if (provider !== null && typeof provider !== 'string') throw new HttpError(400, 'expected { provider?: string }');
            setup.login.start(provider);
            return json({ login: setup.login.state() }, 202);
          },
          DELETE: async () => {
            setup.login.cancel();
            return noContent();
          },
        }),
        '/api/setup/login/input': api({
          POST: async (req) => {
            const body = await readJson(req);
            if (typeof body?.line !== 'string' || body.line.includes('\n')) throw new HttpError(400, 'expected { line: string } (one line)');
            setup.login.input(body.line);
            return noContent();
          },
        }),
        '/api/scratchpads': api({ GET: async () => json({ pads: await scratchpads.list() }) }),
        '/api/scratchpads/:id': api({
          GET: async (req) => json(await scratchpads.read(padOf(req))),
          DELETE: async (req) => {
            await scratchpads.remove(padOf(req));
            return noContent();
          },
          PUT: async (req) => {
            const id = padOf(req);
            const body = await readJson(req);
            if (typeof body?.text !== 'string' || typeof body?.base !== 'string') {
              throw new HttpError(400, 'expected { text: string, base: string }');
            }
            const result = await scratchpads.write(id, body.text, body.base);
            if (!result.ok) return json({ error: 'the scratchpad changed since this edit began', current: result.current }, 409);
            return json({ rev: result.rev });
          },
        }),
        '/api/scratchpads/:id/assets': api({
          POST: async (req) => json({ path: await scratchpads.saveAsset(padOf(req), fileName(req), await req.bytes()) }, 201),
        }),
        '/api/scratchpads/:id/assets/:name': api({
          GET: async (req) => {
            const asset = scratchpads.asset(padOf(req), req.params.name);
            const file = asset && Bun.file(asset.path);
            if (!asset || !file || !(await file.exists())) throw new HttpError(404, 'no such file');
            const headers = new Headers({ ...ASSET_HEADERS, 'content-type': asset.type });
            if (!asset.inline) headers.set('content-disposition', 'attachment');
            return new Response(file, { headers });
          },
        }),
        '/api/attachments': api({
          POST: async (req) => json({ path: await attachments.save(fileName(req), await req.bytes()) }, 201),
        }),
        '/api/workspaces/:name': api({ GET: async (req) => json(await workspaces.read(workspaceOf(req))) }),
        '/api/workspaces/:name/screens/:id': api({
          PUT: async (req) => {
            const name = workspaceOf(req);
            if (!SCREEN_ID.test(req.params.id)) throw new HttpError(404, 'no such screen');
            const { tree, base } = (await readJson(req)) ?? {};
            if (!isValidTree(tree) || !(base === null || (Number.isInteger(base) && base > 0))) {
              throw new HttpError(400, 'expected { tree: a layout or null, base: the rev it was made from, or null }');
            }
            const result = await workspaces.write(name, req.params.id, tree, base);
            if (!result.ok) return json({ error: 'the screen changed since this layout was loaded', current: result.current }, 409);
            return json({ rev: result.rev });
          },
        }),
        '/api/sessions': api({
          GET: () => json({ sessions: hub.list() }),
          POST: async (req) => {
            const body = await readJson(req);
            const cwd = await existingPath(body?.cwd, 'directory', 'cwd');
            if (body?.resume != null && body?.fork != null) throw new HttpError(400, 'resume and fork cannot be combined');
            if (body?.prompt != null && (body?.fork == null || typeof body.prompt !== 'string')) throw new HttpError(400, 'a prompt goes with a fork, as a string');
            const resume = body?.resume == null ? null : await existingPath(body.resume, 'file', 'resume');
            const fork = body?.fork == null ? null : await existingPath(body.fork, 'file', 'fork');
            if (resume && history.isArchived(resume)) throw new HttpError(409, 'the conversation is archived: restore it to carry it on');
            const running = resume && hub.writing(resume);
            if (running) return json({ session: running });
            if (fork) return json({ session: await forker.fork({ cwd, file: fork, prompt: body?.prompt ?? null }) }, 201);
            return json({ session: hub.create({ cwd, resume, fork: null }) }, 201);
          },
        }),
        '/api/sessions/:id': api({
          DELETE: async (req) => {
            await sessionOf(req).close();
            return noContent();
          },
        }),
        '/api/sessions/:id/seen': api({
          POST: (req) => {
            sessionOf(req);
            hub.seen(req.params.id);
            return noContent();
          },
        }),
        '/api/sessions/:id/rpc': api({
          POST: async (req) => {
            const session = sessionOf(req);
            const command = asCommand(await readJson(req));
            if (command.type === 'extension_ui_response') throw new HttpError(400, 'send dialog answers to /ui');
            // omp's answer travels on the stream, never in this request: some commands answer only
            // when they finish (`bash`, `login`, `compact`), and holding those open would tie up
            // the browser's six connections per host.
            const { id, response } = session.command(command);
            response.catch(() => {});
            return json({ id }, 202);
          },
        }),
        '/api/deliver': api({
          POST: async (req) => {
            const body = (await readJson(req)) ?? {};
            if (typeof body.message !== 'string' || !body.message.trim()) throw new HttpError(400, 'expected a message to send');
            return json({ session: await delivery.deliver(asTarget(body.target), body.message) }, 202);
          },
        }),
        '/api/github/pulls': api({
          GET: async (req) => json(await github.pulls(await pullAt(new URL(req.url).searchParams))),
        }),
        '/api/github/repos': api({
          GET: async (req) => json(await github.repos(await existingPath(new URL(req.url).searchParams.get('cwd'), 'directory', 'cwd'))),
        }),
        '/api/github/pull': api({
          GET: async (req) => {
            const params = new URL(req.url).searchParams;
            const at = await pullAt(params);
            return json(await github.pull(at, pullNumber(params.get('number'))));
          },
        }),
        '/api/github/bugbot': api({
          POST: async (req) => {
            const body = (await readJson(req)) ?? {};
            return json(await bugbot.start({ repo: repoName(body.repo), number: pullNumber(body.number), target: asTarget(body.target) }), 201);
          },
        }),
        '/api/files': api({ GET: (req) => listing(req, homedir()) }),
        '/api/file': api({
          GET: async (req) => {
            const path = resolvePath(new URL(req.url).searchParams.get('path') ?? '', homedir());
            const type = LOCAL_FILE_TYPES[extname(path).toLowerCase()];
            const file = Bun.file(path);
            if (!type || !(await file.exists())) throw new HttpError(404, 'no such image or data file');
            return new Response(file, { headers: { ...FILE_HEADERS, 'content-type': type } });
          },
        }),
        '/api/text': api({
          GET: async (req) => {
            const path = resolvePath(new URL(req.url).searchParams.get('path') ?? '', homedir());
            try {
              return json(await readTextFile(path));
            } catch (err) {
              throw err instanceof TextFileRefused ? new HttpError(err.status, err.message) : err;
            }
          },
          PUT: async (req) => {
            const body = await readJson(req);
            if (typeof body?.path !== 'string' || typeof body?.text !== 'string' || typeof body?.base !== 'string') {
              throw new HttpError(400, 'expected { path: string, text: string, base: string }');
            }
            try {
              const result = await writeTextFile(resolvePath(body.path, homedir()), body.text, body.base);
              if (!result.ok) return json({ error: 'the file changed since this edit began', current: result.current }, 409);
              return json(result.file);
            } catch (err) {
              throw err instanceof TextFileRefused ? new HttpError(err.status, err.message) : err;
            }
          },
        }),
        '/api/sessions/:id/ui': api({
          POST: async (req) => {
            const session = sessionOf(req);
            const response = asCommand({ type: 'extension_ui_response', ...(await readJson(req)) });
            if (typeof response.id !== 'string') throw new HttpError(400, 'a dialog answer needs the request `id`');
            session.respondUi(response);
            return noContent();
          },
        }),
        '/api/*': api(() => json({ error: 'no such route' }, 404)),
    };

    return Bun.serve({
      hostname: listener.hostname,
      port: listener.port,
      maxRequestBodySize: MAX_BODY_BYTES,
      routes: Object.fromEntries(Object.entries(routes).map(([path, handler]) => [path, gated(handler)])),
      fetch: gated(async (req, srv) => {
        if (!isAllowedHost(req.headers.get('host'), names(srv))) return text('unexpected Host header', 403);
        if (req.method !== 'GET' && req.method !== 'HEAD') return text('method not allowed', 405);
        const url = new URL(req.url);
        if (url.searchParams.has('token')) return bootstrap(url);
        // The tailnet listener is the phone's: its page is the only one there.
        if (listener.remote && url.pathname === '/') return new Response(null, { status: 302, headers: { ...BASE_HEADERS, location: '/phone' } });
        return serveStatic(url.pathname);
      }),
      error: errorResponse,
    });
  }

  return { serve };
}

/**
 * Starts serving on `127.0.0.1:port` (0 picks a free port); throws if the port is taken.
 * @param {DaemonOptions & { port: number }} options
 */
export const createDaemonServer = (options) => createDaemon(options).serve(loopbackListener(options.port));
