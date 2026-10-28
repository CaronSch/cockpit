/**
 * Renders the safe markdown tree from `markdown.js` as DOM nodes (text nodes only, never HTML).
 *
 * TeX math becomes MathML, which the browser typesets itself, through Temml's `render`: it
 * builds the elements with `createElementNS` and text nodes, never markup. TeX it cannot
 * read stays as its source, in the code style, with Temml's reason as the tooltip.
 */
import temml from 'temml';
import { el } from '../ui/dom.js';
import { parseMarkdown } from './markdown.js';
import { tableCopy } from './table-copy.js';
import { renderVisual } from './visuals.js';
/** @import { Block, Inline } from './markdown.js' */

/** @param {string} source @returns {DocumentFragment} */
export function renderMarkdown(source) {
  const fragment = document.createDocumentFragment();
  for (const block of parseMarkdown(source)) fragment.append(renderBlock(block));
  return fragment;
}

/** @param {Block} block @returns {Node} */
function renderBlock(block) {
  switch (block.type) {
    case 'paragraph':
      return withInline(el('p'), block.children);
    case 'heading':
      return withInline(el(/** @type {'h3' | 'h4' | 'h5' | 'h6'} */ (`h${Math.min(6, block.level + 2)}`), 'md-heading'), block.children);
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
          const td = withInline(el(tag), cell);
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
      for (const child of block.children) quote.append(renderBlock(child));
      return quote;
    }
    case 'list': {
      const list = block.ordered ? el('ol') : el('ul');
      if (block.ordered && block.start !== 1 && list instanceof HTMLOListElement) list.start = block.start;
      for (const item of block.items) {
        const li = el('li');
        for (const child of item) li.append(renderBlock(child));
        list.append(li);
      }
      return list;
    }
  }
}

/** @template {HTMLElement} E @param {E} parent @param {Inline[]} children @returns {E} */
function withInline(parent, children) {
  for (const child of children) parent.append(renderInline(child));
  return parent;
}

/** @param {Inline} node @returns {Node} */
function renderInline(node) {
  switch (node.type) {
    case 'text':
      return document.createTextNode(node.text);
    case 'code':
      return el('code', 'md-inline-code', node.text);
    case 'strong':
      return withInline(el('strong'), node.children);
    case 'em':
      return withInline(el('em'), node.children);
    case 'break':
      return el('br');
    case 'link': {
      const a = withInline(el('a'), node.children);
      a.href = node.href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      return a;
    }
    case 'image':
      return renderImage(node.path, node.alt);
    case 'math':
      return renderMath(node.tex, node.display);
  }
}

/**
 * An image file on this machine, served by the daemon (`/api/file`): a click opens it full
 * size. One that cannot be shown (gone, unreadable) says so, with its path.
 * @param {string} path @param {string} alt @returns {HTMLElement}
 */
function renderImage(path, alt) {
  const src = `/api/file?path=${encodeURIComponent(path)}`;
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
