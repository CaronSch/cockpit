/**
 * Landing preview for drag & drop, plus the sash snap guide.
 *
 * Both layers cover the whole grid; the visible rect is carved out with
 * `clip-path: inset()`, which transitions without triggering layout.
 */

/** @import { Axis } from '../layout/grid-model.js' */
/** @import { Rect } from '../layout/compute-layout.js' */
/** @typedef {ReturnType<typeof createDropIndicator>} DropIndicator */

/** The windows' corner radius (`--radius-l`, tokens.css). */
const RADIUS = 10;
const BORDER = 2;
const LABEL_OFFSET = 10;

/** @param {Rect} rect @param {Rect} bounds @param {number} pad */
const insetFor = (rect, bounds, pad) => {
  const top = rect.y + pad;
  const right = bounds.w - (rect.x + rect.w) + pad;
  const bottom = bounds.h - (rect.y + rect.h) + pad;
  const left = rect.x + pad;
  return `inset(${top}px ${right}px ${bottom}px ${left}px round ${Math.max(0, RADIUS - pad)}px)`;
};

/** @param {HTMLElement} gridEl */
export function createDropIndicator(gridEl) {
  // Static markup from index.html: these elements always exist.
  const root = /** @type {HTMLElement} */ (gridEl.querySelector('.drop-indicator'));
  const edge = /** @type {HTMLElement} */ (root.querySelector('.drop-edge'));
  const fill = /** @type {HTMLElement} */ (root.querySelector('.drop-fill'));
  const label = /** @type {HTMLElement} */ (root.querySelector('.drop-label'));
  const guide = /** @type {HTMLElement} */ (gridEl.querySelector('.snap-guide'));

  let lastKey = '';

  /** @param {Rect} rect @param {Rect} bounds @param {string} text */
  function show(rect, bounds, text) {
    const key = `${rect.x},${rect.y},${rect.w},${rect.h}|${text}`;
    if (key === lastKey) return;
    lastKey = key;

    // First appearance should land in place, not sweep in from the full grid.
    const entering = !root.classList.contains('is-visible');
    root.classList.toggle('is-entering', entering);

    edge.style.clipPath = insetFor(rect, bounds, 0);
    fill.style.clipPath = insetFor(rect, bounds, BORDER);
    label.textContent = text;
    label.style.transform = `translate3d(${rect.x + LABEL_OFFSET}px, ${rect.y + LABEL_OFFSET}px, 0)`;
    root.classList.add('is-visible');

    if (entering) requestAnimationFrame(() => root.classList.remove('is-entering'));
  }

  function hide() {
    lastKey = '';
    root.classList.remove('is-visible');
  }

  /** axis 'row' → vertical line at x; axis 'col' → horizontal line at y. @param {Axis} axis @param {number} pos */
  function showGuide(axis, pos) {
    guide.classList.toggle('is-vertical', axis === 'row');
    guide.style.transform = axis === 'row' ? `translate3d(${pos}px, 0, 0)` : `translate3d(0, ${pos}px, 0)`;
    guide.classList.add('is-visible');
  }

  function hideGuide() {
    guide.classList.remove('is-visible');
  }

  return { show, hide, showGuide, hideGuide };
}
