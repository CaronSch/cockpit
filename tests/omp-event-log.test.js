import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { withoutSpent } from '../src/omp/event-log.js';
import { applyEvent, createTranscript } from '../src/omp/transcript.js';
/** @import { SessionEvent } from '../daemon/wire.js' */

const toolCall = { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls' } };
const reply = { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'Hello there' }, toolCall], stopReason: 'toolUse' };
/** @param {Record<string, any>} event */
const update = (event) => ({ type: 'message_update', messageId: 'm1', message: { role: 'assistant' }, assistantMessageEvent: event });

const TURN = [
  { type: 'message_start', messageId: 'm1', message: { role: 'assistant', content: [] } },
  update({ type: 'thinking_start', contentIndex: 0 }),
  update({ type: 'thinking_delta', contentIndex: 0, delta: 'hm' }),
  update({ type: 'thinking_end', contentIndex: 0, content: 'hm' }),
  update({ type: 'text_start', contentIndex: 1 }),
  update({ type: 'text_delta', contentIndex: 1, delta: 'Hello ' }),
  update({ type: 'text_delta', contentIndex: 1, delta: 'there' }),
  update({ type: 'text_end', contentIndex: 1, content: 'Hello there' }),
  update({ type: 'toolcall_start', contentIndex: 2 }),
  update({ type: 'toolcall_delta', contentIndex: 2, delta: '{"command"' }),
  update({ type: 'toolcall_end', contentIndex: 2, toolCall }),
  { type: 'message_end', messageId: 'm1', message: reply },
  { type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } },
  { type: 'tool_execution_update', toolCallId: 't1', toolName: 'bash', partialResult: { content: [{ type: 'text', text: 'a' }] } },
  { type: 'tool_stream_update', toolCallId: 't1', toolName: 'bash', update: { content: [{ type: 'text', text: 'a\nb' }] } },
  { type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', result: { content: [{ type: 'text', text: 'a\nb' }] }, isError: false },
];

/**
 * Feeds frames as the log takes them.
 * @param {Record<string, any>[]} frames @param {string} [session] @param {SessionEvent[]} [start]
 */
function logOf(frames, session = 's1', start = []) {
  let log = start;
  for (const frame of frames) {
    const event = /** @type {SessionEvent} */ ({ kind: 'frame', frame, seq: 0, at: 1000, session });
    log = withoutSpent([...log, event], event);
  }
  return log;
}

/** What a window shows from `events`, without its render counters. @param {SessionEvent[]} events */
function shown(events) {
  const state = createTranscript();
  for (const event of events) applyEvent(state, event);
  return JSON.parse(JSON.stringify(state.items, (key, value) => (key === 'rev' ? undefined : value)));
}

const allOf = (/** @type {Record<string, any>[]} */ frames) => frames.map((frame, i) => /** @type {SessionEvent} */ ({ kind: 'frame', frame, seq: i + 1, at: 1000, session: 's1' }));

describe('what the log keeps', () => {
  test('a window shows a finished turn the same without its deltas and tool progress', () => {
    const log = logOf(TURN);
    assert.ok(log.length < TURN.length);
    assert.deepEqual(shown(log), shown(allOf(TURN)));
  });

  test('a message still streaming keeps its deltas, as a window opened now has to show them', () => {
    const streaming = TURN.slice(0, 7);
    assert.equal(logOf(streaming).length, streaming.length);
  });

  test('a stream event the transcript does not know stays, to be shown as unrecognised', () => {
    const log = logOf([update({ type: 'surprise_delta', contentIndex: 0 }), TURN[11]]);
    assert.equal(log.length, 2);
  });

  test('another session\'s deltas stay', () => {
    const other = logOf(TURN.slice(0, 7), 's2');
    const log = logOf(TURN.slice(11, 12), 's1', other);
    assert.equal(log.filter((e) => e.session === 's2').length, 7);
  });

  test('of a session that ended only that remains, while others keep theirs', () => {
    const log = logOf(TURN.slice(0, 3), 's2', logOf(TURN.slice(0, 3)));
    const end = /** @type {SessionEvent} */ ({ kind: 'session', meta: { status: 'exited' }, seq: 99, at: 1000, session: 's1' });
    const after = withoutSpent([...log, end], end);
    assert.deepEqual(after.filter((e) => e.session === 's1'), [end]);
    assert.equal(after.filter((e) => e.session === 's2').length, 3);
  });

  test('a session starting or ready spends nothing', () => {
    const log = logOf(TURN.slice(0, 3));
    const up = /** @type {SessionEvent} */ ({ kind: 'session', meta: { status: 'ready' }, seq: 99, at: 1000, session: 's1' });
    assert.equal(withoutSpent([...log, up], up).length, 4);
  });
});
