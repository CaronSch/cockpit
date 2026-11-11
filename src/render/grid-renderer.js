/**
 * Imperative, diffed DOM writer for the grid.
 *
 * - Frames are keyed by leaf id and mounted once; layout changes only move them.
 * - Every style write is skipped when the cached value is unchanged
 *   (the same trick as VS Code's FastDomNode).
 * - Structural changes animate with FLIP on `transform` only.
 * - A stack's tabs share their slot's rect; those behind the one it shows stay mounted (their
 *   state, scroll and all, is kept) but hidden and inert (`is-tab-hidden`).
 */
import { listLeaves } from '../layout/grid-model.js';

/** @import { Axis, Leaf, Tree } from '../layout/grid-model.js' */
/** @import { Layout, Rect, Sash } from '../layout/compute-layout.js' */
/** A mounted widget: its frame element plus an optional teardown hook. @typedef {{ el: HTMLElement, destroy?: () => void }} MountedWidget */
/**
 * @typedef {object} GridRendererOptions
 * @property {(leaf: Leaf) => MountedWidget} mountWidget
 * @property {() => boolean} prefersReducedMotion
 */
/** @typedef {{ el: HTMLElement, widget: string, instance: MountedWidget, rect: Rect | null }} Frame */
/** @typedef {{ el: HTMLElement, rect: Rect | null, axis?: Axis, percent?: number }} SashEntry */
/** @typedef {ReturnType<typeof createGridRenderer>} GridRenderer */

const FLIP_MS = 220;
const ENTER_MS = 180;
const EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';

/** @param {Pick<Sash, 'path' | 'index'>} sash */
export const sashKey = (sash) => `${sash.path.join('.')}/${sash.index}`;

/** @param {Rect | null} a @param {Rect | null} b */
const sameRect = (a, b) => a && b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/** @param {HTMLElement} el @param {Rect | null} prev @param {Rect} next */
function writeRect(el, prev, next) {
  if (sameRect(prev, next)) return;
  if (!prev || prev.x !== next.x || prev.y !== next.y) {
    el.style.transform = `translate(${next.x}px, ${next.y}px)`;
  }
  if (!prev || prev.w !== next.w) el.style.width = `${next.w}px`;
  if (!prev || prev.h !== next.h) el.style.height = `${next.h}px`;
}

/** @param {HTMLElement} el @param {Rect} prev @param {Rect} next */
function flip(el, prev, next) {
  el.animate(
    [
      { transform: `translate3d(${prev.x}px, ${prev.y}px, 0) scale(${prev.w / next.w}, ${prev.h / next.h})` },
      { transform: `translate3d(${next.x}px, ${next.y}px, 0) scale(1, 1)` },
    ],
    { duration: FLIP_MS, easing: EASE },
  );
}

/** @param {HTMLElement} gridEl @param {GridRendererOptions} options */
export function createGridRenderer(gridEl, { mountWidget, prefersReducedMotion }) {
  /** @type {Map<string, Frame>} */
  const frames = new Map();
  /** @type {Map<string, SashEntry>} */
  const sashes = new Map();

  /** @param {string} id */
  function destroyFrame(id) {
    const frame = frames.get(id);
    if (!frame) return;
    try {
      frame.instance.destroy?.();
    } catch (err) {
      console.error(`[renderer] widget "${frame.widget}" failed to clean up`, err);
    }
    frame.el.remove();
    frames.delete(id);
  }

  /** @param {Tree} tree @param {Layout} layout @param {boolean} animate */
  function syncFrames(tree, layout, animate) {
    /** @type {Set<string>} */
    const live = new Set();
    const motion = animate && !prefersReducedMotion();

    for (const leaf of listLeaves(tree)) {
      live.add(leaf.id);
      let frame = frames.get(leaf.id);
      if (frame && frame.widget !== leaf.widget) {
        destroyFrame(leaf.id);
        frame = undefined;
      }

      const next = layout.leaves.get(leaf.id);
      if (!next) throw new Error(`[renderer] layout has no rect for leaf "${leaf.id}"`);
      if (!frame) {
        const instance = mountWidget(leaf);
        gridEl.append(instance.el);
        frame = { el: instance.el, widget: leaf.widget, instance, rect: null };
        frames.set(leaf.id, frame);
        writeRect(frame.el, null, next);
        if (motion) frame.el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ENTER_MS, easing: EASE });
      } else {
        if (motion && frame.rect && !sameRect(frame.rect, next)) flip(frame.el, frame.rect, next);
        writeRect(frame.el, frame.rect, next);
      }
      frame.rect = next;
      const hidden = layout.hidden.has(leaf.id);
      if (frame.el.inert !== hidden) {
        frame.el.inert = hidden;
        frame.el.classList.toggle('is-tab-hidden', hidden);
      }
    }

    for (const id of [...frames.keys()]) {
      if (!live.has(id)) destroyFrame(id);
    }
  }

  /** @param {Sash} sash */
  function createSashEl(sash) {
    const el = document.createElement('div');
    el.className = `sash sash-${sash.axis}`;
    el.tabIndex = 0;
    el.setAttribute('role', 'separator');
    el.setAttribute('aria-orientation', sash.axis === 'row' ? 'vertical' : 'horizontal');
    el.setAttribute('aria-label', sash.axis === 'row' ? 'Resize columns' : 'Resize rows');
    el.setAttribute('aria-valuemin', '0');
    el.setAttribute('aria-valuemax', '100');
    gridEl.append(el);
    return el;
  }

  /** @param {Layout} layout */
  function syncSashes(layout) {
    /** @type {Set<string>} */
    const live = new Set();
    for (const sash of layout.sashes) {
      const key = sashKey(sash);
      live.add(key);
      /** @type {SashEntry} */
      const entry = sashes.get(key) ?? { el: createSashEl(sash), rect: null };
      if (entry.axis !== sash.axis) {
        entry.el.className = `sash sash-${sash.axis}`;
        entry.axis = sash.axis;
      }
      entry.el.dataset.key = key;
      writeRect(entry.el, entry.rect, sash);
      entry.rect = { x: sash.x, y: sash.y, w: sash.w, h: sash.h };

      const pairPx = sash.end - sash.start - (sash.axis === 'row' ? sash.w : sash.h);
      const percent = pairPx > 0 ? Math.round(((sash.pos - sash.start) / pairPx) * 100) : 50;
      if (entry.percent !== percent) {
        entry.el.setAttribute('aria-valuenow', String(percent));
        entry.percent = percent;
      }
      sashes.set(key, entry);
    }

    for (const [key, entry] of [...sashes]) {
      if (live.has(key)) continue;
      entry.el.remove();
      sashes.delete(key);
    }
  }

  return {
    /** @param {Tree} tree @param {Layout} layout @param {{ animate?: boolean }} [options] */
    render(tree, layout, { animate = false } = {}) {
      syncFrames(tree, layout, animate);
      syncSashes(layout);
    },
    /** @param {string} id */
    frameElement: (id) => frames.get(id)?.el ?? null,
    /** @param {string} key */
    sashElement: (key) => sashes.get(key)?.el ?? null,
    destroy() {
      [...frames.keys()].forEach(destroyFrame);
      sashes.forEach((entry) => entry.el.remove());
      sashes.clear();
    },
  };
}
