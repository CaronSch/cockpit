/**
 * Conversations as the Sessions window lists them, kept free of the DOM so they can be
 * tested: every journal with the session holding it while one is awake, how each is doing,
 * and what an agent window is given to show one.
 *
 * Asleep or awake is the daemon's business (daemon/sleep.js): the list shows conversations.
 * How an awake one is doing is the daemon's summary of its session's events (`SessionActivity`):
 * its name, whether a turn runs, whether it asks its user something and what work it has
 * running; and whether the user has read what it did (daemon/unread.js). The desktop's
 * notifications follow sessions' events themselves (`follow`, sessions/notify.js).
 *
 * A conversation is named by its journal; a new one's session names it before omp has
 * written it (and a session's journal is reported as it starts), so `conversationKey` is the
 * journal, else the session.
 */
import { applyEvent, conversationName, createTranscript } from '../omp/transcript.js';
/** @import { PastSession, SessionActivity, SessionEvent, SessionMeta } from '../../daemon/wire.js' */
/** @import { LeafParams } from '../layout/grid-model.js' */
/** @import { Transcript } from '../omp/transcript.js' */

/** @typedef {'starting' | 'asking' | 'working' | 'done' | 'idle'} RunningState */
/** What the notifier follows of one running session, from its events. @typedef {{ transcript: Transcript }} Followed */

/** A conversation the list shows: a journal, with the session holding it while it is awake. @typedef {PastSession & { key: string, meta: SessionMeta | null }} Listed */

/** @param {SessionMeta} meta */
export const isRunning = (meta) => meta.status === 'starting' || meta.status === 'ready';

/** What names a conversation: its journal, else (not yet known) its session. @param {{ sessionFile: string | null, session: string | null }} of */
export const conversationKey = ({ sessionFile, session }) => sessionFile ?? session;

/**
 * The conversations to list: every journal the daemon listed (`past`), each with the awake
 * session holding it, and the awake sessions whose journal is not listed (a new one omp has
 * not written yet, or one kept elsewhere), unless searching (their journals did not match);
 * only those in `directory` when one is given. Unordered.
 * @param {readonly PastSession[]} past @param {readonly SessionMeta[]} metas
 * @param {{ searching: boolean, directory: string | null }} options @returns {Listed[]}
 */
export function listConversations(past, metas, { searching, directory }) {
  const awake = metas.filter(isRunning);
  const holding = new Map(awake.flatMap((m) => (m.sessionFile ? [[m.sessionFile, m]] : [])));
  const files = new Set(past.map((s) => s.file));
  const unlisted = searching ? [] : awake.filter((m) => !m.sessionFile || !files.has(m.sessionFile));
  return [
    ...past.map((s) => ({ ...s, key: s.file, meta: holding.get(s.file) ?? null })),
    ...unlisted.map((m) => ({
      file: m.sessionFile ?? '',
      id: m.ompId ?? m.id,
      title: null,
      cwd: m.cwd,
      createdAt: m.startedAt,
      modifiedAt: m.startedAt,
      prompts: 0,
      firstPrompt: null,
      key: /** @type {string} */ (conversationKey({ sessionFile: m.sessionFile, session: m.id })),
      meta: m,
    })),
  ].filter((c) => !directory || c.cwd === directory);
}

/** @returns {Followed} */
export const follow = () => ({ transcript: createTranscript() });

/** @param {Followed} followed @param {SessionEvent} event */
export function noteEvent(followed, event) {
  applyEvent(followed.transcript, event);
}

/**
 * How an awake conversation is doing: still starting (or not summed up by the daemon yet),
 * asking its user something (a question or an approval, read or not: it waits until they
 * answer), working on a turn, done (it handed the turn back and they have not read it yet), or
 * idle.
 * @param {SessionActivity | null} activity @param {SessionMeta} meta @param {boolean} unread
 * @returns {RunningState}
 */
export function runningState(activity, meta, unread) {
  if (meta.status === 'starting' || !activity) return 'starting';
  if (activity.asking) return 'asking';
  if (activity.working) return 'working';
  return unread ? 'done' : 'idle';
}

/** How each state reads in the list: a short word. @type {Readonly<Record<RunningState, string>>} */
export const STATE_LABELS = Object.freeze({ starting: 'starting', asking: 'needs you', working: 'working', done: 'done', idle: 'idle' });

/** What the session is called: its title, else its first prompt (as an agent window names it). @param {Followed} followed */
export const followedName = (followed) => conversationName(followed.transcript);

/**
 * The settings that make an agent window show a conversation (whatever it showed before): its
 * journal, and the session holding it if one is awake.
 * @param {{ file: string | null, meta: SessionMeta | null, cwd: string | null, name: string | null }} conversation
 * @returns {LeafParams}
 */
export const showConversation = ({ file, meta, cwd, name }) => ({
  session: meta?.id ?? null,
  sessionFile: file || meta?.sessionFile || null,
  cwd: cwd ?? meta?.cwd ?? null,
  name,
  fork: null,
  prompt: null,
});
