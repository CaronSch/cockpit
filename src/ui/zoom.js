/**
 * Text size for the whole app, picked in the top bar (− 100% +; the percentage resets it) and
 * kept per browser. It scales the type tokens only (`--font-scale` in tokens.css): spacing and
 * layout stay as they are. The browser's own zoom (Cmd/Ctrl and +, −, 0) is left alone.
 *
 * Text boxes sized to their text (`autosize`) refit through `onZoom`: a font change resizes
 * nothing their ResizeObservers watch.
 */
import { button, el } from './dom.js';
import { readPref, writePref } from './prefs.js';

const ZOOM_KEY = 'cockpit.zoom';
const MIN_ZOOM = 0.7;
const MAX_ZOOM = 1.5;
const STEP = 0.1;

/** `scale` moved `steps` steps (10% each), kept in range and off float noise. @param {number} scale @param {number} steps */
const stepZoom = (scale, steps) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round((scale + steps * STEP) * 10) / 10));

/** A stored value as a scale, or 1 when there is none or it is not one. @param {string | null} value */
function parseZoom(value) {
  const scale = Number(value);
  return value !== null && Number.isFinite(scale) && scale >= MIN_ZOOM && scale <= MAX_ZOOM ? scale : 1;
}

const stored = () => parseZoom(readPref(ZOOM_KEY));

/** @type {Set<() => void>} */
const listeners = new Set();

/** Calls `fn` after every text size change; returns what stops it. @param {() => void} fn */
export function onZoom(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** @param {number} scale */
function apply(scale) {
  document.documentElement.style.setProperty('--font-scale', String(scale));
}

/** Sets the saved text size before anything is drawn, so the page never flashes at 100%. */
export const applySavedZoom = () => apply(stored());

/** The top bar's text size control. */
export function createZoomControl() {
  const root = el('div', 'zoom');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Text size');
  let scale = stored();
  const smaller = button('zoom-btn', '−', () => set(stepZoom(scale, -1)));
  smaller.setAttribute('aria-label', 'Smaller text');
  const reset = button('zoom-btn zoom-level', '', () => set(1));
  const larger = button('zoom-btn', '+', () => set(stepZoom(scale, 1)));
  larger.setAttribute('aria-label', 'Larger text');
  root.append(smaller, reset, larger);

  /** @param {number} next */
  function set(next) {
    scale = next;
    apply(scale);
    writePref(ZOOM_KEY, scale === 1 ? null : String(scale));
    draw();
    for (const fn of listeners) fn();
  }

  function draw() {
    const percent = `${Math.round(scale * 100)}%`;
    reset.textContent = percent;
    reset.setAttribute('aria-label', `Text size ${percent}: reset to 100%`);
    smaller.disabled = scale <= MIN_ZOOM;
    larger.disabled = scale >= MAX_ZOOM;
  }
  draw();
  return { root };
}
