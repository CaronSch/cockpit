/**
 * Idle compaction, as Claude Code does it: a long conversation left idle is compacted shortly
 * before its prompt cache expires, while the summary request can still read the conversation
 * from the cache, so coming back later sends a summary instead of the whole conversation at
 * full price.
 *
 * It applies when the latest model request wrote a one-hour cache entry (Anthropic's long
 * tier, reported in `usage.cttl.ephemeral1h`) and the conversation is at least `minTokens`
 * long. It is due 90% of the way through that entry's life, timed from the request (when the
 * reply started streaming): 54 minutes. A newer request moves it; one that changes the cached
 * prefix (another model or thinking level, a compaction, a rewind) drops it. The daemon checks
 * once in a while (hub.js); a check that comes more than a minute after it was due (the
 * machine slept) lets it lapse, as the entry has likely expired and compacting would read it
 * cold. The session must be idle at that moment, and stays awake until then (sleep.js would
 * otherwise end omp first).
 *
 * omp has the same logic, but only its terminal UI runs it, not RPC mode, so the daemon sends
 * omp's `compact` itself.
 */
/** @import { SessionEvent } from './wire.js' */

/** Claude Code's default size from which a conversation is compacted while idle. */
export const IDLE_COMPACT_MIN_TOKENS = 200_000;
/** Below this, compacting a conversation is not worth it (Claude Code's floor too). */
export const IDLE_COMPACT_TOKENS_FLOOR = 100_000;
/** 90% of a one-hour cache entry's life. */
export const IDLE_COMPACT_AFTER_MS = 0.9 * 60 * 60_000;
/** How late a check may be and still compact. */
export const IDLE_COMPACT_LATE_MS = 60_000;

/** What omp's `compact` is sent as. */
export const IDLE_COMPACT = Object.freeze({ type: 'compact' });

/** Frames after which the next request no longer reads the cached prefix. */
const PREFIX_CHANGING_FRAMES = new Set(['model_changed', 'thinking_level_changed', 'auto_compaction_start']);
/** Successful responses after which the next request no longer reads the cached prefix. */
const PREFIX_CHANGING_COMMANDS = new Set(['set_model', 'cycle_model', 'set_thinking_level', 'cycle_thinking_level', 'compact', 'branch', 'new_session', 'switch_session']);

/**
 * `requestAt`: when the reply to the latest request started; `dueAt`: when the session
 * compacts, if it does.
 * @typedef {{ requestAt: number | null, dueAt: number | null }} IdleCompaction
 */

/** @typedef {{ afterMs: number, minTokens: number }} IdleCompactionOptions */

/** @returns {IdleCompaction} */
export const createIdleCompaction = () => ({ requestAt: null, dueAt: null });

/**
 * Follows one of the session's events.
 * @param {IdleCompaction} state @param {SessionEvent} event @param {IdleCompactionOptions} options
 */
export function followIdleCompaction(state, event, { afterMs, minTokens }) {
  if (event.kind !== 'frame') return;
  const { frame } = event;
  if (frame.type === 'message_start' && frame.message?.role === 'assistant') {
    state.requestAt = event.at;
  } else if (frame.type === 'message_end' && frame.message?.role === 'assistant') {
    const usage = frame.message.usage;
    const tokens = (usage?.input ?? 0) + (usage?.output ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
    const oneHour = (usage?.cttl?.ephemeral1h ?? 0) > 0;
    state.dueAt = oneHour && tokens >= minTokens ? (state.requestAt ?? event.at) + afterMs : null;
    state.requestAt = null;
  } else if (frame.type === 'response' ? frame.success === true && PREFIX_CHANGING_COMMANDS.has(frame.command) : PREFIX_CHANGING_FRAMES.has(frame.type)) {
    state.dueAt = null;
  }
}

/**
 * Whether the session compacts now (`due`), will later (`waiting`: it stays awake meanwhile),
 * or not at all (`null`, also once it lapsed).
 * @param {IdleCompaction} state @param {number} now @returns {'due' | 'waiting' | null}
 */
export function idleCompactionNow({ dueAt }, now) {
  if (dueAt === null || now - dueAt > IDLE_COMPACT_LATE_MS) return null;
  return now < dueAt ? 'waiting' : 'due';
}
