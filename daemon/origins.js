/**
 * Which workspace each conversation was started in, so the Sessions window can list a
 * workspace's conversations, open in one of its windows or not (src/widgets/sessions.js).
 *
 * An agent window says which workspace it is in as it starts a conversation or a fork
 * (`POST /api/sessions` `workspace`); the conversation is named by omp's id for it, which omp
 * tells only once it is up, so the daemon notes the session until then (`expect`, `heard`). A
 * resumed conversation keeps where it was started; a rewound one, which goes on under a new id,
 * is moved there. Conversations from before this was kept have none.
 *
 * `<file>` (state-file.js): `{ version: 1, origins: { [ompId]: workspaceId } }`.
 */
import { loadStateFile } from './state-file.js';
import { OMP_ID } from './unread.js';
import { WORKSPACE_ID } from '../src/workspace/model.js';
/** @import { SessionEvent } from './wire.js' */

const VERSION = 1;

/** The workspace each conversation was started in, by omp id. @typedef {Readonly<Record<string, string>>} Origins */

/** @param {any} data parsed untrusted JSON @returns {data is { version: 1, origins: Record<string, string> }} */
const isOriginsFile = (data) =>
  data?.version === VERSION &&
  data.origins !== null &&
  typeof data.origins === 'object' &&
  !Array.isArray(data.origins) &&
  Object.entries(data.origins).every(([id, ws]) => OMP_ID.test(id) && typeof ws === 'string' && WORKSPACE_ID.test(ws));

/**
 * Loads the origins kept in `file` (none if it does not exist yet).
 * @param {{ file: string }} options
 */
export async function loadOrigins({ file }) {
  const store = await loadStateFile({
    file,
    what: 'an origins file',
    initial: /** @type {Origins} */ ({}),
    read: (data) => (isOriginsFile(data) ? data.origins : null),
    write: (origins) => ({ version: VERSION, origins }),
  });
  /** Sessions started in a workspace whose omp id is not known yet, by session id. @type {Map<string, string>} */
  const pending = new Map();

  /** @param {string} ompId @param {string} workspace */
  const set = (ompId, workspace) => (store.get()[ompId] === workspace ? Promise.resolve() : store.set({ ...store.get(), [ompId]: workspace }));

  return {
    all: store.get,
    /** Session `session` was started in `workspace`: noted once omp says which conversation it holds. @param {string} session @param {string} workspace */
    expect(session, workspace) {
      pending.set(session, workspace);
    },
    /** Follows the hub's events, for the omp id of each session expected. @param {SessionEvent} event */
    heard(event) {
      if (event.kind !== 'session') return;
      const workspace = pending.get(event.session);
      if (workspace === undefined) return;
      if (event.meta.status === 'exited' || event.meta.status === 'failed') pending.delete(event.session);
      if (!event.meta.ompId) return;
      pending.delete(event.session);
      void set(event.meta.ompId, workspace);
    },
    /** A rewound conversation goes on as `to`: where it was started goes with it. @param {string} from @param {string} to */
    moved(from, to) {
      const workspace = store.get()[from];
      if (workspace === undefined) return Promise.resolve();
      const { [from]: _gone, ...rest } = store.get();
      return store.set({ ...rest, [to]: workspace });
    },
    /** Hears every change, with all the origins. */
    subscribe: store.subscribe,
  };
}

/** @typedef {Awaited<ReturnType<typeof loadOrigins>>} OriginsStore */
