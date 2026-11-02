/**
 * One omp process in RPC mode: launch, protocol setup, command/response correlation and
 * lifecycle, with everything it does reported as session events.
 *
 * It also asks once for a title. omp names sessions by itself only in its TUI, so once the
 * first prompt of a session with no name is in its conversation, the daemon sends `/rename`
 * with no title, as a user would: omp's title model names the conversation in the
 * background while the agent works on the turn. (Sent any earlier, omp has nothing to name.)
 * A fork is named again by its first prompt, though it has its parent's name: it is going
 * somewhere else, and omp's title model reads the latest messages along with the first.
 */
import { readFileSync } from 'node:fs';
import { conversationOf } from './conversation.js';
import { createFrameDecoder } from './frame-decoder.js';
/** @import { RpcResponse, SessionEvent, SessionMeta } from './wire.js' */

/** A SessionEvent before the hub stamps it. @typedef {SessionEvent extends infer E ? E extends any ? Omit<E, 'seq' | 'at' | 'session'> : never : never} SessionEventBody */

/**
 * Sent by the daemon before a session counts as ready, so every widget sees the same
 * protocol (lossless v2 framing, delta-only message updates, `ask` dialogs enabled), and the
 * log holds the session's state (and so the journal it writes) and which providers omp is
 * logged in to (does its model need a login?) before anything else asks.
 */
export const SETUP_COMMANDS = Object.freeze([
  { type: 'negotiate_protocol', protocolVersion: 2 },
  { type: 'set_event_filter', events: null, messageUpdates: 'delta' },
  { type: 'set_ask_dialog', enabled: true },
  { type: 'get_login_providers' },
  { type: 'get_state' },
]);

/**
 * Appended to every session's system prompt (`--append-system-prompt`): an agent window shows
 * the agent's text, while its thinking and tool calls sit in collapsed cards or are hidden, so
 * the agent is asked to say what it is doing as it goes (Claude Code's own wording), and told
 * what the window can show (diagrams, charts, images). It takes the place of any APPEND_SYSTEM.md the
 * user has: omp reads one or the other.
 */
export const APPEND_SYSTEM_PROMPT =
  "Your text output is what the user reads between tool calls; they usually can't see your thinking or the raw tool results. Write it for a teammate who stepped away and is catching up, not for a log file: they don't know the codenames or shorthand you created along the way, and they didn't watch your process unfold. Before your first tool call, say in a sentence what you're about to do; while working, give brief updates when you find something load-bearing or change direction.\n\n" +
  "The user reads your replies in a rich view, not a terminal: markdown tables, TeX math ($…$, $$…$$), diagrams, charts and images all render. Visuals are very welcome, and cheap: add one whenever it would make something clearer.\n" +
  "- Diagrams (flows, sequences, architecture, states, timelines): a ```mermaid block in your reply. Draw flowcharts left to right (flowchart LR) and keep node labels to a few words; put details in the text around the diagram.\n" +
  '- Charts of numbers: a ```vega-lite block holding a Vega-Lite JSON spec, its data inline ("data": {"values": [...]}); for many points, write them to a JSON or CSV file and use "data": {"url": "/absolute/path.json"}.\n' +
  "- Anything else (screenshots, plots you render yourself): an image file, shown with ![what it shows](/absolute/path/to/image.png) (png, jpeg, gif, webp or avif).\n" +
  "Everything shown must be on this machine: remote URLs are not loaded.";

/** Successful responses after which omp is logged in to other providers. */
const LOGIN_CHANGING_COMMANDS = new Set(['login', 'logout']);

/**
 * Added to the setup of a session started from a journal (resumed or forked): omp streams
 * none of the conversation so far, so its answer puts that history in the log, ahead of
 * anything the session does once it is ready. Sent again after a rewind (`branch`), whose
 * conversation omp does not stream either: windows replace theirs with that answer.
 */
export const HISTORY_COMMAND = Object.freeze({ type: 'get_messages' });

/** Successful responses after which `get_state` reports something else. */
const STATE_CHANGING_COMMANDS = new Set(['set_model', 'cycle_model', 'set_thinking_level', 'cycle_thinking_level', 'login', 'new_session', 'switch_session', 'fork', 'branch', 'compact']);

/**
 * Frames after which `get_state` reports something else: a turn's end (context use, todos),
 * the model or thinking level changing, and omp emptying the todo list (`todo_auto_clear`).
 */
const STATE_CHANGING_FRAMES = new Set(['agent_end', 'model_changed', 'thinking_level_changed', 'config_update', 'todo_auto_clear']);

/** @param {Record<string, any>} frame */
const changesState = (frame) =>
  frame.type === 'response' ? frame.success === true && STATE_CHANGING_COMMANDS.has(frame.command) : STATE_CHANGING_FRAMES.has(frame.type);

const RENAME = Object.freeze({ type: 'prompt', message: '/rename' });
const CLOSE_GRACE_MS = 5000;
const MAX_GARBLED_CHARS = 64 * 1024;

export class SessionNotRunning extends Error {}

/**
 * `command` throws SessionNotRunning unless the session is ready; otherwise it returns the
 * id the daemon gave the request (omp echoes it on its response frame) and the response.
 * @typedef {{
 *   meta(): SessionMeta,
 *   command(command: Record<string, unknown>): { id: string, response: Promise<RpcResponse> },
 *   respondUi(response: Record<string, unknown>): void,
 *   close(): Promise<void>,
 * }} OmpSession
 */

/**
 * `resume` continues a journal; `fork` starts a new one from a copy of it (omp's `--fork`
 * only reads the source). At most one of them is set.
 * @param {{
 *   id: string, cwd: string, resume: string | null, fork: string | null, ompPath: string,
 *   emit: (body: SessionEventBody) => void, now?: () => number,
 * }} options
 * @returns {OmpSession}
 */
export function launchOmp({ id, cwd, resume, fork, ompPath, emit, now = Date.now }) {
  const startedAt = now();
  /** @type {SessionMeta} */
  let meta = { id, cwd, resume, fork, sessionFile: resume, status: 'starting', pid: null, exitCode: null, error: null, startedAt, ompId: null };
  /** @type {Map<string, PromiseWithResolvers<RpcResponse>>} */
  const pending = new Map();
  const decoder = createFrameDecoder();
  let counter = 0;
  let finished = false;
  /** @type {PromiseWithResolvers<void>} */
  const closed = Promise.withResolvers();
  let named = false;
  let titleAsked = false;
  /** The id of the history asked for at setup, once asked. @type {string | null} */
  let historyId = null;

  /** @param {Partial<SessionMeta>} patch */
  const update = (patch) => {
    meta = { ...meta, ...patch };
    emit({ kind: 'session', meta });
  };

  emit({ kind: 'session', meta });
  /** @type {import('bun').Subprocess<'pipe', 'pipe', 'pipe'> | null} */
  let child = null;
  try {
    const from = resume ? ['--resume', resume] : fork ? ['--fork', fork] : [];
    child = Bun.spawn([ompPath, '--mode', 'rpc-ui', '--append-system-prompt', APPEND_SYSTEM_PROMPT, ...from], {
      cwd,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    update({ pid: child.pid });
  } catch (err) {
    finish(null, `could not run ${ompPath}: ${err instanceof Error ? err.message : err}`);
  }

  /** @param {number | null} exitCode @param {string | null} error */
  function finish(exitCode, error) {
    if (finished) return;
    finished = true;
    for (const p of pending.values()) p.reject(new SessionNotRunning('omp exited before answering'));
    pending.clear();
    const failed = error !== null || (meta.status === 'starting' && exitCode !== 0);
    update({
      status: failed ? 'failed' : 'exited',
      pid: null,
      exitCode,
      error: error ?? (failed ? `omp exited with code ${exitCode} before it was ready` : null),
    });
    closed.resolve();
  }

  /**
   * Puts the whole conversation in omp's answer to the history asked for at setup: omp answers
   * with its context, which a compaction cut down to a summary and the latest messages, while
   * the window should show everything said. The journal has it all (`conversation.js`); read
   * at once, so the answer keeps its place in the log. Unreadable, omp's answer stands.
   * @param {Record<string, any>} frame
   */
  function withWholeHistory(frame) {
    const file = resume ?? fork;
    if (!file) return;
    /** @type {Record<string, any>[] | undefined} */
    let messages;
    try {
      messages = conversationOf(file, readFileSync(file, 'utf8'))?.messages;
    } catch {}
    if (messages?.length) frame.data = { ...frame.data, messages };
  }

  /** @param {import('./frame-decoder.js').Decoded} decoded */
  function handle(decoded) {
    if (!decoded.ok) {
      emit({ kind: 'garbled', line: decoded.line.slice(0, MAX_GARBLED_CHARS), error: decoded.error });
      return;
    }
    const { frame } = decoded;
    if (frame.type === 'response' && frame.id === historyId && frame.success === true) withWholeHistory(frame);
    emit({ kind: 'frame', frame });
    if (frame.type === 'ready' && meta.status === 'starting') void setup();
    // Every window shows the session's state from the log: the daemon asks for it again
    // whenever it changes, once for all of them.
    if (meta.status === 'ready' && changesState(frame)) send({ type: 'get_state' }).response.catch(() => {});
    if (meta.status === 'ready' && frame.type === 'response' && frame.success === true && LOGIN_CHANGING_COMMANDS.has(frame.command)) {
      send({ type: 'get_login_providers' }).response.catch(() => {});
    }
    if (meta.status === 'ready' && frame.type === 'response' && frame.success === true && frame.command === 'branch') {
      send(HISTORY_COMMAND).response.catch(() => {});
    }
    if (frame.type === 'response' && frame.command === 'get_state' && frame.success) {
      const file = frame.data?.sessionFile;
      if (typeof file === 'string' && file !== meta.sessionFile) update({ sessionFile: file });
      const ompId = frame.data?.sessionId;
      if (typeof ompId === 'string' && ompId !== meta.ompId) update({ ompId });
      if (frame.data?.sessionName) named = true;
    }
    if (frame.type === 'session_info_update' && frame.title) named = true;
    if (frame.type === 'message_end' && frame.message?.role === 'user' && !titleAsked) {
      titleAsked = true;
      if (!named || fork) send(RENAME).response.catch(() => {});
    }
    if (frame.type === 'response' && typeof frame.id === 'string') {
      const waiter = pending.get(frame.id);
      pending.delete(frame.id);
      waiter?.resolve(/** @type {RpcResponse} */ (frame));
    }
  }

  /**
   * Reads omp's stdout as frames and its stderr as lines; reports the exit once both ended.
   * @param {import('bun').Subprocess<'pipe', 'pipe', 'pipe'>} proc
   */
  async function pump(proc) {
    const stdout = (async () => {
      for await (const data of proc.stdout) decoder.push(data).forEach(handle);
      decoder.end().forEach(handle);
    })();
    let rest = '';
    for await (const text of proc.stderr.pipeThrough(new TextDecoderStream())) {
      const lines = (rest + text).split('\n');
      rest = /** @type {string} */ (lines.pop());
      for (const line of lines) emit({ kind: 'stderr', line: line.replace(/\r$/, '') });
    }
    if (rest) emit({ kind: 'stderr', line: rest });
    await Promise.all([proc.exited, stdout]);
    const killed = proc.signalCode && proc.exitCode === null && meta.status === 'starting';
    finish(proc.exitCode, killed ? `omp was killed (${proc.signalCode})` : null);
  }
  if (child) void pump(child);

  /** @param {Record<string, unknown>} frame */
  function writeFrame(frame) {
    emit({ kind: 'sent', command: frame });
    child?.stdin.write(`${JSON.stringify(frame)}\n`);
    child?.stdin.flush();
  }

  /** @param {Record<string, unknown>} command @returns {{ id: string, response: Promise<RpcResponse> }} */
  function send(command) {
    const frame = { ...command, id: `ac_${++counter}` };
    if (finished) return { id: frame.id, response: Promise.reject(new SessionNotRunning(`session is ${meta.status}`)) };
    /** @type {PromiseWithResolvers<RpcResponse>} */
    const response = Promise.withResolvers();
    pending.set(frame.id, response);
    writeFrame(frame);
    return { id: frame.id, response: response.promise };
  }

  async function setup() {
    // A refused setup command leaves its failure in the log; the session still works on
    // the protocol omp does support, so it becomes ready either way.
    const commands = resume || fork ? [...SETUP_COMMANDS, HISTORY_COMMAND] : SETUP_COMMANDS;
    for (const command of commands) {
      const sent = send(command);
      if (command === HISTORY_COMMAND) historyId = sent.id;
      await sent.response.catch(() => {});
    }
    if (!finished) update({ status: 'ready' });
  }

  return {
    meta: () => meta,
    command(command) {
      if (meta.status !== 'ready') throw new SessionNotRunning(`session is ${meta.status}`);
      return send(command);
    },
    respondUi(response) {
      if (meta.status !== 'ready') throw new SessionNotRunning(`session is ${meta.status}`);
      writeFrame({ ...response, type: 'extension_ui_response' });
    },
    async close() {
      if (finished || !child) return;
      const proc = child;
      proc.stdin.end(); // omp drains accepted work and exits on EOF
      const term = setTimeout(() => proc.kill('SIGTERM'), CLOSE_GRACE_MS);
      const kill = setTimeout(() => proc.kill('SIGKILL'), CLOSE_GRACE_MS * 2);
      await closed.promise;
      clearTimeout(term);
      clearTimeout(kill);
    },
  };
}
