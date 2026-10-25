import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { addNote, applyEvent, askAnswers, conversationName, createTranscript, needsLogin, seedConversation } from '../src/omp/transcript.js';
/** @import { SessionEvent } from '../daemon/wire.js' */
/** @import { Transcript } from '../src/omp/transcript.js' */

// Sanitized fixtures shaped like frames recorded from omp 18.10 in `--mode rpc-ui` with
// `set_event_filter { messageUpdates: 'delta' }`.

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

/** @param {Transcript} state */
const kinds = (state) => state.items.map((i) => i.kind);

const usage = (total = 0.25) => ({ input: 4, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 8, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } });

/** @param {any[]} content @param {Record<string, any>} [extra] */
const assistant = (content, extra = {}) => ({ role: 'assistant', content, api: 'messages', provider: 'acme', model: 'model-1', usage: usage(), stopReason: 'stop', timestamp: 1, ...extra });

/** @param {Record<string, any>} event @param {string} id */
const update = (event, id) => frame({ type: 'message_update', assistantMessageEvent: event, message: { role: 'assistant' }, messageId: id });

/** @param {Transcript} state @param {string} key */
function assistantItem(state, key) {
  const item = state.items.find((i) => i.key === key);
  assert.ok(item && item.kind === 'assistant', `no assistant item ${key}`);
  return item;
}

describe('assistant streaming', () => {
  test('a pre-filled message_start followed by deltas shows the text once', () => {
    const state = run([
      frame({ type: 'message_start', message: assistant([{ type: 'text', text: 'pong' }]), messageId: 'm1' }),
      update({ type: 'text_start', contentIndex: 0 }, 'm1'),
      update({ type: 'text_delta', contentIndex: 0, delta: 'po' }, 'm1'),
      update({ type: 'text_delta', contentIndex: 0, delta: 'ng' }, 'm1'),
    ]);
    assert.deepEqual(assistantItem(state, 'msg:m1').blocks, [{ kind: 'text', text: 'pong' }]);
    assert.deepEqual(kinds(state), ['assistant']);
  });

  test('thinking and text blocks assemble at their content index', () => {
    const state = run([
      frame({ type: 'message_start', message: assistant([]), messageId: 'm1' }),
      update({ type: 'thinking_start', contentIndex: 0 }, 'm1'),
      update({ type: 'thinking_delta', contentIndex: 0, delta: 'hmm' }, 'm1'),
      update({ type: 'thinking_end', contentIndex: 0, content: 'hmm.' }, 'm1'),
      update({ type: 'text_start', contentIndex: 1 }, 'm1'),
      update({ type: 'text_delta', contentIndex: 1, delta: 'Hi' }, 'm1'),
    ]);
    assert.deepEqual(assistantItem(state, 'msg:m1').blocks, [
      { kind: 'thinking', text: 'hmm.', redacted: false },
      { kind: 'text', text: 'Hi' },
    ]);
  });

  test('message_end replaces content that drifted during streaming', () => {
    const state = run([
      frame({ type: 'message_start', message: assistant([]), messageId: 'm1' }),
      update({ type: 'text_start', contentIndex: 0 }, 'm1'),
      update({ type: 'text_delta', contentIndex: 0, delta: 'Hel' }, 'm1'),
      update({ type: 'text_delta', contentIndex: 0, delta: 'Hel' }, 'm1'), // duplicated delta
      frame({ type: 'message_end', message: assistant([{ type: 'text', text: 'Hello' }]), messageId: 'm1' }),
    ]);
    const item = assistantItem(state, 'msg:m1');
    assert.deepEqual(item.blocks, [{ kind: 'text', text: 'Hello' }]);
    assert.equal(item.ended, true);
    assert.equal(item.stopReason, 'stop');
  });

  test('cost sums assistant usage once per message, at message_end', () => {
    const m = assistant([{ type: 'text', text: 'a' }], { usage: usage(0.5) });
    const state = run([
      frame({ type: 'message_start', message: m, messageId: 'm1' }),
      frame({ type: 'message_end', message: m, messageId: 'm1' }),
      frame({ type: 'message_end', message: assistant([], { usage: usage(0.25) }), messageId: 'm2' }),
    ]);
    assert.equal(state.cost, 0.75);
  });

  test('a provider error is kept on the message', () => {
    const state = run([
      frame({ type: 'message_end', message: assistant([], { stopReason: 'error', errorMessage: 'overloaded' }), messageId: 'm1' }),
    ]);
    assert.equal(assistantItem(state, 'msg:m1').errorMessage, 'overloaded');
  });
});

describe('tool cards', () => {
  const call = { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'echo hi' }, intent: 'Running echo' };
  const lifecycle = () => [
    frame({ type: 'message_start', message: assistant([call], { stopReason: 'toolUse' }), messageId: 'm1' }),
    update({ type: 'toolcall_start', contentIndex: 0 }, 'm1'),
    update({ type: 'toolcall_delta', contentIndex: 0, delta: '{"command": "ech' }, 'm1'),
    update({ type: 'toolcall_end', contentIndex: 0, toolCall: call }, 'm1'),
    frame({ type: 'message_end', message: assistant([call], { stopReason: 'toolUse' }), messageId: 'm1' }),
    frame({ type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'bash', args: { command: 'echo hi' }, intent: 'Running echo' }),
    frame({ type: 'tool_execution_update', toolCallId: 'call_1', toolName: 'bash', partialResult: { content: [{ type: 'text', text: 'h' }], details: {} } }),
  ];

  test('live output shows while the tool runs', () => {
    const state = run(lifecycle());
    const tool = state.tools.get('call_1');
    assert.equal(tool?.status, 'running');
    assert.equal(tool?.output, 'h');
    assert.equal(tool?.intent, 'Running echo');
  });

  test('the toolResult message folds into its card instead of rendering twice', () => {
    const state = run([
      ...lifecycle(),
      frame({ type: 'tool_execution_end', toolCallId: 'call_1', toolName: 'bash', result: { content: [{ type: 'text', text: 'hi\n' }], details: {} }, isError: false }),
      frame({ type: 'message_start', message: { role: 'toolResult', toolCallId: 'call_1', toolName: 'bash', content: [{ type: 'text', text: 'hi\n' }], isError: false, timestamp: 2 }, messageId: 'm2' }),
      frame({ type: 'message_end', message: { role: 'toolResult', toolCallId: 'call_1', toolName: 'bash', content: [{ type: 'text', text: 'hi\n' }], isError: false, timestamp: 2 }, messageId: 'm2' }),
    ]);
    assert.deepEqual(kinds(state), ['assistant']);
    const tool = state.tools.get('call_1');
    assert.equal(tool?.status, 'ok');
    assert.equal(tool?.result, 'hi\n');
    const block = assistantItem(state, 'msg:m1').blocks[0];
    assert.equal(block.kind === 'toolCall' && block.id, 'call_1');
  });

  test('a failing tool marks its card as an error', () => {
    const state = run([
      ...lifecycle(),
      frame({ type: 'tool_execution_end', toolCallId: 'call_1', toolName: 'bash', result: { content: [{ type: 'text', text: 'boom' }] }, isError: true }),
    ]);
    assert.equal(state.tools.get('call_1')?.status, 'error');
  });

  test('a tool run with no assistant message gets a card of its own', () => {
    const state = run([frame({ type: 'tool_execution_start', toolCallId: 'orphan', toolName: 'read', args: {} })]);
    assert.deepEqual(kinds(state), ['tool']);
  });
});

describe('frames the pane does not know', () => {
  test('an unknown frame type becomes an unrecognised item with its raw JSON', () => {
    const state = run([frame({ type: 'telepathy_update', mood: 'calm' })]);
    assert.equal(state.items.length, 1);
    const item = state.items[0];
    assert.equal(item.kind, 'unrecognised');
    assert.ok(item.kind === 'unrecognised' && item.label === 'telepathy_update' && item.raw.includes('"mood": "calm"'));
  });

  test('an unknown message role, stream event and UI method are surfaced too', () => {
    const state = run([
      frame({ type: 'message_end', message: { role: 'oracle', content: 'x', timestamp: 5 }, messageId: 'm9' }),
      update({ type: 'hologram_delta', contentIndex: 0 }, 'm10'),
      frame({ type: 'extension_ui_request', id: 'u1', method: 'teleport' }),
    ]);
    const labels = state.items.filter((i) => i.kind === 'unrecognised').map((i) => i.kind === 'unrecognised' && i.label);
    assert.deepEqual(labels, ['message role oracle', 'message_update hologram_delta', 'ui teleport']);
  });

  test('garbled stdout is kept, never dropped', () => {
    const state = createTranscript();
    applyEvent(state, { kind: 'garbled', line: '{not json', error: 'Unexpected token', seq: 1, at: 0, session: 's1' });
    const item = state.items[0];
    assert.ok(item.kind === 'unrecognised' && item.raw.includes('{not json') && item.raw.includes('Unexpected token'));
  });

  test('known bookkeeping frames add nothing to the transcript', () => {
    const state = run([
      frame({ type: 'ready', protocolVersion: 1 }),
      frame({ type: 'turn_start' }),
      frame({ type: 'session_settled' }),
      frame({ type: 'advisor_cost_changed' }),
      frame({ type: 'extension_ui_request', id: 'w', method: 'setWidget', widgetKey: 'k' }),
    ]);
    assert.deepEqual(kinds(state), []);
  });
});

describe('notes', () => {
  test('notices, extension errors and stderr show as notes; stderr lines in a row share one', () => {
    const state = run([
      frame({ type: 'notice', level: 'warning', message: 'low disk', source: 'fs' }),
      frame({ type: 'extension_error', extensionPath: 'ext.ts', event: 'tool_call', error: 'bad' }),
      { kind: 'stderr', line: 'Decompression error: ZlibError', seq: 1, at: 0, session: 's1' },
      { kind: 'stderr', line: 'second', seq: 2, at: 0, session: 's1' },
    ]);
    assert.deepEqual(kinds(state), ['note', 'note', 'note']);
    const stderr = state.items[2];
    assert.ok(stderr.kind === 'note' && stderr.detail === 'Decompression error: ZlibError\nsecond');
  });

  test('a message without a messageId shows once, whole, at its end', () => {
    const m = { role: 'custom', customType: 'mount-notice', content: 'tools changed', display: false, timestamp: 7 };
    const reply = assistant([{ type: 'text', text: 'Hello' }]);
    const state = run([
      frame({ type: 'message_start', message: m }),
      frame({ type: 'message_end', message: m }),
      frame({ type: 'message_start', message: assistant([]) }),
      frame({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hel' }, message: { role: 'assistant' } }),
      frame({ type: 'message_end', message: reply }),
    ]);
    assert.deepEqual(kinds(state), ['note', 'assistant']);
    const item = state.items[1];
    assert.ok(item.kind === 'assistant' && item.ended);
    assert.deepEqual(item.blocks, [{ kind: 'text', text: 'Hello' }]);
  });

  test('a failed command response and its prompt_result show one error', () => {
    const state = run([
      frame({ type: 'response', id: 'ac_4', command: 'prompt', success: false, error: 'no model' }),
      frame({ type: 'prompt_result', id: 'ac_4', agentInvoked: false, status: 'error', error: { message: 'no model', retryable: false }, sessionSettled: true }),
    ]);
    assert.equal(state.items.filter((i) => i.kind === 'note' && i.level === 'error').length, 1);
    assert.equal(state.lastError, 'no model');
  });

  test('a login under way is a note, from the command the daemon sent', () => {
    const state = run([sent({ type: 'login', providerId: 'anthropic', id: 'ac_7' })]);
    assert.ok(state.items[0].kind === 'note' && state.items[0].text === 'Logging in to anthropic…');
  });

  test('the pane can add its own notes', () => {
    const state = createTranscript();
    addNote(state, 'error', 'daemon', 'unreachable');
    assert.ok(state.items[0].kind === 'note' && state.items[0].text === 'unreachable');
  });
});

describe('dialogs', () => {
  const confirm = { type: 'extension_ui_request', id: 'u1', method: 'confirm', title: 'Run?', message: 'rm -rf build' };

  test('a dialog disappears on cancel', () => {
    const state = run([frame(confirm), frame({ type: 'extension_ui_request', id: 'u2', method: 'cancel', targetId: 'u1' })]);
    assert.deepEqual(state.dialogs, []);
  });

  test('a dialog disappears once answered, and a repeated request does not duplicate it', () => {
    const state = run([frame(confirm), frame(confirm)]);
    assert.equal(state.dialogs.length, 1);
    applyEvent(state, sent({ type: 'extension_ui_response', id: 'u1', confirmed: true }));
    assert.deepEqual(state.dialogs, []);
  });

  test('ask answers have the exact rpc.md shape', () => {
    const questions = [
      { id: 'db', question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }], recommended: 1 },
      { id: 'features', question: 'Which features?', options: [{ label: 'Auth' }, { label: 'Billing' }, { label: 'Search' }], multi: true },
      { id: 'name', question: 'Name?', options: [{ label: 'a' }] },
    ];
    const answers = askAnswers(questions, {
      db: { selected: ['SQLite'], custom: '  DuckDB ' }, // single-select: free text wins over an option
      features: { selected: ['Auth', 'Search', 'Auth', 'Bogus'], custom: '' },
    });
    assert.deepEqual(answers, [
      { id: 'db', selectedOptions: [], customInput: 'DuckDB' },
      { id: 'features', selectedOptions: ['Auth', 'Search'] },
      { id: 'name', selectedOptions: [] },
    ]);
  });
});

describe('derived state', () => {
  test('streaming follows agent_start and a yielded agent_end', () => {
    const state = run([frame({ type: 'agent_start' })]);
    assert.equal(state.streaming, true);
    applyEvent(state, frame({ type: 'agent_end', messages: [], yielded: false }));
    assert.equal(state.streaming, true);
    applyEvent(state, frame({ type: 'agent_end', messages: [], yielded: true }));
    assert.equal(state.streaming, false);
  });

  test('omp’s nerd-font icons, which browsers draw as a box, are dropped from the session’s name and from command output', () => {
    const state = run([
      frame({ type: 'session_info_update', title: '\u{F056E} Fix the login flow', sessionId: 'x' }),
      frame({ type: 'command_output', text: 'Session renamed to \u{F056E} Fix the login flow.' }),
    ]);
    assert.equal(state.session.name, 'Fix the login flow');
    const output = state.items.at(-1);
    assert.equal(output?.kind === 'note' ? output.text : null, 'Session renamed to Fix the login flow.');
  });

  test('one line of command output is a quiet note; several lines are an answer shown open', () => {
    const state = run([
      frame({ type: 'command_output', text: 'Session renamed to Login fix.\n' }),
      frame({ type: 'command_output', text: 'Workspace directories:\n  /work (working directory)' }),
    ]);
    const [line, lines] = state.items.slice(-2).map((i) => (i.kind === 'note' ? [i.level, i.source, i.text, i.detail] : null));
    assert.deepEqual(line, ['muted', 'command', 'Session renamed to Login fix.', null]);
    assert.deepEqual(lines, ['info', 'command', '', 'Workspace directories:\n  /work (working directory)']);
  });

  test('a side question’s answer builds up beside the chat and never enters it', () => {
    const record = { id: 'b1', leafId: null, question: 'why?', answer: '', status: 'running', createdAt: 1, updatedAt: 1 };
    const state = run([
      frame({ type: 'btw_record', record }),
      frame({ type: 'btw_delta', recordId: 'b1', delta: 'Because ' }),
      frame({ type: 'btw_delta', recordId: 'b1', delta: 'it was' }),
    ]);
    assert.deepEqual(state.sideAnswers.get('b1'), [{ answer: 'Because it was', status: 'running', error: null }]);
    applyEvent(state, frame({ type: 'btw_record', record: { ...record, answer: 'Because it was.', status: 'complete' } }));
    assert.deepEqual(state.sideAnswers.get('b1'), [{ answer: 'Because it was.', status: 'complete', error: null }]);
    assert.deepEqual(kinds(state), []);
  });

  test('a follow-up adds a turn to its topic, streams into it, and can fail or be cancelled', () => {
    const first = { id: 'b1', leafId: null, question: 'why?', answer: 'Because.', status: 'complete', createdAt: 1, updatedAt: 1 };
    const turn = (/** @type {Record<string, unknown>} */ patch) => ({ question: 'and?', answer: '', status: 'running', createdAt: 2, updatedAt: 2, ...patch });
    const state = run([
      frame({ type: 'btw_record', record: first }),
      frame({ type: 'btw_record', record: { ...first, followUps: [turn({})] } }),
      frame({ type: 'btw_delta', recordId: 'b1', delta: 'Also ' }),
      frame({ type: 'btw_delta', recordId: 'b1', delta: 'this' }),
    ]);
    const done = { answer: 'Because.', status: 'complete', error: null };
    assert.deepEqual(state.sideAnswers.get('b1'), [done, { answer: 'Also this', status: 'running', error: null }]);

    const failed = turn({ answer: 'Also this', status: 'error', error: 'Provider error' });
    applyEvent(state, frame({ type: 'btw_record', record: { ...first, followUps: [failed] } }));
    assert.deepEqual(state.sideAnswers.get('b1'), [done, { answer: 'Also this', status: 'error', error: 'Provider error' }]);

    // Asked again after the failure, then cancelled before it answered.
    applyEvent(state, frame({ type: 'btw_record', record: { ...first, followUps: [failed, turn({ status: 'cancelled' })] } }));
    assert.deepEqual(state.sideAnswers.get('b1'), [
      done,
      { answer: 'Also this', status: 'error', error: 'Provider error' },
      { answer: '', status: 'cancelled', error: null },
    ]);
    assert.deepEqual(kinds(state), []);
  });

  test('queue, commands, status strip, editor text and login URL', () => {
    const state = run([
      frame({ type: 'queue_update', steering: ['use the parser'], followUp: [] }),
      frame({ type: 'available_commands_update', commands: [{ name: 'model', aliases: ['models'], description: 'Pick', source: 'builtin', input: { hint: '<id>' } }] }),
      frame({ type: 'extension_ui_request', id: 'a', method: 'setStatus', statusKey: 'git', statusText: 'main' }),
      frame({ type: 'extension_ui_request', id: 'b', method: 'setWidget', widgetKey: 'w', widgetLines: ['one'] }),
      frame({ type: 'extension_ui_request', id: 'c', method: 'set_editor_text', text: 'draft' }),
      frame({ type: 'extension_ui_request', id: 'd', method: 'open_url', url: 'https://example.com/auth', instructions: 'Sign in' }),
    ]);
    assert.deepEqual(state.queue, { steering: ['use the parser'], followUp: [] });
    assert.deepEqual(state.commands, [{ name: 'model', aliases: ['models'], description: 'Pick', hint: '<id>' }]);
    assert.deepEqual(state.statuses, { git: 'main' });
    assert.deepEqual(state.widgets, { w: ['one'] });
    assert.deepEqual(state.editorText, { seq: 1, text: 'draft' });
    assert.equal(state.openUrl?.url, 'https://example.com/auth');
    applyEvent(state, frame({ type: 'extension_ui_request', id: 'e', method: 'setWidget', widgetKey: 'w' }));
    assert.deepEqual(state.widgets, {});
  });

  test('get_state responses fill the toolbar info', () => {
    const state = run([
      frame({
        type: 'response',
        id: 'ac_5',
        command: 'get_state',
        success: true,
        data: {
          model: { provider: 'acme', id: 'model-1', name: 'Model One' },
          thinkingLevel: 'medium',
          contextUsage: { tokens: 10, contextWindow: 1000, percent: 1.5 },
          sessionFile: '/s/a.jsonl',
          sessionName: '\u{F056E} Fix the login flow',
        },
      }),
    ]);
    assert.deepEqual(state.session, {
      model: { provider: 'acme', id: 'model-1', name: 'Model One' },
      thinkingLevel: 'medium',
      contextPercent: 1.5,
      name: 'Fix the login flow',
    });
  });
});

describe('bash and resume', () => {
  test('a `!cmd` run renders from the sent command and its response', () => {
    const state = run([
      sent({ type: 'bash', command: 'ls', id: 'ac_7' }),
      frame({ type: 'response', id: 'ac_7', command: 'bash', success: true, data: { output: 'a\nb\n', exitCode: 0, cancelled: false, truncated: false } }),
    ]);
    const item = state.items[0];
    assert.ok(item.kind === 'bash');
    assert.equal(item.status, 'ok');
    assert.equal(item.output, 'a\nb\n');
  });

  const history = [
    { role: 'user', content: [{ type: 'text', text: 'old question' }], timestamp: 1 },
    assistant([{ type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a' } }]),
    { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [{ type: 'text', text: 'file' }], isError: false, timestamp: 2 },
  ];
  /** @param {string | null} resume @returns {SessionEvent} */
  const session = (resume) => ({
    kind: 'session',
    meta: { id: 's1', cwd: '/w', resume, fork: null, sessionFile: resume, status: 'ready', pid: 1, exitCode: null, error: null, startedAt: 0, ompId: null },
    seq: ++seq,
    at: 0,
    session: 's1',
  });
  const messagesReply = (/** @type {string} */ id) => frame({ type: 'response', id, command: 'get_messages', success: true, data: { messages: history } });

  test('a resumed session is seeded from get_messages ahead of live notes', () => {
    const state = run([session('/s/old.jsonl'), frame({ type: 'notice', level: 'info', message: 'hello' }), messagesReply('ac_3')]);
    assert.deepEqual(kinds(state), ['user', 'assistant', 'note']);
    assert.equal(state.tools.get('c1')?.status, 'ok');
  });

  test('a reply aborted before it said anything leaves only the Aborted note, live or from a journal', () => {
    const aborted = (/** @type {string} */ errorMessage) => assistant([], { stopReason: 'aborted', errorMessage });
    const notes = (/** @type {Transcript} */ state) => state.items.map((i) => (i.kind === 'note' ? `${i.level} ${i.source}: ${i.text}` : i.kind));
    const live = run([
      frame({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'go' }] }, messageId: 'u1' }),
      frame({ type: 'message_start', message: assistant([]), messageId: 'a1' }),
      frame({ type: 'message_end', message: aborted('Interrupted by user'), messageId: 'a1' }),
      frame({ type: 'prompt_result', id: 'p1', status: 'aborted' }),
    ]);
    assert.deepEqual(notes(live), ['user', 'muted prompt: Aborted']);

    // As omp's journals keep them: stopped by the user, or ended with its process.
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'go' }], timestamp: 1 },
      aborted('Interrupted by user'),
      { role: 'user', content: [{ type: 'text', text: 'again' }], timestamp: 2 },
      aborted('Previous OMP process exited before completing the turn.'),
      { role: 'user', content: [{ type: 'text', text: 'think' }], timestamp: 3 },
      assistant([{ type: 'thinking', thinking: 'hmm' }], { stopReason: 'aborted', errorMessage: 'Request was aborted' }),
    ];
    const asleep = createTranscript();
    seedConversation(asleep, { messages, title: null, model: null, thinkingLevel: null });
    assert.deepEqual(notes(asleep), ['user', 'muted prompt: Aborted', 'user', 'muted prompt: Aborted', 'user', 'assistant']);
  });

  test('after a rewind, the history omp answers with replaces the transcript, cost kept', () => {
    const live = (/** @type {string} */ id, /** @type {any} */ message) => frame({ type: 'message_end', message, messageId: id });
    const state = run([
      session('/s/old.jsonl'),
      messagesReply('ac_3'),
      live('msg-1', { role: 'user', content: [{ type: 'text', text: 'new question' }] }),
      live('msg-2', assistant([{ type: 'text', text: 'new answer' }])),
      frame({ type: 'notice', level: 'info', message: 'hello' }),
    ]);
    const cost = state.cost;
    assert.equal(kinds(state).length, 5);
    // The daemon asks again after omp's `branch`; that answer is the conversation as it now stands.
    applyEvent(state, frame({ type: 'response', id: 'ac_9', command: 'branch', success: true, data: { text: 'new question', cancelled: false } }));
    applyEvent(state, messagesReply('ac_10'));
    assert.deepEqual(kinds(state), ['user', 'assistant']);
    assert.equal(state.items[0].kind === 'user' && state.items[0].text, 'old question');
    assert.equal(state.cost, cost, 'the rewound turns were paid for all the same');
    assert.equal(state.rewinds, 1);
    // A second rewind's items get keys of their own, and a later answer seeds as before.
    applyEvent(state, frame({ type: 'response', id: 'ac_11', command: 'branch', success: true, data: { text: 'old question', cancelled: false } }));
    applyEvent(state, frame({ type: 'response', id: 'ac_12', command: 'get_messages', success: true, data: { messages: [] } }));
    assert.deepEqual(kinds(state), []);
    applyEvent(state, live('msg-3', { role: 'user', content: [{ type: 'text', text: 'again' }] }));
    assert.deepEqual(kinds(state), ['user']);
  });
});

describe('conversation name', () => {
  /** @param {string} text @param {string} [attribution] */
  const user = (text, attribution = 'user') => frame({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text }], attribution }, messageId: `u-${text}` });

  test('an untitled conversation is named by the user’s first prompt, on one line', () => {
    const state = run([user('steer here', 'agent'), user('fix the\nlogin bug'), user('and tests')]);
    assert.equal(conversationName(state), 'fix the login bug');
    assert.equal(conversationName(run([])), null);
  });

  test('omp’s title, once the user names the session, wins over the first prompt', () => {
    const state = run([user('fix the login bug'), frame({ type: 'session_info_update', title: 'Login fix', sessionId: 'x' })]);
    assert.equal(conversationName(state), 'Login fix');
  });
});

describe('needsLogin', () => {
  /** @param {Record<string, unknown>} frame @returns {SessionEvent} */
  const ev = (frame) => ({ kind: 'frame', frame, seq: 1, at: 1, session: 's1' });
  const state = (/** @type {string | null} */ provider, /** @type {Array<{ id: string, authenticated: boolean }> | null} */ providers) => {
    const t = createTranscript();
    if (providers) applyEvent(t, ev({ type: 'response', command: 'get_login_providers', success: true, data: { providers } }));
    applyEvent(t, ev({ type: 'response', command: 'get_state', success: true, data: provider ? { model: { provider, id: 'm', name: 'M' } } : {} }));
    return t;
  };

  test('without a model, or with one whose login provider is logged out', () => {
    assert.equal(needsLogin(state(null, null)), true);
    assert.equal(needsLogin(state('fake', [{ id: 'fake', authenticated: false }])), true);
  });

  test('not with a logged-in provider, a provider omp does not log in to (keys), or before omp said', () => {
    assert.equal(needsLogin(state('keyed', [{ id: 'keyed', authenticated: true }])), false);
    assert.equal(needsLogin(state('openrouter', [{ id: 'fake', authenticated: false }])), false);
    assert.equal(needsLogin(state('fake', null)), false);
  });
});
