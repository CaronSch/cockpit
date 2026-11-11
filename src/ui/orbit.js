/**
 * A light going round an element's outline while something it stands for is at work (a running
 * shell or subagent): an SVG outline the size of its element whose dash moves along it, at an
 * even pace whatever the element's shape, since the outline's length is set to 100 and the dash
 * moves by its offset.
 *
 * The element it goes in must be positioned; its corner radius is the `--orbit-radius` it sets
 * (styles/app.css).
 */
import { svg } from './dom.js';

/** One turn round the outline, in ms (styles/app.css `.orbit-path`). */
const TURN_MS = 4000;

/** Where in its turn the light of `key` is, as a share of a turn: the same for one key, spread across keys. @param {string} key */
function phaseOf(key) {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return (hash % 1000) / 1000;
}

/**
 * The light, to append to the element it goes round. Lights of different `key`s are spread
 * round their turn, so several side by side never line up; one redrawn with the same key (a
 * list rebuilt) goes on where it was.
 * @param {string} key
 */
export function orbit(key) {
  const ring = svg('svg', { class: 'orbit', 'aria-hidden': 'true' });
  const path = svg('rect', { class: 'orbit-path', pathLength: '100' });
  path.style.animationDelay = `${-((performance.now() + phaseOf(key) * TURN_MS) % TURN_MS)}ms`;
  ring.append(path);
  return ring;
}
