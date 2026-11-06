/**
 * Forks: conversations the workbench started from a copy of another (omp's `--fork`), which
 * one each came from, and their own titles. An agent window lists a conversation's forks (and
 * the one it was forked from), and windows showing conversations of one family are coloured
 * alike.
 *
 * Which conversation a fork came from is kept here, not read from journals: omp's journal
 * header names a `parentSession` for a rewind's new journal too, and a rewound conversation is
 * not a fork. Like unread marks (unread.js) a conversation is named by omp's id for it; a
 * rewind moves a conversation onto a new id (hub.js `onRewoundId`), and its fork links move
 * with it.
 *
 * A fork is a conversation of its own from the start: a new journal (omp copies the source
 * into it and leaves the source alone), a session of its own, and a title of its own (omp
 * copies the source's): the first prompt it gets names it (fork-title.js). The title is kept
 * here too, so a fork is listed by it while its journal still carries its source's: the first
 * line of the prompt it was forked with until the model has titled it, then the model's title,
 * then whatever the conversation is renamed to while awake. Forking a conversation whose agent
 * is working copies it as of its last completed response, not the turn under way
 * (`settledJournal`). A prompt given with the fork goes to it once it is ready, whether a
 * window shows it or not (`/fork <prompt>` runs it in the background).
 *
 * `<file>` (state-file.js): `{ version: 1, forks: { [forkId]: { parent: id, named: boolean, title: string | null } } }`.
 */
import { randomUUID } from 'node:crypto';
import { cp, mkdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { currentPath } from './conversation.js';
import { fallbackForkTitle } from './fork-title.js';
import { loadStateFile } from './state-file.js';
import { OMP_ID } from './unread.js';
import { isContinueDirective } from '../src/omp/message.js';
import { contentText } from '../src/omp/transcript.js';
/** @import { Hub } from './hub.js' */
/** @import { SessionMeta } from './wire.js' */

const VERSION = 1;

/** Which conversation a fork came from, and its title (null: none yet). @typedef {{ parent: string, title: string | null }} ForkLink */
/** Every fork, by omp id: the wire's view of the store. @typedef {Readonly<Record<string, ForkLink>>} Forks */
/** @typedef {ForkLink & { named: boolean }} StoredLink */
/** @typedef {Readonly<Record<string, StoredLink>>} ForkLinks */

/** @param {any} link @returns {boolean} */
const isLink = (link) => typeof link?.parent === 'string' && OMP_ID.test(link.parent) && typeof link.named === 'boolean' && (link.title === null || typeof link.title === 'string');

/** @param {any} data parsed untrusted JSON @returns {data is { version: 1, forks: Record<string, StoredLink> }} */
const isForksFile = (data) =>
  data?.version === VERSION &&
  data.forks !== null &&
  typeof data.forks === 'object' &&
  !Array.isArray(data.forks) &&
  Object.entries(data.forks).every(([id, link]) => OMP_ID.test(id) && isLink(link));

/**
 * Loads the forks kept in `file` (none if it does not exist yet).
 * @param {{ file: string }} options
 */
export async function loadForks({ file }) {
  const store = await loadStateFile({
    file,
    what: 'a forks file',
    initial: /** @type {ForkLinks} */ ({}),
    read: (data) => (isForksFile(data) ? data.forks : null),
    write: (forks) => ({ version: VERSION, forks }),
  });
  /** @param {ForkLinks} links @returns {Forks} */
  const wire = (links) => Object.fromEntries(Object.entries(links).map(([id, { parent, title }]) => [id, { parent, title }]));
  /** @param {string} id @param {Partial<StoredLink>} change */
  const change = (id, change) => {
    const link = store.get()[id];
    if (!link || Object.entries(change).every(([key, value]) => link[/** @type {keyof StoredLink} */ (key)] === value)) return Promise.resolve();
    return store.set({ ...store.get(), [id]: { ...link, ...change } });
  };
  return {
    /** Every fork: which conversation it came from, and its title. @returns {Forks} */
    all: () => wire(store.get()),
    /** Records `id` as a fork of `parent`, titled `title` for now, not named yet. @param {string} id @param {string} parent @param {string | null} title */
    add(id, parent, title) {
      if (id === parent || store.get()[id]) return Promise.resolve();
      return store.set({ ...store.get(), [id]: { parent, named: false, title } });
    },
    /** Whether `id` is a fork still waiting for its first prompt to name it. @param {string} id */
    unnamed: (id) => store.get()[id]?.named === false,
    /** Fork `id` is being named (by its first prompt): it is not to be again. @param {string} id */
    named: (id) => change(id, { named: true }),
    /** Fork `id` is called `title` now. @param {string} id @param {string} title */
    titled: (id, title) => change(id, { title }),
    /**
     * Conversation `from` goes on as `to` (a rewind's new journal): its own link and its forks'
     * links to it move along.
     * @param {string} from @param {string} to
     */
    moved(from, to) {
      const links = store.get();
      if (from === to || !Object.entries(links).some(([id, link]) => id === from || link.parent === from)) return Promise.resolve();
      /** @type {Record<string, StoredLink>} */
      const next = {};
      for (const [id, link] of Object.entries(links)) next[id === from ? to : id] = link.parent === from ? { ...link, parent: to } : link;
      return store.set(next);
    },
    /** Hears every change, with every fork. @param {(forks: Forks) => void} fn */
    subscribe: (fn) => store.subscribe((links) => fn(wire(links))),
  };
}

/** @typedef {Awaited<ReturnType<typeof loadForks>>} ForksStore */

/** Assistant messages that answered: a turn that ends on one of these is complete. */
const SETTLED = new Set(['stop', 'length']);

/**
 * The journal `text` as of its last completed response, for forking a conversation whose
 * agent is working: the lines up to that response's entry (the entries after it on the
 * conversation's path are the turn under way, written later). Null when there is nothing to
 * leave out (the path ends on that response) or no response to keep.
 * @param {string} text
 * @returns {string | null}
 */
export function settledJournal(text) {
  const lines = text.split('\n');
  /** @type {Map<Record<string, any>, number>} */
  const lineOf = new Map();
  lines.forEach((line, i) => {
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === 'object' && entry.type !== 'title' && entry.type !== 'session') lineOf.set(entry, i);
    } catch {}
  });
  const path = currentPath([...lineOf.keys()]);
  const settled = path.findLast((e) => e.type === 'message' && e.message?.role === 'assistant' && SETTLED.has(e.message.stopReason));
  if (!settled || settled === path.at(-1)) return null;
  return `${lines.slice(0, /** @type {number} */ (lineOf.get(settled)) + 1).join('\n')}\n`;
}

/** The journal's own id and title, from its first lines. @param {string} text */
function journalHead(text) {
  /** @type {{ id: string | null, title: string | null }} */
  const head = { id: null, title: null };
  for (const line of text.split('\n', 8)) {
    try {
      const entry = JSON.parse(line);
      if (entry?.type === 'title' && typeof entry.title === 'string') head.title = entry.title.replace(/\p{Co}/gu, '').trim() || null;
      if (entry?.type === 'session' && typeof entry.id === 'string') head.id = entry.id;
    } catch {}
  }
  return head;
}

/** A journal's artifacts folder (tool output logs, subagents), beside it. @param {string} file */
const artifactsOf = (file) => (file.endsWith('.jsonl') ? file.slice(0, -'.jsonl'.length) : null);

/**
 * @param {{
 *   hub: Pick<Hub, 'create' | 'get' | 'writing' | 'working' | 'subscribe'>, forks: ForksStore, scratchDir: string,
 *   nameFork: (prompt: string, sourceTitle: string | null) => Promise<string>,
 * }} options
 *   `scratchDir` holds the cut copies of journals forked mid-turn while their fork starts;
 *   `nameFork` titles a fork from its first prompt (fork-title.js)
 */
export function createForker({ hub, forks, scratchDir, nameFork }) {
  /**
   * Forks starting, by session: the conversation they came from, the prompt they get once
   * ready, and the cut copy they were started from (with the source whose artifacts it lacks).
   * @type {Map<string, { parent: string | null, prompt: string | null, cut: { file: string, source: string } | null, recorded: boolean }>}
   */
  const starting = new Map();
  /** The title each session had when omp last said, by session: a fork's is its source's until it is named. @type {Map<string, string | null>} */
  const titles = new Map();

  /** @param {string} id session @param {SessionMeta} meta */
  async function settle(id, meta) {
    const fork = starting.get(id);
    if (!fork) return;
    starting.delete(id);
    if (fork.cut) {
      // omp copies the artifacts beside the journal it forks: the cut copy has none.
      const from = artifactsOf(fork.cut.source);
      const to = meta.sessionFile && artifactsOf(meta.sessionFile);
      if (from && to && meta.status === 'ready' && (await stat(from).catch(() => null))?.isDirectory()) {
        await mkdir(to, { recursive: true }).catch(() => {});
        await cp(from, to, { recursive: true, force: false, errorOnExist: false }).catch((err) => console.error(`[daemon] could not copy a fork's artifacts (${from}):`, err));
      }
      await unlink(fork.cut.file).catch(() => {});
    }
    const session = hub.get(id);
    if (fork.prompt && meta.status === 'ready' && session) {
      const res = await session.command({ type: 'prompt', message: fork.prompt }).response.catch((err) => ({ success: false, error: String(err) }));
      if (!res.success) console.error(`[daemon] a fork did not take its prompt: ${'error' in res ? res.error : 'refused'}`);
    }
  }

  /**
   * Names fork `ompId`, held by session `id`, from its first prompt: by the prompt's first line
   * at once (unless it was forked with that prompt, and has that title already), then by the
   * model's title, which the conversation is renamed to as well.
   * @param {string} id @param {string} ompId @param {string} prompt
   */
  async function name(id, ompId, prompt) {
    await forks.named(ompId);
    if (forks.all()[ompId]?.title === null) await forks.titled(ompId, fallbackForkTitle(prompt));
    const title = await nameFork(prompt, titles.get(id) ?? null);
    await forks.titled(ompId, title);
    const session = hub.get(id);
    // Asleep meanwhile: listed by its title, its journal keeps its source's.
    if (!session || session.meta().status !== 'ready' || session.meta().ompId !== ompId) return;
    await session.command({ type: 'prompt', message: `/rename ${title}` }).response.catch(() => {});
  }

  hub.subscribe((event) => {
    if (event.kind === 'frame') {
      const frame = /** @type {Record<string, any>} */ (event.frame);
      if (frame.type === 'response' && frame.command === 'get_state' && frame.success) titles.set(event.session, typeof frame.data?.sessionName === 'string' ? frame.data.sessionName : null);
      const ompId = hub.get(event.session)?.meta().ompId;
      // A bare continue (`.`) says nothing to name the fork by: the next prompt names it.
      if (frame.type === 'message_end' && frame.message?.role === 'user') {
        const prompt = contentText(frame.message.content).trim();
        if (ompId && prompt && forks.unnamed(ompId) && !isContinueDirective(prompt)) void name(event.session, ompId, prompt);
      }
      // Renamed (by the naming above, or by the user's `/rename`): listed so from now on.
      if (frame.type === 'session_info_update' && typeof frame.title === 'string' && frame.title.trim() && ompId && forks.all()[ompId]) void forks.titled(ompId, frame.title.trim());
      return;
    }
    if (event.kind !== 'session') return;
    const { meta } = event;
    const fork = starting.get(event.session);
    if (fork && !fork.recorded && fork.parent && meta.ompId) {
      fork.recorded = true;
      void forks.add(meta.ompId, fork.parent, fork.prompt ? fallbackForkTitle(fork.prompt) : null);
    }
    if (meta.status === 'exited' || meta.status === 'failed') titles.delete(event.session);
    if (fork && meta.status !== 'starting') void settle(event.session, meta);
  });

  return {
    /**
     * Starts a fork of the conversation in journal `file`, in `cwd`: as of its last completed
     * response while its agent is working; `prompt`, if given, goes to the fork once it is ready.
     * @param {{ cwd: string, file: string, prompt: string | null }} options
     * @returns {Promise<SessionMeta>}
     */
    async fork({ cwd, file, prompt }) {
      const text = await Bun.file(file).text();
      const head = journalHead(text);
      const holder = hub.writing(file);
      const settled = holder && hub.working(holder.id) ? settledJournal(text) : null;
      /** @type {{ file: string, source: string } | null} */
      let cut = null;
      if (settled !== null) {
        await mkdir(scratchDir, { recursive: true, mode: 0o700 });
        cut = { file: join(scratchDir, `${randomUUID()}.jsonl`), source: file };
        await Bun.write(cut.file, settled);
      }
      const meta = hub.create({ cwd, resume: null, fork: cut?.file ?? file });
      starting.set(meta.id, { parent: head.id && OMP_ID.test(head.id) ? head.id : null, prompt: prompt?.trim() || null, cut, recorded: false });
      return meta;
    },
  };
}

/** @typedef {ReturnType<typeof createForker>} Forker */
