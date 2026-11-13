/**
 * A text file to read, and edit, beside the agents: Markdown, CSV, JSON, plain text or code
 * (files/file-refs.js), through the daemon (`/api/text`). A path an agent's reply names opens one
 * with a click, or a drag (files/file-window.js), as do the paths and Obsidian wiki links
 * (`[[note]]`) in a Markdown file shown rendered, read from the file's folder: a vault's notes are
 * read from one to the next.
 *
 * Params (persisted with the layout): `path` (absolute, or from home with `~/`), `line` (the one
 * to show, marked, or null) and `rendered` (Markdown, or CSV and TSV as a table (files/csv.js),
 * shown rendered rather than as their source; unset, they are, unless a line is asked for). A
 * window dropped from a wiki link has no path yet but the link (`wiki`) and the folder of the text
 * it was in (`from`): it asks the daemon which file that is (daemon/vaults.js), and shows it.
 * Without either, the window asks for a path. The file is read when shown and again on Reload.
 *
 * The source view is editable; the rendered one only shows. Edits are saved with Save (or
 * Cmd/Ctrl+S), never by themselves: the file is the user's, or an agent's, not the window's. Until
 * then they are kept by path for the page's life (`drafts`), so showing another file, or closing
 * the window, loses none; showing the file again brings them back. A save names the version it was
 * edited from: if the file has moved on since (an agent wrote it), the window says so and the user
 * chooses whose text stays, never the window.
 */
import { button, el, setText } from '../ui/dom.js';
import { errorMessage } from '../ui/format.js';
import { autosize } from '../ui/autosize.js';
import { onZoom } from '../ui/zoom.js';
import { tabIndent } from '../ui/indent.js';
import { getDaemon } from '../daemon/client.js';
import { renderMarkdown, renderTable } from '../omp/markdown-dom.js';
import { delimitedTable, tableDelimiter } from '../files/csv.js';
import { attachFileRefs } from '../files/file-window.js';
/** @import { WidgetContext } from './registry.js' */
/** @import { DaemonClient } from '../daemon/client.js' */
/** @import { TextFile } from '../../daemon/wire.js' */

export default {
  type: 'file',
  title: 'File',
  glyph: '¶',
  description: 'Read and edit a text file (Markdown, CSV, JSON, text, code); a path in an agent’s reply opens one with a click',

  /** @param {HTMLElement} body @param {WidgetContext} ctx */
  mount(body, ctx) {
    return createFileWindow(body, ctx, getDaemon());
  },
};

/**
 * Edited text not yet saved, as the text box holds it (`\n` line ends), and the version of the
 * file (`rev`) it was edited from: by resolved path, for any window that shows that file.
 * @typedef {{ text: string, base: string }} Draft
 * @type {Map<string, Draft>}
 */
const drafts = new Map();
// Leaving the page would lose them: the browser asks first.
addEventListener('beforeunload', (event) => {
  if (drafts.size) event.preventDefault();
});

/** Whether `path` has a rendered view: Markdown, or a table (CSV, TSV). @param {string} path */
const renders = (path) => /\.(md|markdown|mdx)$/i.test(path) || tableDelimiter(path) !== null;
/** @param {number} bytes */
const sizeText = (bytes) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
/** A file's text as a text box holds it: a text box turns every `\r\n` into `\n`. @param {TextFile} file */
const boxText = (file) => file.text.replace(/\r\n/g, '\n');
/** Edited text as saved: with `\r\n` line ends again, if the file had them. @param {string} text @param {TextFile} file */
const savedText = (text, file) => (file.text.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text);
/** @param {string} text */
const lineCount = (text) => (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n').length;

/** @param {HTMLElement} body @param {WidgetContext} ctx @param {DaemonClient} daemon */
function createFileWindow(body, ctx, daemon) {
  const params = () => {
    const line = Number(ctx.params.line);
    return {
      path: typeof ctx.params.path === 'string' && ctx.params.path ? ctx.params.path : null,
      line: Number.isInteger(line) && line > 0 ? line : null,
      rendered: typeof ctx.params.rendered === 'boolean' ? ctx.params.rendered : null,
      wiki: typeof ctx.params.wiki === 'string' && ctx.params.wiki ? ctx.params.wiki : null,
      from: typeof ctx.params.from === 'string' ? ctx.params.from : '',
    };
  };

  const root = el('div', 'fv');
  body.append(root);
  tabIndent(root);
  const offFileRefs = attachFileRefs({ root, ctx, cwd: () => (file ? file.path.slice(0, file.path.lastIndexOf('/')) || '/' : null) });
  const saveBtn = button('omp-tool-btn', 'Save', () => void save());
  const revertBtn = button('omp-tool-btn', 'Revert', () => {
    if (file) drafts.delete(file.path);
    draw();
  });
  const reloadBtn = button('omp-tool-btn', 'Reload', () => void load());
  const viewBtn = button('omp-tool-btn', '', () => ctx.setParams({ rendered: !rendered() }));
  ctx.headActions.append(saveBtn, revertBtn, viewBtn, reloadBtn);

  root.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void save();
    }
  });

  /** @type {TextFile | null} */
  let file = null;
  /** The path `file` was read for; a load for another one replaces it. */
  let shownPath = '';
  let loads = 0;
  let destroyed = false;
  let saving = false;
  /** Why the last save failed, until the next edit or save. @type {string | null} */
  let saveError = null;
  /**
   * What the shown view was drawn from: a read, a save or an edit that leaves both the same keeps
   * it, with its caret, scroll and undo. @type {{ key: string, text: string } | null}
   */
  let drawn = null;
  /** The text box of the source view, while it is shown. @type {HTMLTextAreaElement | null} */
  let area = null;
  // A text box is as tall as its text, so the window scrolls the line numbers with it: refit when
  // the window is laid out or resized, and when the text size changes.
  const resize = new ResizeObserver(() => fit());
  const offZoom = onZoom(() => fit());

  /** Whether the file shows rendered. */
  const rendered = () => {
    const p = params();
    return Boolean(p.path && renders(p.path)) && (p.rendered ?? p.line === null);
  };
  const draft = () => (file ? drafts.get(file.path) : undefined);
  /** The file changed since the unsaved edits began. */
  const conflicted = () => Boolean(file && draft() && draft()?.base !== file.rev);
  /** What a view of `file` is drawn from besides its text. @param {TextFile} file */
  const viewKey = (file) => JSON.stringify([file.path, rendered(), params().line, file.editable]);

  async function load() {
    const { path, wiki, from } = params();
    if (!path && wiki) return findWiki(wiki, from);
    if (!path) return draw();
    const mine = ++loads;
    shownPath = path;
    reloadBtn.disabled = true;
    try {
      const read = await daemon.textFile(path);
      if (mine !== loads || destroyed) return;
      file = read;
      // Edits that came to be the file's text (an agent made the same change) leave nothing to save.
      if (draft()?.text === boxText(read)) drafts.delete(read.path);
      draw();
    } catch (err) {
      if (mine !== loads || destroyed) return;
      file = null;
      drawn = null;
      area = null;
      root.replaceChildren(el('p', 'omp-error fv-message', `Cannot show ${path}: ${errorMessage(err)}`));
    } finally {
      if (mine === loads && !destroyed) reloadBtn.disabled = false;
    }
  }

  async function save() {
    const edit = draft();
    if (!file || !edit || saving || !file.editable) return;
    const path = file.path;
    saving = true;
    saveError = null;
    showState();
    try {
      const result = await daemon.saveTextFile(path, savedText(edit.text, file), edit.base);
      if (destroyed) return;
      if (result.ok) {
        // Typing went on during the save: what was typed since is still unsaved, now edited from what was saved.
        const now = drafts.get(path);
        if (now === edit) drafts.delete(path);
        else if (now) drafts.set(path, { text: now.text, base: result.file.rev });
        file = result.file;
      } else {
        file = result.current;
      }
    } catch (err) {
      if (destroyed) return;
      saveError = errorMessage(err);
    } finally {
      saving = false;
    }
    draw();
  }

  /** Keeps the edit, saved over whatever the file now holds. */
  function keepMine() {
    const edit = draft();
    if (!file || !edit) return;
    drafts.set(file.path, { text: edit.text, base: file.rev });
    void save();
  }

  /** Drops the edit for the file as it now is. */
  function useTheirs() {
    if (file) drafts.delete(file.path);
    draw();
  }

  function draw() {
    const p = params();
    if (!p.path) {
      drawn = null;
      area = null;
      showState();
      return root.replaceChildren(pathForm());
    }
    if (!file) return showState();
    const text = draft()?.text ?? boxText(file);
    const asRendered = rendered();
    const key = viewKey(file);
    if (key !== drawn?.key || text !== drawn.text) {
      // Read again (Reload, the agent's edits), it stays where the reader was, unless a line is asked for.
      const scrolled = root.querySelector('.fv-body')?.scrollTop ?? 0;
      resize.disconnect();
      area = null;
      const view = asRendered ? renderedView(file.path, text) : sourceView(text, file.editable, p.line);
      root.replaceChildren(el('div', 'fv-head'), conflictBar(), view);
      resize.observe(view);
      if (p.line === null) view.scrollTop = scrolled;
      drawn = { key, text };
    }
    showState();
  }

  /** The head, the buttons and the conflict notice, for the file and its edits as they are now. */
  function showState() {
    const p = params();
    const edit = draft();
    const name = p.path ? p.path.slice(p.path.lastIndexOf('/') + 1) : null;
    ctx.setLabel(name && edit ? `${name} •` : name);
    viewBtn.hidden = !p.path || !renders(p.path);
    setText(viewBtn, rendered() ? 'Source' : 'Rendered');
    reloadBtn.hidden = !p.path;
    saveBtn.hidden = revertBtn.hidden = !edit || !file?.editable;
    saveBtn.disabled = revertBtn.disabled = saving || conflicted();
    const head = root.querySelector('.fv-head');
    if (!file || !head) return;
    const where = el('span', 'fv-path', file.path);
    const facts = [file.truncated ? `${sizeText(file.size)}, shown cut short` : sizeText(file.size)];
    if (!file.editable && !file.truncated) facts.push('read only: not plain UTF-8');
    const state = saving ? 'Saving…' : saveError ? `Not saved: ${saveError}` : edit ? 'Unsaved edits' : '';
    const status = el('span', saveError ? 'omp-error fv-status' : 'omp-muted fv-status', state);
    head.replaceChildren(where, el('span', 'omp-muted', facts.join(', ')), status);
    const bar = /** @type {HTMLElement | null} */ (root.querySelector('.fv-conflict'));
    if (bar) bar.hidden = !conflicted();
  }

  function conflictBar() {
    const bar = el('div', 'fv-conflict');
    bar.setAttribute('role', 'alert');
    const mine = button('btn btn-accent', 'Keep mine', keepMine);
    const theirs = button('btn', 'Use the file', useTheirs);
    const row = el('div', 'omp-row');
    row.append(mine, theirs);
    bar.append(el('p', '', 'The file changed since you began editing it (an agent, or another editor). Your edits are not saved.'), row);
    bar.hidden = true;
    return bar;
  }

  /** Shows the file wiki link `wiki` names, from text in folder `from`, once the daemon has found it. @param {string} wiki @param {string} from */
  async function findWiki(wiki, from) {
    const mine = ++loads;
    try {
      const { path } = await daemon.wikiTarget(wiki, from);
      if (mine === loads && !destroyed) ctx.setParams({ path, line: null, wiki: null, from: null });
    } catch (err) {
      if (mine === loads && !destroyed) root.replaceChildren(el('p', 'omp-error fv-message', `Cannot show [[${wiki}]]: ${errorMessage(err)}`));
    }
  }

  /** Markdown rendered, or CSV and TSV as a table. @param {string} path @param {string} text */
  function renderedView(path, text) {
    const node = el('div', 'fv-body fv-rendered omp-md');
    const delimiter = tableDelimiter(path);
    if (delimiter === null) {
      node.append(renderMarkdown(text, { files: true }));
      return node;
    }
    const table = delimitedTable(text, delimiter);
    if (!table) {
      node.append(el('p', 'omp-muted', 'No rows.'));
      return node;
    }
    if (table.shown < table.total) {
      node.append(el('p', 'omp-muted', `The first ${table.shown.toLocaleString()} of ${table.total.toLocaleString()} rows; Source shows them all.`));
    }
    node.append(renderTable(table.block));
    return node;
  }

  /**
   * The text with its line numbers, in a text box to edit when `editable`; `line`, if given,
   * marked and scrolled to.
   * @param {string} text @param {boolean} editable @param {number | null} line
   */
  function sourceView(text, editable, line) {
    const node = el('div', 'fv-body fv-source');
    let lines = lineCount(text);
    const numbers = (/** @type {number} */ n) => Array.from({ length: n }, (_, i) => i + 1).join('\n');
    const gutter = el('pre', 'fv-gutter', numbers(lines));
    gutter.setAttribute('aria-hidden', 'true');
    const box = el('textarea', 'fv-text');
    box.value = text;
    box.wrap = 'off';
    box.spellcheck = false;
    box.readOnly = !editable;
    box.setAttribute('aria-label', editable ? 'File text' : 'File text, read only');
    node.append(gutter, box);
    area = box;
    /** @type {HTMLElement | null} */
    let mark = null;
    box.addEventListener('input', () => {
      if (!file) return;
      const now = box.value;
      // Back to the file's own text (as it now is), there is nothing to save.
      if (now === boxText(file)) drafts.delete(file.path);
      else drafts.set(file.path, { text: now, base: draft()?.base ?? file.rev });
      drawn = { key: viewKey(file), text: now };
      saveError = null;
      if (lineCount(now) !== lines) gutter.textContent = numbers((lines = lineCount(now)));
      // The marked line has moved with the edit: the mark would point at another.
      mark?.remove();
      mark = null;
      fit();
      showState();
    });
    if (line !== null && line <= lines) {
      const lineMark = el('div', 'fv-line-mark');
      mark = lineMark;
      node.append(lineMark);
      // Placed once laid out: a line's height is the text's.
      requestAnimationFrame(() => {
        fit();
        const style = getComputedStyle(box);
        const height = parseFloat(style.lineHeight);
        const top = box.offsetTop + parseFloat(style.paddingTop) + (line - 1) * height;
        lineMark.style.top = `${top}px`;
        lineMark.style.height = `${height}px`;
        node.scrollTop = Math.max(0, top - node.clientHeight / 3);
      });
    }
    return node;
  }

  function fit() {
    const scroller = area?.parentElement;
    if (area && scroller?.isConnected) autosize(area, { scroller });
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
        saveError = null;
        drawn = null;
        area = null;
        resize.disconnect();
        root.replaceChildren();
      }
      void load();
    },
    destroy() {
      // Unsaved edits stay in `drafts`: the file shown again brings them back.
      destroyed = true;
      offFileRefs();
      resize.disconnect();
      offZoom();
      ctx.headActions.replaceChildren();
      root.remove();
    },
  };
}
