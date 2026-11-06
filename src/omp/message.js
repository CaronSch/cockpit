/**
 * Builds what the agent pane sends from what the user wrote: the prompt (comments on quoted
 * parts of earlier replies, the draft, then files), `!` shell commands, and side questions
 * about a quote.
 *
 * A comment goes first as a Markdown quote of the text it is about, followed by the comment,
 * the way a reply quotes an email; the model and the transcript both read it naturally.
 * A file goes after the draft as an `@"<path>"` mention: omp reads it when the prompt
 * starts a turn (images to the model, text inline); a steer keeps the path, which the model
 * can open itself. A side question quotes its text the same way, for omp's `btw`, and asks
 * for a short answer.
 *
 * A message of just `.` continues the conversation silently, as in omp's own editor: the pane
 * sends omp's continue directive in its place, which tells the agent to carry on with what it
 * was doing, and no view shows it as a prompt (transcript.js flags it). The module is free of
 * the DOM, so the daemon reads the directive from here too.
 */

/** A comment on a quoted part of the transcript. @typedef {{ quote: string, comment: string }} QuoteComment */

/**
 * omp's continue directive, verbatim (`prompts/system/manual-continue.md`), which its editor
 * sends as a hidden message for a bare `.`. omp's RPC mode cannot send it hidden, so it lands
 * in the conversation as a user message, recognised by its text (`isContinueDirective`).
 */
export const CONTINUE_DIRECTIVE = `<system-notice>
Continue.

MUST resume most recent intent; complete unfinished work.
If interrupted mid-step: resume where stopped.
NEVER pause to summarize progress, re-confirm plan, or ask whether to proceed; continue.
</system-notice>
`;

/** Whether a user message is the continue directive, however omp trimmed it. @param {string} text */
export const isContinueDirective = (text) => text.trim() === CONTINUE_DIRECTIVE.trim();

/**
 * What goes to omp for a composed message: the continue directive for a bare `.` (no comments
 * or files, which would have added to the text), else the message as composed.
 * @param {string} message what `composeMessage` returned
 */
export const outgoingPrompt = (message) => (message === '.' ? CONTINUE_DIRECTIVE : message);

/** Every line of `text` as a Markdown quote. @param {string} text */
export const asQuote = (text) =>
  text
    .trim()
    .split('\n')
    .map((line) => (line.trim() ? `> ${line}` : '>'))
    .join('\n');

/** omp's file mention for `path`, quoted so spaces survive. @param {string} path */
const mention = (path) => (path.includes('"') ? `@'${path}'` : `@"${path}"`);

/**
 * The text to send, or '' when there is nothing to send.
 * @param {string} draft @param {readonly QuoteComment[]} comments @param {readonly string[]} [files] where omp can read each file
 */
export function composeMessage(draft, comments, files = []) {
  const parts = comments.map(({ quote, comment }) => `${asQuote(quote)}\n\n${comment.trim()}`);
  if (draft.trim()) parts.push(draft.trim());
  parts.push(...files.map(mention));
  return parts.join('\n\n');
}

/** Commands (`/model`, `!ls`) go to omp as typed; comments and files wait for the next prompt. @param {string} draft */
export const isCommand = (draft) => /^[/!]/.test(draft.trim());

/**
 * The shell command a `!cmd` draft runs ('' for a bare `!`), or null when the draft is not one.
 * @param {string} draft
 */
export function shellCommand(draft) {
  const text = draft.trim();
  return text.startsWith('!') ? text.slice(1).trim() : null;
}

/**
 * Ends every side question, follow-ups included: omp's side-question prompt only asks for a
 * "brief" answer; this one bounds it.
 */
export const ANSWER_BRIEFLY = 'Answer in at most three sentences, or a short list; no preamble.';

/**
 * A side question about `quote`, for omp's `btw`: answered from the session's context, kept
 * out of it.
 * @param {string} quote @param {string} question
 */
export const composeAsk = (quote, question) => `About this part of our conversation:\n\n${asQuote(quote)}\n\n${question.trim()}\n\n${ANSWER_BRIEFLY}`;

/** A follow-up in a side topic: omp replays the topic's earlier turns, quote included. @param {string} question */
export const composeFollowUp = (question) => `${question.trim()}\n\n${ANSWER_BRIEFLY}`;
