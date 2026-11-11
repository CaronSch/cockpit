/**
 * Copy control for a rendered Markdown table: a button whose menu copies the table as Markdown, CSV or a PNG image.
 *
 * The image is drawn on a canvas from the parsed cells (not a screenshot of the page), in the
 * rendered table's fonts and colours.
 */
import { button, el } from '../ui/dom.js';
import { errorMessage } from '../ui/format.js';
import { inlineText, tableCsv } from './table-text.js';
/** @import { Align, TableBlock } from './markdown.js' */

const REPORT_MS = 1500;
/** Widest a column of the image grows before its text wraps, in CSS px. */
const MAX_COLUMN = 420;

/**
 * The Copy button and its menu (to be placed right after it), for `table` rendered from `block`.
 * @param {TableBlock} block @param {HTMLTableElement} table @returns {[HTMLButtonElement, HTMLElement]}
 */
export function tableCopy(block, table) {
  const copy = button('md-table-copy', 'Copy');
  const menu = el('div', 'omp-menu md-table-copy-menu');
  menu.popover = 'auto';
  copy.popoverTargetElement = menu;
  const report = copyReport(copy);
  /** @type {[string, () => Promise<void>][]} */
  const formats = [
    ['Markdown', async () => navigator.clipboard.writeText(block.source)],
    ['CSV', async () => navigator.clipboard.writeText(tableCsv(block))],
    // Handing over the promise keeps the click's user activation while the image is drawn and encoded.
    ['PNG image', async () => navigator.clipboard.write([new ClipboardItem({ 'image/png': tablePng(block, table) })])],
  ];
  menu.append(
    ...formats.map(([label, write]) =>
      button('omp-menu-item', label, () => {
        menu.hidePopover();
        write().then(
          () => report('Copied'),
          (err) => report('Copy failed', errorMessage(err)),
        );
      }),
    ),
  );
  return [copy, menu];
}

/**
 * Reports a copy on `copy`'s label for a moment: `Copied`, or `Copy failed` with why as its
 * tooltip, before it reads `rest` (`Copy`) again.
 * @param {HTMLButtonElement} copy @param {string} [rest] @returns {(label: string, title?: string) => void}
 */
export function copyReport(copy, rest = 'Copy') {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let reset;
  return (label, title = '') => {
    copy.textContent = label;
    copy.title = title;
    clearTimeout(reset);
    reset = setTimeout(() => {
      copy.textContent = rest;
      copy.title = '';
    }, REPORT_MS);
  };
}

/** @typedef {{ font: string, color: string, background: string }} CellLook */
/**
 * @typedef {{
 *   head: CellLook, body: CellLook, even: CellLook, lineHeight: number,
 *   padX: number, padY: number, border: number, borderColor: string, backdrop: string | null
 * }} TableLook
 */

/** @param {Element} cell @returns {CellLook} */
function cellLook(cell) {
  const s = getComputedStyle(cell);
  return { font: `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`, color: s.color, background: s.backgroundColor };
}

/**
 * How the rendered table looks: its header, body and even-row cells, spacing, borders and backdrop.
 * @param {HTMLTableElement} table @returns {TableLook}
 */
function tableLook(table) {
  const th = /** @type {Element} */ (table.querySelector('th'));
  const td = table.querySelector('tbody td') ?? th;
  const s = getComputedStyle(th);
  const lineHeight = parseFloat(s.lineHeight);
  return {
    head: cellLook(th),
    body: cellLook(td),
    even: cellLook(table.querySelector('tbody tr:nth-child(even) td') ?? td),
    lineHeight: Number.isNaN(lineHeight) ? parseFloat(s.fontSize) * 1.2 : lineHeight, // 'normal'
    padX: parseFloat(s.paddingLeft),
    padY: parseFloat(s.paddingTop),
    border: parseFloat(s.borderTopWidth),
    borderColor: s.borderTopColor,
    backdrop: backdrop(table),
  };
}

/**
 * The background the table sits on: that of its first ancestor that paints one, if any.
 * Computed colours may be `oklch(…)` or `color(srgb …)`, so a 1×1 canvas tells whether one is transparent.
 * @param {Element} table @returns {string | null}
 */
function backdrop(table) {
  const probe = /** @type {OffscreenCanvasRenderingContext2D} */ (new OffscreenCanvas(1, 1).getContext('2d'));
  for (let node = table.parentElement; node; node = node.parentElement) {
    const color = getComputedStyle(node).backgroundColor;
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = color;
    probe.fillRect(0, 0, 1, 1);
    if (probe.getImageData(0, 0, 1, 1).data[3] > 0) return color;
  }
  return null;
}

/** Width of the widest line of `text` in `font`. @param {CanvasRenderingContext2D} ctx @param {string} font @param {string} text */
function textWidth(ctx, font, text) {
  ctx.font = font;
  return Math.max(...text.split('\n').map((line) => ctx.measureText(line).width));
}

/**
 * `text` broken into lines no wider than `width`: at its line breaks, at spaces, and inside a word wider than `width`.
 * @param {CanvasRenderingContext2D} ctx @param {string} text @param {number} width @returns {string[]}
 */
function wrap(ctx, text, width) {
  /** @param {string} s */
  const fits = (s) => ctx.measureText(s).width <= width;
  return text.split('\n').flatMap((paragraph) => {
    /** @type {string[]} */
    const lines = [];
    let line = '';
    for (const word of paragraph.split(' ')) {
      const joined = line ? `${line} ${word}` : word;
      if (fits(joined)) {
        line = joined;
        continue;
      }
      if (line) lines.push(line);
      let chars = [...word];
      while (!fits(chars.join(''))) {
        let n = 1;
        while (n < chars.length - 1 && fits(chars.slice(0, n + 1).join(''))) n++;
        lines.push(chars.slice(0, n).join(''));
        chars = chars.slice(n);
      }
      line = chars.join('');
    }
    lines.push(line);
    return lines;
  });
}

/**
 * Where the border lines go around and between cells of `sizes`, each line `border` thick.
 * @param {number[]} sizes @param {number} border @returns {number[]}
 */
function gridLines(sizes, border) {
  const at = [0];
  for (const size of sizes) at.push(at[at.length - 1] + border + size);
  return at;
}

/**
 * The table drawn on a canvas from `block`'s cells, in the look of its rendering `table`, as a PNG.
 * @param {TableBlock} block @param {HTMLTableElement} table @returns {Promise<Blob>}
 */
async function tablePng(block, table) {
  const look = tableLook(table);
  const canvas = el('canvas');
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  const cells = [block.head, ...block.rows].map((row) => row.map(inlineText));
  /** @param {number} r */
  const lookOf = (r) => (r === 0 ? look.head : r % 2 === 0 ? look.even : look.body); // body rows 2, 4, … are the even ones
  const widths = block.align.map((_, c) =>
    Math.min(MAX_COLUMN, Math.ceil(Math.max(...cells.map((row, r) => textWidth(ctx, lookOf(r).font, row[c]))))),
  );
  const lines = cells.map((row, r) => {
    ctx.font = lookOf(r).font;
    return row.map((text, c) => wrap(ctx, text, widths[c]));
  });
  const { border, padX, padY, lineHeight } = look;
  const heights = lines.map((row) => Math.max(...row.map((cell) => cell.length)) * lineHeight + 2 * padY);
  const xs = gridLines(widths.map((w) => w + 2 * padX), border);
  const ys = gridLines(heights, border);
  const width = xs[xs.length - 1] + border;
  const height = ys[ys.length - 1] + border;
  const scale = Math.max(2, devicePixelRatio);
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  ctx.scale(scale, scale);
  if (look.backdrop) {
    ctx.fillStyle = look.backdrop;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.textBaseline = 'middle';
  lines.forEach((row, r) => {
    const { font, color, background } = lookOf(r);
    const y = ys[r] + border;
    ctx.fillStyle = background;
    ctx.fillRect(0, y, width, heights[r]);
    ctx.font = font;
    ctx.fillStyle = color;
    row.forEach((cell, c) => drawCell(ctx, cell, block.align[c], xs[c] + border + padX, y + padY, widths[c], lineHeight));
  });
  ctx.fillStyle = look.borderColor;
  for (const x of xs) ctx.fillRect(x, 0, border, height);
  for (const y of ys) ctx.fillRect(0, y, width, border);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('the table image could not be encoded'))), 'image/png'),
  );
}

/**
 * The lines of one cell, aligned within its content box at (`x`, `y`) of `width`.
 * @param {CanvasRenderingContext2D} ctx @param {string[]} lines @param {Align} align
 * @param {number} x @param {number} y @param {number} width @param {number} lineHeight
 */
function drawCell(ctx, lines, align, x, y, width, lineHeight) {
  ctx.textAlign = align ?? 'left';
  const at = align === 'center' ? x + width / 2 : align === 'right' ? x + width : x;
  lines.forEach((line, i) => ctx.fillText(line, at, y + (i + 0.5) * lineHeight));
}
