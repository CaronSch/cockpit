/**
 * Which omp conversations the user pinned to the top of the Sessions list: kept in one small
 * file in the state directory, so a pin outlives windows, browsers, daemon restarts and the
 * session itself. Like unread marks (unread.js) a conversation is named by omp's id for it,
 * which archiving and resuming keep.
 *
 * `<file>`: `{ version: 1, pinned: [id, …] }`, oldest pin first, written whole after every
 * change (write-then-rename, one write at a time). A file that cannot be read as one stops the
 * daemon from starting, naming the file, rather than being replaced.
 */
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { OMP_ID } from './unread.js';

const VERSION = 1;

/** The pinned conversations' omp ids, oldest pin first. @typedef {readonly string[]} Pinned */

/** @param {any} data parsed untrusted JSON @returns {data is { version: 1, pinned: string[] }} */
const isPinsFile = (data) => data?.version === VERSION && Array.isArray(data.pinned) && data.pinned.every((/** @type {unknown} */ id) => typeof id === 'string' && OMP_ID.test(id));

/**
 * Loads the pins kept in `file` (none if it does not exist yet).
 * @param {{ file: string }} options
 */
export async function loadPins({ file }) {
  /** @type {Pinned} */
  let pinned = [];
  const stored = Bun.file(file);
  if (await stored.exists()) {
    /** @type {any} */
    let data;
    try {
      data = JSON.parse(await stored.text());
    } catch {}
    if (!isPinsFile(data)) throw new Error(`${file} is not a pins file this daemon can read; fix it or move it away`);
    pinned = data.pinned;
  }
  /** @type {Set<(pinned: Pinned) => void>} */
  const listeners = new Set();
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();
  let tmpSeq = 0;

  async function store() {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    // Write-then-rename: a crash mid-write leaves the old pins, never half of the new ones.
    const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ version: VERSION, pinned }, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
  }

  /** Pins or unpins conversation `id`. @param {string} id @param {boolean} pin */
  function set(id, pin) {
    if (pinned.includes(id) === pin) return queue;
    pinned = pin ? [...pinned, id] : pinned.filter((p) => p !== id);
    for (const fn of listeners) fn(pinned);
    // Each write stores the pins as they are when it runs, so the last one leaves the newest.
    queue = queue.then(store).catch((err) => console.error(`[daemon] could not save ${file}:`, err));
    return queue;
  }

  return {
    /** @returns {Pinned} */
    all: () => pinned,
    set,
    /** Hears every change, with all the pins. @param {(pinned: Pinned) => void} fn */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** @typedef {Awaited<ReturnType<typeof loadPins>>} PinsStore */
