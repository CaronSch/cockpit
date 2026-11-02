/**
 * What of a session's events a later window still needs, so the daemon's log and a page's
 * buffers stay about as long as the conversation instead of growing with every token streamed:
 * a message's deltas go once `message_end` carries it whole, a tool's progress once
 * `tool_execution_end` carries its result, and a session's events once it has ended (windows
 * then read the conversation from its journal), bar the event saying how it ended.
 *
 * Only frames the transcript reduces to the same result without go, so whichever frames a
 * window has seen, it shows the same (omp/transcript.js).
 */
/** @import { SessionEvent } from '../../daemon/wire.js' */

const MESSAGE_DELTAS = new Set(['text_delta', 'thinking_delta', 'toolcall_delta']);
const TOOL_PROGRESS = new Set(['tool_execution_update', 'tool_stream_update']);

/** Which earlier events of its session `event` makes unneeded, if any. @param {SessionEvent} event @returns {((earlier: SessionEvent) => boolean) | null} */
function spentBy(event) {
  if (event.kind === 'session') return event.meta.status === 'exited' || event.meta.status === 'failed' ? () => true : null;
  if (event.kind !== 'frame') return null;
  const { frame } = event;
  if (frame.type === 'message_end') {
    return (e) => e.kind === 'frame' && e.frame.type === 'message_update' && e.frame.messageId === frame.messageId && MESSAGE_DELTAS.has(e.frame.assistantMessageEvent?.type);
  }
  if (frame.type === 'tool_execution_end') return (e) => e.kind === 'frame' && TOOL_PROGRESS.has(e.frame.type) && e.frame.toolCallId === frame.toolCallId;
  return null;
}

/**
 * `events`, whose newest is `event`, without what `event` has made unneeded.
 * @param {SessionEvent[]} events @param {SessionEvent} event @returns {SessionEvent[]}
 */
export function withoutSpent(events, event) {
  const spent = spentBy(event);
  return spent ? events.filter((e) => e === event || e.session !== event.session || !spent(e)) : events;
}
