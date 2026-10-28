/**
 * Which omp conversations the user pinned to the top of the Sessions list: kept in one small
 * file in the state directory, so a pin outlives windows, browsers, daemon restarts and the
 * session itself. Like unread marks (unread.js) a conversation is named by omp's id for it,
 * which archiving and resuming keep.
 *
 * `<file>` (state-file.js): `{ version: 1, pinned: [id, …] }`, oldest pin first.
 */
import { loadStateFile } from './state-file.js';
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
  const pins = await loadStateFile({
    file,
    what: 'a pins file',
    initial: /** @type {Pinned} */ ([]),
    read: (data) => (isPinsFile(data) ? data.pinned : null),
    write: (pinned) => ({ version: VERSION, pinned }),
  });
  return {
    all: pins.get,
    /** Pins or unpins conversation `id`. @param {string} id @param {boolean} pin */
    set(id, pin) {
      const pinned = pins.get();
      if (pinned.includes(id) === pin) return Promise.resolve();
      return pins.set(pin ? [...pinned, id] : pinned.filter((p) => p !== id));
    },
    /** Hears every change, with all the pins. */
    subscribe: pins.subscribe,
  };
}

/** @typedef {Awaited<ReturnType<typeof loadPins>>} PinsStore */
