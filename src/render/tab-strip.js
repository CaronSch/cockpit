/**
 * Tab strips of stacked windows: the window a stack shows carries, in place of its title, a tab
 * for each window of the stack (its glyph and title, a dot while it is unread), the one shown
 * marked.
 *
 * The strip lives in the head of the window the stack shows (the others are hidden), in its
 * `.widget-tabs` (`role=tablist`); each tab is a `role=tab` button keyed by its window's id, so a
 * redraw keeps the tabs that stay, and focus with them. Each window of a stack is its tab's
 * `tabpanel`. What the tabs do (show, close, reorder, drag out) is app.js's and the drag
 * controller's.
 */
import { listStacks } from '../layout/grid-model.js';
import { button, el } from '../ui/dom.js';
/** @import { Stack, Tree } from '../layout/grid-model.js' */
/** What a tab shows of its window. @typedef {{ glyph: string, name: string, unread: boolean }} TabFace */

/** The id of the tab naming window `id`. @param {string} id */
export const tabId = (id) => `tab-${id}`;
/** The id of window `id`'s body, the panel its tab controls. @param {string} id */
export const panelId = (id) => `panel-${id}`;

/**
 * @param {{
 *   gridEl: HTMLElement,
 *   frameElement: (id: string) => HTMLElement | null,
 *   describe: (id: string) => TabFace,
 * }} options
 */
export function createTabStrips({ gridEl, frameElement, describe }) {
  /** @param {string} id */
  function createTab(id) {
    const tab = button('widget-tab');
    tab.id = tabId(id);
    tab.dataset.id = id;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', panelId(id));
    const glyph = el('span', 'widget-tab-glyph');
    const dot = el('span', 'widget-tab-dot');
    // Closes its window with a click (app.js); a keyboard closes the focused tab with Delete.
    const close = el('span', 'widget-tab-close', '×');
    for (const part of [glyph, dot, close]) part.setAttribute('aria-hidden', 'true');
    tab.append(glyph, el('span', 'widget-tab-name'), dot, close);
    return tab;
  }

  /** @param {HTMLElement} tab @param {string} id @param {boolean} active */
  function paint(tab, id, active) {
    const face = describe(id);
    const [glyph, name] = /** @type {HTMLElement[]} */ ([...tab.children]);
    if (glyph.textContent !== face.glyph) glyph.textContent = face.glyph;
    if (name.textContent !== face.name) name.textContent = face.name;
    tab.dataset.unread = String(face.unread);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  }

  /** @param {HTMLElement} strip @param {Stack} stack */
  function sync(strip, stack) {
    const old = new Map([...strip.children].map((tab) => [/** @type {HTMLElement} */ (tab).dataset.id, /** @type {HTMLElement} */ (tab)]));
    stack.tabs.forEach(({ id }, i) => {
      const tab = old.get(id) ?? createTab(id);
      old.delete(id);
      paint(tab, id, id === stack.active);
      const here = strip.children[i] ?? null;
      if (here !== tab) strip.insertBefore(tab, here);
    });
    for (const tab of old.values()) tab.remove();
  }

  /** Draws the strips of the stacks in `tree` (the one on screen). @param {Tree} tree */
  function draw(tree) {
    /** @type {Map<string, Stack>} */
    const stackOf = new Map();
    /** @type {Map<HTMLElement, Stack>} */
    const strips = new Map();
    for (const stack of listStacks(tree)) {
      for (const { id } of stack.tabs) stackOf.set(id, stack);
      const strip = frameElement(stack.active)?.querySelector('.widget-tabs');
      if (strip instanceof HTMLElement) strips.set(strip, stack);
    }
    // Strips no stack shows any more go first, so no tab id is ever on the page twice.
    for (const node of gridEl.querySelectorAll('.widget')) {
      const frame = /** @type {HTMLElement} */ (node);
      const strip = /** @type {HTMLElement} */ (frame.querySelector('.widget-tabs'));
      const tabbed = strips.has(strip);
      frame.classList.toggle('is-tabbed', tabbed);
      if (!tabbed && strip.firstChild) strip.replaceChildren();
      const body = frame.querySelector('.widget-body');
      const id = frame.dataset.id ?? '';
      if (stackOf.has(id)) {
        body?.setAttribute('role', 'tabpanel');
        body?.setAttribute('aria-labelledby', tabId(id));
      } else {
        body?.removeAttribute('role');
        body?.removeAttribute('aria-labelledby');
      }
    }
    strips.forEach((stack, strip) => sync(strip, stack));
  }

  return { draw };
}
