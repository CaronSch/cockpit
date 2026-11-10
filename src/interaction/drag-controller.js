/**
 * Pointer-driven drag & drop for moving widgets and adding new ones.
 *
 * Pointer events instead of native HTML5 DnD: no throttled `dragover`, a ghost
 * we fully control, and touch support. The landing preview is the real result
 * of the drop (applyDrop + computeLayout), recomputed only when the hovered
 * target/zone changes.
 *
 * A drag may also end on an element of the window it started from (`target`: the timeline's
 * bin): armed (`is-drop-armed`) while the drag runs, lit (`is-drop-over`) while the pointer is
 * over it, when the grid previews nothing; released there, the grid stays as it was and `onEnd`
 * says so (`onTarget`).
 */
import { applyDrop, canDropInto } from '../layout/grid-model.js';
import { computeLayout } from '../layout/compute-layout.js';
import { computeDropZone, detectEdgeZone } from '../layout/drop-zone.js';

/** @import { Direction, DropOp, DropSource, DropTarget, Tree } from '../layout/grid-model.js' */
/** @import { Layout, LayoutOptions, Rect } from '../layout/compute-layout.js' */
/** @import { DropIndicator } from '../render/drop-indicator.js' */
/**
 * What `src/app.js` hands to the sash and drag controllers.
 * @typedef {object} GridApi
 * @property {HTMLElement} gridEl
 * @property {DropIndicator} indicator
 * @property {LayoutOptions} layoutOptions
 * @property {() => Tree} getTree
 * @property {() => Layout} getLayout
 * @property {() => Rect} getBounds
 * @property {() => boolean} [isStacked]
 * @property {(id: string) => HTMLElement | null} frameElement
 * @property {(tree: Tree) => void} previewTree
 * @property {(tree: Tree, options?: { animate?: boolean }) => void} commitTree
 * @property {(dragging: boolean) => void} [onDragStateChange]
 */
/** @typedef {{ activated: boolean, dropped: boolean, onTarget: boolean }} DragEndResult */
/** @typedef {{ label?: string, onEnd?: (result: DragEndResult) => void, target?: HTMLElement | null }} DragStartOptions */
/** @typedef {{ target: DropTarget, dir: Direction }} DropHit */
/**
 * @typedef {object} DragSession
 * @property {DropSource} source
 * @property {string} movingId
 * @property {string} label
 * @property {((result: DragEndResult) => void) | undefined} onEnd
 * @property {number} pointerId
 * @property {number} originX
 * @property {number} originY
 * @property {{ clientX: number, clientY: number }} latest
 * @property {boolean} active
 * @property {string | null} key
 * @property {DropOp | null} op
 * @property {Tree} nextTree
 * @property {number} frame
 * @property {DOMRect} [gridRect] set once the drag activates
 * @property {HTMLDivElement} [ghost] set once the drag activates
 * @property {HTMLElement | null} target the element it may end on instead of the grid
 * @property {boolean} overTarget whether the pointer is over `target`
 */
/** @typedef {ReturnType<typeof createDragController>} DragController */

const DRAG_THRESHOLD = 4;
const EDGE_PX = 18;
/** @type {Readonly<Record<Direction, string>>} */
const ZONE_LABEL = { left: 'Left', right: 'Right', up: 'Top', down: 'Bottom', center: 'Swap' };

/** @param {Rect} rect @param {number} x @param {number} y */
const contains = (rect, x, y) => x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;

/** @param {Event} event */
const swallow = (event) => {
  event.stopPropagation();
  event.preventDefault();
};

/**
 * The release that ends a drag is no click on what it lands on, not even on the button the drag
 * started from (Send, Resume), whose click would do what the drag did not. Call it as the
 * pointer is released: the click follows in the same task.
 */
const swallowReleaseClick = () => {
  window.addEventListener('click', swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', swallow, true));
};

/** @param {GridApi} app */
export function createDragController(app) {
  const { gridEl, indicator } = app;
  /** @type {DragSession | null} */
  let session = null;

  /**
   * null = no valid target; undefined = pointer is in a gutter, keep the last target.
   * @param {DragSession} s @param {DOMRect} gridRect @param {number} clientX @param {number} clientY
   * @returns {DropHit | null | undefined}
   */
  function hitTest(s, gridRect, clientX, clientY) {
    const bounds = app.getBounds();
    const x = clientX - gridRect.left;
    const y = clientY - gridRect.top;
    if (!contains(bounds, x, y)) return null;
    if (!app.getTree()) return { target: { kind: 'empty' }, dir: 'center' };

    const edge = detectEdgeZone(x, y, bounds, EDGE_PX);
    if (edge) return { target: { kind: 'edge' }, dir: edge };

    for (const [id, rect] of app.getLayout().leaves) {
      if (!contains(rect, x, y)) continue;
      if (s.source.kind === 'move' && id === s.source.id) return null;
      const allowCenter = s.source.kind === 'move' || canDropInto(app.getTree(), s.source, id);
      return { target: { kind: 'leaf', id }, dir: computeDropZone(x, y, rect, { allowCenter }) };
    }
    return undefined;
  }

  /** @param {DragSession} s */
  function clearTarget(s) {
    s.op = null;
    s.nextTree = null;
    indicator.hide();
  }

  function update() {
    const s = session;
    if (!s) return;
    s.frame = 0;
    const { clientX, clientY } = s.latest;
    // Only scheduled after activate(), which sets both.
    const { ghost, gridRect } = s;
    if (!ghost || !gridRect) return;
    ghost.style.transform = `translate3d(${clientX}px, ${clientY}px, 0)`;

    const over = isOverTarget(s);
    if (over !== s.overTarget) {
      s.overTarget = over;
      s.target?.classList.toggle('is-drop-over', over);
    }
    if (over) {
      s.key = 'target';
      return clearTarget(s);
    }
    const hit = hitTest(s, gridRect, clientX, clientY);
    if (hit === undefined) return;
    const key = hit ? `${hit.target.kind}:${hit.target.kind === 'leaf' ? hit.target.id : ''}:${hit.dir}` : '';
    if (key === s.key) return;
    s.key = key;
    if (!hit) return clearTarget(s);

    const tree = app.getTree();
    /** @type {DropOp} */
    const op = { source: s.source, ...hit };
    const next = applyDrop(tree, op);
    // A new window dropped into another shows there: that window is where it lands.
    const landing = s.source.kind === 'new' && hit.dir === 'center' && hit.target.kind === 'leaf' ? hit.target.id : s.movingId;
    const into = landing !== s.movingId;
    const rect = next === tree ? null : computeLayout(next, app.getBounds(), app.layoutOptions).leaves.get(landing);
    if (!rect) return clearTarget(s);

    s.op = op;
    s.nextTree = next;
    const zone = into ? 'Show here' : (ZONE_LABEL[hit.dir] ?? 'Place');
    indicator.show(rect, app.getBounds(), `${zone} · ${rect.w}×${rect.h}`);
  }

  /** Whether the pointer is over the drag's own target now. @param {DragSession} s */
  function isOverTarget(s) {
    const box = s.target?.getBoundingClientRect();
    const { clientX: x, clientY: y } = s.latest;
    return Boolean(box && box.width > 0 && x >= box.left && x <= box.right && y >= box.top && y <= box.bottom);
  }

  /** @param {DragSession} s */
  function activate(s) {
    s.active = true;
    s.gridRect = gridEl.getBoundingClientRect();
    const ghost = document.createElement('div');
    s.ghost = ghost;
    ghost.className = 'drag-ghost';
    ghost.textContent = s.label;
    document.body.append(ghost);
    document.body.classList.add('is-dragging');
    if (s.source.kind === 'move') app.frameElement(s.source.id)?.classList.add('is-drag-source');
    s.target?.classList.add('is-drop-armed');
    app.onDragStateChange?.(true);
  }

  /** @param {PointerEvent} event */
  function onPointerMove(event) {
    const s = session;
    if (!s || event.pointerId !== s.pointerId) return;
    s.latest = { clientX: event.clientX, clientY: event.clientY };
    if (!s.active) {
      if (Math.hypot(event.clientX - s.originX, event.clientY - s.originY) < DRAG_THRESHOLD) return;
      activate(s);
    }
    event.preventDefault();
    if (!s.frame) s.frame = requestAnimationFrame(update);
  }

  /** @param {{ commit: boolean }} options */
  function end({ commit }) {
    const s = session;
    if (!s) return;
    session = null;
    if (s.frame) cancelAnimationFrame(s.frame);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    window.removeEventListener('keydown', onKeyDown, true);

    // The last move may not have been drawn yet: where the pointer is now decides.
    const onTarget = commit && s.active && isOverTarget(s);
    if (s.active) {
      s.ghost?.remove();
      document.body.classList.remove('is-dragging');
      if (s.source.kind === 'move') app.frameElement(s.source.id)?.classList.remove('is-drag-source');
      s.target?.classList.remove('is-drop-armed', 'is-drop-over');
      indicator.hide();
      app.onDragStateChange?.(false);
    }

    const dropped = Boolean(commit && s.active && s.nextTree && !onTarget);
    if (dropped) app.commitTree(s.nextTree, { animate: true });
    s.onEnd?.({ activated: s.active, dropped, onTarget });
  }

  /** @param {PointerEvent} event */
  function onPointerUp(event) {
    if (!session || event.pointerId !== session.pointerId) return;
    if (session.active) swallowReleaseClick();
    end({ commit: true });
  }

  /** @param {PointerEvent} event */
  function onPointerCancel(event) {
    if (session && event.pointerId === session.pointerId) end({ commit: false });
  }

  /** @param {KeyboardEvent} event */
  function onKeyDown(event) {
    if (event.key !== 'Escape' || !session?.active) return;
    // The Esc is the drag's: nothing else acts on it, and a cancelled keydown is no close
    // request for an open popover (the palette the drag started from stays open).
    event.stopPropagation();
    event.preventDefault();
    end({ commit: false });
    // The pointer is still down: its release ends the gesture Esc cancelled.
    window.addEventListener('pointerup', swallowReleaseClick, { once: true });
  }

  /** @param {DropSource} source @param {PointerEvent} event @param {DragStartOptions} [options] */
  function start(source, event, { label = 'Widget', onEnd, target = null } = {}) {
    if (session || event.button !== 0 || app.isStacked?.()) return;
    session = {
      source,
      movingId: source.kind === 'move' ? source.id : source.leaf.id,
      label,
      onEnd,
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      latest: { clientX: event.clientX, clientY: event.clientY },
      active: false,
      key: null,
      op: null,
      nextTree: null,
      frame: 0,
      target,
      overTarget: false,
    };
    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('keydown', onKeyDown, true);
  }

  return {
    start,
    cancel: () => end({ commit: false }),
  };
}
