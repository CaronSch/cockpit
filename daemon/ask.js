/**
 * Asking an agent where something was said: Spotlight's Ask (src/ui/spotlight.js) hands a
 * question in plain words to a one-shot omp that reads the user's conversations and answers it,
 * naming the conversations that do.
 *
 * The agent is `omp -p` with read-only tools (read, grep, find) and no session, rules, skills or
 * extensions, in a temporary directory holding `index.tsv`: one line per conversation, live and
 * archived (journal path, title, directory, last active, first prompt), from history.js. It
 * greps and reads the journals it needs, then answers in a few sentences and names each
 * conversation that answers the question on a line of its own, `CONVERSATION: <journal path>`;
 * only paths in the index count, so it can name nothing else.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/** What it reads of history.js: every conversation, live or archived. @typedef {{ list(query: string, options?: { archived?: boolean }): Promise<PastSession[]> }} History */
/** @import { PastSession } from './wire.js' */

/** How long the agent may take before it is stopped and the question fails. */
const ASK_TIMEOUT_MS = 180_000;
/** How many conversations an answer may name. */
const MAX_NAMED = 5;

const ASK_SYSTEM_PROMPT =
  "You find things in the user's past conversations with coding agents. Your working directory holds index.tsv: one line per conversation, " +
  'tab-separated: journal path, title, directory, last active (YYYY-MM-DD), first prompt. Each journal is a JSONL file of the whole conversation: ' +
  "the user's prompts, the agent's replies, its tool calls and their output. Use grep and read on the journals in the index to answer the " +
  "user's question from what the conversations say; do not guess. Then answer in Markdown, in at most five sentences, saying what was found " +
  `and when. End with one line for each conversation that answers it, best first, at most ${MAX_NAMED}: CONVERSATION: <journal path, exactly as in the index>. ` +
  'If none does, say so and name none.';

/** A field of index.tsv: one line, no tabs. @param {string | null} value */
const field = (value) => (value ?? '').replace(/[\t\r\n]+/g, ' ').trim();

/** index.tsv's text for `sessions`. @param {readonly PastSession[]} sessions */
export const indexOf = (sessions) =>
  sessions.map((s) => [s.file, s.title, s.cwd, new Date(s.modifiedAt).toISOString().slice(0, 10), s.firstPrompt].map(field).join('\t')).join('\n') + '\n';

/**
 * The agent's answer, without its CONVERSATION lines, and the journals those name that are in
 * `known` (in its order, once each, at most MAX_NAMED).
 * @param {string} output @param {ReadonlySet<string>} known
 */
function parseAnswer(output, known) {
  /** @type {string[]} */
  const files = [];
  const lines = [];
  for (const line of output.split('\n')) {
    const named = /^\s*[-*]?\s*`?CONVERSATION:\s*(.+?)`?\s*$/.exec(line)?.[1];
    if (named === undefined) lines.push(line);
    else if (known.has(named) && !files.includes(named) && files.length < MAX_NAMED) files.push(named);
  }
  return { answer: lines.join('\n').trim(), files };
}

/**
 * Asks an agent `question` about every conversation `history` lists.
 * @param {string} question
 * @param {{ ompPath: string, history: History, timeoutMs?: number }} options
 * @returns {Promise<{ answer: string, sessions: PastSession[] }>}
 */
export async function askAgent(question, { ompPath, history, timeoutMs = ASK_TIMEOUT_MS }) {
  const sessions = [...(await history.list('')), ...(await history.list('', { archived: true }))];
  const byFile = new Map(sessions.map((s) => [s.file, s]));
  const dir = await mkdtemp(join(tmpdir(), 'cockpit-ask-'));
  try {
    await writeFile(join(dir, 'index.tsv'), indexOf(sessions));
    const proc = Bun.spawn(
      [ompPath, '-p', '--no-session', '--no-skills', '--no-rules', '--no-extensions', '--no-lsp', '--no-title', '--tools', 'read,grep,find', '--auto-approve', '--thinking', 'low', '--system-prompt', ASK_SYSTEM_PROMPT, question],
      { cwd: dir, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs },
    );
    const [output, errors, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (proc.signalCode) throw new Error(`the agent took longer than ${Math.round(timeoutMs / 1000)} s`);
    if (code !== 0) throw new Error(errors.trim().split('\n').at(-1) || `the agent exited with ${code}`);
    const { answer, files } = parseAnswer(output, new Set(byFile.keys()));
    return { answer, sessions: files.flatMap((file) => byFile.get(file) ?? []) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
