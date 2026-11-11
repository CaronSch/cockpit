/**
 * Renders the safe markdown tree from `markdown.js` as DOM nodes (text nodes only, never HTML).
 *
 * TeX math becomes MathML, which the browser typesets itself, through Temml's `render`: it
 * builds the elements with `createElementNS` and text nodes, never markup. TeX it cannot
 * read stays as its source, in the code style, with Temml's reason as the tooltip.
 *
 * Pull requests named in text are marked (github/pr-refs.js), so a window can let them be
 * dragged out, or clicked open on GitHub (github/pull-window.js): a link to one gets
 * `md-pr-link` with its `repo` and `number`, and a `#123` or `owner/repo#123` in plain text
 * (not in code) is a `md-pr-ref` span with its `number` (and `repo`).
 *
 * So are text files (files/file-refs.js) where `files` asks for them, for the file window
 * (files/file-window.js): a path to one in plain text is a `md-file-ref` span, and a code span
 * holding just one gets the class, each with its `path` as written and the `line` named after
 * it, if any.
 */
import temml from 'temml';
import { el } from '../ui/dom.js';
import { parseMarkdown } from './markdown.js';
import { renderCode } from './code-copy.js';
import { tableCopy } from './table-copy.js';
import { renderVisual } from './visuals.js';
import { pullOfUrl, splitRefs } from '../github/pr-refs.js';
import { fileRefOf, splitFileRefs } from '../files/file-refs.js';
import { opensInViewer } from '../ui/image-viewer.js';
/** @import { Block, Inline, TableBlock } from './markdown.js' */

/**
 * How a reply is rendered: `reply` names the reply (its item and block), so the images it
 * shows are its own (see renderImage); `files` marks the text files it names. `lastRepo` (set
 * by renderMarkdown) is the repository the text last named, through a pull request link or an
 * `owner/name#123`: a bare `#123` after it is of that repository, not the conversation's.
 * @typedef {{ reply?: string, files?: boolean, lastRepo?: { name: string | null } }} RenderOptions
 */

/** @param {string} source @param {RenderOptions} [options] @returns {DocumentFragment} */
export function renderMarkdown(source, options = {}) {
  const scope = { ...options, lastRepo: { name: null } };
  const fragment = document.createDocumentFragment();
  for (const block of parseMarkdown(source)) fragment.append(renderBlock(block, scope));
  return fragment;
}

/**
 * A table, with its Copy control (as Markdown, CSV or an image); also the file window's view of
 * a CSV file (files/csv.js).
 * @param {TableBlock} block @param {RenderOptions} [options] @returns {HTMLElement}
 */
export function renderTable(block, options = {}) {
  const table = el('table', 'md-table');
  /** @param {'th' | 'td'} tag @param {Inline[][]} cells */
  const row = (tag, cells) => {
    const tr = el('tr');
    cells.forEach((cell, c) => {
      const td = withInline(el(tag), cell, options);
      const align = block.align[c];
      if (align) td.style.textAlign = align;
      tr.append(td);
    });
    return tr;
  };
  const head = el('thead');
  head.append(row('th', block.head));
  const body = el('tbody');
  for (const cells of block.rows) body.append(row('td', cells));
  table.append(head, body);
  // Wide tables scroll sideways inside the transcript instead of squeezing their columns;
  // the Copy control sits outside that scroller so it stays in the corner.
  const wrap = el('div', 'md-table-wrap');
  wrap.append(table);
  const tableBlock = el('div', 'md-table-block');
  tableBlock.append(...tableCopy(block, table), wrap);
  return tableBlock;
}

/** @param {Block} block @param {RenderOptions} options @returns {Node} */
function renderBlock(block, options) {
  switch (block.type) {
    case 'paragraph':
      return withInline(el('p'), block.children, options);
    case 'heading':
      return withInline(el(/** @type {'h3' | 'h4' | 'h5' | 'h6'} */ (`h${Math.min(6, block.level + 2)}`), 'md-heading'), block.children, options);
    case 'code':
      return renderCode(block.text, block.lang);
    case 'table':
      return renderTable(block, options);
    case 'visual':
      return renderVisual(block.lang, block.source);
    case 'rule':
      return el('hr');
    case 'quote': {
      const quote = el('blockquote');
      for (const child of block.children) quote.append(renderBlock(child, options));
      return quote;
    }
    case 'list': {
      const list = block.ordered ? el('ol') : el('ul');
      if (block.ordered && block.start !== 1 && list instanceof HTMLOListElement) list.start = block.start;
      for (const item of block.items) {
        const li = el('li');
        for (const child of item) li.append(renderBlock(child, options));
        list.append(li);
      }
      return list;
    }
  }
}

/** @template {HTMLElement} E @param {E} parent @param {Inline[]} children @param {RenderOptions} options @returns {E} */
function withInline(parent, children, options) {
  for (const child of children) parent.append(renderInline(child, options));
  return parent;
}

/** @param {Inline} node @param {RenderOptions} options @returns {Node} */
function renderInline(node, options) {
  switch (node.type) {
    case 'text':
      return renderText(node.text, options);
    case 'code': {
      const code = el('code', 'md-inline-code', node.text);
      const file = options.files ? fileRefOf(node.text) : null;
      if (file) markFile(code, file);
      return code;
    }
    case 'strong':
      return withInline(el('strong'), node.children, options);
    case 'em':
      return withInline(el('em'), node.children, options);
    case 'break':
      return el('br');
    case 'link': {
      const a = withInline(el('a'), node.children, options);
      a.href = node.href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      const pull = pullOfUrl(node.href);
      if (pull) {
        a.classList.add('md-pr-link');
        a.dataset.repo = pull.repo;
        if (options.lastRepo) options.lastRepo.name = pull.repo;
        a.dataset.number = String(pull.number);
        a.draggable = false; // dragged out as a pull request window, never as a link
      }
      return a;
    }
    case 'image':
      return renderImage(node.path, node.alt, options);
    case 'math':
      return renderMath(node.tex, node.display);
  }
}

/** Plain text, its `#123` references (and text file paths) marked. @param {string} text @param {RenderOptions} options @returns {Node} */
function renderText(text, options) {
  const fragment = document.createDocumentFragment();
  for (const part of splitRefs(text)) {
    if ('number' in part) {
      const ref = el('span', 'md-pr-ref', part.text);
      ref.dataset.number = String(part.number);
      if (part.repo && options.lastRepo) options.lastRepo.name = part.repo;
      const repo = part.repo ?? options.lastRepo?.name;
      if (repo) ref.dataset.repo = repo;
      fragment.append(ref);
      continue;
    }
    if (!options.files) {
      fragment.append(part.text);
      continue;
    }
    for (const run of splitFileRefs(part.text)) {
      fragment.append('path' in run ? markFile(el('span', undefined, run.text), run) : run.text);
    }
  }
  return fragment;
}

/** @template {HTMLElement} E @param {E} node @param {{ path: string, line: number | null }} file @returns {E} */
function markFile(node, file) {
  node.classList.add('md-file-ref');
  node.dataset.path = file.path;
  if (file.line !== null) node.dataset.line = String(file.line);
  return node;
}

/**
 * An image file on this machine, served by the daemon (`/api/file`): a click shows it in the
 * image viewer (ui/image-viewer.js). One that cannot be shown (gone, unreadable) says so, with its path.
 *
 * Its address names the reply too: a page shows the image it already loaded from an address
 * however the response said not to keep it, so an agent's chart redrawn under the same name
 * would show its old picture in the new reply. Each reply loads its own once, and keeps it as
 * the reply redraws.
 * @param {string} path @param {string} alt @param {RenderOptions} options @returns {HTMLElement}
 */
function renderImage(path, alt, options) {
  const src = `/api/file?path=${encodeURIComponent(path)}${options.reply ? `&in=${encodeURIComponent(options.reply)}` : ''}`;
  const a = el('a', 'md-image');
  a.href = src;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  const img = el('img');
  img.src = src;
  img.alt = alt;
  img.addEventListener('error', () => a.replaceWith(el('span', 'md-image-missing', `${alt ? `${alt}: ` : ''}image not found (${path})`)), { once: true });
  a.append(img);
  opensInViewer(/** @type {HTMLAnchorElement} */ (a), alt || path.split('/').pop() || path);
  return a;
}

/** A file a prompt was sent with (message.js `splitAttachments`): an image as a thumbnail, anything else as its name. @param {string} path @returns {HTMLElement} */
export function renderAttachment(path) {
  const name = path.split('/').pop() ?? path;
  if (/\.(png|jpe?g|gif|webp|avif)$/i.test(path)) return renderImage(path, name, {});
  const chip = el('span', 'md-attachment', name);
  return chip;
}

/**
 * Display math is a block of its own, scrolling sideways when wide, as a table does.
 * @param {string} tex @param {boolean} display @returns {HTMLElement}
 */
function renderMath(tex, display) {
  const box = el('span', display ? 'md-math is-display' : 'md-math');
  /** @param {string} source */
  const render = (source) => temml.render(source, box, { displayMode: display, throwOnError: true });
  try {
    try {
      render(tex);
    } catch (err) {
      // Models often write a bare `&` in text (`\text{P&L}`), which TeX reads as a column
      // separator and rejects; escaped, it reads as meant. Only tried once that has failed, so
      // the `&`s of an aligned environment that rendered are left alone.
      const escaped = tex.replace(/(?<!\\)&/g, '\\&');
      if (escaped === tex) throw err;
      render(escaped);
    }
  } catch (err) {
    const source = el('code', 'md-inline-code md-math-error', display ? `$$${tex}$$` : `$${tex}$`);
    box.replaceChildren(source);
  }
  return box;
}
