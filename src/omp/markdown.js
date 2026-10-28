/**
 * Safe markdown subset for agent text: parses into a small block/inline tree, never HTML.
 *
 * Supported: paragraphs (newlines kept as line breaks), ATX headings, fenced code with a
 * language, inline code, bold/italic, bullet and numbered lists, block quotes, horizontal
 * rules, links and autolinks, images on this machine (`![alt](/abs/or/~/path.png)`), and GFM tables (column alignment, inline formatting in cells;
 * a table may start right under a paragraph line), and TeX math: `$$…$$` and `\[…\]` on their
 * own as display math, `$…$` and `\(…\)` inline (markdown-dom.js renders it). Raw HTML is
 * plain text. Only
 * http, https and mailto targets become links; anything else stays text. An unterminated
 * fence (text still streaming) runs to the end of the input.
 */

/**
 * @typedef {(
 *   | { type: 'text', text: string }
 *   | { type: 'code', text: string }
 *   | { type: 'strong', children: Inline[] }
 *   | { type: 'em', children: Inline[] }
 *   | { type: 'link', href: string, children: Inline[] }
 *   | { type: 'image', path: string, alt: string }
 *   | { type: 'break' }
 *   | { type: 'math', tex: string, display: boolean }
 * )} Inline
 */

/**
 * @typedef {(
 *   | { type: 'paragraph', children: Inline[] }
 *   | { type: 'heading', level: number, children: Inline[] }
 *   | { type: 'code', lang: string, text: string }
 *   | { type: 'list', ordered: boolean, start: number, items: Block[][] }
 *   | { type: 'quote', children: Block[] }
 *   | { type: 'table', align: Align[], head: Inline[][], rows: Inline[][][], source: string }
 *   | { type: 'rule' }
 * )} Block
 */

/** @typedef {Extract<Block, { type: 'table' }>} TableBlock */

/** @typedef {'left' | 'center' | 'right' | null} Align */

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);
/** An image file named by an absolute or `~/` path (the daemon serves these: `/api/image`). */
export const LOCAL_IMAGE = /^~?\/[^\s]*\.(png|jpe?g|gif|webp|avif)$/i;

/**
 * Returns the href if it is an absolute http(s) or mailto URL, else null.
 * @param {string} raw @returns {string | null}
 */
export function safeHref(raw) {
  const href = raw.trim();
  // Control characters and whitespace inside a URL are never legitimate here.
  if (!href || /[\u0000-\u0020\u007f]/.test(href)) return null;
  const url = URL.parse(href);
  return url && SAFE_SCHEMES.has(url.protocol) ? href : null;
}

/** @param {string} source @returns {Block[]} */
export function parseMarkdown(source) {
  return parseBlocks(source.replace(/\r\n?/g, '\n').split('\n'));
}

/** @param {string} line */
const isBlank = (line) => line.trim() === '';

/**
 * True when `line` would open a block other than a paragraph (so it ends a paragraph).
 * @param {string} line
 */
function startsBlock(line) {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST_ITEM.test(line);
}

/**
 * The cells of a table row: split on unescaped pipes, outer pipes optional, `\|` a literal pipe.
 * @param {string} line @returns {string[]}
 */
function splitRow(line) {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

/**
 * The column alignments if `lines[i]` is a table header with a matching divider under it.
 * @param {string[]} lines @param {number} i @returns {Align[] | null}
 */
function tableAt(lines, i) {
  const divider = lines[i + 1];
  if (!lines[i].includes('|') || divider === undefined || !TABLE_DIVIDER.test(divider) || !divider.includes('-')) return null;
  const cells = splitRow(divider);
  if (cells.length !== splitRow(lines[i]).length) return null;
  return cells.map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
  });
}

/** @param {string[]} lines @returns {Block[]} */
function parseBlocks(lines) {
  /** @type {Block[]} */
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const indent = line.length - line.trimStart().length;
      /** @type {string[]} */
      const body = [];
      i++;
      while (i < lines.length) {
        const close = lines[i].trim();
        if (close[0] === marker[0] && close.length >= marker.length && /^(`+|~+)$/.test(close)) {
          i++;
          break;
        }
        body.push(stripIndent(lines[i], indent));
        i++;
      }
      blocks.push({ type: 'code', lang: fence[2] ?? '', text: body.join('\n') });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, children: parseInline(heading[2] ?? '') });
      i++;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ type: 'rule' });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      /** @type {string[]} */
      const inner = [];
      while (i < lines.length && !isBlank(lines[i])) {
        const quoted = QUOTE.exec(lines[i]);
        // Lazy continuation: an unmarked line right after quoted text continues it.
        inner.push(quoted ? quoted[1] : lines[i]);
        i++;
      }
      blocks.push({ type: 'quote', children: parseBlocks(inner) });
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      const parsed = parseList(lines, i);
      blocks.push(parsed.block);
      i = parsed.next;
      continue;
    }

    const align = tableAt(lines, i);
    if (align) {
      /** @param {string} row */
      const cells = (row) => {
        const raw = splitRow(row);
        // Every row has the header's columns: missing cells are empty, extra ones dropped.
        return align.map((_, c) => parseInline(raw[c] ?? ''));
      };
      const start = i;
      const head = cells(lines[i]);
      i += 2;
      /** @type {Inline[][][]} */
      const rows = [];
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|')) rows.push(cells(lines[i++]));
      // The table's own lines as written, for copying it back out as Markdown.
      blocks.push({ type: 'table', align, head, rows, source: lines.slice(start, i).join('\n') });
      continue;
    }

    /** @type {string[]} */
    const para = [line];
    i++;
    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines[i]) && !tableAt(lines, i)) para.push(lines[i++]);
    blocks.push({ type: 'paragraph', children: parseInline(para.map((l) => l.trim()).join('\n')) });
  }
  return blocks;
}

/** @param {string} line @param {number} count */
function stripIndent(line, count) {
  let n = 0;
  while (n < count && line[n] === ' ') n++;
  return line.slice(n);
}

/**
 * @param {string[]} lines @param {number} start
 * @returns {{ block: Block, next: number }}
 */
function parseList(lines, start) {
  const first = /** @type {RegExpExecArray} */ (LIST_ITEM.exec(lines[start]));
  const ordered = /\d/.test(first[2]);
  const delimiter = ordered ? first[2].slice(-1) : first[2];
  /** @type {string[][]} */
  const items = [];
  let i = start;
  while (i < lines.length) {
    const match = LIST_ITEM.exec(lines[i]);
    if (!match) break;
    const isOrdered = /\d/.test(match[2]);
    if (isOrdered !== ordered || (isOrdered ? match[2].slice(-1) : match[2]) !== delimiter) break;
    const contentIndent = match[1].length + match[2].length + 1;
    /** @type {string[]} */
    const body = [match[3] ?? ''];
    i++;
    while (i < lines.length) {
      const next = lines[i];
      if (isBlank(next)) {
        // A blank line continues the item only if indented content follows it.
        let j = i;
        while (j < lines.length && isBlank(lines[j])) j++;
        if (j < lines.length && indentOf(lines[j]) >= contentIndent) {
          for (; i < j; i++) body.push('');
          continue;
        }
        break;
      }
      if (indentOf(next) >= contentIndent) {
        body.push(stripIndent(next, contentIndent));
      } else if (LIST_ITEM.test(next) || startsBlock(next)) {
        break;
      } else {
        body.push(next.trim()); // lazy paragraph continuation
      }
      i++;
    }
    items.push(body);
    // Blank lines between items keep the list going.
    let j = i;
    while (j < lines.length && isBlank(lines[j])) j++;
    if (j > i && j < lines.length && LIST_ITEM.test(lines[j])) i = j;
  }
  const startNumber = ordered ? Number.parseInt(first[2], 10) : 1;
  return { block: { type: 'list', ordered, start: startNumber, items: items.map(parseBlocks) }, next: i };
}

/** @param {string} line */
function indentOf(line) {
  return line.length - line.trimStart().length;
}

const PUNCTUATION = /[!-/:-@[-`{-~]/;
const WORD = /[\p{L}\p{N}]/u;
const BARE_URL = /^(https?:\/\/[^\s<]+[^\s<.,;:!?'")\]}])/;

/**
 * @param {string} text @returns {Inline[]}
 */
export function parseInline(text) {
  /** @type {Inline[]} */
  const out = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ type: 'text', text: buf });
    buf = '';
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    const math = parseMath(text, i);
    if (math) {
      flush();
      out.push(math.node);
      i = math.next;
      continue;
    }

    if (ch === '\\' && i + 1 < text.length && PUNCTUATION.test(text[i + 1])) {
      buf += text[i + 1];
      i += 2;
      continue;
    }

    if (ch === '\n') {
      flush();
      out.push({ type: 'break' });
      i++;
      continue;
    }

    if (ch === '`') {
      let run = 1;
      while (text[i + run] === '`') run++;
      const fence = '`'.repeat(run);
      let close = text.indexOf(fence, i + run);
      while (close !== -1 && text[close + run] === '`') close = text.indexOf(fence, close + run + 1);
      if (close === -1) {
        buf += fence;
        i += run;
        continue;
      }
      let code = text.slice(i + run, close).replace(/\n/g, ' ');
      if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ')) code = code.slice(1, -1);
      flush();
      out.push({ type: 'code', text: code });
      i = close + run;
      continue;
    }

    if (ch === '*' || ch === '_') {
      const span = parseEmphasis(text, i);
      if (span) {
        flush();
        out.push(span.node);
        i = span.next;
        continue;
      }
      // An unmatched run of delimiters is literal text.
      let run = 1;
      while (text[i + run] === ch) run++;
      buf += text.slice(i, i + run);
      i += run;
      continue;
    }

    if (ch === '!' && text[i + 1] === '[') {
      const image = parseImage(text, i);
      if (image) {
        flush();
        out.push(image.node);
        i = image.next;
        continue;
      }
    }

    if (ch === '[') {
      const link = parseLink(text, i);
      if (link) {
        flush();
        out.push(...link.nodes);
        i = link.next;
        continue;
      }
    }

    if (ch === '<') {
      const close = text.indexOf('>', i + 1);
      const href = close === -1 ? null : safeHref(text.slice(i + 1, close));
      if (href) {
        flush();
        out.push({ type: 'link', href, children: [{ type: 'text', text: href.replace(/^mailto:/i, '') }] });
        i = close + 1;
        continue;
      }
    }

    if ((ch === 'h' || ch === 'H') && (i === 0 || !WORD.test(text[i - 1]))) {
      const bare = BARE_URL.exec(text.slice(i));
      const href = bare && safeHref(bare[1]);
      if (bare && href) {
        flush();
        out.push({ type: 'link', href, children: [{ type: 'text', text: href }] });
        i += bare[1].length;
        continue;
      }
    }

    buf += ch;
    i++;
  }
  flush();
  return out;
}

/** Math delimiters: what opens, what closes, and whether it is display math. */
const MATH = /** @type {const} */ ([
  ['$$', '$$', true],
  ['\\[', '\\]', true],
  ['\\(', '\\)', false],
  ['$', '$', false],
]);

/**
 * TeX math starting at `start`, or null. Display math may span lines; inline math may not.
 * A single `$` only counts as Pandoc has it, so prices stay text ("$5 and $10"): the opening
 * `$` has no space after it, and the next `$` closes it only with no space before it and no
 * digit after it (else neither is math).
 * Without its closing delimiter, a `\[` or `\(` is the Markdown escape it also is.
 * @param {string} text @param {number} start
 * @returns {{ node: Inline, next: number } | null}
 */
function parseMath(text, start) {
  for (const [open, close, display] of MATH) {
    if (!text.startsWith(open, start)) continue;
    const from = start + open.length;
    if (open === '$' && (from >= text.length || /\s/.test(text[from]))) return null;
    for (let end = text.indexOf(close, from); end !== -1; end = text.indexOf(close, end + 1)) {
      const tex = text.slice(from, end);
      if (!display && tex.includes('\n')) break;
      if (open === '$' && (/\s$/.test(tex) || /\d/.test(text[end + 1] ?? ''))) break;
      if (!tex.trim()) break;
      return { node: { type: 'math', tex: tex.trim(), display }, next: end + close.length };
    }
    return null;
  }
  return null;
}

/**
 * `**strong**`, `__strong__`, `*em*`, `_em_` starting at `start`. Underscores only count
 * at word boundaries, so snake_case identifiers stay intact.
 * @param {string} text @param {number} start
 * @returns {{ node: Inline, next: number } | null}
 */
function parseEmphasis(text, start) {
  const ch = text[start];
  const double = text[start + 1] === ch;
  const delim = double ? ch + ch : ch;
  const open = start + delim.length;
  if (open >= text.length || /\s/.test(text[open])) return null;
  if (ch === '_' && start > 0 && WORD.test(text[start - 1])) return null;
  let search = open;
  while (search < text.length) {
    const close = text.indexOf(delim, search);
    if (close === -1) return null;
    const after = text[close + delim.length];
    const valid =
      close > open &&
      !/\s/.test(text[close - 1]) &&
      // A single delimiter must not be half of a double one.
      (double || (after !== ch && text[close - 1] !== ch)) &&
      (ch !== '_' || after === undefined || !WORD.test(after));
    if (valid) {
      const children = parseInline(text.slice(open, close));
      return { node: double ? { type: 'strong', children } : { type: 'em', children }, next: close + delim.length };
    }
    search = close + 1;
  }
  return null;
}

/**
 * `![alt](path)` for an image file on this machine (an absolute or `~/` path); null for any
 * other target, which is then read as a link: a remote image is never fetched, since the URL
 * an agent picks could carry what it read.
 * @param {string} text @param {number} start at the `!`
 * @returns {{ node: Inline, next: number } | null}
 */
function parseImage(text, start) {
  const parts = linkParts(text, start + 1);
  if (!parts || !LOCAL_IMAGE.test(parts.target)) return null;
  return { node: { type: 'image', path: parts.target, alt: parts.label }, next: parts.next };
}

/**
 * `[label](target)`. Unsafe targets keep their label as plain text.
 * @param {string} text @param {number} start
 * @returns {{ nodes: Inline[], next: number } | null}
 */
function parseLink(text, start) {
  const parts = linkParts(text, start);
  if (!parts) return null;
  const children = parseInline(parts.label);
  const href = safeHref(parts.target);
  return { nodes: href ? [{ type: 'link', href, children }] : children, next: parts.next };
}

/**
 * The label and target of `[label](target)` at `start`, and where it ends.
 * @param {string} text @param {number} start
 * @returns {{ label: string, target: string, next: number } | null}
 */
function linkParts(text, start) {
  let depth = 0;
  let end = -1;
  for (let j = start; j < text.length; j++) {
    if (text[j] === '\\') {
      j++;
      continue;
    }
    if (text[j] === '[') depth++;
    else if (text[j] === ']' && --depth === 0) {
      end = j;
      break;
    }
  }
  if (end === -1 || text[end + 1] !== '(') return null;
  // The target may hold balanced parentheses, e.g. a Wikipedia URL.
  let close = -1;
  for (let j = end + 2, parens = 0; j < text.length; j++) {
    if (text[j] === '(') parens++;
    else if (text[j] === ')' && parens-- === 0) {
      close = j;
      break;
    }
  }
  if (close === -1) return null;
  const target = (text.slice(end + 2, close).trim().split(/\s+/)[0] ?? '').replace(/^<|>$/g, '');
  return { label: text.slice(start + 1, end), target, next: close + 1 };
}
