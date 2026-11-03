/**
 * A text file to read beside the agents: Markdown, JSON, plain text or code (files/file-refs.js),
 * read through the daemon (`/api/text`). A path an agent's reply names opens one with a click,
 * or a drag (files/file-window.js).
 *
 * Params (persisted with the layout): `path` (absolute, or from home with `~/`), `line` (the one
 * to show, marked, or null) and `rendered` (Markdown shown rendered rather than as its source;
 * unset, it is, unless a line is asked for). Without a path, the window asks for one. The file
 * is read when shown and again on Reload: the window never writes it.
 */
import { button, el, setText } from '../ui/dom.js';
import { errorMessage } from '../ui/format.js';
import { getDaemon } from '../daemon/client.js';
import { renderMarkdown } from '../omp/markdown-dom.js';
/** @import { WidgetContext } from './registry.js' */
/** @import { DaemonClient } from '../daemon/client.js' */
/** @import { TextFile } from '../../daemon/wire.js' */

export default {
  type: 'file',
  title: 'File',
  glyph: '¶',
  description: 'Read a text file (Markdown, JSON, text, code); a path in an agent’s reply opens one with a click',

  /** @param {HTMLElement} body @param {WidgetContext} ctx */
  mount(body, ctx) {
    return createFileWindow(body, ctx, getDaemon());
  },
};

/** @param {string} path */
const isMarkdown = (path) => /\.(md|markdown|mdx)$/i.test(path);
/** @param {number} bytes */
const sizeText = (bytes) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/** @param {HTMLElement} body @param {WidgetContext} ctx @param {DaemonClient} daemon */
function createFileWindow(body, ctx, daemon) {
  const params = () => {
    const line = Number(ctx.params.line);
    return {
      path: typeof ctx.params.path === 'string' && ctx.params.path ? ctx.params.path : null,
      line: Number.isInteger(line) && line > 0 ? line : null,
      rendered: typeof ctx.params.rendered === 'boolean' ? ctx.params.rendered : null,
    };
  };

  const root = el('div', 'fv');
  body.append(root);
  const reloadBtn = button('omp-tool-btn', 'Reload', () => void load());
  reloadBtn.title = 'Read the file again';
  const viewBtn = button('omp-tool-btn', '', () => ctx.setParams({ rendered: !rendered() }));
  ctx.headActions.append(viewBtn, reloadBtn);

  /** @type {TextFile | null} */
  let file = null;
  /** The path `file` was read for; a load for another one replaces it. */
  let shownPath = '';
  let loads = 0;
  let destroyed = false;

  /** Whether Markdown shows rendered. */
  const rendered = () => {
    const p = params();
    return Boolean(p.path && isMarkdown(p.path)) && (p.rendered ?? p.line === null);
  };

  async function load() {
    const { path } = params();
    if (!path) return draw();
    const mine = ++loads;
    shownPath = path;
    reloadBtn.disabled = true;
    try {
      const read = await daemon.textFile(path);
      if (mine !== loads || destroyed) return;
      file = read;
      draw();
    } catch (err) {
      if (mine !== loads || destroyed) return;
      file = null;
      root.replaceChildren(el('p', 'omp-error fv-message', `Cannot show ${path}: ${errorMessage(err)}`));
    } finally {
      if (mine === loads && !destroyed) reloadBtn.disabled = false;
    }
  }

  function draw() {
    const p = params();
    ctx.setLabel(p.path ? p.path.slice(p.path.lastIndexOf('/') + 1) : null);
    viewBtn.hidden = !p.path || !isMarkdown(p.path);
    setText(viewBtn, rendered() ? 'Source' : 'Rendered');
    viewBtn.title = rendered() ? 'Show the Markdown as written, with line numbers' : 'Show the Markdown rendered';
    reloadBtn.hidden = !p.path;
    if (!p.path) return root.replaceChildren(pathForm());
    if (!file) return;
    const head = el('div', 'fv-head');
    const where = el('span', 'fv-path', file.path);
    where.title = file.path;
    head.append(where, el('span', 'omp-muted', file.truncated ? `${sizeText(file.size)}, shown cut short` : sizeText(file.size)));
    // Read again (Reload, the agent's edits), it stays where the reader was, unless a line is asked for.
    const scrolled = root.querySelector('.fv-body')?.scrollTop ?? 0;
    const view = rendered() ? renderedView(file.text) : sourceView(file.text, p.line);
    root.replaceChildren(head, view);
    if (p.line === null) view.scrollTop = scrolled;
  }

  /** @param {string} text */
  function renderedView(text) {
    const node = el('div', 'fv-body fv-rendered omp-md');
    node.append(renderMarkdown(text));
    return node;
  }

  /** The text with its line numbers; `line`, if given, marked and scrolled to. @param {string} text @param {number | null} line */
  function sourceView(text, line) {
    const node = el('div', 'fv-body fv-source');
    const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
    const gutter = el('pre', 'fv-gutter', lines.map((_, i) => i + 1).join('\n'));
    gutter.setAttribute('aria-hidden', 'true');
    const code = el('pre', 'fv-text', text);
    node.append(gutter, code);
    if (line !== null && line <= lines.length) {
      const mark = el('div', 'fv-line-mark');
      node.append(mark);
      // Placed once laid out: a line's height is the text's.
      requestAnimationFrame(() => {
        const style = getComputedStyle(code);
        const height = parseFloat(style.lineHeight);
        const top = code.offsetTop + parseFloat(style.paddingTop) + (line - 1) * height;
        mark.style.top = `${top}px`;
        mark.style.height = `${height}px`;
        node.scrollTop = Math.max(0, top - node.clientHeight / 3);
      });
    }
    return node;
  }

  function pathForm() {
    const form = el('form', 'fv-pick');
    const input = el('input', 'omp-field');
    input.type = 'text';
    input.spellcheck = false;
    input.placeholder = '~/notes/plan.md';
    input.setAttribute('aria-label', 'File');
    const open = el('button', 'btn btn-accent', 'Open');
    open.type = 'submit';
    const row = el('div', 'omp-row');
    row.append(input, open);
    form.append(el('p', 'omp-setup-title', 'Read a file'), row);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (input.value.trim()) ctx.setParams({ path: input.value.trim(), line: null, rendered: null });
    });
    return form;
  }

  void load();
  return {
    // Shown again, the file is read again: the agent may have changed it since.
    paramsChanged() {
      if (params().path !== shownPath) {
        file = null;
        root.replaceChildren();
      }
      void load();
    },
    destroy() {
      destroyed = true;
      ctx.headActions.replaceChildren();
      root.remove();
    },
  };
}
