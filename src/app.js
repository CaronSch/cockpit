/**
 * Cockpit controller: owns the layout atom and wires rendering, interaction and widgets together.
 *
 * The layout is this window's screen of its workspace (workspace/screen.js), which the daemon
 * keeps; the app starts once the screen is claimed and loaded.
 */
import { activateTab, addTab, applyDrop, branch, findLeaf, insertBeside, listLeaves, moveLeaf, removeLeaf, setLeafParams } from './layout/grid-model.js';
import { computeLayout } from './layout/compute-layout.js';
import { findNeighbor, DIRECTION_KEYS } from './layout/neighbors.js';
import { createAtom } from './state/atom.js';
import { createGridRenderer } from './render/grid-renderer.js';
import { createDropIndicator } from './render/drop-indicator.js';
import { createTabStrips, panelId, tabId } from './render/tab-strip.js';
import { attachSashController } from './interaction/sash-controller.js';
import { createDragController } from './interaction/drag-controller.js';
import { createPalette } from './ui/palette.js';
import { createScreenSwitcher } from './ui/screen-switcher.js';
import { createUpdateNotice } from './ui/update-notice.js';
import { createNotifier } from './sessions/notify.js';
import { sessionLinks } from './sessions/links.js';
import { createZoomControl } from './ui/zoom.js';
import { createConfigMenu } from './ui/settings.js';
import { createSpotlight } from './ui/spotlight.js';
import { button, el } from './ui/dom.js';
import { crossIcon, gripIcon, plusIcon } from './ui/icons.js';
import { getDaemon } from './daemon/client.js';
import { openScreen } from './workspace/screen.js';
import { describeWindows } from './workspace/model.js';
import { WIDGETS, newWidgetLeaf } from './widgets/registry.js';
/** @import { Leaf, LeafParams, Tree } from './layout/grid-model.js' */
/** @import { ScreenWindows, WidgetContext } from './widgets/registry.js' */
/** @import { Layout, Rect } from './layout/compute-layout.js' */
/** @import { Palette } from './ui/palette.js' */
/** @import { GridApi } from './interaction/drag-controller.js' */
/** @import { TabFace } from './render/tab-strip.js' */

const LAYOUT_OPTIONS = Object.freeze({ gap: 6, minWidth: 180, minHeight: 120 });
const STACK_BREAKPOINT = 640;
const STACK_ROW_HEIGHT = 260;
/** How many colours related windows' top bars are drawn in (`--color-family-1` … in tokens.css). */
const FAMILY_COLOURS = 6;

/** A family's name as a number, so its colour stays the same wherever it shows. @param {string} name */
function familyHash(name) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + /** @type {number} */ (char.codePointAt(0))) >>> 0;
  return hash;
}

/**
 * @template {Element} [T=HTMLElement]
 * @param {ParentNode} root @param {string} selector
 * @returns {T}
 */
function query(root, selector) {
  const node = /** @type {T | null} */ (root.querySelector(selector));
  if (!node) throw new Error(`[app] missing required element ${selector}`);
  return node;
}

/** The windows on show: a stack's tabs behind the one it shows aside. @param {Layout} layout */
const shownRects = (layout) => new Map([...layout.leaves].filter(([id]) => !layout.hidden.has(id)));

/** @param {Map<string, Rect>} leaves @returns {[string, Rect] | null} */
const largestLeaf = (leaves) =>
  [...leaves].reduce(
    (/** @type {[string, Rect] | null} */ best, entry) =>
      !best || entry[1].w * entry[1].h > best[1].w * best[1].h ? entry : best,
    null,
  );

/**
 * Narrow screens show the same widgets as a scrolling column, every tab of a stack a window of
 * its own; the saved tree is untouched.
 * @param {Tree} tree @returns {Tree}
 */
function stackProjection(tree) {
  const leaves = listLeaves(tree);
  return leaves.length > 1 ? branch('col', leaves) : (leaves[0] ?? null);
}

/** @param {string} widget */
const titleOf = (widget) => WIDGETS[widget]?.title ?? widget;

/** @param {ParentNode} root */
export async function createApp(root) {
  const gridEl = query(root, '#grid');
  const deckEl = query(root, '.deck');
  const emptyEl = query(root, '.grid-empty');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const daemon = getDaemon();
  const opened = await openScreen({ daemon });
  const layoutAtom = createAtom(opened.ok ? opened.screen.tree() : null);

  // ── which windows there are, which was used last, which is pointed at (ctx.screen) ──
  /** When each window was last used (pressed or focused), in order of use. @type {Map<string, number>} */
  const usedAt = new Map();
  let uses = 0;
  /** The window under the pointer, and the one holding focus. @type {{ hovered: string | null, focused: string | null }} */
  const pointer = { hovered: null, focused: null };
  /** @returns {ScreenWindows} */
  function screenWindows() {
    const windows = listLeaves(layoutAtom.get());
    /** @type {Record<string, string>} */
    const used = {};
    // Per type, the window used last; the first one in the screen until one has been.
    for (const w of windows) {
      const best = used[w.widget];
      if (best === undefined || (usedAt.get(w.id) ?? 0) > (usedAt.get(best) ?? 0)) used[w.widget] = w.id;
    }
    return { windows, used, pointed: pointer.hovered ?? pointer.focused };
  }
  const screenAtom = createAtom(screenWindows());
  function refreshScreen() {
    const next = screenWindows();
    const now = screenAtom.get();
    const same =
      next.pointed === now.pointed &&
      JSON.stringify(next.used) === JSON.stringify(now.used) &&
      next.windows.length === now.windows.length &&
      next.windows.every((w, i) => w === now.windows[i]);
    if (!same) screenAtom.set(next);
  }
  layoutAtom.subscribe(refreshScreen);
  const indicator = createDropIndicator(gridEl);

  let bounds = { x: 0, y: 0, w: 0, h: 0 };
  let layout = computeLayout(null, bounds, LAYOUT_OPTIONS);
  let frame = 0;
  let pendingAnimate = false;
  /** @type {Palette | null} */
  let palette = null;

  /** @param {Leaf} leaf */
  function mountWidget(leaf) {
    const def = WIDGETS[leaf.widget];
    const title = def?.title ?? `Unknown widget (${leaf.widget})`;
    const frameEl = el('article', 'widget');
    frameEl.dataset.id = leaf.id;
    frameEl.dataset.widget = leaf.widget;
    frameEl.setAttribute('aria-labelledby', `title-${leaf.id}`);

    const head = el('header', 'widget-head');
    const grip = button('widget-grip');
    grip.append(gripIcon());
    grip.setAttribute('aria-label', `Move ${title}: drag, or Alt+Shift+Arrow keys`);
    const glyph = el('span', 'widget-glyph', def?.glyph ?? '?');
    glyph.setAttribute('aria-hidden', 'true');
    const heading = el('h2', 'widget-title', title);
    heading.id = `title-${leaf.id}`;
    // What the window shows, beside its type: part of the heading, so it names the window too.
    const label = el('span', 'widget-label');
    label.hidden = true;
    heading.append(' ', label); // a space, so the heading reads "Agent <name>", not "Agent<name>"
    // In a stack, the tabs of its windows take the glyph's and title's place (render/tab-strip.js).
    const tabs = el('div', 'widget-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Windows here');
    // A widget that opens more of its kind as tabs (registry.js `newTab`) has a + after its title.
    /** @type {HTMLElement[]} */
    const plus = [];
    if (def?.newTab) {
      const add = button('widget-plus');
      add.append(plusIcon());
      add.setAttribute('aria-label', `New ${title} here`);
      plus.push(add);
    }
    // The widget's own controls for the window, before its close button.
    const actions = el('div', 'widget-actions');
    const close = button('widget-close');
    close.append(crossIcon());
    close.setAttribute('aria-label', `Close ${title}`);
    head.append(grip, glyph, heading, tabs, ...plus, actions, close);

    const body = el('div', 'widget-body');
    body.id = panelId(leaf.id);
    frameEl.append(head, body);
    /** What the window's tab shows. @type {TabFace} */
    const face = { glyph: def?.glyph ?? '?', name: title, unread: false };
    faces.set(leaf.id, face);

    /** @type {WidgetContext} */
    const ctx = {
      // Read through the atom, not the mount-time leaf: params change after mount.
      get params() {
        return findLeaf(layoutAtom.get(), leaf.id)?.params ?? {};
      },
      setParams: (/** @type {LeafParams} */ patch) => api.commitTree(setLeafParams(layoutAtom.get(), leaf.id, patch)),
      addWidget: (/** @type {string} */ type, /** @type {LeafParams} */ params) => addWidget(type, params),
      openTab(/** @type {string} */ type, /** @type {LeafParams} */ params) {
        const tree = layoutAtom.get();
        const opened = newWidgetLeaf(type, params);
        api.commitTree(tree && findLeaf(tree, leaf.id) ? addTab(tree, leaf.id, opened) : opened, { animate: true });
      },
      showWidget: (/** @type {string} */ type, /** @type {LeafParams} */ params) => showWidget(type, params),
      dragWidget(/** @type {string} */ type, /** @type {LeafParams} */ params, /** @type {PointerEvent} */ event, options = {}) {
        drag.start({ kind: 'new', leaf: newWidgetLeaf(type, params), into: options.into }, event, {
          label: options.label ?? WIDGETS[type]?.title ?? type,
          onEnd: options.onEnd,
          target: options.target,
        });
      },
      setUnread(/** @type {boolean} */ unread) {
        frameEl.classList.toggle('is-unread', unread);
        frameEl.dataset.unread = String(unread);
        if (face.unread !== unread) {
          face.unread = unread;
          redrawTabs();
        }
      },
      setLabel(/** @type {string | null} */ text) {
        if (label.textContent === (text ?? '')) return;
        label.textContent = text ?? '';
        label.hidden = !text;
        face.name = text || title;
        redrawTabs();
      },
      headActions: actions,
      screen: screenAtom,
      outline(/** @type {readonly string[]} */ ids) {
        outlines.set(leaf.id, ids);
        drawOutlines();
      },
      setFamily(/** @type {string | null} */ family) {
        if ((families.get(leaf.id) ?? null) === family) return;
        if (family) families.set(leaf.id, family);
        else families.delete(leaf.id);
        drawFamilies();
      },
    };

    /** @type {{ destroy(): void, paramsChanged?(): void }} */
    let instance = { destroy() {} };
    if (!def) {
      body.append(el('p', 'widget-empty', 'This widget type is not installed.'));
    } else {
      try {
        instance = def.mount(body, ctx) ?? instance;
      } catch (err) {
        console.error(`[app] widget "${leaf.widget}" failed to mount`, err);
        body.replaceChildren(el('p', 'widget-empty widget-error', 'This widget failed to load.'));
      }
    }
    // Settings also change from outside the window: another window shows something in it.
    let params = leaf.params;
    const offParams = layoutAtom.subscribe((tree) => {
      const next = findLeaf(tree, leaf.id)?.params;
      if (next === params) return;
      params = next;
      instance.paramsChanged?.();
    });
    return {
      el: frameEl,
      destroy() {
        offParams();
        instance.destroy?.();
        faces.delete(leaf.id);
        outlines.delete(leaf.id);
        drawOutlines();
        families.delete(leaf.id);
        drawFamilies();
      },
    };
  }

  /** What each window's tab shows, should it be in a stack, by window id. @type {Map<string, TabFace>} */
  const faces = new Map();

  /** The windows each window has asked to outline (`ctx.outline`), by the asking window's id. @type {Map<string, readonly string[]>} */
  const outlines = new Map();
  /** Outlines those windows, and the tabs of those stacked behind another. */
  function drawOutlines() {
    const ids = new Set([...outlines.values()].flat());
    for (const node of gridEl.querySelectorAll('.widget, .widget-tab')) {
      node.classList.toggle('is-outlined', ids.has(/** @type {HTMLElement} */ (node).dataset.id ?? ''));
    }
  }

  /** The family each window's conversation belongs to (`ctx.setFamily`), by window id. @type {Map<string, string>} */
  const families = new Map();
  /**
   * Colours the top bars of windows whose conversations are related (forked from one another)
   * alike, one colour per family shown in two or more windows of this screen; a family's colour
   * follows from its name, and two families on screen never share one.
   */
  function drawFamilies() {
    /** @type {Map<string, number>} */
    const count = new Map();
    for (const family of families.values()) count.set(family, (count.get(family) ?? 0) + 1);
    /** @type {Map<string, number>} */
    const colourOf = new Map();
    for (const family of [...count.keys()].filter((f) => /** @type {number} */ (count.get(f)) > 1).sort()) {
      let colour = familyHash(family) % FAMILY_COLOURS;
      for (let tries = 0; tries < FAMILY_COLOURS && [...colourOf.values()].includes(colour); tries++) colour = (colour + 1) % FAMILY_COLOURS;
      colourOf.set(family, colour);
    }
    for (const node of gridEl.querySelectorAll('.widget')) {
      const frameEl = /** @type {HTMLElement} */ (node);
      const colour = colourOf.get(families.get(frameEl.dataset.id ?? '') ?? '');
      if (colour === undefined) delete frameEl.dataset.family;
      else frameEl.dataset.family = String(colour + 1);
    }
  }

  const renderer = createGridRenderer(gridEl, { mountWidget, prefersReducedMotion: () => reducedMotion.matches });
  const strips = createTabStrips({
    gridEl,
    frameElement: (id) => renderer.frameElement(id),
    describe: (id) => faces.get(id) ?? { glyph: '?', name: id, unread: false },
  });
  /** The tree on screen (the narrow column's, when narrow), whose stacks' strips are drawn. @type {Tree} */
  let shownTree = null;
  /** A tab to focus once the strips are drawn: one the keyboard moved to. @type {string | null} */
  let focusTab = null;
  function drawTabs() {
    strips.draw(shownTree);
    drawOutlines();
    if (!focusTab) return;
    // A stack closed down to one window has no tabs left: its grip keeps the focus.
    (document.getElementById(tabId(focusTab)) ?? renderer.frameElement(focusTab)?.querySelector('.widget-grip'))?.focus();
    focusTab = null;
  }
  let tabsFrame = 0;
  /** A window's title or unread mark changed: its tab follows, once per frame. */
  function redrawTabs() {
    tabsFrame ||= requestAnimationFrame(() => {
      tabsFrame = 0;
      drawTabs();
    });
  }
  // A window mounted after an outline was asked for (the layout redrawn) gets it too.
  layoutAtom.subscribe(() =>
    requestAnimationFrame(() => {
      drawOutlines();
      drawFamilies();
    }),
  );

  const isStacked = () => bounds.w > 0 && bounds.w < STACK_BREAKPOINT;

  /** @param {Tree} tree @param {boolean} animate */
  function draw(tree, animate) {
    const stacked = isStacked();
    const shown = stacked ? stackProjection(tree) : tree;
    const count = listLeaves(shown).length;
    const frameBounds = stacked
      ? { ...bounds, h: Math.max(bounds.h, count * STACK_ROW_HEIGHT + LAYOUT_OPTIONS.gap * (count - 1)) }
      : bounds;
    const height = stacked ? `${frameBounds.h}px` : '';
    if (gridEl.style.height !== height) gridEl.style.height = height;
    gridEl.classList.toggle('is-stacked', stacked);

    layout = computeLayout(shown, frameBounds, LAYOUT_OPTIONS);
    renderer.render(shown, layout, { animate });
    shownTree = shown;
    drawTabs();
    emptyEl.hidden = Boolean(tree);
  }

  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const animate = pendingAnimate;
      pendingAnimate = false;
      draw(layoutAtom.get(), animate);
    });
  }

  /** @type {GridApi} */
  const api = {
    gridEl,
    indicator,
    layoutOptions: LAYOUT_OPTIONS,
    getTree: () => layoutAtom.get(),
    getLayout: () => layout,
    getBounds: () => bounds,
    isStacked,
    frameElement: (/** @type {string} */ id) => renderer.frameElement(id),
    previewTree: (/** @type {Tree} */ tree) => draw(tree, false),
    /** @param {Tree} tree @param {{ animate?: boolean }} [options] */
    commitTree(tree, { animate = false } = {}) {
      pendingAnimate = pendingAnimate || animate;
      layoutAtom.set(tree);
      schedule();
    },
    onDragStateChange: (/** @type {boolean} */ dragging) => palette?.setDragging(dragging),
  };

  if (opened.ok) layoutAtom.subscribe((/** @type {Tree} */ tree) => opened.screen.update(tree));

  new ResizeObserver(([entry]) => {
    bounds = { x: 0, y: 0, w: Math.floor(entry.contentRect.width), h: Math.floor(entry.contentRect.height) };
    draw(layoutAtom.get(), false);
  }).observe(deckEl);

  /** @param {string} type @param {LeafParams} [params] */
  function addWidget(type, params) {
    const leaf = newWidgetLeaf(type, params);
    const tree = layoutAtom.get();
    const target = largestLeaf(shownRects(layout));
    const next =
      tree && target ? insertBeside(tree, target[0], target[1].w >= target[1].h ? 'right' : 'down', leaf) : leaf;
    api.commitTree(next, { animate: true });
  }

  /**
   * Shows `params` in the window of `type` used last in this screen (`screenAtom`'s `used`),
   * bringing it to the front of its stack; opens a new window when there is none.
   * @param {string} type @param {LeafParams} params
   */
  function showWidget(type, params) {
    const target = screenAtom.get().used[type];
    if (!target) return addWidget(type, params);
    api.commitTree(activateTab(setLeafParams(layoutAtom.get(), target, params), target));
  }

  /** Shows a tab of a stack, as used now; false when it was already shown. @param {string} id */
  function showTab(id) {
    usedAt.set(id, ++uses);
    const tree = layoutAtom.get();
    const next = activateTab(tree, id);
    if (next === tree) {
      refreshScreen();
      return false;
    }
    api.commitTree(next);
    return true;
  }

  /** @param {string} id */
  const closeWindow = (id) => api.commitTree(removeLeaf(layoutAtom.get(), id), { animate: true });

  /** Opens another window of window `id`'s kind as a tab beside it, as its `newTab` says. @param {string} id */
  function newTabBeside(id) {
    const tree = layoutAtom.get();
    const leaf = tree && findLeaf(tree, id);
    const make = leaf && WIDGETS[leaf.widget]?.newTab;
    if (!leaf || !make) return;
    api.commitTree(addTab(tree, id, newWidgetLeaf(leaf.widget, make(leaf.params ?? {}))), { animate: true });
  }

  /** @param {Event} event */
  const windowAt = (event) => /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest?.('.widget'))?.dataset.id ?? null;
  for (const type of ['pointerdown', 'focusin']) {
    gridEl.addEventListener(
      type,
      (event) => {
        const id = windowAt(event);
        if (!id) return;
        usedAt.set(id, ++uses);
        if (type === 'focusin') pointer.focused = id;
        refreshScreen();
      },
      { capture: true },
    );
  }
  gridEl.addEventListener('focusout', (event) => {
    if (event.relatedTarget instanceof Element && event.relatedTarget.closest('.widget')) return; // focusin follows
    pointer.focused = null;
    refreshScreen();
  });
  gridEl.addEventListener('pointerover', (event) => {
    pointer.hovered = windowAt(event);
    refreshScreen();
  });
  gridEl.addEventListener('pointerleave', () => {
    pointer.hovered = null;
    refreshScreen();
  });

  attachSashController(api);
  const drag = createDragController(api);

  /** @param {EventTarget | null} target */
  const tabAt = (target) => /** @type {HTMLElement | null} */ (/** @type {Element} */ (target).closest?.('.widget-tab'));

  // A window's head drags it; a tab drags its window, shown as it is pressed.
  gridEl.addEventListener('pointerdown', (event) => {
    const target = /** @type {Element} */ (event.target);
    const head = target.closest('.widget-head');
    if (!head || isStacked() || target.closest('.widget-close, .widget-plus, .widget-actions, .widget-tab-close')) return;
    const tab = tabAt(target);
    if (tab && event.button === 1) event.preventDefault(); // a middle click closes it, never scrolls
    if (event.button !== 0) return;
    const frameEl = /** @type {HTMLElement} */ (head.closest('.widget'));
    const id = /** @type {string} */ (tab?.dataset.id ?? frameEl.dataset.id);
    if (tab) showTab(id);
    drag.start({ kind: 'move', id }, event, {
      label: /** @type {Element} */ (tab?.querySelector('.widget-tab-name') ?? head.querySelector('.widget-title')).textContent,
    });
  });

  gridEl.addEventListener('click', (event) => {
    const target = /** @type {Element} */ (event.target);
    const tab = tabAt(target);
    if (tab && target.closest('.widget-tab-close')) return closeWindow(/** @type {string} */ (tab.dataset.id));
    if (tab) return showTab(/** @type {string} */ (tab.dataset.id));
    const close = target.closest('.widget-close');
    if (close) return closeWindow(/** @type {string} */ (/** @type {HTMLElement} */ (close.closest('.widget')).dataset.id));
    const add = target.closest('.widget-plus');
    if (add) newTabBeside(/** @type {string} */ (/** @type {HTMLElement} */ (add.closest('.widget')).dataset.id));
  });

  gridEl.addEventListener('auxclick', (event) => {
    const tab = tabAt(event.target);
    if (tab && event.button === 1) closeWindow(/** @type {string} */ (tab.dataset.id));
  });

  // A strip's tabs, as a tablist: arrows (and Home, End) show the next one, Delete closes one.
  gridEl.addEventListener('keydown', (event) => {
    const tab = tabAt(event.target);
    if (!tab || event.altKey || event.ctrlKey || event.metaKey) return;
    const tabs = /** @type {HTMLElement[]} */ ([.../** @type {HTMLElement} */ (tab.parentElement).children]);
    const at = tabs.indexOf(tab);
    const to = { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: tabs.length - 1 }[event.key];
    if (to !== undefined) {
      event.preventDefault();
      focusTab = /** @type {string} */ (tabs[(to + tabs.length) % tabs.length].dataset.id);
      if (!showTab(focusTab)) drawTabs(); // already shown: no redraw to move focus
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      // Focus stays in the strip: on the tab shown next, as the stack (if any is left) shows it.
      focusTab = /** @type {string | undefined} */ ((tabs[at + 1] ?? tabs[at - 1])?.dataset.id) ?? null;
      closeWindow(/** @type {string} */ (tab.dataset.id));
    }
  });

  gridEl.addEventListener('keydown', (event) => {
    const grip = /** @type {Element} */ (event.target).closest?.('.widget-grip');
    if (!grip) return;
    const id = /** @type {string} */ (/** @type {HTMLElement} */ (grip.closest('.widget')).dataset.id);
    const tree = layoutAtom.get();
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      api.commitTree(removeLeaf(tree, id), { animate: true });
      return;
    }
    const dir = DIRECTION_KEYS[event.key];
    if (!dir || !event.altKey || !event.shiftKey) return;
    event.preventDefault();
    const neighbor = findNeighbor(shownRects(layout), id, dir);
    const next = neighbor
      ? moveLeaf(tree, id, neighbor, dir)
      : applyDrop(tree, { source: { kind: 'move', id }, target: { kind: 'edge' }, dir });
    api.commitTree(next, { animate: true });
  });

  palette = createPalette({
    panel: query(root, '#palette'),
    toggle: query(root, '#palette-toggle'),
    widgets: WIDGETS,
    drag,
    onAdd: addWidget,
  });

  query(root, '.topbar-actions').prepend(
    createScreenSwitcher({ opened, describe: (tree) => describeWindows(tree, titleOf) }).root,
  );
  query(root, '.topbar-actions').prepend(createZoomControl().root);
  query(root, '.topbar-actions').prepend(createSpotlight({ daemon, show: (params) => showWidget('omp', params) }).root);
  // Desktop notifications follow every awake session; Config turns them on or off. A window
  // stacked behind another shows its conversation to nobody.
  const notifier = createNotifier({
    daemon,
    shown: () => {
      const screen = screenAtom.get();
      return new Set(sessionLinks({ ...screen, windows: screen.windows.filter((w) => !layout.hidden.has(w.id)) }).windows.keys());
    },
    show: (params) => showWidget('omp', params),
  });
  query(root, '.topbar-actions').prepend(createConfigMenu({ daemon, notifier }).root);
  // Shown only while this page runs older UI files than the daemon serves.
  query(root, '.topbar-actions').prepend(createUpdateNotice({ daemon }).root);

  // Until this machine has what agents need (daemon/settings.js `setupDone`), an empty screen
  // opens Setup: decided once, as the page first hears the daemon's settings.
  let setupOffered = false;
  function offerSetup() {
    const atDaemon = daemon.settings();
    if (setupOffered || !atDaemon || !opened.ok) return;
    setupOffered = true;
    if (!atDaemon.setupDone && !layoutAtom.get()) addWidget('setup');
  }
  daemon.onSettings(offerSetup);
  offerSetup();

  schedule();
  return { api };
}
