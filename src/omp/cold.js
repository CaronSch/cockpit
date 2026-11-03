/**
 * When an agent window dims: its conversation has been quiet past the point at which idle
 * compaction (daemon/idle-compaction.js) compacts a long one, 54 minutes after the last model
 * request, so its prompt cache is about to expire and the next message reads the conversation
 * in full. It applies to every conversation, whatever its length, and whether that setting is
 * on or not. Kept free of the DOM so it can be tested.
 */
/** @import { Transcript } from './transcript.js' */

/**
 * When the conversation goes, or went, quiet past the cutoff: `afterMs` after the newer of its
 * last model request and the user's last prompt (one just sent wakes it before its request is
 * made); null while the agent works or asks something, or before anything was said.
 * @param {Pick<Transcript, 'items' | 'streaming' | 'dialogs'>} state @param {number} afterMs
 * @returns {number | null}
 */
export function coldAt(state, afterMs) {
  if (state.streaming || state.dialogs.length > 0) return null;
  let last = null;
  for (const item of state.items) {
    const at = item.kind === 'assistant' || (item.kind === 'user' && !item.byAgent) ? item.at : null;
    if (at !== null && (last === null || at > last)) last = at;
  }
  return last === null ? null : last + afterMs;
}
