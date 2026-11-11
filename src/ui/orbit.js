/**
 * A light going round an element's outline while something it stands for is at work (a running
 * shell or subagent, a working session, the message box of a working agent): an SVG outline the
 * size of its element whose dash moves along it, at an even pace whatever the element's shape,
 * since the outline's length is set to 100 and the dash moves by its offset.
 *
 * The element it goes in must be positioned; its corner radius is the `--orbit-radius` it sets,
 * and a long one sets a shorter dash (`--orbit-dash`, in hundredths of the outline) and a slower
 * lap (`--orbit-turn`) (styles/app.css).
 */
import { svg } from './dom.js';

/** One turn round the outline, in ms (styles/app.css `.orbit-path`). */
const TURN_MS = 2400;

/** The light, to append to the element it goes round. */
export function orbit() {
  const ring = svg('svg', { class: 'orbit', 'aria-hidden': 'true' });
  const path = svg('rect', { class: 'orbit-path', pathLength: '100' });
  // Every light keeps the page clock's phase, so one redrawn (a list rebuilt) goes on where it was.
  path.style.animationDelay = `${-(performance.now() % TURN_MS)}ms`;
  ring.append(path);
  return ring;
}

/** Puts the light round `host`, or takes it off. @param {Element} host @param {boolean} on */
export function setOrbit(host, on) {
  const there = host.querySelector(':scope > .orbit');
  if (on && !there) host.append(orbit());
  else if (!on) there?.remove();
}
