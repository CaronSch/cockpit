#!/usr/bin/env bun
/**
 * Scripted stand-in for `omp --mode rpc-ui`, for daemon and browser tests: it speaks omp's
 * JSONL protocol with frame shapes recorded from omp 18.12.3, and answers prompts by keyword.
 *
 * - default: streams "You said: <prompt>" (assistant message_start arrives pre-filled, as omp's does)
 * - run in a folder whose name has "slow-start": takes 1.5 s to come up
 * - starts with "say:": replies with the rest of the prompt, verbatim (a diagram, a chart…)
 * - contains "tool": a bash tool call with live output, then a reply
 * - contains "ask": an `ask` dialog; the reply names the chosen option
 * - contains "mystery": emits a frame type no client knows
 * - contains "garble": writes a stdout line that is not JSON
 * - contains "table": replies with a markdown table; with "wide" too, a heading, a table wider
 *   than a narrow pane (inline code in its first column) and a nested list of long lines
 * - contains "slow": an intermediate reply and a tool run, then 1.5 s before the final reply
 * - contains "todo": a `todo` tool call setting a three-task list, one done and one in progress
 *   (its result carries the whole list in `details.phases`, as omp's does; so does `get_state`)
 * - contains "think": the final reply opens with a thinking block
 * - contains "notice": omp's notices first, an info one (the tools xdev mounted) and a warning
 * - contains "interrupt": the reply ends as an aborted one does (`stopReason: 'aborted'` with
 *   "Interrupted by user"), and the prompt's result says it was aborted; with "early" too, the
 *   reply is aborted before it says anything (no content), as omp journals one
 * - contains "long": the reply's usage is that of a 250K-token conversation read from a
 *   one-hour prompt cache entry (`cttl.ephemeral1h`), as Anthropic's are reported
 * - `compact`: answers with a summary in omp 18.12.6's `CompactionResult` shape (from its source)
 * - `/rename [title]`: like omp's builtin, names the session (with no title, from the first
 *   prompt that says something: "hi" alone is too little to name a session by; that
 *   outcome follows the answer, as omp's background title generation does)
 * - `/dirs`: like omp's builtin, lists the workspace directories (output of several lines)
 * - `btw`: a side question, answered from the conversation and kept out of it as omp's is;
 *   the answer bolds the first quoted line; a follow-up (`recordId`) appends a turn to its
 *   topic and answers from the topic's quote. A question containing "slow" waits 1.5 s, one
 *   containing "fail" fails as a provider error would.
 * - `get_branch_messages` lists the user messages of the conversation, oldest first, each with
 *   an entry id (not the `msg-N` ids frames carry, as in omp); `branch` rewinds to just before
 *   one and answers with its text, emitting no frames. As omp does, the session goes on in a
 *   new journal beside the old one, with a new id, holding the conversation up to there
 *   (`get_state` reports both); the old journal keeps the path before the rewind. A prompt
 *   containing "drift" is listed reworded, as if another client had rewound and resent it
 *   without the windows hearing of it.
 * - logins: the default model's provider, `fake`, is not logged in (a `login` to it stays
 *   under way); `keyed` is, and its `keyed-model` can be picked from the models
 * With `--resume <file>`, the session continues the journal's conversation: its messages (what
 * `get_messages` returns), title and id (its `session` header's, as omp's `SessionManager`
 * does), and it writes the journal from then on, after every message.
 * New sessions keep a journal in `$TMPDIR/fake-omp-sessions/`, written as omp does: only once
 * the model has replied, then after every message. `--fork <file>` copies that file's title
 * and messages into a new journal at once (omp's `SessionManager.forkFrom`), leaving the
 * source alone; a missing source exits with omp's error. The fake writes a journal flat (no
 * entry ids), which the daemon reads as one path.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

/** Shaped like a real omp reply: a heading, a table too wide for a narrow pane, then long list lines. */
const WIDE_TABLE_REPLY = [
  '### Tips around ours',
  'Each block below put our bundle between two others; the neighbours tipped far less than we did.',
  '| Before us | After us | Next landed |',
  '|---|---|---|',
  '| `0xe67e5d0f9a3c41b2e8d7f6a5c4b3a2918f7e6d5c4b3a29180f7e6d5c4b3a2918` (idx 29) | idx 30 tipped **0.038 gwei**, against our **33.6** | idx 900 |',
  '| `0x3b1f00c2d9e8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2` (idx 12) | idx 13 tipped **0.041 gwei**, against our **28.0** | idx 412 |',
  '',
  '- The builder ordered by tip per gas, so a bundle tipping a thousand times more than its neighbours always lands first in the block, whatever the gas price of the transactions around it.',
  '  - Nested: `bundle_attempts.was_sent_to_the_auction_and_landed_in_the_same_block_as_its_backrun` stays false for every one of these rows, which rules out the auction path.',
  '  - Nested again: the lines here are long enough to wrap several times in a narrow pane.',
  '- Last point, also long enough that it has to wrap at the pane width rather than at the width of the table above it.',
].join('\n');

const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('omp/fake');
  process.exit(0);
}
/** @param {string} flag */
const option = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
const resumed = option('--resume');
const forkedFrom = option('--fork');
const appendedPrompt = option('--append-system-prompt');

/** A journal's lines; a missing one ends the process, as omp's `--resume` and `--fork` do. @param {string} file */
function readJournal(file) {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    process.stderr.write(`Error: Session "${file}" not found.\n`);
    process.exit(1);
  }
}
/** The journal resumed or forked from. @type {Record<string, any>[]} */
const source = resumed ? readJournal(resumed) : forkedFrom ? readJournal(forkedFrom) : [];
const sourceHeader = source.find((entry) => entry.type === 'session');

let sessionId = (resumed && sourceHeader?.id) || randomUUID();
let startedAt = (resumed && sourceHeader?.timestamp) || new Date().toISOString();
let sessionFile = resumed ?? join(tmpdir(), 'fake-omp-sessions', `${sessionId}.jsonl`);
const cwd = (resumed && sourceHeader?.cwd) || process.cwd();
/** The journal this session continues from another (a fork's source, or the one before a rewind). */
let parentSession = forkedFrom ? (sourceHeader?.id ?? null) : null;

/** @type {Record<string, any>[]} */
const messages = source.filter((entry) => entry.type === 'message').map((entry) => entry.message);
let model = { provider: 'fake', id: 'fake-model', name: 'Fake Model' };
let thinkingLevel = 'off';
let msgCounter = 0;
/** @type {string | null} */
let sessionName = source.find((entry) => entry.type === 'title')?.title || null;
/** @type {Map<string, (answer: Record<string, any>) => void>} */
const dialogs = new Map();

/** Rewrites this session's journal: a title line, the header, then one line per message. */
function persist() {
  if (!resumed && !parentSession && !messages.some((m) => m.role === 'assistant')) return;
  const header = { type: 'session', version: 3, id: sessionId, timestamp: startedAt, cwd };
  const lines = [
    { type: 'title', v: 1, title: sessionName ?? '' },
    parentSession ? { ...header, parentSession } : header,
    ...messages.map((message) => ({ type: 'message', message })),
  ];
  mkdirSync(dirname(sessionFile), { recursive: true });
  writeFileSync(sessionFile, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
}
// A fork is written at once; a resumed journal is written as it changes.
if (!resumed) persist();

/** @param {Record<string, any>} frame */
const out = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
/** @param {string | undefined} id @param {string} command @param {unknown} [data] */
const ok = (id, command, data) => out({ id, type: 'response', command, success: true, ...(data === undefined ? {} : { data }) });
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.0125 } };
const longUsage = { input: 10, output: 5, cacheRead: 249_000, cacheWrite: 1000, totalTokens: 250_015, cttl: { ephemeral1h: 1000 }, cost: { total: 0.15 } };

/** The entry id of the message at `index`: stable while the conversation only grows or rewinds. @param {number} index */
const entryId = (index) => `e${index.toString(16).padStart(8, '0')}`;

/** @param {Record<string, any>} message */
function record(message) {
  const messageId = `msg-${++msgCounter}`;
  messages.push(message);
  persist();
  return messageId;
}

/**
 * @param {string} text @param {string | null} [thinking] streamed as a thinking block ahead of the text
 * @param {{ stopReason: string, errorMessage?: string }} [ending] how the message ends
 * @param {Record<string, any>} [used] the request's usage
 */
function streamAssistant(text, thinking = null, ending = { stopReason: 'stop' }, used = usage) {
  const content = [...(thinking === null ? [] : [{ type: 'thinking', thinking }]), { type: 'text', text }];
  const final = { role: 'assistant', content, provider: model.provider, model: model.id, usage: used, ...ending, timestamp: Date.now() };
  const messageId = record(final);
  out({ type: 'message_start', message: final, messageId }); // pre-filled, like real omp
  /** @param {Record<string, any>} event */
  const update = (event) => out({ type: 'message_update', assistantMessageEvent: event, message: { role: 'assistant' }, messageId });
  const at = content.length - 1;
  if (thinking !== null) {
    update({ type: 'thinking_start', contentIndex: 0 });
    update({ type: 'thinking_delta', contentIndex: 0, delta: thinking });
    update({ type: 'thinking_end', contentIndex: 0, content: thinking });
  }
  update({ type: 'text_start', contentIndex: at });
  for (const piece of text.match(/.{1,6}/gs) ?? []) update({ type: 'text_delta', contentIndex: at, delta: piece });
  update({ type: 'text_end', contentIndex: at, content: text });
  out({ type: 'message_end', message: final, messageId });
}

/** Each call gets its own id, as omp's do: a session may run the same tool many times. */
let toolCalls = 0;
/** The agent's todo list, as `get_state` reports it. @type {Record<string, any>[]} */
let todoPhases = [];

/**
 * One tool call, run and answered: the assistant message asking for it, its execution frames,
 * then its result message.
 * @param {string} name @param {Record<string, any>} args @param {string} intent
 * @param {Record<string, any>} result `{ content, details }`
 */
function runTool(name, args, intent, result) {
  const toolCallId = `tool-${++toolCalls}`;
  const call = { type: 'toolCall', id: toolCallId, name, arguments: args, intent };
  const assistant = { role: 'assistant', content: [call], provider: model.provider, model: model.id, usage, stopReason: 'toolUse', timestamp: Date.now() };
  const messageId = record(assistant);
  out({ type: 'message_start', message: assistant, messageId });
  out({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0 }, message: { role: 'assistant' }, messageId });
  out({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 0, toolCall: call }, message: { role: 'assistant' }, messageId });
  out({ type: 'message_end', message: assistant, messageId });
  out({ type: 'tool_execution_start', toolCallId, toolName: name, args, intent: call.intent });
  out({ type: 'tool_execution_update', toolCallId, toolName: name, args, partialResult: result });
  out({ type: 'tool_execution_end', toolCallId, toolName: name, result, isError: false });
  const toolResult = { role: 'toolResult', toolCallId, toolName: name, content: result.content, details: result.details, isError: false, timestamp: Date.now() };
  const resultId = record(toolResult);
  out({ type: 'message_start', message: toolResult, messageId: resultId });
  out({ type: 'message_end', message: toolResult, messageId: resultId });
}

const toolCall = () => runTool('bash', { command: 'echo hi' }, 'Running echo', { content: [{ type: 'text', text: 'hi\n' }], details: {} });

/**
 * A shell call omp backgrounds as a job, as omp 18.12 does with a long one: its result says so
 * (`details.async`), and the job's output comes as an `async-result` message once it ends,
 * after the turn.
 */
function backgroundCall() {
  const result = { content: [{ type: 'text', text: 'Backgrounded as job bg_1' }], details: { async: { state: 'running', jobId: 'bg_1', type: 'bash' }, timeoutSeconds: 900 } };
  runTool('bash', { command: './deploy.sh' }, 'Deploying', result);
  setTimeout(() => {
    const delivery = { role: 'custom', customType: 'async-result', content: 'bg_1 completed', display: true, details: { jobs: [{ jobId: 'bg_1', status: 'completed' }] }, timestamp: Date.now() };
    const deliveryId = record(delivery);
    out({ type: 'message_start', message: delivery, messageId: deliveryId });
    out({ type: 'message_end', message: delivery, messageId: deliveryId });
  }, 2000);
}

function todoCall() {
  const tasks = [
    { content: 'Read the code', status: 'completed' },
    { content: 'Write the fix', status: 'in_progress' },
    { content: 'Run the tests', status: 'pending' },
  ];
  todoPhases = [{ name: 'Fix', tasks }];
  runTool('todo', { op: 'start', task: 'Write the fix' }, 'Writing the fix', { content: [{ type: 'text', text: 'Fix: 1/3 done' }], details: { op: 'start', phases: todoPhases } });
}

/** @returns {Promise<Record<string, any>>} */
function askDialog() {
  const id = `ui-${Date.now()}`;
  out({
    type: 'extension_ui_request',
    id,
    method: 'ask',
    questions: [{ id: 'db', question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite', description: 'file based' }], recommended: 1 }],
  });
  return new Promise((resolve) => dialogs.set(id, resolve));
}

/** @param {string | undefined} id @param {string} text */
async function runPrompt(id, text) {
  const firstMessage = messages.length;
  out({ type: 'agent_start' });
  out({ type: 'turn_start' });
  const user = { role: 'user', content: [{ type: 'text', text }], attribution: 'user', timestamp: Date.now() };
  const userId = record(user);
  out({ type: 'message_start', message: user, messageId: userId });
  out({ type: 'message_end', message: user, messageId: userId });
  if (/mystery/.test(text)) out({ type: 'mystery_frame', payload: 42 });
  if (/notice/.test(text)) {
    out({ type: 'notice', level: 'info', message: 'xd://: github (12 tools); linear (8 tools)', source: 'xdev' });
    out({ type: 'notice', level: 'warning', message: 'Memory retention failed', source: 'Hindsight' });
  }
  if (/garble/.test(text)) process.stdout.write('this line is not json\n');
  if (/tool/.test(text)) toolCall();
  if (/todo/.test(text)) todoCall();
  if (/background/.test(text)) backgroundCall();
  if (/slow/.test(text)) {
    // A turn's middle: an intermediate reply and a tool run, then a pause before the final reply.
    streamAssistant('Let me check first.', null, { stopReason: 'toolUse' }); // it goes on to call a tool, as omp marks it
    toolCall();
    await Bun.sleep(1500);
  }
  if (text.startsWith('say:')) {
    streamAssistant(text.slice('say:'.length).trim());
  } else if (/ask/.test(text)) {
    const answer = await askDialog();
    const picked = answer.cancelled ? 'nothing (cancelled)' : (answer.answers?.[0]?.selectedOptions?.[0] ?? answer.answers?.[0]?.customInput);
    streamAssistant(`You picked **${picked}**.`);
  } else if (/interrupt/.test(text) && /early/.test(text)) {
    const aborted = { role: 'assistant', content: [], provider: model.provider, model: model.id, usage, stopReason: 'aborted', errorMessage: 'Interrupted by user', timestamp: Date.now() };
    const messageId = record(aborted);
    out({ type: 'message_start', message: aborted, messageId });
    out({ type: 'message_end', message: aborted, messageId });
  } else if (/interrupt/.test(text)) {
    streamAssistant('I was about to', null, { stopReason: 'aborted', errorMessage: 'Interrupted by user' });
  } else if (/wide/.test(text) && /table/.test(text)) {
    streamAssistant(WIDE_TABLE_REPLY);
  } else if (/table/.test(text)) {
    streamAssistant('Here it is:\n| When | What happens | Code |\n|---|---|---|\n| Now | Stuff happened | `tracked.rs:67` |');
  } else {
    streamAssistant(`You said: **${text}**\n\n- one\n- two`, /think/.test(text) ? 'Weighing what to say.' : null, undefined, /long/.test(text) ? longUsage : usage);
  }
  out({ type: 'turn_end', message: messages.at(-1), toolResults: [] });
  out({ type: 'extension_ui_request', id: `ui-${Date.now()}-w`, method: 'setWidget', widgetKey: 'autoresearch' }); // omp clears it every turn
  out({ type: 'agent_end', messages: messages.slice(firstMessage), isTerminal: true, yielded: true });
  out({ type: 'prompt_result', id, agentInvoked: true, status: /interrupt/.test(text) ? 'aborted' : 'completed', sessionSettled: true });
  out({ type: 'session_settled' });
}

/**
 * Like omp's builtin, answered with `agentInvoked: false` and no `prompt_result`. A given
 * title is applied before the answer; with none, omp generates one in the background
 * (builtin-lifecycle.ts `rename`), so the answer comes first and the outcome after it.
 * @param {string | undefined} id @param {string} title
 */
function rename(id, title) {
  const apply = () => {
    const said = messages.filter((m) => m.role === 'user').map((m) => String(m.content?.[0]?.text ?? ''));
    const topic = said.find((text) => !/^\s*hi\s*$/i.test(text));
    const name = title || (topic ? `About ${topic.split(/\s+/).slice(0, 4).join(' ')}` : null);
    if (!name) return out({ type: 'command_output', text: 'Could not generate a session title. Use /rename <title> to set one.' });
    sessionName = name;
    persist();
    out({ type: 'session_info_update', title: name, sessionId });
    out({ type: 'command_output', text: `Session renamed to ${name}.` });
  };
  if (title) apply();
  ok(id, 'prompt', { agentInvoked: false });
  if (!title) setTimeout(apply, 50);
}

/** Side topics by id, each one omp's record: its first turn, follow-ups in `followUps`. @type {Map<string, Record<string, any>>} */
const topics = new Map();
/** The side question being answered, as omp runs one at a time. @type {{ record: Record<string, any>, timer?: ReturnType<typeof setTimeout> } | null} */
let sideQuestion = null;

/**
 * omp's `patchLatestBtwTurn`: the newest turn is the last follow-up, else the record itself.
 * @param {Record<string, any>} record @param {Record<string, any>} patch @returns {Record<string, any>}
 */
function patchLatestTurn(record, patch) {
  const followUps = record.followUps;
  return followUps?.length ? { ...record, followUps: [...followUps.slice(0, -1), { ...followUps.at(-1), ...patch }] } : { ...record, ...patch };
}

/** @param {string | undefined} id @param {string} question @param {string | undefined} recordId */
function btw(id, question, recordId) {
  const fail = (/** @type {string} */ error) => out({ id, type: 'response', command: 'btw', success: false, error });
  if (sideQuestion) return fail('A /btw question is still running; cancel it first');
  const previous = recordId === undefined ? undefined : topics.get(recordId);
  if (recordId !== undefined && !previous) return fail(`Unknown /btw topic: ${recordId}`);
  const now = Date.now();
  const turn = { question, answer: '', status: 'running', createdAt: now, updatedAt: now };
  /** @type {Record<string, any>} */
  const record = previous ? { ...previous, followUps: [...(previous.followUps ?? []), turn] } : { ...turn, id: `btw-${now}`, leafId: 'leaf-1' };
  const current = { record, timer: /** @type {ReturnType<typeof setTimeout> | undefined} */ (undefined) };
  sideQuestion = current;
  topics.set(record.id, record);
  out({ type: 'btw_record', record });
  ok(id, 'btw', { record });
  const quoted = /^> (.*)$/m.exec(record.question)?.[1] ?? 'that';
  const answer = previous ? `More on **${quoted}**: it came up once.` : `**${quoted}** is what the conversation said.`;
  current.timer = setTimeout(() => {
    if (/fail/.test(question)) return finishSideQuestion({ status: 'error', error: 'Provider error: overloaded' });
    for (const delta of answer.match(/.{1,8}/gs) ?? []) {
      current.record = patchLatestTurn(current.record, { answer: (current.record.followUps?.at(-1) ?? current.record).answer + delta });
      out({ type: 'btw_delta', recordId: record.id, delta });
    }
    finishSideQuestion({ answer, status: 'complete' });
  }, /slow/.test(question) ? 1500 : 0);
}

/** @param {Record<string, any>} patch */
function finishSideQuestion(patch) {
  if (!sideQuestion) return;
  clearTimeout(sideQuestion.timer);
  const record = patchLatestTurn(sideQuestion.record, { ...patch, updatedAt: Date.now() });
  topics.set(record.id, record);
  out({ type: 'btw_record', record });
  sideQuestion = null;
}

// omp in a folder named for it is slow to come up, as a real one with a long history can be.
if (/slow-start/.test(process.cwd())) await Bun.sleep(1500);
out({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });
out({ type: 'extension_ui_request', id: 'ui-start-w', method: 'setWidget', widgetKey: 'autoresearch' });
out({ type: 'advisor_cost_changed' });
out({
  type: 'available_commands_update',
  commands: [
    { name: 'model', aliases: ['models'], description: 'Show current model selection', source: 'builtin' },
    {
      name: 'compact',
      description: 'Compact the conversation',
      input: { hint: '[soft|remote|snapcompact] [focus]' },
      subcommands: [{ name: 'soft', description: 'Summarize locally with the active model (skip server compaction)', usage: '[focus]' }],
      source: 'builtin',
    },
    { name: 'rename', description: 'Rename the current session (omit title to generate)', input: { hint: '[title]' }, source: 'builtin' },
    { name: 'dirs', description: "List this session's workspace directories", source: 'builtin' },
  ],
});

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (!line.trim()) return;
  const cmd = JSON.parse(line);
  const { id, type } = cmd;
  switch (type) {
    case 'extension_ui_response':
      dialogs.get(cmd.id)?.(cmd);
      dialogs.delete(cmd.id);
      return;
    case 'negotiate_protocol':
      return ok(id, type, { protocolVersion: 2 });
    case 'set_event_filter':
      return ok(id, type, { events: cmd.events, messageUpdates: cmd.messageUpdates ?? 'full' });
    case 'set_ask_dialog':
      return ok(id, type, { enabled: cmd.enabled });
    case 'get_state':
      return ok(id, type, {
        model,
        thinkingLevel,
        isStreaming: false,
        isCompacting: false,
        steeringMode: 'one-at-a-time',
        followUpMode: 'one-at-a-time',
        interruptMode: 'immediate',
        sessionFile,
        sessionId,
        ...(sessionName ? { sessionName } : {}),
        ...(appendedPrompt ? { appendedPrompt } : {}), // the fake's own: what the daemon appended
        autoCompactionEnabled: true,
        queuedMessageCount: 0,
        hasPendingAsyncWork: false,
        isSettled: true,
        queuedMessages: { steering: [], followUp: [], liveSteered: 0 },
        messageCount: messages.length,
        contextUsage: { tokens: 120, contextWindow: 1000, percent: 12 },
        goal: null,
        todoPhases,
      });
    case 'get_messages':
      return ok(id, type, { messages });
    case 'get_branch_messages':
      return ok(id, type, {
        messages: messages.flatMap((m, i) => {
          const text = String(m.content?.[0]?.text ?? '');
          return m.role === 'user' ? [{ entryId: entryId(i), text: /drift/.test(text) ? `${text} (reworded elsewhere)` : text }] : [];
        }),
      });
    case 'branch': {
      const at = messages.findIndex((m, i) => m.role === 'user' && entryId(i) === cmd.entryId);
      if (at === -1) return out({ id, type: 'response', command: type, success: false, error: `Entry ${cmd.entryId} not found` });
      const text = String(messages[at].content?.[0]?.text ?? '');
      messages.splice(at);
      // A new journal beside the old one, which keeps the path before the rewind.
      parentSession = sessionId;
      sessionId = randomUUID();
      startedAt = new Date().toISOString();
      sessionFile = join(dirname(sessionFile), `${startedAt.replace(/[:.]/g, '-')}_${sessionId}.jsonl`);
      persist();
      return ok(id, type, { text, cancelled: false });
    }
    case 'get_available_models':
      return ok(id, type, { models: [model, { provider: 'fake', id: 'fake-large', name: 'Fake Large' }, { provider: 'keyed', id: 'keyed-model', name: 'Keyed Model' }] });
    case 'set_model':
      model = { provider: cmd.provider, id: cmd.modelId, name: cmd.modelId };
      out({ type: 'model_changed' }); // no payload, emitted while the model is set
      return ok(id, type, model);
    case 'get_available_thinking_levels':
      return ok(id, type, { levels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'] });
    case 'set_thinking_level':
      thinkingLevel = cmd.level;
      out({ type: 'thinking_level_changed', thinkingLevel });
      return ok(id, type);
    case 'get_login_providers':
      return ok(id, type, {
        providers: [
          { id: 'fake', name: 'Fake Provider', available: true, authenticated: false },
          { id: 'keyed', name: 'Keyed Provider', available: true, authenticated: true },
        ],
      });
    case 'bash': {
      // Like omp, answer only when the command finishes; "sleep" makes it take a while.
      const result = { exitCode: 0, cancelled: false, workingDir: process.cwd(), output: 'hi\n', truncated: false, totalLines: 2, totalBytes: 3, outputLines: 2, outputBytes: 3 };
      return void setTimeout(() => ok(id, type, result), /sleep/.test(cmd.command) ? 600 : 0);
    }
    case 'abort':
      return ok(id, type);
    case 'btw':
      return btw(id, String(cmd.question ?? ''), cmd.recordId);
    case 'btw_cancel': {
      const cancelled = sideQuestion !== null && (cmd.recordId === undefined || sideQuestion.record.id === cmd.recordId);
      if (cancelled) finishSideQuestion({ status: 'cancelled' });
      return ok(id, type, { cancelled });
    }
    case 'compact':
      return ok(id, type, { summary: 'The user and the agent talked at length.', shortSummary: 'A long talk', firstKeptEntryId: entryId(messages.length - 1), tokensBefore: longUsage.totalTokens });
    case 'abort_and_restore_queue':
      out({ type: 'queue_update', steering: [], followUp: [], liveSteered: 0 });
      return ok(id, type, { steering: [], followUp: [] });
    case 'prompt':
      if (/^\/rename(\s|$)/.test(cmd.message)) return rename(id, cmd.message.slice('/rename'.length).trim());
      if (cmd.message.trim() === '/dirs') {
        out({ type: 'command_output', text: `Workspace directories:\n  ${process.cwd()} (working directory)` });
        return ok(id, type, { agentInvoked: false });
      }
      ok(id, type);
      return void runPrompt(id, cmd.message);
    default:
      return out({ id, type: 'response', command: type, success: false, error: `Unknown command: ${type}` });
  }
});
lines.on('close', () => process.exit(0));
