#!/usr/bin/env bun
/**
 * Scripted stand-in for `omp --mode rpc-ui`, for daemon and browser tests: it speaks omp's
 * JSONL protocol with frame shapes recorded from omp 18.19.0, and answers prompts by keyword.
 *
 * - default: streams "You said: <prompt>" (assistant message_start arrives holding the first
 *   piece already streamed, as omp's does; each block's `*_start` then starts it afresh)
 * - omp's continue directive (src/omp/message.js): replies "Carrying on where I left off."
 *   without reading it for the keywords below (it says "ask", "interrupted" and "notice")
 * - run in a folder whose name has "slow-start": takes 1.5 s to come up
 * - starts with "say:": replies with the rest of the prompt, verbatim (a diagram, a chart…)
 * - contains "tool": a bash tool call with live output, then a reply
 * - contains "ask": an `ask` tool call, its form walked as omp 18.19 walks one without a form
 *   surface: a `select` of the options and "Other (type your own)", which asks on with an
 *   `input`; the reply names the answer, and a cancelled dialog aborts the turn
 * - contains "approve": a `confirm` dialog, as omp asks to approve a command; the reply says
 *   whether it was approved, denied or cancelled
 * - contains "spawn": a `task` call starting subagents Alpha and Beta in the background, which
 *   run until a prompt containing "kill" cancels them through `proc://` (shapes of omp 18.12.6)
 * - contains "revive": a `write` to `agent://Alpha`, which a parked Alpha wakes for
 * - contains "prefill": a `set_editor_text` request ("Prefilled by the agent") before the reply
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
 * - `compact`: answers with a summary in omp 18.12.6's `CompactionResult` shape (from its source),
 *   between `manual_compaction_start` and `manual_compaction_end`, as omp 18.19 announces one
 * - contains "style": says whether its system prompt carries the rules "I have ADHD" adds
 *   (daemon/adhd.js): "Writing in ADHD mode." or "Writing as usual."
 * - `schedule <JSON>`, `plan <JSON>`: calls the host's `schedule` or `plan` tool (the daemon's, given
 *   by `set_host_tools`) with that JSON as its arguments, as omp runs a host tool (`host_tool_call`,
 *   answered by `host_tool_result`; frame shapes from omp 18.10.3's source), then replies with its answer
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
 *
 * With `-p` it is the decision reviewer instead (daemon/decisions.js): it answers the message
 * (its last argument, the turn) and exits, as `omp -p` does. A turn containing "decide" gets
 * two decisions, one with a list mark the daemon takes off; one containing "reviewer fails"
 * fails as a provider error would; any other, NONE. Asked to title a fork (daemon/fork-title.js's
 * system prompt), it answers `"Forked: <the fork's first prompt>".` (quoted and closed, as a
 * model might), or fails for a prompt containing "untitled".
 *
 * `models --json` and `login [provider]` stand in for omp's own, as Setup runs them
 * (daemon/setup.js): the models of the providers signed in (see `signedIn`), and a terminal login
 * that picks a provider by number, prints its sign-in URL and asks for a code ("good" signs in).
 * `get_state` also reports the `PI_BROWSER_*` variables the daemon set (daemon/browser.js).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { isContinueDirective } from '../../src/omp/message.js';

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
/**
 * The providers `models` and `login` (daemon/setup.js) find signed in: those listed, one a line,
 * in the file `$FAKE_OMP_AUTH` names (none while it does not exist), else `keyed`.
 */
const authFile = process.env.FAKE_OMP_AUTH;
const signedIn = () => (authFile ? (existsSync(authFile) ? readFileSync(authFile, 'utf8').split('\n').filter(Boolean) : []) : ['keyed']);
if (args[0] === 'models' && args.includes('--json')) {
  console.log(JSON.stringify({ models: signedIn().flatMap((provider) => [`${provider}-model`, `${provider}-small`].map((id) => ({ provider, kind: 'chat', id, selector: `${provider}/${id}`, name: id }))) }));
  process.exit(0);
}
if (args[0] === 'login') {
  // As omp's terminal login: a numbered pick (unless a provider is named), the sign-in URL, and,
  // as a paste-code provider asks, the code: "good" signs in, anything else fails.
  const providers = [
    { id: 'fake-cloud', name: 'Fake Cloud' },
    { id: 'keyed', name: 'Keyed' },
  ];
  const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
  /** @param {string} question */
  const ask = async (question) => {
    process.stdout.write(question);
    return String((await lines.next()).value ?? '').trim();
  };
  /** @param {string} message @returns {never} */
  const failLogin = (message) => {
    process.stderr.write(`Login failed: ${message}\n`);
    process.exit(1);
  };
  let provider = providers.find((p) => p.id === args[1]);
  if (args[1] && !provider) failLogin(`Unknown OAuth provider '${args[1]}'. Run \`omp login\` to pick one.`);
  if (!provider) {
    process.stdout.write(`Select a provider:\n\n${providers.map((p, i) => `  ${i + 1}. ${p.name}\n`).join('')}\n`);
    const choice = await ask(`Enter number (1-${providers.length}): `);
    provider = providers[Number.parseInt(choice, 10) - 1] ?? failLogin(`Invalid selection: ${choice}`);
  }
  process.stdout.write(`\nOpen this URL in your browser:\nhttps://login.fake.example/${provider.id}\n\n`);
  if ((await ask('Paste the authorization code (or full redirect URL): ')) !== 'good') failLogin('invalid authorization code');
  if (authFile) writeFileSync(authFile, `${[...new Set([...signedIn(), provider.id])].join('\n')}\n`);
  process.stdout.write(`\nLogged in to ${provider.name}\n`);
  process.exit(0);
}
if (args.includes('-p')) {
  const turn = args.at(-1) ?? '';
  if (args[args.indexOf('--system-prompt') + 1]?.startsWith('You title a fork')) {
    const prompt = turn.split('First message in the fork:\n')[1] ?? '';
    if (prompt.includes('untitled')) process.exit(1);
    console.log(`"Forked: ${prompt.split('\n')[0]}".`);
    process.exit(0);
  }
  // Spotlight's Ask (daemon/ask.js): the conversation in index.tsv sharing the most words with
  // the question, named as the real agent names one; none, if none shares a word.
  if (args[args.indexOf('--system-prompt') + 1]?.startsWith("You find things in the user's past conversations")) {
    const words = (/** @type {string} */ text) => new Set(text.toLowerCase().match(/[a-z]{4,}/g) ?? []);
    const asked = words(turn);
    const scored = readFileSync('index.tsv', 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t'))
      .map((cols) => ({ cols, score: [...words(`${cols[1]} ${cols[4]}`)].filter((w) => asked.has(w)).length }))
      .sort((a, b) => b.score - a.score);
    const best = scored[0]?.score ? scored[0].cols : null;
    console.log(best ? `It was in **${best[1] || best[4]}**, last active ${best[3]}.\n\nCONVERSATION: ${best[0]}` : 'Nothing in your conversations answers that.');
    process.exit(0);
  }
  if (turn.includes('reviewer fails')) {
    process.stderr.write('Warning: MCP server "x" failed to connect\nError: 529 overloaded\n');
    process.exit(1);
  }
  console.log(turn.includes('decide') ? '- Picked SQLite over Postgres, as nothing needs a server.\nKept the old API as an alias.' : 'NONE');
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
/** The journal this session continues from another: a fork's source by its id, the one before a rewind by its path, as omp's headers name them. */
let parentSession = forkedFrom ? (sourceHeader?.id ?? null) : null;

/** @type {Record<string, any>[]} */
const messages = source.filter((entry) => entry.type === 'message').map((entry) => entry.message);
/** How many of them a compaction in the journal left out of the context, which `get_messages` answers with, as omp's does. */
const compacted = source.slice(0, source.findLastIndex((entry) => entry.type === 'compaction') + 1).filter((entry) => entry.type === 'message').length;
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
  /** @type {Array<{ type: 'thinking', thinking: string } | { type: 'text', text: string }>} */
  const content = [...(thinking === null ? [] : [{ type: /** @type {const} */ ('thinking'), thinking }]), { type: /** @type {const} */ ('text'), text }];
  const final = { role: 'assistant', content, provider: model.provider, model: model.id, usage: used, ...ending, timestamp: Date.now() };
  const messageId = record(final);
  const pieces = (/** @type {string} */ body) => body.match(/.{1,6}/gs) ?? [];
  const bodyOf = (/** @type {(typeof content)[number]} */ block) => (block.type === 'thinking' ? block.thinking : block.text);
  // omp sends message_start once the first piece has streamed, holding that piece alone.
  const opening = { ...content[0], [content[0].type]: pieces(bodyOf(content[0]))[0] ?? '' };
  out({ type: 'message_start', message: { role: 'assistant', content: [opening], provider: model.provider, model: model.id, usage: used, stopReason: 'stop', timestamp: final.timestamp }, messageId });
  /** @param {Record<string, any>} event */
  const update = (event) => out({ type: 'message_update', assistantMessageEvent: event, message: { role: 'assistant' }, messageId });
  content.forEach((block, contentIndex) => {
    // Under the daemon's `delta` filter, a block's start carries it opened (empty), its end its other fields.
    update({ type: `${block.type}_start`, contentIndex, block: { ...block, [block.type]: '' } });
    for (const delta of pieces(bodyOf(block))) update({ type: `${block.type}_delta`, contentIndex, delta });
    update({ type: `${block.type}_end`, contentIndex, content: bodyOf(block), block: { type: block.type } });
  });
  out({ type: 'message_end', message: final, messageId });
}

/** Each call gets its own id, as omp's do: a session may run the same tool many times. */
let toolCalls = 0;
/** The agent's todo list, as `get_state` reports it. @type {Record<string, any>[]} */
let todoPhases = [];

/**
 * The start of a tool call: the assistant message asking for it and its execution's start; its
 * id, for the rest.
 * @param {string} name @param {Record<string, any>} args @param {string} intent
 */
function startTool(name, args, intent) {
  const toolCallId = `tool-${++toolCalls}`;
  const call = { type: 'toolCall', id: toolCallId, name, arguments: args, intent };
  const assistant = { role: 'assistant', content: [call], provider: model.provider, model: model.id, usage, stopReason: 'toolUse', timestamp: Date.now() };
  const messageId = record(assistant);
  const opened = { type: 'toolCall', id: toolCallId, name, arguments: {} };
  out({ type: 'message_start', message: { ...assistant, content: [opened], stopReason: 'stop' }, messageId });
  /** @param {Record<string, any>} event */
  const update = (event) => out({ type: 'message_update', assistantMessageEvent: { ...event, contentIndex: 0 }, message: { role: 'assistant' }, messageId });
  update({ type: 'toolcall_start', block: opened });
  update({ type: 'toolcall_delta', delta: JSON.stringify(args) });
  update({ type: 'toolcall_end', toolCall: call });
  out({ type: 'message_end', message: assistant, messageId });
  out({ type: 'tool_execution_start', toolCallId, toolName: name, args, intent: call.intent });
  return toolCallId;
}

/**
 * The end of tool call `toolCallId`: its execution's end, then its result message.
 * @param {string} toolCallId @param {string} name @param {Record<string, any>} result `{ content, details }` @param {boolean} isError
 */
function endTool(toolCallId, name, result, isError) {
  out({ type: 'tool_execution_end', toolCallId, toolName: name, result, isError });
  const toolResult = { role: 'toolResult', toolCallId, toolName: name, content: result.content, details: result.details, isError, timestamp: Date.now() };
  const resultId = record(toolResult);
  out({ type: 'message_start', message: toolResult, messageId: resultId });
  out({ type: 'message_end', message: toolResult, messageId: resultId });
}

/**
 * One tool call, run and answered: the assistant message asking for it, its execution frames,
 * then its result message.
 * @param {string} name @param {Record<string, any>} args @param {string} intent
 * @param {Record<string, any>} result `{ content, details }`
 */
function runTool(name, args, intent, result) {
  const toolCallId = startTool(name, args, intent);
  out({ type: 'tool_execution_update', toolCallId, toolName: name, args, partialResult: result });
  endTool(toolCallId, name, result, false);
}

/** The host's tools (`set_host_tools`), by name. @type {Map<string, Record<string, any>>} */
const hostTools = new Map();
/** Host tool calls waiting on the host's answer (`host_tool_result`), by request id. @type {Map<string, (answer: Record<string, any>) => void>} */
const hostCalls = new Map();

/**
 * A call of the host's tool `name`, as omp's RpcHostToolBridge makes it: `host_tool_call`, then
 * the host's `host_tool_result` is the result (an error's text the error); a tool the host did
 * not give fails as omp's unknown tools do. Returns the result's text.
 * @param {string} name @param {Record<string, any>} args @returns {Promise<string>}
 */
async function hostToolCall(name, args) {
  const toolCallId = startTool(name, args, `Using ${name}`);
  /** @type {Record<string, any>} */
  let answer = { result: { content: [{ type: 'text', text: `Tool ${name} not found` }] }, isError: true };
  if (hostTools.has(name)) {
    const id = `host-${toolCallId}`;
    out({ type: 'host_tool_call', id, toolCallId, toolName: name, arguments: args });
    answer = await new Promise((resolve) => hostCalls.set(id, resolve));
  }
  endTool(toolCallId, name, answer.result, answer.isError === true);
  return answer.result.content.map((/** @type {any} */ c) => c.text).join('\n');
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

/** A call starting two subagents: its result names the first in `details.async`, both in `progress`. */
function spawnCall() {
  const progress = ['Alpha', 'Beta'].map((id, index) => ({ index, id, agent: 'task', status: 'pending' }));
  runTool('task', { tasks: [] }, 'Spawning two agents', { content: [{ type: 'text', text: 'Spawned 2 background agents using task.' }], details: { results: [], progress, async: { state: 'running', jobId: 'Alpha', type: 'task' } } });
}

function reviveCall() {
  const message = { op: 'send', from: 'Main', to: 'Alpha', receipts: [{ to: 'Alpha', outcome: 'revived' }] };
  runTool('write', { path: 'agent://Alpha', content: 'One more thing' }, 'Asking Alpha', { content: [{ type: 'text', text: 'Queued for Alpha (was parked; revived).' }], details: { message } });
}

function killCall() {
  const jobs = ['Alpha', 'Beta'].map((id) => ({ id, type: 'task', status: 'cancelled' }));
  runTool('write', { path: 'proc://all/kill', content: '' }, 'Cancelling agents', { content: [{ type: 'text', text: 'Cancelled.' }], details: { proc: { op: 'cancel', jobs } } });
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

let dialogCount = 0;
/** A dialog omp asks the client for; the client's answer. @param {Record<string, any>} request @returns {Promise<Record<string, any>>} */
function dialog(request) {
  const id = `ui-${++dialogCount}`;
  out({ type: 'extension_ui_request', id, ...request });
  return new Promise((resolve) => dialogs.set(id, resolve));
}

/** A reply aborted before it said anything, as omp journals one. */
function abortedReply() {
  const aborted = { role: 'assistant', content: [], provider: model.provider, model: model.id, usage, stopReason: 'aborted', errorMessage: 'Interrupted by user', timestamp: Date.now() };
  const messageId = record(aborted);
  out({ type: 'message_start', message: aborted, messageId });
  out({ type: 'message_end', message: aborted, messageId });
}

const OTHER = 'Other (type your own)';
const ASK_FORM = '<form><fieldset><legend>Which database?</legend><label><input type="radio" name="database" value="Postgres" checked> Postgres</label><label><input type="radio" name="database" value="SQLite"> SQLite</label></fieldset></form>';

/**
 * The `ask` tool, its form's one field asked as omp 18.19 asks one without a form surface: a
 * `select` of its options and Other, which asks on with an `input`. The answer, or null once a
 * dialog is cancelled, which fails the call (and omp aborts the turn).
 * @returns {Promise<string | null>}
 */
async function askTool() {
  const toolCallId = startTool('ask', { html: ASK_FORM }, 'Choosing a database');
  const picked = await dialog({ method: 'select', title: 'Which database?', options: ['Postgres', 'SQLite', OTHER] });
  const typed = picked.value === OTHER && !picked.cancelled ? await dialog({ method: 'input', title: 'Which database?' }) : null;
  if (picked.cancelled || typed?.cancelled) {
    endTool(toolCallId, 'ask', { content: [{ type: 'text', text: 'Ask tool was cancelled by the user' }], details: {} }, true);
    return null;
  }
  const answer = String(typed ? typed.value : picked.value);
  const text = `User answers:\n${JSON.stringify({ database: answer }, null, 2)}`;
  endTool(toolCallId, 'ask', { content: [{ type: 'text', text }], details: { answers: [{ name: 'database', question: 'Which database?', answer: typed ? `Other: ${answer}` : answer }] } }, false);
  return answer;
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
  if (isContinueDirective(text)) {
    streamAssistant('Carrying on where I left off.');
    return endTurn(id, firstMessage, 'completed');
  }
  if (/mystery/.test(text)) out({ type: 'mystery_frame', payload: 42 });
  if (/notice/.test(text)) {
    out({ type: 'notice', level: 'info', message: 'xd://: github (12 tools); linear (8 tools)', source: 'xdev' });
    out({ type: 'notice', level: 'warning', message: 'Memory retention failed', source: 'Hindsight' });
  }
  if (/garble/.test(text)) process.stdout.write('this line is not json\n');
  if (/prefill/.test(text)) out({ type: 'extension_ui_request', id: `ui-${Date.now()}-e`, method: 'set_editor_text', text: 'Prefilled by the agent' });
  if (/tool/.test(text)) toolCall();
  if (/todo/.test(text)) todoCall();
  if (/background/.test(text)) backgroundCall();
  if (/spawn/.test(text)) spawnCall();
  if (/revive/.test(text)) reviveCall();
  if (/kill/.test(text)) killCall();
  if (/slow/.test(text)) {
    // A turn's middle: an intermediate reply and a tool run, then a pause before the final reply.
    streamAssistant('Let me check first.', null, { stopReason: 'toolUse' }); // it goes on to call a tool, as omp marks it
    toolCall();
    await Bun.sleep(1500);
  }
  const hostTool = /^(schedule|plan) (\{.*\})$/s.exec(text);
  if (hostTool) {
    streamAssistant(await hostToolCall(hostTool[1], JSON.parse(hostTool[2])));
  } else if (text.startsWith('say:')) {
    streamAssistant(text.slice('say:'.length).trim());
  } else if (/ask/.test(text)) {
    const answer = await askTool();
    if (answer === null) {
      abortedReply();
      return endTurn(id, firstMessage, 'aborted');
    }
    streamAssistant(`You picked **${answer}**.`);
  } else if (/approve/.test(text)) {
    const answer = await dialog({ method: 'confirm', title: 'Allow this command?', message: 'rm -rf build' });
    streamAssistant(answer.cancelled ? 'Approval cancelled.' : answer.confirmed ? 'Approved: going ahead.' : 'Denied: not running it.');
  } else if (/interrupt/.test(text) && /early/.test(text)) {
    abortedReply();
  } else if (/interrupt/.test(text)) {
    streamAssistant('I was about to', null, { stopReason: 'aborted', errorMessage: 'Interrupted by user' });
  } else if (/wide/.test(text) && /table/.test(text)) {
    streamAssistant(WIDE_TABLE_REPLY);
  } else if (/table/.test(text)) {
    streamAssistant('Here it is:\n| When | What happens | Code |\n|---|---|---|\n| Now | Stuff happened | `tracked.rs:67` |');
  } else if (/style/.test(text)) {
    streamAssistant(appendedPrompt?.includes('ADHD MODE ACTIVE') ? 'Writing in ADHD mode.' : 'Writing as usual.');
  } else {
    streamAssistant(`You said: **${text}**\n\n- one\n- two`, /think/.test(text) ? 'Weighing what to say.' : null, undefined, /long/.test(text) ? longUsage : usage);
  }
  endTurn(id, firstMessage, /interrupt/.test(text) ? 'aborted' : 'completed');
}

/** @param {string | undefined} id @param {number} firstMessage @param {'completed' | 'aborted'} status */
function endTurn(id, firstMessage, status) {
  out({ type: 'turn_end', message: messages.at(-1), toolResults: [] });
  out({ type: 'extension_ui_request', id: `ui-${Date.now()}-w`, method: 'setWidget', widgetKey: 'autoresearch' }); // omp clears it every turn
  out({ type: 'agent_end', messages: messages.slice(firstMessage), isTerminal: true, yielded: true });
  out({ type: 'prompt_result', id, agentInvoked: true, status, sessionSettled: true });
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
out({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864, supportsBashExcludeFromContext: true });
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
    case 'set_host_tools':
      hostTools.clear();
      for (const tool of cmd.tools) hostTools.set(tool.name, tool);
      return ok(id, type, { toolNames: [...hostTools.keys()] });
    case 'host_tool_result':
      hostCalls.get(cmd.id)?.(cmd);
      hostCalls.delete(cmd.id);
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
        browserEnv: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('PI_BROWSER_'))), // the fake's own too
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
      return ok(id, type, { messages: messages.slice(compacted) });
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
      parentSession = sessionFile;
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
    case 'compact': {
      const result = { summary: 'The user and the agent talked at length.', shortSummary: 'A long talk', firstKeptEntryId: entryId(messages.length - 1), tokensBefore: longUsage.totalTokens };
      out({ type: 'manual_compaction_start' });
      out({ type: 'manual_compaction_end', result, aborted: false });
      return ok(id, type, result);
    }
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
