/**
 * A fork's own title: omp copies the title of the conversation it forks, and its title model
 * names a conversation from its opening request, so left to omp a fork keeps its source's name
 * and two windows read the same. The first prompt sent in the fork says where it is going: a
 * small model turns it into a short title of its own, which the daemon gives the fork with
 * `/rename <title>` (forks.js). Without an answer, the prompt's first words are the title.
 *
 * Like the decision reviewer (decisions.js) it is a one-shot omp (`omp -p`) on omp's `smol`
 * role with thinking off, no tools and no session, reading the source's title and the prompt
 * only.
 */
import { tmpdir } from 'node:os';

/** How long the title may take before the prompt's first words stand in for it. */
export const FORK_TITLE_TIMEOUT_MS = 60_000;
/** Titles stay short enough for a window's top bar. */
const MAX_TITLE_CHARS = 60;
/** The prompt is all the model needs of a fork; a long paste adds nothing to its title. */
const MAX_PROMPT_CHARS = 4000;

export const FORK_TITLE_SYSTEM_PROMPT =
  'You title a fork of a coding-agent conversation: a copy of the conversation that goes on in a new direction, beside the original. ' +
  "You are given the original conversation's title and the first message sent in the fork. " +
  'Reply with the fork\'s title only: 2 to 6 words, sentence case, no quotes, no trailing punctuation, saying what the fork sets out to do. ' +
  "It must differ from the original's title: name what is new in the fork, not the shared topic.";

/** What the title model reads: the source's title, then the fork's first prompt. @param {string} prompt @param {string | null} sourceTitle */
export const forkTitleInput = (prompt, sourceTitle) =>
  `Original conversation's title: ${sourceTitle?.trim() || '(untitled)'}\n\nFirst message in the fork:\n${prompt.trim().slice(0, MAX_PROMPT_CHARS)}`;

/** `text` on one line, cut to fit a top bar. @param {string} text */
function oneLine(text) {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > MAX_TITLE_CHARS ? `${line.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…` : line;
}

/**
 * The title in the model's answer: its first line that says something, without the wrapping
 * models add anyway (a `Title:` label, quotes, Markdown emphasis, a closing full stop, in any
 * order); null when there is none.
 * @param {string} answer
 */
export function parseForkTitle(answer) {
  const line = answer
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return null;
  let title = line.replace(/^#+\s*/, '').replace(/^title\s*:\s*/i, '');
  for (let before = ''; before !== title; ) {
    before = title;
    title = title.replace(/^[*_`"'“‘\s]+|[*_`"'”’.!\s]+$/g, '');
  }
  return title ? oneLine(title) : null;
}

/** The title when the model gives none: the prompt's first line, cut to fit. @param {string} prompt */
export const fallbackForkTitle = (prompt) => oneLine(prompt.trim().split('\n')[0] ?? '') || 'Fork';

/**
 * A title for the fork whose first prompt is `prompt`: the small model's, else the prompt's
 * first words. Never rejects.
 * @param {string} prompt @param {string | null} sourceTitle
 * @param {{ ompPath: string, timeoutMs?: number }} options
 * @returns {Promise<string>}
 */
export async function nameFork(prompt, sourceTitle, { ompPath, timeoutMs = FORK_TITLE_TIMEOUT_MS }) {
  try {
    // Run outside any project, so no project's context files or rules are read with it.
    const proc = Bun.spawn(
      [ompPath, '-p', '--no-session', '--no-tools', '--no-skills', '--no-rules', '--no-extensions', '--no-lsp', '--no-title', '--model', '@smol', '--thinking', 'off', '--system-prompt', FORK_TITLE_SYSTEM_PROMPT, forkTitleInput(prompt, sourceTitle)],
      { cwd: tmpdir(), stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', timeout: timeoutMs },
    );
    const [answer, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code === 0 && !proc.signalCode) {
      const title = parseForkTitle(answer);
      if (title) return title;
    }
  } catch {}
  return fallbackForkTitle(prompt);
}
