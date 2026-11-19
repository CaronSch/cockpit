/**
 * A light going round an element's outline while something it stands for is at work (a running
 * shell or subagent): glows set all round the element's edge, each flaring in turn as the light
 * passes, seen only where they cross the element's 1px border (styles/app.css `.orbit`, masked
 * to that ring).
 *
 * The glows stand still and only their opacity is animated, which the compositor runs: the page
 * draws no frame for it, however long the work runs. (A glow moved by `transform` would be
 * composited too, but Chrome then runs a main-thread frame every frame while any
 * IntersectionObserver is in the page.) They are set out at even steps round the outline, so
 * the light keeps an even pace; the element's size, which places them, comes from a
 * ResizeObserver as it changes, never read on the spot.
 *
 * The element it goes in must be positioned, with a 1px border whose corners the light follows
 * (it takes their radius).
 */
import { el } from './dom.js';

/** One turn round the outline, in ms (styles/app.css `.orbit-light`). */
const TURN_MS = 4000;

/** How far apart the glows are, in px: close enough that one flares as the one before fades, so the light glides. */
const STEP = 10;

/** @type {ResizeObserver | null} */
let sizes = null;

/**
 * The light, to append to the element it goes round. Every light keeps the page clock's phase,
 * so several side by side go round in step, and one redrawn (a list rebuilt) goes on where it was.
 */
export function orbit() {
  const ring = el('span', 'orbit');
  ring.setAttribute('aria-hidden', 'true');
  sizes ??= new ResizeObserver((entries) => entries.forEach(resized));
  sizes.observe(ring);
  return ring;
}

/** Sets the glows round a ring at its new size. @param {ResizeObserverEntry} entry */
function resized({ target: ring, borderBoxSize: [box] }) {
  if (!ring.isConnected) return void sizes?.unobserve(ring); // its list was rebuilt
  const { inlineSize: width, blockSize: height } = box;
  if (width && height) ring.replaceChildren(...glows(width, height));
}

/**
 * Glows along the middle of a `width` by `height` ring's 1px border, from its top-left corner
 * clockwise, each flaring a step of the turn after the one before. They are wider than the
 * corners are round, so they take them as the border does.
 * @param {number} width @param {number} height
 */
function glows(width, height) {
  const [left, top, right, bottom] = [0.5, 0.5, width - 0.5, height - 0.5];
  const across = right - left;
  const down = bottom - top;
  const count = Math.max(8, Math.round((2 * (across + down)) / STEP));
  const step = (2 * (across + down)) / count;
  const now = performance.now();
  return Array.from({ length: count }, (_, i) => {
    let along = i * step;
    /** @type {[number, number]} */
    let at;
    if (along < across) at = [left + along, top];
    else if ((along -= across) < down) at = [right, top + along];
    else if ((along -= down) < across) at = [right - along, bottom];
    else at = [left, bottom - (along - across)];
    const glow = el('span', 'orbit-light');
    glow.style.translate = `${at[0]}px ${at[1]}px`;
    // Its flare (the animation's start) comes when the page clock is i/count of the way into a turn.
    glow.style.animationDelay = `${-(((now - (i / count) * TURN_MS) % TURN_MS) + TURN_MS) % TURN_MS}ms`;
    return glow;
  });
}
