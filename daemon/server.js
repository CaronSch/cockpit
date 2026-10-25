/**
 * HTTP face of the daemon: the workbench's static files, the JSON API and the event stream
 * (routes in `wire.js`), all behind the loopback guard.
 */
import { homedir } from 'node:os';
import { extname, resolve, sep } from 'node:path';
import { TOKEN_COOKIE, checkApiRequest, isAllowedHost, tokensMatch } from './guard.js';
import { JournalRefused, readConversation } from './history.js';
import { SessionNotRunning } from './omp-session.js';
import { OMP_ID } from './unread.js';
import { isSettingsPatch } from './settings.js';
import { listDirectory, resolvePath } from './files.js';
import { PAD_ID } from '../src/scratchpad/blocks.js';
import { SCREEN_ID, WORKSPACE_NAME } from '../src/workspace/model.js';
import { isValidTree } from '../src/layout/grid-model.js';
import { CONTENT_TYPES, INDEX_FILE, STATIC_DIRS, VENDOR_FILES, createUiVersion } from './ui-files.js';
/** @import { BunRequest, Server } from 'bun' */
/** @import { DaemonConfig, Scratchpad, SessionEvent } from './wire.js' */
/** @import { Hub } from './hub.js' */
/** @typedef {ReturnType<typeof import('./history.js').createHistory>} History */
/** @typedef {ReturnType<typeof import('./scratchpad.js').createScratchpads>} Scratchpads */
/** @typedef {ReturnType<typeof import('./attachments.js').createAttachments>} Attachments */
/** @typedef {ReturnType<typeof import('./workspace.js').createWorkspaces>} Workspaces */
/** @import { Unread, UnreadStore } from './unread.js' */
/** @import { DaemonSettings, SettingsStore } from './settings.js' */
/** @typedef {(req: BunRequest, server: Server<undefined>) => Response | Promise<Response>} Handler */

/** Bun refuses (413) any request body larger than this; uploads are the largest. */
const MAX_BODY_BYTES = 25 * 1024 * 1024;
const HEARTBEAT_MS = 15_000;
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
 * @param {string | null} header @param {string} bootId
 * @returns {number} the last sequence number this client saw in the current boot, else 0
 */
function lastSeenSeq(header, bootId) {
  const [boot, seq] = (header ?? '').split(':');
  const n = Number(seq);
  return boot === bootId && Number.isInteger(n) && n > 0 ? n : 0;
}

/** @param {unknown} err */
function errorResponse(err) {
  const status = err instanceof HttpError || err instanceof JournalRefused ? err.status : err instanceof SessionNotRunning ? 409 : 500;
  if (status === 500) console.error('[daemon]', err);
  return json({ error: err instanceof Error ? err.message : String(err) }, status);
}

/**
 * Starts serving on `127.0.0.1:port` (0 picks a free port); throws if the port is taken.
 * @param {{ hub: Hub, history: History, scratchpads: Scratchpads, attachments: Attachments, workspaces: Workspaces, unread: UnreadStore, settings: SettingsStore, token: string, root: string, config: DaemonConfig, port: number }} options
 */
export function createDaemonServer({ hub, history, scratchpads, attachments, workspaces, unread, settings, token, root, config, port }) {
  const rootDir = resolve(root);
  const indexFile = resolve(rootDir, INDEX_FILE);
  const staticDirs = STATIC_DIRS.map((dir) => resolve(rootDir, dir));
  const uiVersion = createUiVersion(rootDir);

  /**
   * An API route: the guard first, then the handler for the request's method.
   * @param {Partial<Record<string, Handler>> | Handler} methods @returns {Handler}
   */
  const api = (methods) => async (req, srv) => {
    const verdict = checkApiRequest({ method: req.method, headers: req.headers, port: srv.port ?? port, token });
    if (!verdict.ok) return json({ error: verdict.error }, verdict.status);
    const handler = typeof methods === 'function' ? methods : methods[req.method];
    if (!handler) return json({ error: 'method not allowed' }, 405);
    try {
      return await handler(req, srv);
    } catch (err) {
      return errorResponse(err);
    }
  };

  /** @type {Handler} */
  async function stream(req, srv) {
    srv.timeout(req, 0); // an event stream is idle between events; Bun would close it after 10 s
    const ui = await uiVersion.current();
    /** @type {() => void} */
    let stop = () => {};
    const body = new ReadableStream({
      start(controller) {
        const write = (/** @type {string} */ chunk) => controller.enqueue(chunk);
        write('retry: 1000\n\n');
        write(`data: ${JSON.stringify({ kind: 'hello', bootId: hub.bootId, seq: hub.latest(), sessions: hub.list(), unread: unread.all(), settings: settings.all(), ui })}\n\n`);
        const send = (/** @type {SessionEvent} */ event) => write(`id: ${hub.bootId}:${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
        for (const event of hub.since(lastSeenSeq(req.headers.get('last-event-id'), hub.bootId))) send(event);
        const unsubscribe = hub.subscribe(send);
        // No id: scratchpad, history, unread and settings events are not part of the replayable log (see wire.js).
        const offScratchpad = scratchpads.subscribe((/** @type {string} */ id, /** @type {Scratchpad} */ pad) =>
          write(`data: ${JSON.stringify({ kind: 'scratchpad', id, ...pad })}\n\n`),
        );
        const offHistory = history.watch(() => write(`data: ${JSON.stringify({ kind: 'history' })}\n\n`));
        const offUnread = unread.subscribe((/** @type {Unread} */ marks) => write(`data: ${JSON.stringify({ kind: 'unread', unread: marks })}\n\n`));
        const offSettings = settings.subscribe((/** @type {DaemonSettings} */ all) => write(`data: ${JSON.stringify({ kind: 'settings', settings: all })}\n\n`));
        const heartbeat = setInterval(() => write(': ping\n\n'), HEARTBEAT_MS);
        stop = () => {
          clearInterval(heartbeat);
          unsubscribe();
          offScratchpad();
          offHistory();
          offUnread();
          offSettings();
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
      decoded = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    } catch {
      return text('bad path', 400);
    }
    // Check the allowlist on the resolved file, never the raw path: `/src/..%2f…` passes a
    // prefix test and decodes to a file outside `src/`.
    const vendor = VENDOR_FILES[decoded.slice(1)];
    const path = resolve(rootDir, vendor ?? `.${decoded}`);
    const allowed = vendor !== undefined || path === indexFile || staticDirs.some((dir) => path.startsWith(dir + sep));
    const type = CONTENT_TYPES[extname(path)];
    const file = Bun.file(path);
    if (!allowed || !type || !(await file.exists())) return text('not found', 404);
    return new Response(file, { headers: { ...BASE_HEADERS, 'content-type': type } });
  }

  return Bun.serve({
    hostname: '127.0.0.1',
    port,
    maxRequestBodySize: MAX_BODY_BYTES,
    routes: {
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
      '/api/settings': api({
        PUT: async (req) => {
          const patch = await readJson(req);
          if (!isSettingsPatch(patch)) throw new HttpError(400, 'expected some of { idleCompaction: boolean }');
          await settings.set(patch);
          return json(settings.all());
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
          const resume = body?.resume == null ? null : await existingPath(body.resume, 'file', 'resume');
          const fork = body?.fork == null ? null : await existingPath(body.fork, 'file', 'fork');
          const running = resume && hub.writing(resume);
          if (running) return json({ session: running });
          return json({ session: hub.create({ cwd, resume, fork }) }, 201);
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
      '/api/files': api({ GET: (req) => listing(req, homedir()) }),
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
    },
    async fetch(req, srv) {
      if (!isAllowedHost(req.headers.get('host'), srv.port ?? port)) return text('unexpected Host header', 403);
      if (req.method !== 'GET' && req.method !== 'HEAD') return text('method not allowed', 405);
      const url = new URL(req.url);
      if (url.searchParams.has('token')) return bootstrap(url);
      return serveStatic(url.pathname);
    },
    error: errorResponse,
  });
}
