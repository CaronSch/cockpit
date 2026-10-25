/**
 * Grows a selection out to whole words once it spans more than one, as Google Docs does, so a
 * rough drag still quotes clean text, while a selection inside one word stays exactly as made.
 *
 * The rule, on a line's text (bold, code and links within a line are one text; a word never
 * runs from one block into another):
 * - A word is everything between spaces, punctuation included (`dog.`, `(see`, `foo.bar()`),
 *   except in a long token (over LONG characters: a path, a URL, a hash) where it also ends
 *   after a run of `/ . : = ( )`, so `src/omp/drag-highlight.js` snaps by segment. Sentence
 *   punctuation closing a token stays with the word before it.
 * - A selection inside one word does not snap. Once it spans two, its start moves back to the
 *   start of the word it is in and its end on to the end of the word it is in; neither ever
 *   reaches a neighbouring word.
 *
 * The boundaries (`isBoundary`, `wordStart`, `wordEnd`, `snapSpan`) are plain text in, offsets
 * out, so they can be tested without a DOM. `snappedRange` applies them to a range, and
 * `snapToWords` sets a selection to that, keeping which end the user dragged from. The
 * animated highlight (omp/drag-highlight.js) draws `snappedRange` while the pointer drags, and
 * the selection popup snaps the real selection the same way on release, so what is
 * highlighted is what gets quoted.
 */

const SPACE = /\s/;
/** Where a long token's segments end: after a run of these. */
const SEPARATOR = /[/.:=()]/;
/** Sentence punctuation that may close a token; it belongs to the word before it. */
const CLOSING = /^[.,;:!?)]*$/;
/** Tokens longer than this snap by segment rather than whole. */
const LONG = 24;

/** The token (run of non-space characters) around `at` in `text`. @param {string} text @param {number} at */
function token(text, at) {
  let start = at;
  while (start > 0 && !SPACE.test(text[start - 1])) start--;
  let end = at;
  while (end < text.length && !SPACE.test(text[end])) end++;
  return { start, end };
}

/** Whether a word starts or ends at `at` in `text`. @param {string} text @param {number} at */
export function isBoundary(text, at) {
  if (at <= 0 || at >= text.length || SPACE.test(text[at - 1]) || SPACE.test(text[at])) return true;
  const { start, end } = token(text, at);
  if (end - start <= LONG) return false;
  return SEPARATOR.test(text[at - 1]) && !SEPARATOR.test(text[at]) && !CLOSING.test(text.slice(at, end));
}

/** The start of the word `offset` is in (`offset` itself on a boundary). @param {string} text @param {number} offset */
function wordStart(text, offset) {
  let at = offset;
  while (!isBoundary(text, at)) at--;
  return at;
}

/** The end of the word `offset` is in (`offset` itself on a boundary). @param {string} text @param {number} offset */
function wordEnd(text, offset) {
  let at = offset;
  while (!isBoundary(text, at)) at++;
  return at;
}

/** Whether `from`…`to` of `text` lies inside one word. @param {string} text @param {number} from @param {number} to */
const withinWord = (text, from, to) => {
  for (let at = from + 1; at < to; at++) if (isBoundary(text, at)) return false;
  return !SPACE.test(text.slice(from, to));
};

/**
 * `from`…`to` of `text` snapped: as it is inside one word, else out to whole words.
 * @param {string} text @param {number} from @param {number} to @returns {[number, number]}
 */
export function snapSpan(text, from, to) {
  return withinWord(text, from, to) ? [from, to] : [wordStart(text, from), wordEnd(text, to)];
}

/** Where a line of text breaks: a word never runs from one of these into another. */
const BLOCK = 'p, li, td, th, pre, h1, h2, h3, h4, h5, h6, blockquote, div';

/**
 * The text of the line `node` is in, and where each of its text nodes starts in it: the text
 * nodes of its block, bold, code and links included, a nested block's text or a <br> a break
 * between them.
 * @param {Text} node @returns {{ text: string, nodes: Text[], starts: number[] }}
 */
function lineOf(node) {
  const block = node.parentElement?.closest(BLOCK);
  if (!block) return { text: node.data, nodes: [node], starts: [0] };
  let text = '';
  /** @type {Text[]} */
  const nodes = [];
  /** @type {number[]} */
  const starts = [];
  // Elements too, for line breaks: a paragraph's newlines are <br>s, which end a word as a
  // space does (else `<attachment>` and the first word of the next line read as one).
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let next = walker.nextNode(); next; next = walker.nextNode()) {
    if (next.nodeName === 'BR') {
      text += '\n';
      continue;
    }
    if (!(next instanceof Text)) continue;
    if (next.parentElement?.closest(BLOCK) !== block) {
      if (!text.endsWith('\n')) text += '\n';
      continue;
    }
    nodes.push(/** @type {Text} */ (next));
    starts.push(text.length);
    text += /** @type {Text} */ (next).data;
  }
  return { text, nodes, starts };
}

/**
 * The point at `index` of a line's text: in the node that holds it (at a node's edge, the
 * earlier node for an end, the later one for a start).
 * @param {{ nodes: Text[], starts: number[] }} line @param {number} index @param {boolean} isEnd
 * @returns {[Text, number]}
 */
function pointAt({ nodes, starts }, index, isEnd) {
  let i = nodes.length - 1;
  while (i > 0 && (isEnd ? starts[i] >= index : starts[i] > index)) i--;
  return [nodes[i], Math.min(index - starts[i], nodes[i].data.length)];
}

/** `range` snapped as `snapSpan` does, as a new range; `range` itself is left alone. @param {Range} range */
export function snappedRange(range) {
  const snapped = range.cloneRange();
  const { startContainer, startOffset, endContainer, endOffset } = range;
  const start = startContainer instanceof Text ? lineOf(startContainer) : null;
  const end = endContainer instanceof Text ? (start?.nodes.includes(endContainer) ? start : lineOf(endContainer)) : null;
  const from = start ? start.starts[start.nodes.indexOf(/** @type {Text} */ (startContainer))] + startOffset : null;
  const to = end ? end.starts[end.nodes.indexOf(/** @type {Text} */ (endContainer))] + endOffset : null;
  if (start && start === end && from !== null && to !== null) {
    const [a, b] = snapSpan(start.text, from, to);
    snapped.setStart(...pointAt(start, a, false));
    snapped.setEnd(...pointAt(start, b, true));
    return snapped;
  }
  // Across lines the selection spans more than one word: each end goes to its word's edge.
  if (start && from !== null) snapped.setStart(...pointAt(start, wordStart(start.text, from), false));
  if (end && to !== null) snapped.setEnd(...pointAt(end, wordEnd(end.text, to), true));
  return snapped;
}

/** Snaps `sel` as `snappedRange` does; leaves it alone when nothing moves. @param {Selection} sel */
export function snapToWords(sel) {
  if (sel.rangeCount === 0 || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  const snapped = snappedRange(range);
  if (snapped.compareBoundaryPoints(Range.START_TO_START, range) === 0 && snapped.compareBoundaryPoints(Range.END_TO_END, range) === 0) return;
  const backward = sel.anchorNode !== range.startContainer || sel.anchorOffset !== range.startOffset;
  if (backward) sel.setBaseAndExtent(snapped.endContainer, snapped.endOffset, snapped.startContainer, snapped.startOffset);
  else sel.setBaseAndExtent(snapped.startContainer, snapped.startOffset, snapped.endContainer, snapped.endOffset);
}
