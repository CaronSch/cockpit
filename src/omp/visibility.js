/**
 * Which transcript items an agent pane shows when it is set to only prompts and responses:
 * what the user said and ran, and what the agent finally answered, without the work in
 * between. A view over `transcript.js` items, computed at render time: switching back
 * shows everything again, because nothing is ever removed from the transcript.
 *
 * Shown:
 * - the user's prompts (`user` items the agent did not write); comments travel inside the
 *   prompt, attached files as the `files` note omp's `fileMention` message becomes
 * - the user's `!` shell runs (`bash` items: omp records bash and python executions only
 *   for commands the user runs; the agent's shell runs are tool calls)
 * - every response (below), and the agent's narration between tool calls (what it says
 *   it is doing, as Claude Code shows it), both without their thinking and tool calls
 * - errors (every `error` note: a failed prompt, command, attachment, exhausted retries)
 *   and how a prompt ended (`prompt` notes: failed or aborted)
 * - slash-command output (`command` notes): the answer to what the user typed
 * - unrecognised items: the pane cannot tell work from answer in what it does not know,
 *   and never hides it (CLAUDE.md, Invariants)
 * Dialogs waiting for an answer are not transcript items: the pane always shows them.
 *
 * Hidden: thinking, tool calls and their output, messages injected into the conversation (`byAgent` user items: another agent's prompts,
 * omp's own nudges), and every other note.
 *
 * A response is an assistant message that ended (`message_end`) without asking for tools:
 * its `stopReason` is `stop`, `length`, `error` or `aborted`, not `toolUse`; the agent
 * spoke and was done. Every one is shown, not only a turn's last: omp may carry on after
 * one (a todo nudge, an injected message), and the answer the user asked for is then not
 * the last thing the agent said. Narration is a message that goes on to call tools: its
 * text shows, the calls do not. A message still streaming shows its text so far; one cut
 * off for good (omp exited mid-stream) is neither. While a turn runs, the work since the
 * user's prompt is summarised as `working`.
 */
/** @import { AssistantItem, Item } from './transcript.js' */

/**
 * `working` is set while a turn runs: its work so far, counted in steps (assistant
 * messages, each one model call with the tool calls it made).
 * @typedef {{ items: Item[], working: { steps: number } | null }} PromptsAndResponses
 */

/**
 * @param {readonly Item[]} items a transcript's items, in order
 * @param {boolean} streaming whether the agent is still running its turn (transcript `streaming`)
 * @returns {PromptsAndResponses}
 */
export function promptsAndResponses(items, streaming) {
  /** @type {Item[]} */
  const shown = [];
  /** Assistant messages since the user's last prompt. */
  let steps = 0;
  for (const item of items) {
    switch (item.kind) {
      case 'user':
        if (item.byAgent) break;
        shown.push(item);
        steps = 0;
        break;
      case 'assistant':
        steps++;
        if (isResponse(item) || saysSomething(item, streaming)) shown.push(withoutWork(item));
        break;
      case 'bash':
      case 'unrecognised':
        shown.push(item);
        break;
      case 'note':
        if (item.level === 'error' || NOTE_SOURCES.has(item.source)) shown.push(item);
        break;
      case 'tool':
        break;
    }
  }
  return { items: shown, working: streaming ? { steps } : null };
}

/** Notes that belong to the conversation, not to the work: see the module comment. */
const NOTE_SOURCES = new Set(['files', 'prompt', 'command']);

/** @param {AssistantItem} item */
const isResponse = (item) => item.ended && item.stopReason !== 'toolUse';

/**
 * Narration, or a message still streaming, with text to show.
 * @param {AssistantItem} item @param {boolean} streaming
 */
const saysSomething = (item, streaming) =>
  (item.ended || streaming) && item.blocks.some((b) => b.kind === 'text' && b.text.trim() !== '');

/**
 * The response as the user reads it: its text (and images or blocks the pane does not
 * know), without the thinking and tool calls that led to it.
 * @param {AssistantItem} item @returns {AssistantItem}
 */
function withoutWork(item) {
  const blocks = item.blocks.filter((b) => b.kind === 'text' || b.kind === 'other');
  return blocks.length === item.blocks.length ? item : { ...item, blocks };
}
