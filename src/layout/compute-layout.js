/**
 * Turns a split tree into absolute pixel rects for leaves and sashes.
 * Pure: the renderer diff-writes the result to the DOM.
 */

/** @import { Axis, Branch, GridNode, Tree } from './grid-model.js' */
/** @typedef {{ x: number, y: number, w: number, h: number }} Rect */
/** @typedef {{ gap: number, minWidth: number, minHeight: number }} LayoutOptions */
/**
 * A divider between children `index` and `index + 1` of the branch at `path`.
 * `pos` is its offset along the branch axis; `start`/`end` bound the pair it splits.
 * @typedef {Rect & { path: number[], index: number, axis: Axis, pos: number, start: number, end: number,
 *   minBefore: number, minAfter: number }} Sash
 */
/**
 * `leaves`: every window's rect (a stack's tabs share their slot's); `hidden`: the tabs stacked
 * behind the one their stack shows, which the renderer hides and drops never land on.
 * @typedef {{ leaves: Map<string, Rect>, hidden: Set<string>, sashes: Sash[] }} Layout
 */

/** @param {number[]} xs */
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/**
 * Minimum pixel extent of `node` along `axis` ('row' = width, 'col' = height).
 * @param {Tree} node @param {Axis} axis @param {LayoutOptions} opts
 * @returns {number}
 */
export function minSize(node, axis, opts) {
  if (!node) return 0;
  if (node.kind !== 'branch') return axis === 'row' ? opts.minWidth : opts.minHeight;
  const mins = node.children.map((c) => minSize(c, axis, opts));
  return node.axis === axis ? sum(mins) + opts.gap * (mins.length - 1) : Math.max(...mins);
}

/** @param {Branch} node @param {number} start @param {number} total @param {number} gap */
function childEdges(node, start, total, gap) {
  const n = node.children.length;
  const available = Math.max(0, total - gap * (n - 1));
  const cumulative = node.sizes.map((_, i) => (i === n - 1 ? 1 : sum(node.sizes.slice(0, i + 1))));

  // Round cumulative positions (not individual sizes) so edges never drift apart.
  return node.children.map((_, i) => {
    const before = i === 0 ? 0 : cumulative[i - 1];
    return {
      start: start + Math.round(before * available) + gap * i,
      end: start + Math.round(cumulative[i] * available) + gap * i,
    };
  });
}

/** @param {GridNode} node @param {Rect} rect @param {number[]} path @param {LayoutOptions} opts @param {Layout} out */
function place(node, rect, path, opts, out) {
  if (node.kind === 'leaf') {
    out.leaves.set(node.id, rect);
    return;
  }
  if (node.kind === 'stack') {
    for (const tab of node.tabs) {
      out.leaves.set(tab.id, rect);
      if (tab.id !== node.active) out.hidden.add(tab.id);
    }
    return;
  }

  const horizontal = node.axis === 'row';
  const edges = childEdges(node, horizontal ? rect.x : rect.y, horizontal ? rect.w : rect.h, opts.gap);

  edges.slice(0, -1).forEach((edge, i) => {
    const pos = edge.end;
    out.sashes.push({
      path,
      index: i,
      axis: node.axis,
      pos,
      start: edge.start,
      end: edges[i + 1].end,
      minBefore: minSize(node.children[i], node.axis, opts),
      minAfter: minSize(node.children[i + 1], node.axis, opts),
      ...(horizontal
        ? { x: pos, y: rect.y, w: opts.gap, h: rect.h }
        : { x: rect.x, y: pos, w: rect.w, h: opts.gap }),
    });
  });

  node.children.forEach((child, i) => {
    const { start, end } = edges[i];
    const childRect = horizontal
      ? { x: start, y: rect.y, w: end - start, h: rect.h }
      : { x: rect.x, y: start, w: rect.w, h: end - start };
    place(child, childRect, [...path, i], opts, out);
  });
}

/** @param {Tree} tree @param {Rect} bounds @param {LayoutOptions} opts @returns {Layout} */
export function computeLayout(tree, bounds, opts) {
  /** @type {Layout} */
  const out = { leaves: new Map(), hidden: new Set(), sashes: [] };
  if (tree) place(tree, bounds, [], opts, out);
  return out;
}
