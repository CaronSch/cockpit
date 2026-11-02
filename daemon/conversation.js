/**
 * A conversation read from its journal, for a window to show while no omp process holds it:
 * the messages omp's `get_messages` would answer with once resumed, so the transcript seeds
 * from either the same way, and what the journal records about the session around them.
 *
 * Unlike omp's context, it is the whole conversation: a compaction is a summary where it
 * happened, and what it summarised stays before it.
 *
 * A journal is a tree: each entry names its parent (`parentId`), a rewind (`branch`) starts a
 * new path from an earlier entry, and the newest entry ends the path the conversation is on.
 * That path's entries become messages as omp's own session context makes them
 * (`buildSessionContext`): a `message` entry is its message, minus tool results omp marked
 * `useless`; a `custom_message` is a `custom` message; `branch_summary` and `compaction` are
 * their summaries. Model and thinking level are the path's last changes. A journal whose
 * entries carry no ids (one written by hand, or the test fake) is a single path, in order.
 */
/** @import { Conversation } from './wire.js' */

/** @param {unknown} timestamp ISO time, as journals write it @returns {number} */
const epoch = (timestamp) => {
  const at = Date.parse(String(timestamp));
  return Number.isFinite(at) ? at : 0;
};

/** The entries of the path the conversation is on, oldest first. @param {Record<string, any>[]} entries */
function currentPath(entries) {
  const linked = entries.filter((e) => typeof e.id === 'string');
  if (!linked.length) return entries;
  const byId = new Map(linked.map((e) => [e.id, e]));
  const path = [];
  for (let e = linked.at(-1); e; e = byId.get(e.parentId)) path.push(e);
  return path.reverse();
}

/** @param {Record<string, any>} entry @returns {Record<string, any> | null} */
function messageOf(entry) {
  switch (entry.type) {
    case 'message': {
      const m = entry.message;
      if (!m || typeof m !== 'object') return null;
      return m.role === 'toolResult' && m.useless === true && m.isError !== true ? null : m;
    }
    case 'custom_message':
      return { role: 'custom', customType: entry.customType, content: entry.content, display: entry.display, details: entry.details, attribution: entry.attribution, timestamp: epoch(entry.timestamp) };
    case 'branch_summary':
      return { role: 'branchSummary', summary: entry.summary, fromId: entry.fromId, timestamp: epoch(entry.timestamp) };
    case 'compaction':
      return { role: 'compactionSummary', summary: entry.summary, shortSummary: entry.shortSummary, tokensBefore: entry.tokensBefore, timestamp: epoch(entry.timestamp) };
    default:
      return null;
  }
}

/**
 * The conversation in a journal's lines, or null without a session header.
 * @param {string} file @param {string} text the journal @returns {Conversation | null}
 */
export function conversationOf(file, text) {
  /** @type {Record<string, any>[]} */
  const entries = [];
  // A torn last write is skipped, as the Sessions list skips it.
  for (const line of text.split('\n')) {
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === 'object') entries.push(entry);
    } catch {}
  }
  const header = entries.find((e) => e.type === 'session');
  if (typeof header?.id !== 'string') return null;
  const title = entries.find((e) => e.type === 'title' && typeof e.title === 'string')?.title;
  const path = currentPath(entries.filter((e) => e.type !== 'title' && e.type !== 'session'));
  const last = (/** @type {string} */ type, /** @type {string} */ key) => path.findLast((e) => e.type === type && typeof e[key] === 'string')?.[key] ?? null;
  return {
    file,
    id: header.id,
    cwd: typeof header.cwd === 'string' ? header.cwd : null,
    // omp's auto-titles start with a nerd-font icon (a private-use character); browsers show a box.
    title: title?.replace(/\p{Co}/gu, '').trim() || null,
    model: last('model_change', 'model'),
    thinkingLevel: last('thinking_level_change', 'thinkingLevel'),
    messages: path.flatMap((e) => messageOf(e) ?? []),
  };
}
