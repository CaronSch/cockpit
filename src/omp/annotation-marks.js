/**
 * Highlights on the parts of agent replies the user commented on or asked about
 * (daemon/annotations.js), as in Google Docs: drawn with the CSS Custom Highlight API, so the
 * transcript's DOM is never touched, comments in the accent and questions in the code colour,
 * and a plain click on one opens it again (selection-popup.js `open`).
 *
 * An annotation names its reply by the message's `at` (items-view.js tags each rendered piece of
 * an assistant message with it, `data-at`) and its part by the quoted text and which occurrence
 * of it in the reply's text it is. Text is matched without its whitespace, which differs between
 * a selection's text (a line break between blocks) and the DOM's (nothing between them); a quote
 * no longer found (a rewound conversation, a view that hides it) is simply not drawn.
 */
/** @import { Annotation } from '../../daemon/annotations.js' */

/**
 * Where an annotation sits: its assistant message's `at`, and which occurrence of its quote in
 * that message's text it is.
 * @typedef {{ at: number, occurrence: number }} Anchor
 */

/** The highlight each kind is drawn with (styles/omp.css `::highlight`). */
const NAMES = /** @type {const} */ ({ comment: 'omp-annotation-comment', ask: 'omp-annotation-ask' });
const SPACE = /\s/;

/**
 * `texts` (a reply's text nodes, in order) without whitespace, and where each character of that
 * came from: `from[i]` is `[text index, offset]` of its `i`th character.
 * @param {readonly string[]} texts @returns {{ chars: string, from: Array<[number, number]> }}
 */
export function squeeze(texts) {
  let chars = '';
  /** @type {Array<[number, number]>} */
  const from = [];
  texts.forEach((text, t) => {
    for (let o = 0; o < text.length; o++) {
      if (SPACE.test(text[o])) continue;
      chars += text[o];
      from.push([t, o]);
    }
  });
  return { chars, from };
}

/** Where each match of `quote` (squeezed already) starts in `chars`, overlapping ones too. @param {string} chars @param {string} quote */
export function matches(chars, quote) {
  /** @type {number[]} */
  const starts = [];
  if (!quote) return starts;
  for (let i = chars.indexOf(quote); i !== -1; i = chars.indexOf(quote, i + 1)) starts.push(i);
  return starts;
}

/** `text` without whitespace. @param {string} text */
export const squeezed = (text) => text.replace(/\s+/g, '');

/**
 * The `occurrence`th match of `quote` in `texts`: from `[text index, offset]` to the same just
 * after its last character; null if there is no such match.
 * @param {readonly string[]} texts @param {string} quote @param {number} occurrence
 * @returns {{ start: [number, number], end: [number, number] } | null}
 */
export function findQuote(texts, quote, occurrence) {
  const { chars, from } = squeeze(texts);
  const q = squeezed(quote);
  const start = matches(chars, q)[occurrence];
  if (start === undefined) return null;
  const [t, o] = from[start + q.length - 1];
  return { start: from[start], end: [t, o + 1] };
}

/** Every highlight range of every agent window, by window, so each window draws its own. @type {Map<object, Array<{ kind: Annotation['kind'], range: Range }>>} */
const windows = new Map();

/** Draws every window's ranges in their highlights. */
function paint() {
  if (!('highlights' in CSS)) return;
  for (const kind of /** @type {const} */ (['comment', 'ask'])) {
    const ranges = [...windows.values()].flatMap((marks) => marks.flatMap((m) => (m.kind === kind ? [m.range] : [])));
    CSS.highlights.set(NAMES[kind], new Highlight(...ranges));
  }
}

/** The text blocks of the assistant message `at` as `transcript` shows it. @param {HTMLElement} transcript @param {number} at */
const blocksOf = (transcript, at) => [...transcript.querySelectorAll(`[data-at="${CSS.escape(String(at))}"] > .omp-md`)];

/** The text nodes of `blocks`, in order, but for a Comment or Ask box open among them (selection-popup.js). @param {readonly Element[]} blocks */
function textNodes(blocks) {
  /** @type {Text[]} */
  const nodes = [];
  const filter = { acceptNode: (/** @type {Node} */ n) => (n.parentElement?.closest('.omp-quote-panel') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) };
  for (const block of blocks) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, filter);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(/** @type {Text} */ (n));
  }
  return nodes;
}

/**
 * Highlights `transcript`'s annotations, and opens one on a plain click on its text.
 * @param {{ transcript: HTMLElement, onOpen: (annotation: Annotation, range: Range) => void }} options
 */
export function attachAnnotationMarks({ transcript, onOpen }) {
  const key = {};
  /** What each annotation was last drawn on (its reply's text blocks) and its range there, by id. @type {Map<string, { anchor: string, blocks: Element[], range: Range | null }>} */
  const drawn = new Map();
  /** @type {Annotation[]} */
  let shown = [];

  /** @param {MouseEvent} e */
  const onClick = (e) => {
    if (e.button !== 0 || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented) return;
    if (!(document.getSelection()?.isCollapsed ?? true)) return; // a drag that selected text
    // The newest one under the pointer, where several overlap.
    for (const annotation of [...shown].reverse()) {
      const range = drawn.get(annotation.id)?.range;
      if (!range) continue;
      const hit = [...range.getClientRects()].some((r) => e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom);
      if (!hit) continue;
      e.preventDefault(); // the box opens instead of the click focusing the message box
      onOpen(annotation, range);
      return;
    }
  };
  transcript.addEventListener('click', onClick);

  return {
    /**
     * Where a selection of `quote` (`range`) is, if it lies in one assistant message's text;
     * null otherwise (it is not annotated then).
     * @param {Range} range @param {string} quote @returns {Anchor | null}
     */
    anchor(range, quote) {
      const holder = (/** @type {Node} */ node) => (node instanceof Element ? node : node.parentElement)?.closest('[data-at]');
      const start = holder(range.startContainer);
      const end = holder(range.endContainer);
      const at = Number(start?.getAttribute('data-at'));
      if (!start || !end || !transcript.contains(start) || start.getAttribute('data-at') !== end.getAttribute('data-at') || !Number.isFinite(at)) return null;
      const nodes = textNodes(blocksOf(transcript, at));
      // How many of the message's characters (whitespace aside) come before the selection.
      let before = 0;
      for (const node of nodes) {
        if (node === range.startContainer) {
          before += squeezed(node.data.slice(0, range.startOffset)).length;
          break;
        }
        if (range.comparePoint(node, node.length) >= 0) break;
        before += squeezed(node.data).length;
      }
      const occurrence = matches(squeeze(nodes.map((n) => n.data)).chars, squeezed(quote)).indexOf(before);
      return occurrence === -1 ? null : { at, occurrence };
    },
    /**
     * Highlights `annotations` where the transcript shows them; call after every redraw of the
     * transcript. A reply not redrawn since keeps its ranges.
     * @param {readonly Annotation[]} annotations
     */
    draw(annotations) {
      shown = [...annotations];
      const ids = new Set(shown.map((a) => a.id));
      for (const id of drawn.keys()) if (!ids.has(id)) drawn.delete(id);
      /** @type {Array<{ kind: Annotation['kind'], range: Range }>} */
      const marks = [];
      for (const a of shown) {
        const anchor = `${a.at}:${a.occurrence}:${a.quote}`;
        const blocks = blocksOf(transcript, a.at);
        let entry = drawn.get(a.id);
        const same =
          entry &&
          entry.anchor === anchor &&
          entry.blocks.length === blocks.length &&
          entry.blocks.every((b, i) => b === blocks[i]) &&
          (!entry.range || (entry.range.startContainer.isConnected && entry.range.endContainer.isConnected));
        if (!entry || !same) {
          const nodes = textNodes(blocks);
          const found = findQuote(
            nodes.map((n) => n.data),
            a.quote,
            a.occurrence,
          );
          /** @type {Range | null} */
          let range = null;
          if (found) {
            range = document.createRange();
            range.setStart(nodes[found.start[0]], found.start[1]);
            range.setEnd(nodes[found.end[0]], found.end[1]);
          }
          entry = { anchor, blocks, range };
          drawn.set(a.id, entry);
        }
        if (entry.range) marks.push({ kind: a.kind, range: entry.range });
      }
      const before = windows.get(key);
      const unchanged = before && before.length === marks.length && before.every((m, i) => m.kind === marks[i].kind && m.range === marks[i].range);
      if (unchanged) return;
      windows.set(key, marks);
      paint();
    },
    destroy() {
      transcript.removeEventListener('click', onClick);
      windows.delete(key);
      paint();
    },
  };
}
