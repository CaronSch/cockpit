/**
 * Past omp sessions, read from omp's session files: one summary per conversation, searchable
 * (search.js, ranked) by title, directory, what the user asked and what the agent answered.
 *
 * omp keeps one journal per session at `<sessions>/<project>/<timestamp>_<id>.jsonl`; folders
 * beside them hold subagent sessions and artifacts, which are not conversations of their own.
 * A journal starts with a `title` line omp rewrites in place, then a `session` header
 * (`id`, `timestamp`, `cwd`); user prompts are `message` lines with role `user`, and the agent's
 * replies those with role `assistant` (their text only: thinking and tool calls are left out,
 * as tool output is, being most of a journal and little of what a conversation was about). Summaries are
 * cached by path, size and mtime, so a refresh only re-reads journals that changed.
 *
 * Archiving moves a journal and its folder out of omp's sessions directory into the archive
 * directory at the same relative path, where omp's resume no longer finds it, and restoring
 * moves them back. That is what omp's own `omp gc` archive moves (`moveSessionWithArtifacts`,
 * which leaves the inert `.<name>.lock.os` lock sidecar where it is). Both directories are
 * listed the same way.
 *
 * `watch` hears when either directory's journals change (omp writing one, a session archived
 * or restored), at most once per COALESCE_MS, and says which journals did, so the Sessions
 * window refreshes without polling.
 */
import { createReadStream, mkdirSync, watch } from 'node:fs';
import { link, lstat, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { conversationOf } from './conversation.js';
import { indexText, rank } from './search.js';
/** @import { Conversation, PastSession } from './wire.js' */

const PREVIEW_CHARS = 280;
/** omp appends to a journal after every message: changes this close together are one. */
const COALESCE_MS = 300;

/** @typedef {Omit<PastSession, 'match'> & { index: import('./search.js').TextIndex }} Summary */

/** @param {unknown} content @returns {string} */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

/** @param {string} text */
const oneLine = (text) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1)}…` : flat;
};

/**
 * Reads one journal. Lines that are not JSON (a torn last write) are skipped, not fatal.
 * @param {string} file @param {{ size: number, mtimeMs: number }} info
 * @returns {Promise<Summary | null>} null when the journal has no session header
 */
async function summarise(file, info) {
  /** @type {string | null} */
  let title = null;
  /** @type {Record<string, any> | null} */
  let header = null;
  /** @type {string[]} */
  const prompts = [];
  /** @type {string[]} */
  const replies = [];

  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    // Most lines are tool output; only parse the ones that can matter.
    const maybeHeader = header === null && (line.includes('"type":"session"') || line.includes('"type":"title"'));
    if (!maybeHeader && !line.includes('"role":"user"') && !line.includes('"role":"assistant"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    // omp's auto-titles start with a nerd-font icon (a private-use character); browsers show a box.
    if (entry?.type === 'title' && typeof entry.title === 'string') title = entry.title.replace(/\p{Co}/gu, '').trim() || null;
    else if (entry?.type === 'session' && header === null) header = entry;
    else if (entry?.type === 'message' && entry.message?.role === 'user' && entry.message.attribution !== 'agent') {
      const text = textOf(entry.message.content).trim();
      if (!text) continue;
      prompts.push(text);
    } else if (entry?.type === 'message' && entry.message?.role === 'assistant') {
      const text = textOf(entry.message.content).trim();
      if (text) replies.push(text);
    }
  }
  if (!header || typeof header.id !== 'string') return null;

  const created = Date.parse(header.timestamp);
  const index = indexText({ title: title ?? '', names: [typeof header.cwd === 'string' ? header.cwd : '', header.id], texts: [...prompts, ...replies] });
  return {
    file,
    id: header.id,
    title,
    cwd: typeof header.cwd === 'string' ? header.cwd : null,
    createdAt: Number.isFinite(created) ? created : null,
    modifiedAt: info.mtimeMs,
    prompts: prompts.length,
    firstPrompt: prompts.length ? oneLine(prompts[0]) : null,
    index,
  };
}

/** Why a journal could not be read, archived or restored, as an HTTP status. */
export class JournalRefused extends Error {
  /** @param {400 | 404 | 409} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Every summary in one sessions directory (omp's own, or the archive). @param {string} root */
function createShelf(root) {
  /** @type {Map<string, { size: number, mtimeMs: number, summary: Summary | null }>} */
  const cache = new Map();

  /** @returns {Promise<string[]>} */
  async function journals() {
    const projects = await readdir(root, { withFileTypes: true }).catch(() => []);
    const nested = await Promise.all(
      projects
        .filter((p) => p.isDirectory())
        .map(async (p) => {
          const dir = join(root, p.name);
          const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
          return entries.filter((e) => e.isFile() && e.name.endsWith('.jsonl') && !e.name.startsWith('.')).map((e) => join(dir, e.name));
        }),
    );
    return nested.flat();
  }

  return {
    /** Every conversation; with a query, those it finds, best first. @param {string} query @returns {Promise<PastSession[]>} */
    async list(query) {
      const files = await journals();
      const seen = new Set(files);
      for (const file of cache.keys()) if (!seen.has(file)) cache.delete(file);

      const summaries = await Promise.all(
        files.map(async (file) => {
          const info = await stat(file).catch(() => null);
          if (!info) return null;
          const hit = cache.get(file);
          if (hit && hit.size === info.size && hit.mtimeMs === info.mtimeMs) return hit.summary;
          const summary = await summarise(file, info).catch(() => null);
          cache.set(file, { size: info.size, mtimeMs: info.mtimeMs, summary });
          return summary;
        }),
      );

      const listed = /** @type {Summary[]} */ (summaries.filter((s) => s !== null && s.prompts > 0));
      /** @param {Summary} s @returns {Omit<PastSession, 'match'>} */
      const past = ({ index: _index, ...rest }) => rest;
      if (!query.trim()) return listed.map(past);
      return rank(listed, query).map(({ doc, snippet, terms }) => ({ ...past(doc), match: { snippet, terms } }));
    },
  };
}

/**
 * Where `file` sits under `root`, as `<project>/<name>.jsonl`: a journal the Sessions window
 * lists, never a path elsewhere (`..`), a subagent journal deeper down, or a lock file.
 * @param {string} root @param {unknown} file @returns {string}
 */
function journalUnder(root, file) {
  if (typeof file !== 'string' || !file) throw new JournalRefused(400, 'file is required');
  const rel = relative(root, resolve(file));
  const parts = rel.split(sep);
  if (isAbsolute(rel) || parts.length !== 2 || parts[0] === '..' || !parts[1].endsWith('.jsonl') || parts[1].startsWith('.')) {
    throw new JournalRefused(400, `not a session journal under ${root}: ${file}`);
  }
  return rel;
}

/**
 * The first of `roots` that `file` is a journal under, and where under it: refused as
 * `journalUnder` refuses when it is under none.
 * @param {string[]} roots @param {unknown} file @returns {[string, string]}
 */
function journalIn(roots, file) {
  for (const base of roots) {
    try {
      return [base, journalUnder(base, file)];
    } catch {}
  }
  return [roots[0], journalUnder(roots[0], file)];
}

/**
 * The conversation in the journal at `path`, wherever it is: the caller decides it may be read.
 * @param {string} path @returns {Promise<Conversation>}
 */
export async function readConversation(path) {
  const text = await Bun.file(path)
    .text()
    .catch(() => {
      throw new JournalRefused(404, `no such session journal: ${path}`);
    });
  const found = conversationOf(path, text);
  if (!found) throw new JournalRefused(404, `not a session journal: ${path}`);
  return found;
}

/** @param {string} path */
const exists = (path) => lstat(path).then(() => true, () => false);

/**
 * Moves a journal without ever replacing a file: `rename` would overwrite one at `to`, while
 * `link` refuses (EEXIST). Moving across volumes (EXDEV) is refused too, leaving both in place.
 * @param {string} from @param {string} to
 */
async function moveFile(from, to) {
  await link(from, to);
  await unlink(from);
}

/**
 * Moves the journal at `rel` from one directory to the other with its folder, or nothing.
 * @param {string} fromRoot @param {string} toRoot @param {string} rel @returns {Promise<string>} the journal's new path
 */
async function moveSession(fromRoot, toRoot, rel) {
  const from = join(fromRoot, rel);
  const to = join(toRoot, rel);
  const folder = { from: from.slice(0, -'.jsonl'.length), to: to.slice(0, -'.jsonl'.length) };
  const info = await lstat(from).catch(() => null);
  if (!info?.isFile()) throw new JournalRefused(404, `no such session journal: ${from}`);
  const hasFolder = (await lstat(folder.from).catch(() => null))?.isDirectory() ?? false;
  if ((await exists(to)) || (hasFolder && (await exists(folder.to)))) throw new JournalRefused(409, `already there, not replaced: ${to}`);

  await mkdir(dirname(to), { recursive: true });
  await moveFile(from, to).catch((/** @type {NodeJS.ErrnoException} */ err) => {
    if (err.code === 'EEXIST') throw new JournalRefused(409, `already there, not replaced: ${to}`);
    if (err.code === 'EXDEV') throw new JournalRefused(409, `the archive must be on the same volume as omp's sessions: ${toRoot}`);
    throw err;
  });
  if (hasFolder) {
    try {
      // Fails on a folder that is not empty, so nothing is replaced here either.
      await rename(folder.from, folder.to);
    } catch (err) {
      await moveFile(to, from); // the journal goes back beside its folder
      throw err;
    }
  }
  return to;
}

/**
 * @param {{ root: string, archive: string }} options `root` is omp's sessions directory;
 *   `archive` is where archived sessions are kept, in the same layout
 */
export function createHistory({ root, archive }) {
  const sessions = createShelf(root);
  const archived = createShelf(archive);
  /** @type {Set<(changed: ReadonlySet<string | null>) => void>} */
  const listeners = new Set();
  /** Journals changed since the last notice; null for a change the platform could not place. @type {Set<string | null>} */
  let changes = new Set();
  /** @type {import('node:fs').FSWatcher[]} */
  let watchers = [];
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let pending;

  /**
   * @param {string} dir the watched directory
   * @param {string | null} rel the changed path under `dir`, null when the platform could not
   *   say which (then anything may have changed)
   */
  function changed(dir, rel) {
    // A journal is `<project>/<name>.jsonl`; deeper files are subagents' and artifacts'.
    const parts = rel?.split(sep);
    if (parts && (parts.length !== 2 || !parts[1].endsWith('.jsonl'))) return;
    changes.add(rel === null ? null : join(dir, rel));
    pending ??= setTimeout(() => {
      pending = undefined;
      const told = changes;
      changes = new Set();
      for (const fn of listeners) fn(told);
    }, COALESCE_MS);
  }

  function startWatching() {
    watchers = [root, archive].flatMap((dir) => {
      try {
        mkdirSync(dir, { recursive: true }); // a directory that is not there yet cannot be watched
        return [watch(dir, { recursive: true }, (_type, name) => changed(dir, name ? String(name) : null))];
      } catch (err) {
        console.error(`[history] not watching ${dir}; the Sessions window refreshes only on request:`, err);
        return [];
      }
    });
  }

  return {
    /**
     * Calls `fn` (coalesced) whenever a journal in omp's sessions or the archive changes,
     * appears or goes, with the paths of the journals that did (null for a change the platform
     * could not place), until the returned function is called.
     * @param {(changed: ReadonlySet<string | null>) => void} fn @returns {() => void}
     */
    watch(fn) {
      if (listeners.size === 0) startWatching();
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
        if (listeners.size > 0) return;
        for (const w of watchers) w.close();
        watchers = [];
        clearTimeout(pending);
        pending = undefined;
        changes = new Set();
      };
    },
    /**
     * Every past conversation with at least one prompt (archived ones with `archived`),
     * unordered (the widget sorts); with a `query`, the ones it finds (search.js), best first,
     * each with its `match`.
     * @param {string} [query] @param {{ archived?: boolean }} [options]
     * @returns {Promise<PastSession[]>}
     */
    list: (query = '', options = {}) => (options.archived ? archived : sessions).list(query),
    /**
     * The conversation in a journal `list()` lists, archived or not (`conversation.js`).
     * @param {unknown} file untrusted: refused unless it is a journal in either directory
     * @returns {Promise<Conversation>}
     */
    conversation: async (file) => readConversation(join(...journalIn([root, archive], file))),
    /**
     * Moves a journal listed by `list()` into the archive; returns where it is now.
     * @param {unknown} file untrusted: refused unless it is a journal in omp's sessions directory
     */
    archive: async (file) => moveSession(root, archive, journalUnder(root, file)),
    /**
     * Moves an archived journal back where it was; refused if a file is there now.
     * @param {unknown} file untrusted: refused unless it is a journal in the archive
     */
    restore: async (file) => moveSession(archive, root, journalUnder(archive, file)),
  };
}
