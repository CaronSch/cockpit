/**
 * Decisions an agent took without its user: what of a turn the reviewer reads, what it is
 * asked and how its answer becomes at most five one-sentence decisions, and where each
 * review shows in the transcript, kept free of the DOM and of I/O so they can be tested
 * (the daemon runs the reviewer: daemon/decisions.js).
 *
 * A turn is named by its prompt: the time omp took the user's prompt (`UserItem.at`, the
 * message's `timestamp`), which is the same while the conversation runs and once it is read
 * from its journal. A turn the user steered names its last prompt, and its review shows
 * where the turn ends: before the user's next prompt.
 */
/** @import { Item, ToolRun } from './transcript.js' */

/** The most decisions a review lists. */
export const MAX_DECISIONS = 5;

/**
 * A turn's review: under way, done (no decisions when the agent took none worth a look), or
 * failed, with the reason.
 * @typedef {{ status: 'pending' } | { status: 'done', decisions: string[] } | { status: 'failed', error: string }} Review
 */
/** A conversation's reviews, by the time of the prompt each reviews (as a string). @typedef {Readonly<Record<string, Review>>} Reviews */

/** What the reviewer is told it is: its whole system prompt. */
export const REVIEW_SYSTEM_PROMPT = [
  "You review one turn of a coding agent's work for its user, who did not watch it.",
  "The user's prompt left questions open; the agent settled some of them itself instead of asking.",
  `List those decisions, the most consequential first, at most ${MAX_DECISIONS}.`,
  'Only choices the prompt left open and the user did not make: not what the prompt asked for, not routine steps, not facts the agent looked up.',
  'Write each on a line of its own, as one dense sentence of at most 30 words: the choice and, when it matters, what it rules out',
  '(e.g. "Stored the reviews per conversation in ~/.cockpit/decisions, not in the layout, so they outlive the window.").',
  'No bullets, numbers, headings or preamble.',
  'If the agent decided nothing the user should review, answer exactly: NONE',
].join(' ');

/** How much of a turn the reviewer reads: about 30K tokens. */
const MAX_TURN_CHARS = 120_000;
/** How much of its start is always kept: the prompt is there. */
const HEAD_CHARS = 24_000;
const PROMPT_CHARS = 16_000;
const TEXT_CHARS = 6_000;
const THINKING_CHARS = 4_000;
const TOOL_CHARS = 400;

/** @param {string} text @param {number} max */
const clip = (text, max) => (text.length > max ? `${text.slice(0, max)} […]` : text);

/** @param {Item} item @returns {item is Extract<Item, { kind: 'user' }>} */
const isPrompt = (item) => item.kind === 'user' && !item.byAgent;

/**
 * The turn that just ended, for the reviewer: its prompt's time and the turn as text.
 * `since` is the last item the previous turn ended with; the turn starts at the user's first
 * prompt after it. Without it (the conversation was resumed or rewound since, or this is its
 * first turn here) the turn is the user's last prompt and what followed. Null when the user
 * prompted nothing since (the agent went on by itself) or the prompt has no time to be named by.
 * @param {readonly Item[]} items @param {ReadonlyMap<string, ToolRun>} tools @param {string | null} since
 * @returns {{ promptAt: number, text: string } | null}
 */
export function turnToReview(items, tools, since) {
  const after = since === null ? -1 : items.findIndex((i) => i.key === since);
  const start = after >= 0 ? items.findIndex((item, n) => n > after && isPrompt(item)) : items.findLastIndex(isPrompt);
  if (start < 0) return null;
  const turn = items.slice(start);
  const last = turn.findLast(isPrompt);
  if (last?.kind !== 'user' || last.at === null) return null;
  /** @type {string[]} */
  const lines = [];
  for (const item of turn) {
    if (isPrompt(item)) lines.push(`[user prompt]\n${clip(item.text, PROMPT_CHARS)}`);
    else if (item.kind === 'bash') lines.push(`[user ran] ${clip(item.command, TOOL_CHARS)}`);
    else if (item.kind === 'assistant') {
      for (const block of item.blocks) {
        if (block.kind === 'text' && block.text.trim()) lines.push(`[agent] ${clip(block.text, TEXT_CHARS)}`);
        else if (block.kind === 'thinking' && block.text.trim()) lines.push(`[agent thinking] ${clip(block.text, THINKING_CHARS)}`);
        else if (block.kind === 'toolCall') {
          const args = block.argsText || JSON.stringify((block.id && tools.get(block.id)?.args) ?? block.args ?? null);
          lines.push(`[agent tool ${block.name}] ${clip(args, TOOL_CHARS)}`);
        }
      }
    }
  }
  let text = lines.join('\n\n');
  if (text.length > MAX_TURN_CHARS) text = `${text.slice(0, HEAD_CHARS)}\n\n[… part of the work left out …]\n\n${text.slice(-(MAX_TURN_CHARS - HEAD_CHARS))}`;
  // omp reads a file for every `@path` in a prompt: the turn's own are only quoted here.
  return { promptAt: last.at, text: `The turn to review:\n\n${text.replaceAll('@', '＠')}` };
}

/**
 * The decisions in the reviewer's answer: one per line, list marks taken off, at most
 * `MAX_DECISIONS`; none when it answered NONE.
 * @param {string} answer @returns {string[]}
 */
export function parseDecisions(answer) {
  return answer
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim())
    .filter((line) => line && !/^NONE\.?$/i.test(line))
    .slice(0, MAX_DECISIONS);
}

/**
 * Where each review shows among `items` (a transcript's, or those it shows): before the
 * user's next prompt after the one it reviews, else at the end; in order.
 * @param {readonly Item[]} items @param {Reviews} reviews
 * @returns {Array<{ index: number, at: number, review: Review }>}
 */
export function placeReviews(items, reviews) {
  /** @type {Array<{ index: number, at: number, review: Review }>} */
  const placed = [];
  items.forEach((item, i) => {
    if (!isPrompt(item) || item.at === null || !Object.hasOwn(reviews, String(item.at))) return;
    const next = items.findIndex((later, n) => n > i && isPrompt(later));
    placed.push({ index: next < 0 ? items.length : next, at: item.at, review: reviews[String(item.at)] });
  });
  return placed.sort((a, b) => a.index - b.index);
}
