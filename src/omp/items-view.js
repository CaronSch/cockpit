/**
 * DOM for one transcript item of the agent pane (messages, tool cards, shell runs, notes,
 * unrecognised frames), built from text nodes only.
 */
import { button, el } from '../ui/dom.js';
import { json } from '../ui/format.js';
import { renderMarkdown } from './markdown-dom.js';
/** @import { Block, Item, ToolRun } from './transcript.js' */

/**
 * `open` remembers which collapsible parts the user expanded, so redrawing an item while
 * it streams keeps them as they were.
 * @typedef {{ tools: ReadonlyMap<string, ToolRun>, open: Set<string> }} ItemContext
 */

const STATUS_GLYPH = { pending: '○', running: '◌', ok: '✓', error: '✕', cancelled: '⊘' };
const NOTE_INLINE_CHARS = 200;

/** @param {Item} item @param {ItemContext} ctx @returns {HTMLElement} */
export function renderItem(item, ctx) {
  switch (item.kind) {
    case 'user': {
      const node = el('div', `omp-msg omp-user${item.byAgent ? ' is-agent' : ''}`);
      node.dataset.key = item.key;
      // The user's own prompts need no label (the band and prompt mark say it); another agent's do.
      if (item.byAgent) node.append(el('div', 'omp-role', 'another agent →'));
      const body = el('div', 'omp-md');
      body.append(renderMarkdown(item.text));
      if (item.images) body.append(statusLine('muted', `[${item.images} image${item.images === 1 ? '' : 's'}]`));
      node.append(body);
      // The pane acts on it (omp/rewind.js); the user's own prompts can be reworded, not an agent's.
      if (!item.byAgent) {
        const rewind = button('omp-rewind-btn', 'Rewind');
        rewind.title = 'Rewind to here: reword this prompt and send it again (the later turns are set aside)';
        node.append(rewind);
      }
      return node;
    }
    case 'assistant': {
      const node = el('div', 'omp-msg omp-assistant');
      item.blocks.forEach((block, i) => node.append(renderBlock(block, `${item.key}:${i}`, ctx)));
      if (!item.ended && item.blocks.length === 0) node.append(statusLine('muted', '…'));
      if (item.errorMessage) node.append(statusLine('error', item.errorMessage));
      else if (item.stopReason === 'aborted') node.append(statusLine('muted', 'aborted'));
      else if (item.stopReason === 'length') node.append(statusLine('muted', 'stopped: output length limit'));
      return node;
    }
    case 'tool': {
      const run = ctx.tools.get(item.toolCallId);
      return toolCard(item.key, null, run, ctx);
    }
    case 'bash': {
      const node = el('div', `omp-bash is-${item.status}`);
      const head = el('div', 'omp-bash-head');
      head.append(
        el('span', 'omp-status', STATUS_GLYPH[item.status]),
        el('code', 'omp-bash-cmd', `${item.language === 'bash' ? '$' : '>>>'} ${item.command}`),
      );
      if (item.exitCode !== null && item.exitCode !== 0) head.append(statusLine('muted', `exit ${item.exitCode}`, 'span'));
      if (item.status === 'cancelled') head.append(statusLine('muted', 'cancelled', 'span'));
      node.append(head);
      if (item.output) node.append(el('pre', 'omp-pre', item.output));
      if (item.truncated) node.append(statusLine('muted', 'output truncated'));
      if (item.error) node.append(statusLine('error', item.error));
      return node;
    }
    case 'note': {
      // A slash command's multi-line output is the answer to what was asked: show it open.
      if (item.source === 'command' && item.detail) return el('pre', 'omp-pre omp-command-output', item.detail);
      const cls = `omp-note is-${item.level}${item.hidden ? ' is-hidden' : ''}`;
      const label = [item.source, item.text].filter(Boolean).join(': ');
      const [firstLine, ...moreLines] = label.split('\n');
      // A multi-line or very long note (omp's startup notice lists every tool) shows its
      // first line; the rest is one click away.
      const long = moreLines.length > 0 || firstLine.length > NOTE_INLINE_CHARS;
      if (!item.detail && !long) return el('div', cls, label);
      const detail = [long ? label : '', item.detail ?? ''].filter(Boolean).join('\n\n');
      return collapsible(ctx, item.key, cls, [clip(firstLine || item.source)], () => [el('pre', 'omp-pre', detail)]);
    }
    case 'unrecognised':
      return collapsible(ctx, item.key, 'omp-unrecognised', [`unrecognised: ${item.label}`], () => [el('pre', 'omp-pre', item.raw)]);
  }
}

/** @param {Block} block @param {string} id @param {ItemContext} ctx @returns {HTMLElement} */
function renderBlock(block, id, ctx) {
  switch (block.kind) {
    case 'text': {
      const node = el('div', 'omp-md');
      node.append(renderMarkdown(block.text, { reply: id }));
      return node;
    }
    case 'thinking':
      return collapsible(ctx, id, 'omp-thinking', [block.redacted ? 'thinking (redacted)' : 'thinking'], () => [
        el('div', 'omp-thinking-text', block.text),
      ]);
    case 'toolCall':
      return toolCard(id, block, block.id ? ctx.tools.get(block.id) : undefined, ctx);
    case 'other':
      return collapsible(ctx, id, 'omp-unrecognised', [`[${block.type}]`], () => [el('pre', 'omp-pre', json(block.raw))]);
  }
}

/**
 * @param {string} id @param {Extract<Block, { kind: 'toolCall' }> | null} block
 * @param {ToolRun | undefined} run @param {ItemContext} ctx
 */
function toolCard(id, block, run, ctx) {
  const status = run?.status ?? (block?.id ? 'pending' : 'running');
  const name = run?.name || block?.name || 'tool';
  const args = run?.args ?? block?.args ?? null;
  const summary = run?.intent ?? block?.intent ?? argsSummary(args) ?? (block?.argsText ? block.argsText.slice(0, 120) : '');
  const head = [el('span', 'omp-status', STATUS_GLYPH[status]), el('span', 'omp-tool-name', name)];
  if (summary) head.push(el('span', 'omp-tool-summary', summary));
  return collapsible(ctx, `tool:${run?.id ?? id}`, `omp-tool is-${status}`, head, () => {
    /** @type {HTMLElement[]} */
    const parts = [];
    const argsText = args !== null ? json(args) : block?.argsText ?? '';
    if (argsText) parts.push(el('div', 'omp-label', 'input'), el('pre', 'omp-pre', argsText));
    if (run?.result !== null && run?.result !== undefined) {
      parts.push(el('div', 'omp-label', run.status === 'error' ? 'error' : 'result'), el('pre', 'omp-pre', run.result || '(empty)'));
    } else if (run?.output) {
      parts.push(el('div', 'omp-label', 'output'), el('pre', 'omp-pre', run.output));
    } else if (status === 'pending') {
      parts.push(statusLine('muted', 'no result'));
    }
    return parts;
  });
}

/**
 * A status line inside an item (how a reply ended, an exit code, an error), styled as a
 * transcript note.
 * @param {'muted' | 'error'} level @param {string} text @param {'div' | 'span'} [tag]
 */
const statusLine = (level, text, tag = 'div') => el(tag, `omp-note is-${level}`, text);

/**
 * A `<details>` whose body is built only while open.
 * @param {ItemContext} ctx @param {string} id @param {string} className
 * @param {Array<string | Node>} summary @param {() => Node[]} body
 */
function collapsible(ctx, id, className, summary, body) {
  const details = el('details', className);
  const head = el('summary');
  head.append(...summary);
  details.append(head);
  const fill = () => {
    if (details.childNodes.length === 1) details.append(...body());
  };
  if (ctx.open.has(id)) {
    details.open = true;
    fill();
  }
  details.addEventListener('toggle', () => {
    if (details.open) {
      ctx.open.add(id);
      fill();
    } else {
      ctx.open.delete(id);
    }
  });
  return details;
}

const SUMMARY_KEYS = ['command', 'path', 'file_path', 'pattern', 'query', 'url', 'paths'];

/** One-line summary of a tool's arguments. @param {unknown} args @returns {string | null} */
function argsSummary(args) {
  if (!args || typeof args !== 'object') return null;
  const record = /** @type {Record<string, unknown>} */ (args);
  if (typeof record.i === 'string') return record.i; // omp's per-call intent field
  for (const key of SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value === 'string') return clip(value);
    if (Array.isArray(value)) return clip(value.join(' '));
  }
  const first = Object.values(record).find((v) => typeof v === 'string');
  return typeof first === 'string' ? clip(first) : null;
}

/** @param {string} text */
const clip = (text) => (text.length > 120 ? `${text.slice(0, 119)}…` : text).replace(/\s+/g, ' ');

