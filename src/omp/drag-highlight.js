/**
 * The omp transcript's selection highlight, drawn as in Google Docs: while the pointer drags,
 * it already covers whole words (ui/word-snap.js) and its edges glide from word to word. The
 * real selection is the browser's own and is left alone until the pointer lets go, when the
 * selection popup snaps it to the same words; so copying, Comment and Ask are unchanged.
 *
 * The browser's highlight is made transparent in the transcript and one box per line is drawn
 * in a layer over it instead: the layer is not inside the transcript, whose children are its
 * items, so it follows the transcript's scroll by moving its content. Boxes are reused from
 * one draw to the next, which is what lets CSS animate them.
 *
 * Off (the app's "Animated selection" setting), the browser draws the selection as usual.
 */
import { el } from '../ui/dom.js';
import { snappedRange } from '../ui/word-snap.js';

/** @typedef {{ left: number, top: number, right: number, bottom: number }} Box */

/**
 * Text boxes merged into one box per line: a line's boxes (a word in bold, a bit of code)
 * overlap vertically by more than half the shorter one's height. Empty boxes are dropped.
 * @param {Iterable<Box>} boxes @returns {Box[]} top to bottom
 */
function lineBoxes(boxes) {
  /** @type {Box[]} */
  const lines = [];
  for (const box of boxes) {
    if (box.right - box.left < 0.5 || box.bottom - box.top < 0.5) continue;
    const height = box.bottom - box.top;
    const line = lines.find((l) => Math.min(l.bottom, box.bottom) - Math.max(l.top, box.top) > Math.min(l.bottom - l.top, height) / 2);
    if (!line) {
      lines.push({ left: box.left, top: box.top, right: box.right, bottom: box.bottom });
      continue;
    }
    line.left = Math.min(line.left, box.left);
    line.right = Math.max(line.right, box.right);
    line.top = Math.min(line.top, box.top);
    line.bottom = Math.max(line.bottom, box.bottom);
  }
  return lines.sort((a, b) => a.top - b.top);
}

/**
 * The boxes of the text `range` covers inside `within`, leaving out what cannot be selected
 * (a table's Copy button): the range's own boxes would include whole blocks it spans.
 * @param {Range} range @param {Node} within @returns {DOMRect[]}
 */
function textBoxes(range, within) {
  // A range inside one text node has it as common ancestor; walk from its parent, since a
  // walker finds nothing under a text node.
  const common = range.commonAncestorContainer instanceof Text ? range.commonAncestorContainer.parentNode : range.commonAncestorContainer;
  const root = common && within.contains(common) ? common : common?.contains(within) ? within : null;
  if (!root) return [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const part = document.createRange();
  /** @type {DOMRect[]} */
  const boxes = [];
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!range.intersectsNode(node)) {
      if (started) break;
      continue;
    }
    started = true;
    const parent = node.parentElement;
    if (!parent || getComputedStyle(parent).userSelect === 'none') continue;
    part.selectNodeContents(node);
    if (node === range.startContainer) part.setStart(node, range.startOffset);
    if (node === range.endContainer) part.setEnd(node, range.endOffset);
    boxes.push(...part.getClientRects());
  }
  return boxes;
}

/**
 * Draws `transcript`'s selection in a layer added to `host` (the transcript's positioned
 * parent) while `enabled()`; call `refresh` when that changes.
 * @param {{ host: HTMLElement, transcript: HTMLElement, enabled: () => boolean }} options
 */
export function attachDragHighlight({ host, transcript, enabled }) {
  const layer = el('div', 'omp-highlight');
  layer.setAttribute('aria-hidden', 'true');
  const content = el('div', 'omp-highlight-content');
  layer.append(content);
  host.append(layer);
  /** @type {HTMLElement[]} */
  const marks = [];
  let pressed = false;

  function draw() {
    const on = enabled();
    transcript.classList.toggle('has-highlight', on);
    const sel = document.getSelection();
    const range = on && sel && sel.rangeCount && !sel.isCollapsed ? sel.getRangeAt(0) : null;
    // While dragging, words are already whole; afterwards the selection is what it shows.
    const lines = range ? lineBoxes(textBoxes(pressed ? snappedRange(range) : range, transcript)) : [];
    layer.hidden = lines.length === 0;
    if (!lines.length) return;
    // Over the transcript's visible box; the boxes in its content's coordinates.
    layer.style.inset = `${transcript.offsetTop}px auto auto ${transcript.offsetLeft}px`;
    layer.style.width = `${transcript.clientWidth}px`;
    layer.style.height = `${transcript.clientHeight}px`;
    follow();
    const origin = transcript.getBoundingClientRect();
    const dx = transcript.scrollLeft - origin.left - transcript.clientLeft;
    const dy = transcript.scrollTop - origin.top - transcript.clientTop;
    lines.forEach((line, i) => {
      const mark = marks[i] ?? content.appendChild(el('div', 'omp-highlight-line'));
      marks[i] = mark;
      mark.hidden = false;
      mark.style.transform = `translate(${line.left + dx}px, ${line.top + dy}px)`;
      mark.style.width = `${line.right - line.left}px`;
      mark.style.height = `${line.bottom - line.top}px`;
    });
    for (const mark of marks.slice(lines.length)) mark.hidden = true;
  }
  const follow = () => (content.style.transform = `translate(${-transcript.scrollLeft}px, ${-transcript.scrollTop}px)`);

  /** @param {PointerEvent} e */
  const onDown = (e) => {
    if (e.button === 0 && transcript.contains(/** @type {Node} */ (e.target))) pressed = true;
  };
  const onUp = () => {
    if (!pressed) return;
    pressed = false;
    draw();
  };
  const resizes = new ResizeObserver(draw);
  resizes.observe(transcript);
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', onUp);
  document.addEventListener('selectionchange', draw);
  transcript.addEventListener('scroll', follow);

  return {
    refresh: draw,
    destroy() {
      resizes.disconnect();
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      document.removeEventListener('selectionchange', draw);
      transcript.removeEventListener('scroll', follow);
      layer.remove();
    },
  };
}
