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
import { crossIcon } from '../ui/icons.js';
/** @import { Stack, Tree } from '../layout/grid-model.js' */
/** What a tab shows of its window. @typedef {{ glyph: string, name: string, unread: boolean }} TabFace */

/** The id of the tab naming window `id`. @param {string} id */
export const tabId = (id) => `tab-${id}`;
/** The id of window `id`'s body, the panel its tab controls. @param {string} id */
export const panelId = (id) => `panel-${id}`;

/** Sets attribute `name` of `node` to `value`, or removes it for null, unless it is so already. @param {Element} node @param {string} name @param {string | null} value */
function writeAttr(node, name, value) {
  if (node.getAttribute(name) === value) return;
  if (value === null) node.removeAttribute(name);
  else node.setAttribute(name, value);
}

/**
 * @param {{
 *   frameElement: (id: string) => HTMLElement | null,
 *   frameElements: () => Iterable<[string, HTMLElement]>,
 *   describe: (id: string) => TabFace,
 * }} options
 */
export function createTabStrips({ frameElement, frameElements, describe }) {
  /** The tabs on the page, by their window's id. @type {Map<string, HTMLElement>} */
  const tabs = new Map();

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
    const close = el('span', 'widget-tab-close');
    close.append(crossIcon());
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
    if (tab.dataset.unread !== String(face.unread)) tab.dataset.unread = String(face.unread);
    writeAttr(tab, 'aria-selected', String(active));
    if (tab.tabIndex !== (active ? 0 : -1)) tab.tabIndex = active ? 0 : -1;
  }

  /** @param {HTMLElement} strip @param {Stack} stack */
  function sync(strip, stack) {
    const old = new Map([...strip.children].map((tab) => [/** @type {HTMLElement} */ (tab).dataset.id, /** @type {HTMLElement} */ (tab)]));
    stack.tabs.forEach(({ id }, i) => {
      const tab = old.get(id) ?? createTab(id);
      old.delete(id);
      tabs.set(id, tab);
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
    for (const [id, frame] of frameElements()) {
      const strip = /** @type {HTMLElement} */ (frame.querySelector('.widget-tabs'));
      const tabbed = strips.has(strip);
      frame.classList.toggle('is-tabbed', tabbed);
      if (!tabbed && strip.firstChild) strip.replaceChildren();
      const body = frame.querySelector('.widget-body');
      if (!body) continue;
      const stacked = stackOf.has(id);
      writeAttr(body, 'role', stacked ? 'tabpanel' : null);
      writeAttr(body, 'aria-labelledby', stacked ? tabId(id) : null);
    }
    tabs.clear();
    strips.forEach((stack, strip) => sync(strip, stack));
  }

  return {
    draw,
    /** The tabs the strips drew last, by their window's id. @returns {ReadonlyMap<string, HTMLElement>} */
    tabs: () => tabs,
  };
}
