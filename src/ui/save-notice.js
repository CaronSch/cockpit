/**
 * The "Not saved" notice in the top bar: shown while this window's layout is not being saved
 * (the page is signed out, its workspace name is not one, or the daemon refused a save), with
 * why on hover; otherwise nothing. Saved, a layout says nothing about it.
 */
import { el } from './dom.js';
/** @import { OpenedScreen } from '../workspace/screen.js' */

/** @param {{ opened: OpenedScreen }} options */
export function createSaveNotice({ opened }) {
  const root = el('span', 'save-notice', 'Not saved');
  root.setAttribute('role', 'status');
  const draw = () => {
    const problem = opened.ok ? opened.screen.saveError() : opened.problem;
    root.hidden = !problem;
    root.title = problem ?? '';
  };
  if (opened.ok) opened.screen.onChange(draw);
  draw();
  return { root };
}
