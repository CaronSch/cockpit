/**
 * Which omp conversations have news their user has not read: kept in one small file in the
 * state directory, so a mark outlives windows, browsers, daemon restarts and the session
 * itself (a stopped session is a past one, still unread).
 *
 * A conversation is named by omp's id for it (the journal header's `id`: PastSession `id`,
 * SessionMeta `ompId`), which archiving and resuming keep. Each unread one maps to the daemon
 * time it became unread: when its agent last waited on the user (`awaited`, see
 * src/omp/activity.js), or when the user marked it unread. Reading it up to a time (`read`)
 * clears the mark unless it became unread after that time, so a read sent from a window that
 * had not heard of newer news never clears it. Only unread conversations are stored.
 *
 * `<file>` (state-file.js): `{ version: 1, unread: { [id]: since } }`.
 */
import { daemonNow } from './clock.js';
import { loadStateFile } from './state-file.js';

const VERSION = 1;

/** omp's conversation ids: uuids (fixtures use plain words); nothing that could be a path. */
export const OMP_ID = /^[\w.-]{1,128}$/;

/** When each unread conversation became unread, by omp id. @typedef {Readonly<Record<string, number>>} Unread */

/**
 * The mark after the agent waited on its user, or the user marked it, at `at`: unread since
 * the latest of those.
 * @param {Unread} unread @param {string} id @param {number} at @returns {Unread}
 */
export const markUnread = (unread, id, at) => ((unread[id] ?? -Infinity) >= at ? unread : { ...unread, [id]: at });

/**
 * The marks after the user read conversation `id` as it was at `at`: cleared, unless it
 * became unread after that.
 * @param {Unread} unread @param {string} id @param {number} at @returns {Unread}
 */
export function markRead(unread, id, at) {
  if (!(id in unread) || unread[id] > at) return unread;
  const rest = { ...unread };
  delete rest[id];
  return rest;
}

/** @param {any} data parsed untrusted JSON @returns {data is { version: 1, unread: Record<string, number> }} */
const isUnreadFile = (data) =>
  data?.version === VERSION &&
  data.unread !== null &&
  typeof data.unread === 'object' &&
  !Array.isArray(data.unread) &&
  Object.entries(data.unread).every(([id, at]) => OMP_ID.test(id) && Number.isFinite(at));

/**
 * Loads the marks kept in `file` (none if it does not exist yet).
 * @param {{ file: string, now?: () => number }} options
 */
export async function loadUnread({ file, now = daemonNow }) {
  const marks = await loadStateFile({
    file,
    what: 'an unread file',
    initial: /** @type {Unread} */ ({}),
    read: (data) => (isUnreadFile(data) ? data.unread : null),
    write: (unread) => ({ version: VERSION, unread }),
  });
  return {
    all: marks.get,
    /** The agent of conversation `id` waited on its user at `at` (daemon time). @param {string} id @param {number} at */
    awaited: (id, at) => marks.set(markUnread(marks.get(), id, at)),
    /** The user marked conversation `id` unread, now. @param {string} id */
    unread: (id) => marks.set(markUnread(marks.get(), id, now())),
    /** The user read conversation `id` as it was at `at`. @param {string} id @param {number} at */
    read: (id, at) => marks.set(markRead(marks.get(), id, at)),
    /** Hears every change, with all the marks. */
    subscribe: marks.subscribe,
  };
}

/** @typedef {Awaited<ReturnType<typeof loadUnread>>} UnreadStore */
