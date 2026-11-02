import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { applyEvent, createTranscript } from '../src/omp/transcript.js';
import { promptsAndResponses } from '../src/omp/visibility.js';
/** @import { SessionEvent } from '../daemon/wire.js' */
/** @import { Item, Transcript } from '../src/omp/transcript.js' */

// Transcripts are built through the reducer from frames shaped like omp's (see
// omp-transcript.test.js), so the rule is tested on the items the pane really has.

let seq = 0;
/** @param {Record<string, any>} frame @returns {SessionEvent} */
const frame = (frame) => ({ kind: 'frame', frame, seq: ++seq, at: 0, session: 's1' });
/** @param {Record<string, any>} command @returns {SessionEvent} */
const sent = (command) => ({ kind: 'sent', command, seq: ++seq, at: 0, session: 's1' });

/** @param {SessionEvent[]} events */
function run(events) {
  const state = createTranscript();
  for (const event of events) applyEvent(state, event);
  return state;
}

let ids = 0;
/** One whole message, start to end. @param {Record<string, any>} message @returns {SessionEvent[]} */
function message(message) {
  const messageId = `m${++ids}`;
  return [frame({ type: 'message_start', message, messageId }), frame({ type: 'message_end', message, messageId })];
}
/** @param {string} text @param {Record<string, any>} [extra] */
const prompt = (text, extra = {}) => message({ role: 'user', content: [{ type: 'text', text }], attribution: 'user', timestamp: 1, ...extra });
/** @param {any[]} content @param {string} stopReason @param {Record<string, any>} [extra] */
const assistant = (content, stopReason, extra = {}) => message({ role: 'assistant', content, stopReason, timestamp: 1, ...extra });
/** @param {string} text */
const text = (text) => ({ type: 'text', text });
/** @param {string} thinking */
const thinking = (thinking) => ({ type: 'thinking', thinking });
/** @param {string} id */
const toolCall = (id) => ({ type: 'toolCall', id, name: 'bash', arguments: { command: 'ls' } });
/** A tool call's run and result, as omp reports them. @param {string} id @returns {SessionEvent[]} */
const toolRun = (id) => [
  frame({ type: 'tool_execution_start', toolCallId: id, toolName: 'bash', args: { command: 'ls' } }),
  frame({ type: 'tool_execution_end', toolCallId: id, toolName: 'bash', result: { content: [text('a.txt')] }, isError: false }),
  ...message({ role: 'toolResult', toolCallId: id, toolName: 'bash', content: [text('a.txt')], isError: false, timestamp: 1 }),
];
const agentStart = frame({ type: 'agent_start' });
const agentEnd = frame({ type: 'agent_end', messages: [], isTerminal: true, yielded: true });

/**
 * What the pane shows, one line per item.
 * @param {Transcript} state @returns {{ shown: string[], working: { steps: number } | null }}
 */
function view(state) {
  const { items, working } = promptsAndResponses(state.items, state.streaming);
  return { shown: items.map(line), working };
}

/** @param {Item} item */
function line(item) {
  switch (item.kind) {
    case 'user':
      return `user: ${item.text}`;
    case 'assistant':
      return `assistant: ${item.blocks.map((b) => (b.kind === 'text' ? b.text : `[${b.kind}]`)).join(' ')}`;
    case 'bash':
      return `bash: ${item.command}`;
    case 'note':
      return `note ${item.source}: ${item.text || item.detail}`;
    default:
      return item.kind;
  }
}

describe('only prompts and responses', () => {
  test('a turn that used tools shows the prompt, the narration and the final reply, without thinking or tool work', () => {
    const state = run([
      agentStart,
      ...prompt('list files'),
      ...assistant([thinking('Where to look?'), text('Let me look.'), toolCall('t1')], 'toolUse'),
      ...toolRun('t1'),
      ...assistant([thinking('One file.'), text('There is a.txt.')], 'stop'),
      agentEnd,
    ]);
    assert.deepEqual(view(state), { shown: ['user: list files', 'assistant: Let me look.', 'assistant: There is a.txt.'], working: null });
  });

  test('a turn with no tool calls shows its one reply', () => {
    const state = run([agentStart, ...prompt('hi'), ...assistant([text('Hello.')], 'stop'), agentEnd]);
    assert.deepEqual(view(state).shown, ['user: hi', 'assistant: Hello.']);
  });

  test('a reply the agent carried on from still shows: what it said before a nudge or more work is an answer too', () => {
    const state = run([
      agentStart,
      ...prompt('fix it'),
      ...assistant([text('I will start with the tests.')], 'stop'),
      frame({ type: 'agent_end', messages: [], isTerminal: false, yielded: false }), // omp carries on
      ...assistant([toolCall('t1')], 'toolUse'),
      ...toolRun('t1'),
      ...assistant([text('Fixed.')], 'stop'),
      agentEnd,
    ]);
    assert.deepEqual(view(state).shown, ['user: fix it', 'assistant: I will start with the tests.', 'assistant: Fixed.']);
  });

  test('a tool run no message has named (yet) is work too', () => {
    const state = run([
      agentStart,
      ...prompt('go'),
      frame({ type: 'tool_execution_start', toolCallId: 'early', toolName: 'read', args: {} }),
      ...assistant([text('Done.')], 'stop'),
      agentEnd,
    ]);
    assert.ok(state.items.some((i) => i.kind === 'tool'), 'the run has a card of its own');
    assert.deepEqual(view(state).shown, ['user: go', 'assistant: Done.']);
  });

  test('while a turn runs, its work stays behind one indicator, and what the agent says shows as it says it', () => {
    const running = [
      ...prompt('first'),
      ...assistant([text('Answer one.')], 'stop'),
      agentEnd,
      agentStart,
      ...prompt('second'),
      ...assistant([text('Checking.'), toolCall('t1')], 'toolUse'),
      ...toolRun('t1'),
      ...assistant([text('Looks like')], 'stop'),
    ];
    assert.deepEqual(view(run(running)), {
      shown: ['user: first', 'assistant: Answer one.', 'user: second', 'assistant: Checking.', 'assistant: Looks like'],
      working: { steps: 2 },
    });
    assert.deepEqual(view(run([...running, agentEnd])), {
      shown: ['user: first', 'assistant: Answer one.', 'user: second', 'assistant: Checking.', 'assistant: Looks like'],
      working: null,
    });
  });

  test('a turn that has only just started shows the indicator with no steps yet', () => {
    assert.deepEqual(view(run([agentStart, ...prompt('go')])), { shown: ['user: go'], working: { steps: 0 } });
  });

  test('a turn waiting on a dialog keeps working: the asking tool is hidden, the dialog is the pane’s to show', () => {
    const state = run([
      agentStart,
      ...prompt('pick a database'),
      ...assistant([toolCall('ask-1')], 'toolUse'),
      frame({ type: 'tool_execution_start', toolCallId: 'ask-1', toolName: 'ask', args: {} }),
      frame({ type: 'extension_ui_request', id: 'ui-1', method: 'ask', questions: [] }),
    ]);
    assert.deepEqual(view(state), { shown: ['user: pick a database'], working: { steps: 1 } });
    assert.deepEqual(
      state.dialogs.map((d) => d.id),
      ['ui-1'],
    );
  });

  test('errors that end a turn show: a failed reply, a failed prompt, exhausted retries', () => {
    const state = run([
      agentStart,
      ...prompt('one'),
      ...assistant([toolCall('t1')], 'toolUse'),
      ...toolRun('t1'),
      ...assistant([text('Partial')], 'error', { errorMessage: 'overloaded' }),
      frame({ type: 'auto_retry_end', success: false, attempt: 3, finalError: 'overloaded' }),
      agentEnd,
      frame({ type: 'prompt_result', id: 'p1', status: 'error', error: { message: 'provider down' } }),
    ]);
    const { shown } = view(state);
    assert.deepEqual(shown, ['user: one', 'assistant: Partial', 'note retry: Retries exhausted: overloaded', 'note prompt: provider down']);
    const reply = promptsAndResponses(state.items, false).items.find((i) => i.kind === 'assistant');
    assert.equal(reply?.kind === 'assistant' && reply.errorMessage, 'overloaded');
  });

  test('a turn stopped mid-tool shows how it ended, not the tool call', () => {
    const state = run([
      agentStart,
      ...prompt('long job'),
      ...assistant([toolCall('t1')], 'toolUse'),
      frame({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: {} }),
      agentEnd,
      frame({ type: 'prompt_result', id: 'p1', status: 'aborted' }),
    ]);
    assert.deepEqual(view(state).shown, ['user: long job', 'note prompt: Aborted']);
  });

  test('a reply streams in as it is written', () => {
    const streamed = [
      agentStart,
      ...prompt('hi'),
      frame({ type: 'message_start', message: { role: 'assistant', content: [text('Hel')], timestamp: 1 }, messageId: 'live' }),
    ];
    assert.deepEqual(view(run(streamed)), { shown: ['user: hi', 'assistant: Hel'], working: { steps: 1 } });
  });

  test('a reply that never ended (omp exited mid-stream) is not a completed response', () => {
    const state = run([
      agentStart,
      ...prompt('hi'),
      frame({ type: 'message_start', message: { role: 'assistant', content: [text('Hel')], timestamp: 1 }, messageId: 'cut' }),
      { kind: 'session', meta: /** @type {any} */ ({ id: 's1', status: 'exited' }), seq: ++seq, at: 0, session: 's1' },
    ]);
    assert.deepEqual(view(state), { shown: ['user: hi'], working: null });
  });

  test('the user’s shell runs and attachments show; messages the agent injects do not, but end a turn', () => {
    const state = run([
      sent({ type: 'bash', command: 'git status', id: 'b1' }),
      frame({ type: 'response', id: 'b1', command: 'bash', success: true, data: { output: 'clean', exitCode: 0 } }),
      agentStart,
      ...prompt('read @"/tmp/a.png"'),
      ...message({ role: 'fileMention', files: [{ path: '/tmp/a.png' }], timestamp: 2 }),
      ...assistant([text('A cat.')], 'stop'),
      agentEnd,
      agentStart,
      ...prompt('Background job finished.', { attribution: 'agent' }),
      ...assistant([text('The job passed.')], 'stop'),
      agentEnd,
    ]);
    assert.deepEqual(view(state).shown, [
      'bash: git status',
      'user: read @"/tmp/a.png"',
      'note files: Attached /tmp/a.png',
      'assistant: A cat.',
      'assistant: The job passed.',
    ]);
  });

  test('a final reply keeps its place before a later shell run in the same turn', () => {
    const state = run([
      agentStart,
      ...prompt('hi'),
      ...assistant([text('Hello.')], 'stop'),
      agentEnd,
      sent({ type: 'bash', command: 'ls', id: 'b1' }),
    ]);
    assert.deepEqual(view(state).shown, ['user: hi', 'assistant: Hello.', 'bash: ls']);
  });

  test('slash-command output and unknown frames show; notices, notifications and stderr do not', () => {
    const state = run([
      frame({ type: 'command_output', text: 'Session renamed.' }),
      frame({ type: 'mystery_frame' }),
      frame({ type: 'notice', level: 'info', message: 'tools loaded' }),
      frame({ type: 'extension_ui_request', id: 'n', method: 'notify', message: 'saved' }),
      frame({ type: 'auto_compaction_start', reason: 'threshold' }),
      { kind: 'stderr', line: 'debug: hi', seq: ++seq, at: 0, session: 's1' },
    ]);
    assert.deepEqual(view(state).shown, ['note command: Session renamed.', 'unrecognised']);
  });

  test('the transcript itself keeps everything: switching back shows the hidden work again', () => {
    const state = run([agentStart, ...prompt('q'), ...assistant([thinking('hmm'), text('A.')], 'stop'), agentEnd]);
    const before = structuredClone(state.items);
    promptsAndResponses(state.items, state.streaming);
    assert.deepEqual(state.items, before);
    const reply = state.items.find((i) => i.kind === 'assistant');
    assert.deepEqual(reply?.kind === 'assistant' && reply.blocks.map((b) => b.kind), ['thinking', 'text']);
  });
});
