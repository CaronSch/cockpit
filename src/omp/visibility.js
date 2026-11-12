/**
 * Which transcript items an agent pane shows: everything, each stretch of work folded into one
 * line (`compactWork`); or only prompts and responses: what the user said and ran, and what the
 * agent finally answered, without the work in between. A view over `transcript.js` items, computed at render time: switching back
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
 * - compaction (`compaction` notes): from there on the agent works from a summary of what
 *   came before, whether omp compacted near its context's limit or the daemon while idle
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
/** @import { AssistantItem, Item, NoteItem, ToolItem } from './transcript.js' */

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
const NOTE_SOURCES = new Set(['files', 'prompt', 'command', 'compaction']);

/**
 * Whether an assistant message is a response (see the module comment): the pane's
 * previous/next response buttons step through the same ones (omp/response-nav.js).
 * @param {AssistantItem} item
 */
export const isResponse = (item) => item.ended && item.stopReason !== 'toolUse';

/**
 * Narration: what the agent said on its way, in a message that went on to call tools (or the
 * piece of one before its work, compactWork). Shown softer than a response.
 * @param {AssistantItem} item
 */
export const isNarration = (item) => item.ended && item.stopReason === 'toolUse';

/**
 * The responses the transcript marks where they start: those with text that come after tool
 * calls or narration since the user's last prompt, where the eye cannot tell otherwise where the
 * answer begins. A response straight after the prompt, or after thinking alone, needs no mark.
 * @param {ReadonlyArray<Item | WorkItem>} items as shown (compactWork's, or promptsAndResponses')
 * @returns {Set<string>} their keys
 */
export function responseStarts(items) {
  /** @type {Set<string>} */
  const keys = new Set();
  let worked = false;
  for (const item of items) {
    if (item.kind === 'user') {
      if (!item.byAgent) worked = false;
    } else if (item.kind === 'work') {
      // omp's own notes folded in are not the agent working.
      if (item.parts.some((p) => p.kind === 'tool' || (p.kind === 'assistant' && p.blocks.some((b) => b.kind === 'toolCall')))) worked = true;
    } else if (item.kind === 'assistant') {
      if (isNarration(item)) worked = true;
      else if (isResponse(item) && item.blocks.some((b) => b.kind === 'text' && b.text.trim() !== '')) {
        if (worked) keys.add(item.key);
        worked = false;
      }
    }
  }
  return keys;
}

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

/**
 * A stretch of the agent's work between two things it said: its thinking and tool calls, shown
 * as one line that opens to show them (items-view.js `renderWork`). `parts` are assistant
 * messages holding only that work, tool runs, and the notes omp sends but does not display
 * (`hidden`: the tools it mounted, reminders to the model), which are omp's business, not the
 * conversation's.
 * @typedef {{ kind: 'work', key: string, rev: string, parts: Array<AssistantItem | ToolItem | NoteItem> }} WorkItem
 */

/** Thinking and tool calls: the work, as against what the agent says. @param {AssistantItem['blocks'][number]} block */
const isWork = (block) => block.kind === 'thinking' || block.kind === 'toolCall';

/**
 * The items with the agent's work folded: every run of thinking and tool calls between two
 * things it said (or the user did) becomes one WorkItem; what it says stays as it is. An
 * assistant message is split where its text and its work meet; how it ended (an error, aborted)
 * shows after its last piece, outside any fold.
 * @param {readonly Item[]} items @returns {Array<Item | WorkItem>}
 */
export function compactWork(items) {
  /** @type {Array<Item | WorkItem>} */
  const out = [];
  /** @type {WorkItem | null} */
  let work = null;
  const flush = () => {
    if (!work) return;
    work.rev = work.parts.map((p) => `${p.key}@${p.rev}`).join(',');
    out.push(work);
    work = null;
  };
  /** @param {AssistantItem | ToolItem | NoteItem} part */
  const fold = (part) => {
    work ??= { kind: 'work', key: `work:${part.key}`, rev: '', parts: [] };
    work.parts.push(part);
  };
  for (const item of items) {
    if (item.kind === 'tool' || (item.kind === 'note' && item.hidden)) fold(item);
    else if (item.kind !== 'assistant') {
      flush();
      out.push(item);
    } else {
      // Its blocks in runs of work and of text; empty text is nothing to show.
      /** @type {Array<{ work: boolean, blocks: AssistantItem['blocks'] }>} */
      const runs = [];
      for (const block of item.blocks) {
        if (block.kind === 'text' && !block.text.trim()) continue;
        const last = runs.at(-1);
        if (last && last.work === isWork(block)) last.blocks.push(block);
        else runs.push({ work: isWork(block), blocks: [block] });
      }
      // Only the last piece says how the message ended; the others are done, quietly.
      const quiet = { ended: true, stopReason: 'toolUse', errorMessage: null };
      runs.forEach((run, i) => {
        const last = i === runs.length - 1;
        const piece = { ...item, ...(last && !run.work ? {} : quiet), key: `${item.key}:${i}`, blocks: run.blocks };
        if (run.work) fold(piece);
        else {
          flush();
          out.push(piece);
        }
      });
      // Still to say anything, or ended badly after its work: shown as itself, its blocks folded.
      const ending = !item.ended || item.errorMessage || item.stopReason === 'aborted' || item.stopReason === 'length';
      if ((runs.length === 0 || runs.at(-1)?.work) && ending) {
        flush();
        out.push({ ...item, key: `${item.key}:end`, blocks: [] });
      }
    }
  }
  flush();
  return out;
}
