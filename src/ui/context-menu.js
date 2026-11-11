/**
 * A small menu of actions on one thing, as a right-click, the ContextMenu key, Shift+F10 or a
 * ⋯ button opens it: a native popover at the pointer or beside the control, whose items the
 * arrow keys move between; Enter or a click runs one, and Esc or a click elsewhere closes it.
 * Focus starts on the first item and goes back where it was when the menu closes. An item with
 * `checked` is a switch, ticked while on; `'separator'` draws a line between groups.
 */
import { button, el } from './dom.js';

/** @typedef {{ label: string, run: () => void, checked?: boolean } | 'separator'} MenuItem */

/** Shift+F10 and the ContextMenu key: the keyboard's right-click. @param {KeyboardEvent} event */
export const opensContextMenu = (event) => event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10');

/**
 * Opens a menu of `items` beside `anchor`, or at the point `at` (a right-click's).
 * @param {HTMLElement} anchor @param {MenuItem[]} items @param {{ x: number, y: number }} [at]
 */
export function openContextMenu(anchor, items, at) {
  const menu = el('div', `context-menu${at ? ' is-at-point' : ''}`);
  menu.popover = 'auto';
  menu.setAttribute('role', 'menu');
  const returnTo = /** @type {HTMLElement | null} */ (document.activeElement);
  /** @type {HTMLButtonElement[]} */
  const entries = [];
  for (const entry of items) {
    if (entry === 'separator') {
      const line = el('div', 'context-menu-sep');
      line.setAttribute('role', 'separator');
      menu.append(line);
      continue;
    }
    const { label, run, checked } = entry;
    const item = button('context-menu-item', label, () => {
      menu.hidePopover();
      run();
    });
    item.setAttribute('role', checked === undefined ? 'menuitem' : 'menuitemcheckbox');
    if (checked !== undefined) item.setAttribute('aria-checked', String(checked));
    item.tabIndex = -1;
    entries.push(item);
    menu.append(item);
  }
  menu.addEventListener('keydown', (event) => {
    const at = entries.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
    const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: entries.length - 1 }[event.key];
    if (next === undefined) {
      if (event.key === 'Tab') menu.hidePopover();
      return;
    }
    event.preventDefault();
    entries[(next + entries.length) % entries.length]?.focus();
  });
  menu.addEventListener('toggle', (event) => {
    if (/** @type {ToggleEvent} */ (event).newState !== 'closed') return;
    menu.remove();
    // Back where the user was, unless they have moved on (a click elsewhere put focus there).
    if (!document.activeElement || document.activeElement === document.body) returnTo?.focus({ preventScroll: true });
  });
  document.body.append(menu);
  if (at) {
    menu.showPopover();
    // At the pointer, kept inside the viewport.
    const { width, height } = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(0, Math.min(at.x, innerWidth - width))}px`;
    menu.style.top = `${Math.max(0, Math.min(at.y, innerHeight - height))}px`;
  } else {
    menu.showPopover({ source: anchor });
  }
  entries[0]?.focus();
}
