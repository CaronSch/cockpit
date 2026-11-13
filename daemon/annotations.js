/**
 * Annotations: the comments and questions the user left on parts of an agent's replies, as in
 * Google Docs, so the text they are on stays highlighted in every agent window showing the
 * conversation and a click on it shows them again (src/omp/annotation-marks.js). A comment is
 * kept from the moment it is posted, whether or not the prompt it goes with is sent; a question
 * keeps the side answers omp gave it (its `btw`, which omp keeps nowhere once its session ends).
 *
 * Kept per conversation, by omp's id, in `<dir>/<ompId>.json` (state-file.js): `{ version: 1,
 * annotations: Annotation[] }`, oldest first. A rewind moves them to the conversation's new id;
 * a fork starts without any.
 */
import { join } from 'node:path';
import { loadStateFile } from './state-file.js';

const VERSION = 1;
/** The longest quote kept: a passage, not a reply. */
const MAX_QUOTE_CHARS = 20_000;
/** The longest comment or question kept. */
const MAX_TEXT_CHARS = 20_000;
/** The longest answer kept. */
const MAX_ANSWER_CHARS = 100_000;
/** The most questions one thread keeps. */
const MAX_THREAD = 100;

/**
 * One question asked about an annotation's quote, with omp's answer as it ended: `interrupted`
 * while (or since) the answer was on its way when it was kept.
 * @typedef {{ question: string, answer: string, status: 'complete' | 'cancelled' | 'error' | 'interrupted', error: string | null }} AnnotationQA
 */
/**
 * A comment on, or questions about, part of an assistant message: the message is named by its
 * `at` (omp's timestamp for it, the same live and in the journal), the part by its text,
 * `quote`, and which `occurrence` of that text in the message it is (0 for the first). A
 * comment has `comment` and no thread; a question, a thread and no comment.
 * @typedef {{
 *   id: string, kind: 'comment' | 'ask', at: number, quote: string, occurrence: number,
 *   comment: string | null, thread: AnnotationQA[], createdAt: number,
 * }} Annotation
 */
/** What a new annotation is made of: all but what the daemon gives it. @typedef {Omit<Annotation, 'id' | 'createdAt'>} NewAnnotation */
/** What may change of an annotation. @typedef {{ comment?: string, thread?: AnnotationQA[] }} AnnotationPatch */

/** Why an annotation was not changed, with the HTTP status it answers with. */
export class AnnotationRefused extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** @param {unknown} s @param {number} max @returns {s is string} */
const text = (s, max) => typeof s === 'string' && s.length <= max;
/** @param {unknown} s @param {number} max @returns {s is string} */
const words = (s, max) => text(s, max) && s.trim() !== '';

/** @param {any} qa @returns {qa is AnnotationQA} */
const isQA = (qa) =>
  words(qa?.question, MAX_TEXT_CHARS) &&
  text(qa.answer, MAX_ANSWER_CHARS) &&
  ['complete', 'cancelled', 'error', 'interrupted'].includes(qa.status) &&
  (qa.error === null || text(qa.error, MAX_TEXT_CHARS));

/** @param {any} thread @returns {thread is AnnotationQA[]} */
const isThread = (thread) => Array.isArray(thread) && thread.length <= MAX_THREAD && thread.every(isQA);

/** @param {any} a untrusted JSON @returns {a is NewAnnotation} */
const isNew = (a) =>
  (a?.kind === 'comment' ? words(a.comment, MAX_TEXT_CHARS) && Array.isArray(a.thread) && a.thread.length === 0 : a?.kind === 'ask' && a.comment === null && isThread(a.thread)) &&
  Number.isFinite(a.at) &&
  words(a.quote, MAX_QUOTE_CHARS) &&
  Number.isInteger(a.occurrence) &&
  a.occurrence >= 0;

/** @param {any} a untrusted JSON @returns {a is Annotation} */
const isAnnotation = (a) => typeof a?.id === 'string' && Number.isFinite(a.createdAt) && isNew(a);

/** @param {any} data untrusted JSON @returns {data is { version: 1, annotations: Annotation[] }} */
const isFile = (data) => data?.version === VERSION && Array.isArray(data.annotations) && data.annotations.every(isAnnotation);

/**
 * @param {{ dir: string, now?: () => number }} options `dir` holds a file per conversation
 */
export function createAnnotations({ dir, now = Date.now }) {
  /** Each conversation's annotations, loaded when first needed. @type {Map<string, ReturnType<typeof load>>} */
  const stores = new Map();
  /** @type {Set<(ompId: string, annotations: Annotation[]) => void>} */
  const listeners = new Set();

  /** @param {string} file */
  function load(file) {
    return loadStateFile({
      file,
      what: 'an annotations file',
      initial: /** @type {Annotation[]} */ ([]),
      read: (data) => (isFile(data) ? data.annotations : null),
      write: (annotations) => ({ version: VERSION, annotations }),
    });
  }

  /** @param {string} ompId */
  function storeOf(ompId) {
    let store = stores.get(ompId);
    if (!store) {
      store = load(join(dir, `${ompId}.json`));
      stores.set(ompId, store);
      // A file that cannot be read is named again next time, not cached broken.
      store.catch(() => stores.delete(ompId));
      // Every change is heard by every page, with the conversation's annotations as they are now.
      void store.then((s) => s.subscribe((all) => listeners.forEach((fn) => fn(ompId, all))));
    }
    return store;
  }

  /** @param {Annotation[]} all @param {string} id */
  function find(all, id) {
    const found = all.find((a) => a.id === id);
    if (!found) throw new AnnotationRefused(404, 'no such annotation');
    return found;
  }

  return {
    /** Conversation `ompId`'s annotations, oldest first. @param {string} ompId @returns {Promise<Annotation[]>} */
    list: async (ompId) => (await storeOf(ompId)).get(),
    /**
     * Keeps a new annotation (untrusted: from the page) on conversation `ompId`.
     * @param {string} ompId @param {unknown} input @returns {Promise<Annotation>}
     */
    async add(ompId, input) {
      if (!isNew(input)) throw new AnnotationRefused(400, 'expected { kind, at, quote, occurrence, comment, thread } (a comment with no thread, or questions with no comment)');
      const { kind, at, quote, occurrence, comment, thread } = input;
      /** @type {Annotation} */
      const annotation = { id: crypto.randomUUID(), kind, at, quote, occurrence, comment, thread, createdAt: now() };
      const store = await storeOf(ompId);
      await store.set([...store.get(), annotation]);
      return annotation;
    },
    /**
     * Changes annotation `id`'s comment (a comment's) or thread (a question's).
     * @param {string} ompId @param {string} id @param {unknown} patch @returns {Promise<Annotation>}
     */
    async update(ompId, id, patch) {
      const store = await storeOf(ompId);
      const current = find(store.get(), id);
      const p = /** @type {any} */ (patch);
      const ok =
        p !== null &&
        typeof p === 'object' &&
        Object.keys(p).every((k) => k === 'comment' || k === 'thread') &&
        (p.comment === undefined || (current.kind === 'comment' && words(p.comment, MAX_TEXT_CHARS))) &&
        (p.thread === undefined || (current.kind === 'ask' && isThread(p.thread)));
      if (!ok) throw new AnnotationRefused(400, 'expected { comment: string } for a comment or { thread } for a question');
      /** @type {Annotation} */
      const next = { ...current, ...(p.comment !== undefined ? { comment: p.comment } : {}), ...(p.thread !== undefined ? { thread: p.thread } : {}) };
      await store.set(store.get().map((a) => (a.id === id ? next : a)));
      return next;
    },
    /** Forgets annotation `id`. @param {string} ompId @param {string} id */
    async remove(ompId, id) {
      const store = await storeOf(ompId);
      find(store.get(), id);
      await store.set(store.get().filter((a) => a.id !== id));
    },
    /** A rewound conversation goes on under id `to`: its annotations go with it. @param {string} from @param {string} to */
    async moved(from, to) {
      const source = await storeOf(from);
      const moving = source.get();
      if (!moving.length) return;
      const target = await storeOf(to);
      await target.set([...target.get(), ...moving]);
      await source.set([]);
    },
    /** Hears every change to a conversation's annotations, with all of them. @param {(ompId: string, annotations: Annotation[]) => void} fn */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** @typedef {ReturnType<typeof createAnnotations>} Annotations */
