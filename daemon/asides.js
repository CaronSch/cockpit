/**
 * Side questions asked with `/btw`, kept: omp keeps a side question's answer only while its
 * session runs, so the daemon saves each one omp reports done (its `btw_record`), and an agent
 * window shows it where it was asked after a reload, sleep or restart too (omp/transcript.js
 * `addAsides`). Questions about a quote (Ask) are not kept here: their annotations keep them
 * (annotations.js).
 *
 * `<dir>/<ompId>.json` (state-file.js): `{ version: 1, asides: Aside[] }`, oldest first; moved
 * with a rewind to the conversation's new id.
 */
import { join } from 'node:path';
import { loadStateFile } from './state-file.js';
import { OMP_ID } from './unread.js';
import { btwAsked } from '../src/omp/message.js';

const VERSION = 1;
/** How a side question can end; one still running is not kept. */
const ENDED = new Set(['complete', 'cancelled', 'error', 'interrupted']);

/**
 * A `/btw` side question and how omp answered it, `createdAt` when it was asked (epoch ms).
 * @typedef {{ id: string, question: string, answer: string, status: 'complete' | 'cancelled' | 'error' | 'interrupted', error: string | null, createdAt: number }} Aside
 */

/** @param {any} a parsed untrusted JSON @returns {a is Aside} */
const isAside = (a) =>
  typeof a?.id === 'string' &&
  typeof a.question === 'string' &&
  typeof a.answer === 'string' &&
  ENDED.has(a.status) &&
  (a.error === null || typeof a.error === 'string') &&
  Number.isFinite(a.createdAt);

/** @param {any} data parsed untrusted JSON @returns {data is { version: 1, asides: Aside[] }} */
const isAsidesFile = (data) => data?.version === VERSION && Array.isArray(data.asides) && data.asides.every(isAside);

/**
 * The `/btw` side question omp's `btw_record` reports, once it has ended; null for one still
 * running, or one about a quote (Ask).
 * @param {any} record omp's BtwHistoryRecord @returns {Aside | null}
 */
export function endedAside(record) {
  if (typeof record?.id !== 'string' || !ENDED.has(record.status)) return null;
  const question = btwAsked(String(record.question ?? ''));
  if (question === null) return null;
  return {
    id: record.id,
    question,
    answer: String(record.answer ?? ''),
    status: record.status,
    error: typeof record.error === 'string' ? record.error : null,
    createdAt: Number.isFinite(record.createdAt) ? record.createdAt : Date.now(),
  };
}

/** @param {{ dir: string }} options */
export function createAsides({ dir }) {
  /** @type {Map<string, ReturnType<typeof load>>} */
  const stores = new Map();
  /** @type {Set<(ompId: string, asides: Aside[]) => void>} */
  const listeners = new Set();

  /** @param {string} file */
  function load(file) {
    return loadStateFile({
      file,
      what: 'a side questions file',
      initial: /** @type {Aside[]} */ ([]),
      read: (data) => (isAsidesFile(data) ? data.asides : null),
      write: (asides) => ({ version: VERSION, asides }),
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
    }
    return store;
  }

  /** @param {string} ompId @param {Aside[]} asides */
  const changed = (ompId, asides) => {
    for (const fn of listeners) fn(ompId, asides);
  };

  return {
    /** Conversation `ompId`'s side questions, oldest first. @param {string} ompId @returns {Promise<Aside[]>} */
    async list(ompId) {
      return OMP_ID.test(ompId) ? (await storeOf(ompId)).get() : [];
    },
    /**
     * omp reported side question `record` in conversation `ompId`: kept once it has ended (a
     * later report of it replaces it).
     * @param {string} ompId @param {any} record omp's BtwHistoryRecord
     */
    async heard(ompId, record) {
      const aside = endedAside(record);
      if (!aside || !OMP_ID.test(ompId)) return;
      const store = await storeOf(ompId);
      const kept = store.get();
      const before = kept.find((a) => a.id === aside.id);
      if (before && JSON.stringify(before) === JSON.stringify(aside)) return;
      const next = before ? kept.map((a) => (a.id === aside.id ? aside : a)) : [...kept, aside];
      await store.set(next);
      changed(ompId, next);
    },
    /** A rewound conversation goes on under id `to`: its side questions go with it. @param {string} from @param {string} to */
    async moved(from, to) {
      if (!OMP_ID.test(from) || !OMP_ID.test(to)) return;
      const source = await storeOf(from);
      const asides = source.get();
      if (!asides.length) return;
      const target = await storeOf(to);
      const next = [...target.get(), ...asides.filter((a) => !target.get().some((b) => b.id === a.id))];
      await target.set(next);
      await source.set([]);
      changed(to, next);
      changed(from, []);
    },
    /** Hears every change to a conversation's side questions, with all of them. @param {(ompId: string, asides: Aside[]) => void} fn */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** @typedef {ReturnType<typeof createAsides>} Asides */
