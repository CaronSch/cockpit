/**
 * Transcript reducer for one omp session: folds the daemon's SessionEvents into display
 * items plus derived session state, with no DOM.
 *
 * `applyEvent` mutates the state it is given (the stream is high-frequency; copying the
 * whole transcript per delta would be wasteful) and bumps each changed item's `rev`, so a
 * view can redraw only what changed. Replaying the same events into a
 * fresh `createTranscript()` always yields the same state.
 *
 * Invariant: no frame is silently dropped. Every frame type, message role, assistant
 * stream event, content block and UI method is either handled, listed in a
 * `KNOWN_UNRENDERED` set with the reason, or surfaced as an `unrecognised` item.
 */
import { json } from '../ui/format.js';
import { todoPhases } from './todos.js';
/** @import { SessionEvent, SessionMeta } from '../../daemon/wire.js' */
/** @import { TodoPhase } from './todos.js' */

/**
 * One block of an assistant message, in content order.
 * @typedef {(
 *   | { kind: 'text', text: string }
 *   | { kind: 'thinking', text: string, redacted: boolean }
 *   | { kind: 'toolCall', id: string | null, name: string, args: unknown, argsText: string, intent: string | null }
 *   | { kind: 'other', type: string, raw: unknown }
 * )} Block
 */

/**
 * A tool call's execution, shown as one card. Keyed by tool call id in `state.tools`.
 * @typedef {{
 *   id: string, name: string, args: unknown, intent: string | null,
 *   status: 'pending' | 'running' | 'ok' | 'error',
 *   output: string, result: string | null, startedAt: number | null,
 * }} ToolRun
 */

/**
 * A background job omp runs for the agent while it goes on: a shell or a subagent its tool
 * call handed off (`details.async` on the call's result), until omp delivers the job's result
 * (an `async-result` message) or a `wait` reports it ended. `startedAt` is in daemon time.
 * @typedef {{ id: string, type: string, label: string, toolCallId: string, startedAt: number }} Job
 */

/** @typedef {'info' | 'warning' | 'error' | 'muted'} NoteLevel */

/**
 * @typedef {{ key: string, rev: number }} ItemBase
 * @typedef {ItemBase & { kind: 'user', text: string, images: number, byAgent: boolean }} UserItem
 * @typedef {ItemBase & {
 *   kind: 'assistant', blocks: Block[], stopReason: string | null, errorMessage: string | null,
 *   model: string | null, ended: boolean,
 * }} AssistantItem
 * @typedef {ItemBase & { kind: 'tool', toolCallId: string }} ToolItem
 * @typedef {ItemBase & {
 *   kind: 'bash', language: 'bash' | 'python', command: string, requestId: string | null,
 *   status: 'running' | 'ok' | 'error' | 'cancelled', output: string, exitCode: number | null,
 *   truncated: boolean, error: string | null, fromMessage: boolean,
 * }} BashItem
 * @typedef {ItemBase & { kind: 'note', level: NoteLevel, source: string, text: string, detail: string | null, hidden: boolean }} NoteItem
 * @typedef {ItemBase & { kind: 'unrecognised', label: string, raw: string }} UnrecognisedItem
 * @typedef {UserItem | AssistantItem | ToolItem | BashItem | NoteItem | UnrecognisedItem} Item
 */

/**
 * A pending dialog: an omp `extension_ui_request` awaiting an `extension_ui_response`.
 * Fields are as omp sent them (see omp's rpc docs, "Extension UI Sub-Protocol").
 * @typedef {{ id: string, method: 'select' | 'confirm' | 'input' | 'editor' | 'ask' } & Record<string, any>} Dialog
 */

/** @typedef {{ name: string, aliases: string[], description: string, hint: string }} SlashCommand */

/**
 * The parts of omp's `get_state` the pane shows; `name` is the session's title.
 * @typedef {{
 *   model: { provider: string, id: string, name: string } | null,
 *   thinkingLevel: string | null,
 *   contextPercent: number | null,
 *   name: string | null,
 * }} SessionInfo
 */

/**
 * The agent's todo list as it last reported it (omp/todos.js), and whether it changed during
 * the turn running now.
 * @typedef {{ phases: TodoPhase[], updatedInTurn: boolean }} TodoList
 */

/**
 * One turn of a side topic asked with omp's `btw` (see omp/message.js `composeAsk`): the
 * answer to the topic's first question or to a follow-up. Topics are keyed by omp's record
 * id and live beside the chat, never in it: omp answers from the session's context without
 * adding the questions or the answers to it.
 * @typedef {{ answer: string, status: 'running' | 'complete' | 'cancelled' | 'error' | 'interrupted', error: string | null }} SideAnswer
 */

/**
 * @typedef {{
 *   items: Item[],
 *   tools: Map<string, ToolRun>,
 *   jobs: Map<string, Job>,
 *   meta: SessionMeta | null,
 *   session: SessionInfo,
 *   dialogs: Dialog[],
 *   sideAnswers: Map<string, SideAnswer[]>,
 *   streaming: boolean,
 *   queue: { steering: string[], followUp: string[] },
 *   commands: SlashCommand[],
 *   statuses: Record<string, string>,
 *   widgets: Record<string, string[]>,
 *   title: string | null,
 *   todo: TodoList | null,
 *   lastError: string | null,
 *   cost: number,
 *   editorText: { seq: number, text: string } | null,
 *   openUrl: { url: string, launchUrl: string | null, instructions: string | null } | null,
 *   loggedIn: Map<string, boolean> | null,
 *   rewinds: number,
 *   rewound: boolean,
 *   index: Map<string, Item>,
 *   toolOwner: Map<string, string>,
 *   failedRequests: Set<string>,
 *   counted: Set<string>,
 *   nextKey: number,
 * }} Transcript
 */

/**
 * Frame types the pane knows and deliberately does not render.
 * @type {ReadonlySet<string>}
 */
const KNOWN_UNRENDERED = new Set([
  'ready', // startup handshake; the daemon's session status covers it
  'turn_start', // turn boundaries: messages already carry the content
  'turn_end', // repeats the assistant message and tool results already shown
  'session_settled', // quiescence; `agent_end` with `yielded` drives the streaming indicator
  'advisor_cost_changed', // no payload; advisor cost is not part of this pane
  'advisor_yielded', // no payload
  'config_warnings_changed', // no payload; warnings are not exposed over rpc
  'cache_warming_start', // background prompt-cache refreshes, not conversation
  'cache_warming_end',
]);

/** Assistant stream events with nothing to apply: `message_end` carries the result. */
const KNOWN_STREAM_NOOPS = new Set(['start', 'done', 'error']);

/** @returns {Omit<AssistantItem, 'key' | 'rev'>} */
const emptyAssistant = () => ({ kind: 'assistant', blocks: [], stopReason: null, errorMessage: null, model: null, ended: false });

/** @returns {Transcript} */
export function createTranscript() {
  return {
    items: [],
    tools: new Map(),
    jobs: new Map(),
    meta: null,
    session: { model: null, thinkingLevel: null, contextPercent: null, name: null },
    dialogs: [],
    sideAnswers: new Map(),
    streaming: false,
    queue: { steering: [], followUp: [] },
    commands: [],
    statuses: {},
    widgets: {},
    title: null,
    todo: null,
    lastError: null,
    cost: 0,
    editorText: null,
    openUrl: null,
    loggedIn: null,
    rewinds: 0,
    rewound: false,
    index: new Map(),
    toolOwner: new Map(),
    failedRequests: new Set(),
    counted: new Set(),
    nextKey: 0,
  };
}

/**
 * Applies one daemon event to the transcript.
 * @param {Transcript} state @param {SessionEvent} event @returns {Transcript}
 */
export function applyEvent(state, event) {
  switch (event.kind) {
    case 'session':
      state.meta = event.meta;
      if (event.meta.status === 'exited' || event.meta.status === 'failed') {
        // The process is gone: nothing is streaming, no dialog can be answered, no job runs.
        state.streaming = false;
        state.jobs.clear();
        state.dialogs = [];
        state.openUrl = null;
        state.queue = { steering: [], followUp: [] };
      }
      return state;
    case 'frame':
      applyFrame(state, event.frame, event.at);
      return state;
    case 'sent':
      applySent(state, event.command);
      return state;
    case 'stderr':
      addStderr(state, event.line);
      return state;
    case 'garbled':
      push(state, { kind: 'unrecognised', label: 'garbled stdout', raw: `${event.error}\n\n${event.line}` });
      return state;
    default:
      push(state, { kind: 'unrecognised', label: `event ${String(/** @type {any} */ (event).kind)}`, raw: json(event) });
      return state;
  }
}

/**
 * Adds a note the pane itself produced (a transport failure, say).
 * @param {Transcript} state @param {NoteLevel} level @param {string} source @param {string} text
 */
export function addNote(state, level, source, text) {
  note(state, level, source, text);
}

/**
 * Builds the `answers` of an `ask` response exactly as omp's rpc docs require: one entry
 * per question in request order, exact option labels without duplicates, a single-select
 * holding at most one option and never both an option and free text, free text trimmed
 * and omitted when empty.
 * @param {ReadonlyArray<{ id: string, multi?: boolean, options: ReadonlyArray<{ label: string }> }>} questions
 * @param {Readonly<Record<string, { selected: readonly string[], custom: string }>>} picks
 * @returns {Array<{ id: string, selectedOptions: string[], customInput?: string }>}
 */
export function askAnswers(questions, picks) {
  return questions.map((q) => {
    const pick = picks[q.id] ?? { selected: [], custom: '' };
    const labels = new Set(q.options.map((o) => o.label));
    let selected = [...new Set(pick.selected)].filter((l) => labels.has(l));
    const custom = pick.custom.trim();
    if (!q.multi) selected = custom ? [] : selected.slice(0, 1);
    return custom ? { id: q.id, selectedOptions: selected, customInput: custom } : { id: q.id, selectedOptions: selected };
  });
}

// ── Frames ──────────────────────────────────────────────

/**
 * omp's titles start with a nerd-font icon, a private-use character that browsers draw as a
 * box; they reach the pane as the session title and in `/rename`'s output.
 * @param {string} text
 */
const withoutIcons = (text) => text.replace(/\p{Co} ?/gu, '').trim();

/**
 * Whether an `agent_end` hands the turn back to the user; `yielded: false` means the agent
 * carries on. Older runtimes omit `yielded`: treat those as yielded only when terminal.
 * @param {Record<string, any>} frame
 */
export const handsTurnBack = (frame) => (typeof frame.yielded === 'boolean' ? frame.yielded : frame.isTerminal !== false);

const NAME_CHARS = 80;

/**
 * What names the conversation: omp's title (set by a `/rename` the user runs), else the
 * first thing the user asked, on one line, as the Sessions window does for untitled sessions.
 * @param {Transcript} state @returns {string | null}
 */
export function conversationName(state) {
  if (state.session.name) return state.session.name;
  const first = state.items.find((i) => i.kind === 'user' && !i.byAgent && i.text.trim());
  if (first?.kind !== 'user') return null;
  const flat = first.text.replace(/\s+/g, ' ').trim();
  return flat.length > NAME_CHARS ? `${flat.slice(0, NAME_CHARS - 1)}…` : flat;
}

/** @param {Transcript} state @param {Record<string, any>} frame @param {number} at */
function applyFrame(state, frame, at) {
  const type = typeof frame?.type === 'string' ? frame.type : '';
  if (KNOWN_UNRENDERED.has(type)) return;
  switch (type) {
    case 'response':
      return applyResponse(state, frame);
    case 'agent_start':
      state.streaming = true;
      if (state.todo) state.todo.updatedInTurn = false;
      return;
    case 'agent_end': {
      // `messages` repeats what message_end frames already delivered (and may be compacted).
      if (handsTurnBack(frame)) state.streaming = false;
      return;
    }
    case 'message_start':
    case 'message_end':
      return applyMessage(state, frame.message, messageKey(frame), type === 'message_end', at);
    case 'message_update':
      return applyUpdate(state, frame);
    case 'tool_execution_start': {
      const run = ensureTool(state, frame.toolCallId, frame.toolName);
      if (!run) return unrecognised(state, type, frame);
      if (frame.args !== undefined) run.args = frame.args;
      if (typeof frame.intent === 'string') run.intent = frame.intent;
      if (run.status === 'pending') run.status = 'running';
      run.startedAt ??= at;
      return touchTool(state, run.id);
    }
    case 'tool_execution_update': {
      const run = ensureTool(state, frame.toolCallId, frame.toolName);
      if (!run) return unrecognised(state, type, frame);
      run.output = contentText(frame.partialResult?.content);
      return touchTool(state, run.id);
    }
    case 'tool_stream_update': {
      const run = ensureTool(state, frame.toolCallId, frame.toolName);
      if (!run) return unrecognised(state, type, frame);
      // `update` is tool-specific; only a content-shaped update has text worth showing.
      if (Array.isArray(frame.update?.content)) {
        run.output = contentText(frame.update.content);
        touchTool(state, run.id);
      }
      return;
    }
    case 'tool_execution_end': {
      const run = ensureTool(state, frame.toolCallId, frame.toolName);
      if (!run) return unrecognised(state, type, frame);
      run.result = contentText(frame.result?.content);
      run.status = frame.isError ? 'error' : 'ok';
      return touchTool(state, run.id);
    }
    case 'auto_compaction_start':
      return note(state, 'muted', 'compaction', `Compacting context (${frame.reason ?? 'auto'}, ${frame.action ?? 'compact'})…`);
    case 'auto_compaction_end': {
      if (frame.skipped) return note(state, 'muted', 'compaction', 'Compaction skipped');
      if (frame.aborted) return note(state, 'warning', 'compaction', 'Compaction aborted');
      if (frame.errorMessage) return note(state, 'error', 'compaction', `Compaction failed: ${frame.errorMessage}`);
      const summary = frame.result?.shortSummary ?? frame.result?.summary ?? null;
      return note(state, 'muted', 'compaction', 'Context compacted', typeof summary === 'string' ? summary : null);
    }
    case 'auto_retry_start': {
      const wait = typeof frame.delayMs === 'number' ? ` in ${Math.round(frame.delayMs / 1000)}s` : '';
      return note(state, 'warning', 'retry', `Retrying (${frame.attempt}/${frame.maxAttempts})${wait}: ${frame.errorMessage ?? ''}`.trim());
    }
    case 'auto_retry_end':
      return frame.success
        ? note(state, 'muted', 'retry', `Retry ${frame.attempt} succeeded`)
        : note(state, 'error', 'retry', `Retries exhausted: ${frame.finalError ?? 'unknown error'}`);
    case 'retry_fallback_applied':
      return note(state, 'warning', 'retry', `Falling back from ${frame.from} to ${frame.to}${frame.reason ? ` (${frame.reason})` : ''}`);
    case 'retry_fallback_succeeded':
      return note(state, 'muted', 'retry', `Fallback model ${frame.model} answered`);
    case 'model_changed':
    case 'todo_auto_clear':
      return; // no payload; the daemon follows it with a get_state
    case 'thinking_level_changed':
      if (typeof frame.thinkingLevel === 'string') state.session.thinkingLevel = frame.thinkingLevel;
      return;
    case 'config_update':
      if (frame.model && typeof frame.model === 'object') state.session.model = modelInfo(frame.model);
      if (typeof frame.thinkingLevel === 'string') state.session.thinkingLevel = frame.thinkingLevel;
      return;
    case 'ttsr_triggered': {
      const rules = Array.isArray(frame.rules) ? frame.rules.map((r) => r?.name ?? r?.id ?? '?').join(', ') : '';
      return note(state, 'muted', 'rules', `Rule triggered: ${rules}`, json(frame.rules));
    }
    case 'todo_reminder': {
      const open = Array.isArray(frame.todos) ? frame.todos.length : 0;
      return note(state, 'muted', 'todo', `Todo reminder (${frame.attempt}/${frame.maxAttempts}): ${open} open`);
    }
    case 'irc_message':
      return note(state, 'info', `irc ${frame.message?.customType ?? ''}`.trim(), contentText(frame.message?.content));
    case 'notice': {
      const level = levelOf(frame.level);
      const source = frame.source ?? 'notice';
      // An info notice (the tools omp mounted, a mode it switched) is omp's own news, not the
      // conversation: hidden as the messages omp does not display are, its text one click away.
      if (level === 'info') return upsertNote(state, null, source, '', String(frame.message ?? ''), true);
      return note(state, level, source, String(frame.message ?? ''));
    }
    case 'goal_updated':
      return frame.goal
        ? note(state, 'muted', 'goal', `Goal ${frame.goal.status}: ${frame.goal.objective}`)
        : note(state, 'muted', 'goal', 'Goal cleared');
    case 'queue_update':
      state.queue = { steering: strings(frame.steering), followUp: strings(frame.followUp) };
      return;
    case 'prompt_result':
      return applyPromptResult(state, frame);
    case 'extension_error':
      return note(state, 'error', 'extension', `${frame.extensionPath} (${frame.event}): ${frame.error}`);
    case 'available_commands_update':
      state.commands = Array.isArray(frame.commands) ? frame.commands.map(slashCommand) : [];
      return;
    case 'command_output': {
      // One line ("Session renamed to …", whoever ran the command) is a quiet note; longer
      // output is a slash command's answer to read, shown open.
      const output = withoutIcons(String(frame.text ?? ''));
      return output.includes('\n') ? note(state, 'info', 'command', '', output) : note(state, 'muted', 'command', output);
    }
    case 'session_info_update':
      if (typeof frame.title === 'string') state.session.name = withoutIcons(frame.title) || null;
      return;
    // Side questions: each topic's answers, one per turn, go to `sideAnswers`, never into the chat.
    case 'btw_record': {
      const record = frame.record;
      if (typeof record?.id !== 'string') return unrecognised(state, type, frame);
      // omp's record is the topic's first turn, its follow-ups after it.
      const turns = [record, ...(Array.isArray(record.followUps) ? record.followUps : [])];
      state.sideAnswers.set(
        record.id,
        turns.map((turn) => ({ answer: String(turn.answer ?? ''), status: turn.status, error: typeof turn.error === 'string' ? turn.error : null })),
      );
      return;
    }
    case 'btw_delta': {
      // omp streams into the topic's newest turn.
      const answer = state.sideAnswers.get(frame.recordId)?.at(-1);
      if (answer) answer.answer += String(frame.delta ?? '');
      else state.sideAnswers.set(frame.recordId, [{ answer: String(frame.delta ?? ''), status: 'running', error: null }]);
      return;
    }
    case 'rpc_frame_error':
      return note(state, 'error', 'transport', `Dropped ${frame.originalType ?? 'a frame'}: ${frame.error}`);
    case 'extension_ui_request':
      return applyUiRequest(state, frame);
    default:
      return unrecognised(state, type || 'frame without type', frame);
  }
}

/** @param {Transcript} state @param {Record<string, any>} frame */
function applyResponse(state, frame) {
  const command = String(frame.command ?? 'command');
  const id = typeof frame.id === 'string' ? frame.id : null;
  if (!frame.success) {
    if (id) state.failedRequests.add(id);
    if (command === 'bash' && finishBash(state, id, null, String(frame.error ?? 'failed'))) return;
    if (command === 'login') state.openUrl = null;
    return note(state, 'error', command, `${command} failed: ${frame.error ?? 'unknown error'}`);
  }
  switch (command) {
    case 'get_state':
      if (frame.data && typeof frame.data === 'object') applyState(state, frame.data);
      return;
    case 'get_messages':
      if (!Array.isArray(frame.data?.messages)) return;
      if (state.rewound) reseed(state, frame.data.messages);
      else seed(state, frame.data.messages);
      return;
    case 'branch':
      // omp has rewound: the daemon asks for the conversation as it now stands (omp streams
      // none of it), and that answer replaces the transcript.
      state.rewound = true;
      return;
    case 'bash':
      finishBash(state, id, frame.data ?? {}, null);
      return;
    case 'get_login_providers':
      if (Array.isArray(frame.data?.providers)) {
        /** @type {any[]} */
        const providers = frame.data.providers;
        state.loggedIn = new Map(providers.filter((p) => typeof p?.id === 'string').map((p) => [p.id, p.authenticated === true]));
      }
      return;
    case 'login':
      state.openUrl = null;
      return note(state, 'info', 'login', `Logged in${frame.data?.providerId ? ` to ${frame.data.providerId}` : ''}`);
    default:
      // Other successful replies are consumed by whoever sent the command.
      return;
  }
}

/**
 * Whether the session has to log in before it can talk to its model: it has no model, or the
 * model's provider is one omp logs in to (`get_login_providers`) and it is not logged in. omp
 * only starts with, or switches to, a model whose provider has credentials (a key, or a
 * login), so a model from any other provider can be used as it is.
 * @param {Transcript} state
 */
export function needsLogin(state) {
  const model = state.session.model;
  if (!model) return true;
  return state.loggedIn?.get(model.provider) === false;
}

/** @param {Transcript} state @param {Record<string, any>} data */
function applyState(state, data) {
  state.session = {
    model: data.model && typeof data.model === 'object' ? modelInfo(data.model) : null,
    thinkingLevel: typeof data.thinkingLevel === 'string' ? data.thinkingLevel : null,
    contextPercent: typeof data.contextUsage?.percent === 'number' ? data.contextUsage.percent : null,
    name: typeof data.sessionName === 'string' ? withoutIcons(data.sessionName) || null : null,
  };
  const phases = todoPhases(data.todoPhases);
  if (phases) state.todo = { phases, updatedInTurn: state.todo?.updatedInTurn ?? false };
}

/** @param {Transcript} state @param {Record<string, any>} frame */
function applyPromptResult(state, frame) {
  const id = typeof frame.id === 'string' ? frame.id : null;
  if (frame.status === 'error') {
    const message = String(frame.error?.message ?? 'prompt failed');
    state.lastError = message;
    // A prompt that failed before reaching the agent already got an error response.
    if (id && state.failedRequests.has(id)) return;
    const where = [frame.error?.provider, frame.error?.model].filter(Boolean).join('/');
    return note(state, 'error', 'prompt', where ? `${message} (${where})` : message);
  }
  if (frame.status === 'aborted') return note(state, 'muted', 'prompt', 'Aborted');
  state.lastError = null;
}

/** @param {Transcript} state @param {Record<string, any>} frame */
function applyUiRequest(state, frame) {
  const id = typeof frame.id === 'string' ? frame.id : '';
  switch (frame.method) {
    case 'select':
    case 'confirm':
    case 'input':
    case 'editor':
    case 'ask':
      if (!state.dialogs.some((d) => d.id === id)) state.dialogs = [...state.dialogs, /** @type {Dialog} */ (frame)];
      return;
    case 'cancel':
      state.dialogs = state.dialogs.filter((d) => d.id !== frame.targetId);
      return;
    case 'notify':
      return note(state, levelOf(frame.notifyType), 'notify', String(frame.message ?? ''));
    case 'setStatus': {
      const statuses = { ...state.statuses };
      if (typeof frame.statusText === 'string' && frame.statusText) statuses[frame.statusKey] = frame.statusText;
      else delete statuses[frame.statusKey];
      state.statuses = statuses;
      return;
    }
    case 'setWidget': {
      // omp sends `setWidget` without lines every turn to clear it.
      const widgets = { ...state.widgets };
      if (Array.isArray(frame.widgetLines) && frame.widgetLines.length) widgets[frame.widgetKey] = strings(frame.widgetLines);
      else delete widgets[frame.widgetKey];
      state.widgets = widgets;
      return;
    }
    case 'setTitle':
      state.title = typeof frame.title === 'string' ? frame.title : null;
      return;
    case 'set_editor_text':
      state.editorText = { seq: (state.editorText?.seq ?? 0) + 1, text: String(frame.text ?? '') };
      return;
    case 'open_url':
      state.openUrl = {
        url: String(frame.url ?? ''),
        launchUrl: typeof frame.launchUrl === 'string' ? frame.launchUrl : null,
        instructions: typeof frame.instructions === 'string' ? frame.instructions : null,
      };
      return;
    default:
      return unrecognised(state, `ui ${frame.method ?? '?'}`, frame);
  }
}

// ── Commands the daemon wrote to omp ────────────────────

/** @param {Transcript} state @param {Record<string, any>} command */
function applySent(state, command) {
  if (command?.type === 'bash') {
    push(state, {
      kind: 'bash',
      language: 'bash',
      command: String(command.command ?? ''),
      requestId: typeof command.id === 'string' ? command.id : null,
      status: 'running',
      output: '',
      exitCode: null,
      truncated: false,
      error: null,
      fromMessage: false,
    });
  } else if (command?.type === 'extension_ui_response' && typeof command.id === 'string') {
    state.dialogs = state.dialogs.filter((d) => d.id !== command.id);
  } else if (command?.type === 'login') {
    // omp answers a login only once it is done: say what is under way meanwhile.
    note(state, 'muted', 'login', `Logging in to ${String(command.providerId ?? 'a provider')}…`);
  }
  // Every other command shows up through omp's own frames (messages, responses).
}

/**
 * @param {Transcript} state @param {string | null} id
 * @param {Record<string, any> | null} result @param {string | null} error
 * @returns {boolean} whether a running bash item took the reply
 */
function finishBash(state, id, result, error) {
  const item = /** @type {BashItem | undefined} */ (
    state.items.find((i) => i.kind === 'bash' && i.status === 'running' && (id === null || i.requestId === id))
  );
  if (!item) return false;
  if (error !== null) {
    item.status = 'error';
    item.error = error;
  } else if (result) {
    setBashResult(item, result);
  }
  touch(item);
  return true;
}

/** Fills a bash item from omp's result (a `bash` reply or a bash/python message). @param {BashItem} item @param {Record<string, any>} result */
function setBashResult(item, result) {
  item.output = String(result.output ?? '');
  item.exitCode = typeof result.exitCode === 'number' ? result.exitCode : null;
  item.truncated = Boolean(result.truncated);
  item.status = result.cancelled ? 'cancelled' : item.exitCode === null || item.exitCode === 0 ? 'ok' : 'error';
}

// ── Messages ────────────────────────────────────────────

/**
 * omp stamps every message_start, message_update and message_end with the `messageId` of the
 * message it belongs to (rpc-session-events.ts `#stamp`).
 * @param {Record<string, any>} frame @returns {string | null}
 */
const messageKey = (frame) => (typeof frame.messageId === 'string' ? `msg:${frame.messageId}` : null);

/**
 * @param {Transcript} state @param {any} message @param {string | null} key @param {boolean} final
 * @param {number | null} [at] when it arrived, live; none for history (`get_messages`), whose
 *   jobs ran in an omp process gone since and whose prompt results were not kept
 */
function applyMessage(state, message, key, final, at = null) {
  const role = message?.role;
  // Without a key, start and end cannot be paired: show the message once, at its end.
  if (key === null && !final) return;
  switch (role) {
    case 'assistant': {
      // A reply aborted before it said anything (the user stopped the turn, or its omp was
      // ended mid-turn) has nothing to show. Live, the prompt's result says the turn was
      // aborted (a `prompt` note); a journal keeps no prompt results, so there the reply
      // leaves that note in its place.
      if (final && message.stopReason === 'aborted' && !(Array.isArray(message.content) && message.content.length)) {
        if (key) removeItem(state, key);
        if (at === null) note(state, 'muted', 'prompt', 'Aborted');
        return;
      }
      const item = upsert(state, key, emptyAssistant);
      if (item.kind !== 'assistant') return unrecognised(state, 'assistant (id clash)', message);
      item.blocks = Array.isArray(message.content) ? message.content.map(toBlock) : [];
      item.model = typeof message.model === 'string' ? message.model : null;
      if (final) {
        item.ended = true;
        item.stopReason = typeof message.stopReason === 'string' ? message.stopReason : null;
        item.errorMessage = typeof message.errorMessage === 'string' ? message.errorMessage : null;
        if (!state.counted.has(item.key)) {
          state.counted.add(item.key);
          const total = message.usage?.cost?.total;
          if (typeof total === 'number' && Number.isFinite(total)) state.cost += total;
        }
      }
      registerToolCalls(state, item);
      return touch(item);
    }
    case 'user': {
      const item = upsert(state, key, () => ({ kind: 'user', text: '', images: 0, byAgent: false }));
      if (item.kind !== 'user') return unrecognised(state, 'user (id clash)', message);
      item.text = contentText(message.content);
      item.images = Array.isArray(message.content) ? message.content.filter((/** @type {any} */ c) => c?.type === 'image').length : 0;
      item.byAgent = message.attribution === 'agent' || message.synthetic === true;
      return touch(item);
    }
    case 'toolResult': {
      // Folded into its tool card: never a transcript entry of its own.
      const run = ensureTool(state, message.toolCallId, message.toolName);
      if (!run) return unrecognised(state, 'toolResult without toolCallId', message);
      run.result = contentText(message.content);
      run.status = message.isError ? 'error' : 'ok';
      // A `todo` result carries the agent's whole list (a `view` only reads it).
      const phases = message.toolName === 'todo' && !message.isError && message.details?.op !== 'view' ? todoPhases(message.details?.phases) : null;
      if (final && phases) state.todo = { phases, updatedInTurn: true };
      if (final) noteJobs(state, run, message.details, at);
      return touchTool(state, run.id);
    }
    case 'bashExecution':
    case 'pythonExecution': {
      const language = role === 'bashExecution' ? 'bash' : 'python';
      const command = String(role === 'bashExecution' ? message.command ?? '' : message.code ?? '');
      // A `!cmd` run already has an item from the daemon's `sent` bash; fill that one.
      const existing = /** @type {BashItem | undefined} */ (
        state.items.find((i) => i.kind === 'bash' && !i.fromMessage && i.language === language && i.command === command)
      );
      const item = existing ?? upsert(state, key, () => ({ kind: 'bash', language, command, requestId: null, status: 'running', output: '', exitCode: null, truncated: false, error: null, fromMessage: true }));
      if (item.kind !== 'bash') return unrecognised(state, `${role} (id clash)`, message);
      item.fromMessage = true;
      if (existing && key) state.index.set(key, existing); // pairs this message's end with the item
      if (final || existing === undefined) setBashResult(item, message);
      return touch(item);
    }
    case 'custom':
    case 'hookMessage':
      if (final && message.customType === 'async-result') endJobs(state, message.details?.jobs, false);
      return upsertNote(state, key, String(message.customType ?? role), '', contentText(message.content), message.display === false);
    case 'developer':
      return upsertNote(state, key, 'developer', '', contentText(message.content), false);
    case 'branchSummary':
      return upsertNote(state, key, 'branch', 'Branch summary', String(message.summary ?? ''), false);
    case 'compactionSummary':
      return upsertNote(state, key, 'compaction', String(message.shortSummary ?? 'Compaction summary'), String(message.summary ?? ''), false);
    case 'fileMention': {
      const files = Array.isArray(message.files) ? message.files.map((/** @type {any} */ f) => String(f?.path ?? '?')) : [];
      return upsertNote(state, key, 'files', `Attached ${files.join(', ')}`, null, false);
    }
    default: {
      const label = `message role ${role ?? '?'}`;
      if (key && state.index.has(key)) {
        const item = /** @type {UnrecognisedItem} */ (state.index.get(key));
        item.raw = json(message);
        return touch(item);
      }
      return void push(state, { kind: 'unrecognised', label, raw: json(message) }, key);
    }
  }
}

/** @param {Transcript} state @param {Record<string, any>} frame */
function applyUpdate(state, frame) {
  const event = frame.assistantMessageEvent;
  const sub = typeof event?.type === 'string' ? event.type : '';
  if (KNOWN_STREAM_NOOPS.has(sub)) return;
  const key = messageKey(frame);
  // Without a key the update cannot be paired with its message: message_end shows it whole.
  if (key === null) return;
  const item = upsert(state, key, emptyAssistant);
  if (item.kind !== 'assistant') return unrecognised(state, `message_update ${sub}`, frame);
  const at = Number.isInteger(event.contentIndex) && event.contentIndex >= 0 ? event.contentIndex : item.blocks.length;
  while (item.blocks.length < at) item.blocks.push({ kind: 'text', text: '' });
  const current = item.blocks[at];
  switch (sub) {
    // A pre-filled message_start may already hold this block: *_start resets it.
    case 'text_start':
      item.blocks[at] = { kind: 'text', text: '' };
      break;
    case 'text_delta':
      item.blocks[at] = { kind: 'text', text: (current?.kind === 'text' ? current.text : '') + String(event.delta ?? '') };
      break;
    case 'text_end':
      item.blocks[at] = { kind: 'text', text: String(event.content ?? '') };
      break;
    case 'thinking_start':
      item.blocks[at] = { kind: 'thinking', text: '', redacted: false };
      break;
    case 'thinking_delta':
      item.blocks[at] = { kind: 'thinking', text: (current?.kind === 'thinking' ? current.text : '') + String(event.delta ?? ''), redacted: false };
      break;
    case 'thinking_end':
      item.blocks[at] = { kind: 'thinking', text: String(event.content ?? ''), redacted: false };
      break;
    case 'toolcall_start': {
      const prev = current?.kind === 'toolCall' ? current : null;
      item.blocks[at] = { kind: 'toolCall', id: prev?.id ?? null, name: prev?.name ?? '', args: null, argsText: '', intent: prev?.intent ?? null };
      break;
    }
    case 'toolcall_delta': {
      const prev = current?.kind === 'toolCall' ? current : { kind: /** @type {const} */ ('toolCall'), id: null, name: '', args: null, argsText: '', intent: null };
      item.blocks[at] = { ...prev, argsText: prev.argsText + String(event.delta ?? '') };
      break;
    }
    case 'toolcall_end':
      item.blocks[at] = toBlock(event.toolCall);
      registerToolCalls(state, item);
      break;
    case 'image_end':
      item.blocks[at] = { kind: 'other', type: 'image', raw: event.content };
      break;
    default:
      return unrecognised(state, `message_update ${sub || '?'}`, frame);
  }
  touch(item);
}

/**
 * Seeds a session started from a journal with its earlier history, which omp does not
 * stream: the daemon asks for it (`get_messages`) once, before the session is ready, so it
 * goes ahead of the notes the new process has produced and nothing of the conversation
 * can come first.
 * @param {Transcript} state @param {any[]} messages
 */
function seed(state, messages) {
  const live = state.items;
  state.items = [];
  messages.forEach((message, i) => applyMessage(state, message, `seed:${i}`, true));
  state.items.push(...live);
}

/**
 * Shows a conversation read from its journal while no omp holds it (daemon/conversation.js):
 * its messages as `get_messages` would seed them, and what the journal says of the session,
 * the model as `provider/id`.
 * @param {Transcript} state
 * @param {{ messages: any[], title: string | null, model: string | null, thinkingLevel: string | null }} conversation
 */
export function seedConversation(state, { messages, title, model, thinkingLevel }) {
  seed(state, messages);
  const [provider, ...id] = model?.split('/') ?? [];
  state.session = {
    ...state.session,
    model: provider && id.length ? { provider, id: id.join('/'), name: id.join('/') } : null,
    thinkingLevel,
    name: title ? withoutIcons(title) || null : null,
  };
}

/**
 * Replaces the transcript with the conversation omp has after a rewind (`branch`), in every
 * window alike. Each rewind's items get keys of their own, so none clashes with an earlier
 * seed's; the cost spent so far stays as it was, rewound turns included.
 * @param {Transcript} state @param {any[]} messages
 */
function reseed(state, messages) {
  const cost = state.cost;
  state.rewound = false;
  state.rewinds++;
  state.items = [];
  state.index.clear();
  state.toolOwner.clear();
  messages.forEach((message, i) => applyMessage(state, message, `rewind${state.rewinds}:${i}`, true));
  state.cost = cost;
}

// ── Tools ───────────────────────────────────────────────

/**
 * @param {Transcript} state @param {unknown} id @param {unknown} name
 * @returns {ToolRun | null}
 */
function ensureTool(state, id, name) {
  if (typeof id !== 'string' || !id) return null;
  let run = state.tools.get(id);
  if (!run) {
    run = { id, name: typeof name === 'string' ? name : '', args: null, intent: null, status: 'pending', output: '', result: null, startedAt: null };
    state.tools.set(id, run);
  } else if (!run.name && typeof name === 'string') {
    run.name = name;
  }
  if (!state.toolOwner.has(id)) {
    // No assistant message mentions this call (yet): give it a card of its own.
    const item = push(state, { kind: 'tool', toolCallId: id });
    state.toolOwner.set(id, item.key);
  }
  return run;
}

/**
 * The jobs a tool result tells of: one its call started (it went on in the background), and
 * those it reports ended (a `wait`'s `jobs`).
 * @param {Transcript} state @param {ToolRun} run @param {any} details @param {number | null} at
 */
function noteJobs(state, run, details, at) {
  const job = details?.async;
  if (at !== null && job?.state === 'running' && typeof job.jobId === 'string') {
    const label = run.intent ?? argsSummaryText(run.args) ?? run.name;
    state.jobs.set(job.jobId, { id: job.jobId, type: String(job.type ?? run.name), label, toolCallId: run.id, startedAt: run.startedAt ?? at });
  }
  endJobs(state, details?.jobs, true);
}

/**
 * Forgets the jobs `jobs` (omp's job records) reports as ended: every one listed, or with
 * `byStatus` only those whose status is no longer `running`.
 * @param {Transcript} state @param {unknown} jobs @param {boolean} byStatus
 */
function endJobs(state, jobs, byStatus) {
  if (!Array.isArray(jobs)) return;
  for (const job of jobs) {
    const id = job?.jobId ?? job?.id;
    if (typeof id === 'string' && !(byStatus && job.status === 'running')) state.jobs.delete(id);
  }
}

/** A shell call's command, else nothing. @param {unknown} args @returns {string | null} */
const argsSummaryText = (args) => {
  const command = /** @type {any} */ (args)?.command;
  return typeof command === 'string' && command ? command : null;
};

/** @param {Transcript} state @param {AssistantItem} item */
function registerToolCalls(state, item) {
  for (const block of item.blocks) {
    if (block.kind !== 'toolCall' || !block.id) continue;
    let run = state.tools.get(block.id);
    if (!run) {
      run = { id: block.id, name: block.name, args: block.args, intent: block.intent, status: 'pending', output: '', result: null, startedAt: null };
      state.tools.set(block.id, run);
    } else {
      if (block.name) run.name = block.name;
      if (block.args !== null && run.args === null) run.args = block.args;
      if (block.intent && !run.intent) run.intent = block.intent;
    }
    const owner = state.toolOwner.get(block.id);
    if (owner !== item.key) {
      // The call was seen before its assistant message: retire the standalone card.
      if (owner) removeItem(state, owner);
      state.toolOwner.set(block.id, item.key);
    }
  }
}

/** @param {Transcript} state @param {string} id */
function touchTool(state, id) {
  const owner = state.toolOwner.get(id);
  const item = owner ? state.index.get(owner) : undefined;
  if (item) touch(item);
}

// ── Helpers ─────────────────────────────────────────────

/** @param {any} c @returns {Block} */
function toBlock(c) {
  switch (c?.type) {
    case 'text':
      return { kind: 'text', text: String(c.text ?? '') };
    case 'thinking':
      return { kind: 'thinking', text: String(c.thinking ?? ''), redacted: false };
    case 'redactedThinking':
      return { kind: 'thinking', text: '', redacted: true };
    case 'toolCall':
      return {
        kind: 'toolCall',
        id: typeof c.id === 'string' ? c.id : null,
        name: String(c.name ?? ''),
        args: c.arguments ?? null,
        argsText: '',
        intent: typeof c.intent === 'string' ? c.intent : null,
      };
    default:
      // image, fallback, anthropicServerTool and anything newer: shown collapsed, raw.
      return { kind: 'other', type: String(c?.type ?? 'unknown'), raw: c };
  }
}

/** @param {Record<string, any>} m */
function modelInfo(m) {
  return { provider: String(m.provider ?? ''), id: String(m.id ?? ''), name: String(m.name ?? m.id ?? '') };
}

/** @param {any} c @returns {SlashCommand} */
function slashCommand(c) {
  return {
    name: String(c?.name ?? ''),
    aliases: strings(c?.aliases),
    description: typeof c?.description === 'string' ? c.description : '',
    hint: typeof c?.input?.hint === 'string' ? c.input.hint : '',
  };
}

/** Text of a message `content` (a string or content blocks). @param {unknown} content @returns {string} */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (c?.type === 'text' ? String(c.text ?? '') : c?.type === 'image' ? '[image]' : `[${c?.type ?? '?'}]`))
    .join('');
}

/** @param {unknown} value @returns {string[]} */
function strings(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
}

/** @param {unknown} level @returns {NoteLevel} */
function levelOf(level) {
  return level === 'warning' || level === 'error' ? level : 'info';
}

/**
 * @param {Transcript} state @param {DistributiveOmit<Item, 'key' | 'rev'>} body @param {string | null} [key]
 * @returns {Item}
 */
function push(state, body, key = null) {
  const item = /** @type {Item} */ ({ ...body, key: key ?? `n:${state.nextKey++}`, rev: 0 });
  state.items.push(item);
  state.index.set(item.key, item);
  return item;
}

/**
 * @param {Transcript} state @param {string | null} key @param {() => DistributiveOmit<Item, 'key' | 'rev'>} make
 * @returns {Item}
 */
function upsert(state, key, make) {
  const found = key ? state.index.get(key) : undefined;
  return found ?? push(state, make(), key);
}

/** @param {Transcript} state @param {string} key */
function removeItem(state, key) {
  state.index.delete(key);
  state.items = state.items.filter((i) => i.key !== key);
}

/** @param {Item} item */
function touch(item) {
  item.rev++;
}

/**
 * @param {Transcript} state @param {NoteLevel} level @param {string} source @param {string} text
 * @param {string | null} [detail]
 */
function note(state, level, source, text, detail = null) {
  push(state, { kind: 'note', level, source, text, detail, hidden: false });
}

/**
 * A muted note for a message that is context, not conversation.
 * @param {Transcript} state @param {string | null} key @param {string} source
 * @param {string} text @param {string | null} detail @param {boolean} hidden
 */
function upsertNote(state, key, source, text, detail, hidden) {
  const item = upsert(state, key, () => ({ kind: 'note', level: 'muted', source, text, detail, hidden }));
  if (item.kind !== 'note') return;
  Object.assign(item, { level: 'muted', source, text, detail, hidden });
  touch(item);
}

/** stderr lines in a row share one note. @param {Transcript} state @param {string} line */
function addStderr(state, line) {
  const last = state.items.at(-1);
  if (last?.kind === 'note' && last.source === 'stderr') {
    last.detail = `${last.detail ?? last.text}\n${line}`;
    last.text = `stderr (${last.detail.split('\n').length} lines)`;
    return touch(last);
  }
  push(state, { kind: 'note', level: 'muted', source: 'stderr', text: line, detail: null, hidden: false });
}

/** @param {Transcript} state @param {string} label @param {unknown} frame */
function unrecognised(state, label, frame) {
  push(state, { kind: 'unrecognised', label, raw: json(frame) });
}

/** @template T @template {PropertyKey} K @typedef {T extends unknown ? Omit<T, K> : never} DistributiveOmit */
