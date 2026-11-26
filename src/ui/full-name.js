/**
 * A window's whole name while the pointer rests on it, where its tab (or its head's title) cuts
 * it short: a quiet label under it, after a short pause, gone as the pointer leaves, presses or
 * drags. Names shown whole show nothing. One label serves the whole grid.
 */
import { el } from './dom.js';

/** How long the pointer rests on a name before it shows: long enough that passing over shows nothing. */
const REST_MS = 400;
/** The names cut short: a tab's, and a lone window's title (its type and what it shows). */
const NAMES = '.widget-tab-name, .widget-title';

/** @param {HTMLElement} gridEl */
export function attachFullNames(gridEl) {
  const label = el('div', 'full-name');
  label.popover = 'manual';
  label.setAttribute('aria-hidden', 'true'); // the tab and the heading already say it whole
  document.body.append(label);
  /** @type {Element | null} */
  let over = null;
  let timer = 0;

  const hide = () => {
    clearTimeout(timer);
    over = null;
    if (label.matches(':popover-open')) label.hidePopover();
  };

  gridEl.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const name = /** @type {Element} */ (e.target).closest?.(NAMES) ?? null;
    if (name === over) return;
    hide();
    if (!name || name.scrollWidth <= name.clientWidth || document.body.classList.contains('is-dragging')) return;
    over = name;
    timer = window.setTimeout(() => {
      label.textContent = name.textContent?.trim() ?? '';
      label.showPopover({ source: /** @type {HTMLElement} */ (name) });
    }, REST_MS);
  });
  gridEl.addEventListener('pointerleave', hide);
  gridEl.addEventListener('pointerdown', hide, { capture: true });
  addEventListener('blur', hide);
}
