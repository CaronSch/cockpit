/**
 * What of a session's events a later window still needs, so the daemon's log and a page's
 * buffers stay about as long as the conversation instead of growing with every token streamed:
 * a message's deltas go once `message_end` carries it whole, a tool's progress once a newer
 * progress frame or `tool_execution_end` carries it (a subagent run in the background reports
 * progress long after its call has ended, each frame all of it so far), and a session's events
 * once it has ended (windows then read the conversation from its journal), bar the event saying
 * how it ended.
 *
 * Only frames the transcript reduces to the same result without go, so whichever frames a
 * window has seen, it shows the same (omp/transcript.js).
 *
 * Frames are also kept without what omp records of each message for itself and no window reads
 * (`slimFrame`): an assistant message's `inputTransformations` (which earlier thinking omp left
 * out of the request: it grows with the conversation, so a long one's messages carry tens of
 * megabytes of it), its `requestControls` (the request's tool list) and each thinking block's
 * `thinkingSignature` (the provider's opaque proof, sent back to it), and a tool result's
 * `details.trace` (how omp parsed a shell command).
 */
/** @import { SessionEvent } from '../../daemon/wire.js' */

const MESSAGE_DELTAS = new Set(['text_delta', 'thinking_delta', 'toolcall_delta']);
const TOOL_PROGRESS = new Set(['tool_execution_update', 'tool_stream_update']);

/** Whether progress frame `frame` sets the tool's output, as the transcript reads it (a stream update only with content). @param {Record<string, any>} frame */
const setsOutput = (frame) => frame.type === 'tool_execution_update' || (frame.type === 'tool_stream_update' && Array.isArray(frame.update?.content));

/** Which earlier events of its session `event` makes unneeded, if any. @param {SessionEvent} event @returns {((earlier: SessionEvent) => boolean) | null} */
function spentBy(event) {
  if (event.kind === 'session') return event.meta.status === 'exited' || event.meta.status === 'failed' ? () => true : null;
  if (event.kind !== 'frame') return null;
  const { frame } = event;
  if (frame.type === 'message_end') {
    return (e) => e.kind === 'frame' && e.frame.type === 'message_update' && e.frame.messageId === frame.messageId && MESSAGE_DELTAS.has(e.frame.assistantMessageEvent?.type);
  }
  if (frame.type === 'tool_execution_end' || setsOutput(frame)) return (e) => e.kind === 'frame' && TOOL_PROGRESS.has(e.frame.type) && e.frame.toolCallId === frame.toolCallId;
  return null;
}

/** A tool result (`{ content, details }`) without `details.trace`; itself when it has none. @param {any} result */
function slimResult(result) {
  if (!result?.details || typeof result.details !== 'object' || !('trace' in result.details)) return result;
  const { trace: _trace, ...details } = result.details;
  return { ...result, details };
}

/**
 * A message without what omp keeps of it for itself (a journal's too, as daemon/conversation.js
 * reads it); itself when it has none of it.
 * @param {any} message
 */
export function slimMessage(message) {
  if (!message || typeof message !== 'object') return message;
  const { inputTransformations, requestControls, ...rest } = message;
  /** @type {any} */
  let slim = inputTransformations === undefined && requestControls === undefined ? message : rest;
  if (Array.isArray(slim.content) && slim.content.some((/** @type {any} */ b) => b?.thinkingSignature !== undefined)) {
    slim = { ...slim, content: slim.content.map((/** @type {any} */ b) => (b?.thinkingSignature === undefined ? b : (({ thinkingSignature: _s, ...block }) => block)(b))) };
  }
  return slimResult(slim);
}

/** @param {unknown} list */
function slimMessages(list) {
  if (!Array.isArray(list)) return list;
  const slim = list.map(slimMessage);
  return slim.every((m, i) => m === list[i]) ? list : slim;
}

/**
 * Frame `frame` as the log keeps it: every message and tool result it carries without what no
 * window reads (see above). The frame itself when nothing goes.
 * @param {Record<string, any>} frame @returns {Record<string, any>}
 */
export function slimFrame(frame) {
  /** @type {Record<string, any>} */
  const slim = { ...frame };
  if ('message' in frame) slim.message = slimMessage(frame.message);
  if ('messages' in frame) slim.messages = slimMessages(frame.messages);
  if ('toolResults' in frame) slim.toolResults = slimMessages(frame.toolResults);
  if ('result' in frame) slim.result = slimResult(frame.result);
  if ('partialResult' in frame) slim.partialResult = slimResult(frame.partialResult);
  if (frame.type === 'response' && Array.isArray(frame.data?.messages)) slim.data = { ...frame.data, messages: slimMessages(frame.data.messages) };
  return Object.keys(slim).every((k) => slim[k] === frame[k]) ? frame : slim;
}

/**
 * `events`, whose newest is `event`, without what `event` has made unneeded.
 * @param {SessionEvent[]} events @param {SessionEvent} event @returns {SessionEvent[]}
 */
export function withoutSpent(events, event) {
  const spent = spentBy(event);
  return spent ? events.filter((e) => e === event || e.session !== event.session || !spent(e)) : events;
}
