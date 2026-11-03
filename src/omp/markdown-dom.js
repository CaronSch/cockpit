/**
 * Renders the safe markdown tree from `markdown.js` as DOM nodes (text nodes only, never HTML).
 *
 * TeX math becomes MathML, which the browser typesets itself, through Temml's `render`: it
 * builds the elements with `createElementNS` and text nodes, never markup. TeX it cannot
 * read stays as its source, in the code style, with Temml's reason as the tooltip.
 *
 * Pull requests named in text are marked (github/pr-refs.js), so a window can let them be
 * dragged out: a link to one gets `md-pr-link` with its `repo` and `number`, and a `#123` in
 * plain text (not in code) is a `md-pr-ref` span with its `number`.
 */
import temml from 'temml';
import { el } from '../ui/dom.js';
import { parseMarkdown } from './markdown.js';
import { tableCopy } from './table-copy.js';
import { renderVisual } from './visuals.js';
import { pullOfUrl, splitRefs } from '../github/pr-refs.js';
/** @import { Block, Inline } from './markdown.js' */

/**
 * How a reply is rendered: `reply` names the reply (its item and block), so the images it
 * shows are its own (see renderImage).
 * @typedef {{ reply?: string }} RenderOptions
 */

/** @param {string} source @param {RenderOptions} [options] @returns {DocumentFragment} */
export function renderMarkdown(source, options = {}) {
  const fragment = document.createDocumentFragment();
  for (const block of parseMarkdown(source)) fragment.append(renderBlock(block, options));
  return fragment;
}

/** @param {Block} block @param {RenderOptions} options @returns {Node} */
function renderBlock(block, options) {
  switch (block.type) {
    case 'paragraph':
      return withInline(el('p'), block.children, options);
    case 'heading':
      return withInline(el(/** @type {'h3' | 'h4' | 'h5' | 'h6'} */ (`h${Math.min(6, block.level + 2)}`), 'md-heading'), block.children, options);
    case 'code': {
      const pre = el('pre', 'md-code');
      const code = el('code', undefined, block.text);
      if (block.lang) pre.dataset.lang = block.lang;
      pre.append(code);
      return pre;
    }
    case 'table': {
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
      return renderText(node.text);
    case 'code':
      return el('code', 'md-inline-code', node.text);
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

/** Plain text, its `#123` references marked. @param {string} text @returns {Node} */
function renderText(text) {
  const parts = splitRefs(text);
  if (parts.length === 1 && !('number' in parts[0])) return document.createTextNode(text);
  const fragment = document.createDocumentFragment();
  for (const part of parts) {
    if (!('number' in part)) {
      fragment.append(part.text);
      continue;
    }
    const ref = el('span', 'md-pr-ref', part.text);
    ref.dataset.number = String(part.number);
    fragment.append(ref);
  }
  return fragment;
}

/**
 * An image file on this machine, served by the daemon (`/api/file`): a click opens it full
 * size. One that cannot be shown (gone, unreadable) says so, with its path.
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
  a.title = path;
  const img = el('img');
  img.src = src;
  img.alt = alt;
  img.addEventListener('error', () => a.replaceWith(el('span', 'md-image-missing', `${alt ? `${alt}: ` : ''}image not found (${path})`)), { once: true });
  a.append(img);
  return a;
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
    source.title = err instanceof Error ? err.message : String(err);
    box.replaceChildren(source);
  }
  return box;
}
