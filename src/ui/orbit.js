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

/** The light, to append to the element it goes round. Every light keeps the page clock's phase, so several side by side go round in step, and one redrawn (a list rebuilt) goes on where it was. */
export function orbit() {
  const ring = svg('svg', { class: 'orbit', 'aria-hidden': 'true' });
  const path = svg('rect', { class: 'orbit-path', pathLength: '100' });
  path.style.animationDelay = `${-(performance.now() % TURN_MS)}ms`;
  ring.append(path);
  return ring;
}
