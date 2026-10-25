/**
 * Split-tree layout model (same shape as VS Code's GridView).
 *
 * `sizes` are fractions of the branch's space (excluding gaps) and sum to 1.
 * Every export is pure: inputs are never mutated, new trees are returned.
 */

/** @typedef {'row' | 'col'} Axis */
/** @typedef {'left' | 'right' | 'up' | 'down' | 'center'} Direction */
/**
 * Settings a widget owns for one window, e.g. which agent session it shows. Flat and
 * JSON-safe so the layout stays one serialisable value.
 * @typedef {Record<string, string | number | boolean | null>} LeafParams
 */
/** @typedef {{ kind: 'leaf', id: string, widget: string, params?: LeafParams }} Leaf */
/** @typedef {{ kind: 'branch', axis: Axis, children: GridNode[], sizes: number[] }} Branch */
/** @typedef {Leaf | Branch} GridNode */
/** A whole layout; `null` is the empty grid. @typedef {GridNode | null} Tree */
/**
 * A tree mid-edit: children may be `null` until `normalize` drops them.
 * @typedef {{ kind: 'branch', axis: Axis, children: (Draft | null)[], sizes: number[] }} DraftBranch
 * @typedef {Leaf | DraftBranch} Draft
 */
/**
 * What is dropped: a window already in the tree, or a new one. A new one marked `into` may
 * also land on the middle of a window of its own widget type, which then takes its params
 * (shows what was dragged) instead of a window being added.
 * @typedef {{ kind: 'move', id: string } | { kind: 'new', leaf: Leaf, into?: boolean }} DropSource
 */
/** @typedef {{ kind: 'leaf', id: string } | { kind: 'edge' } | { kind: 'empty' }} DropTarget */
/** @typedef {{ source: DropSource, target: DropTarget, dir: Direction }} DropOp */

/** @type {readonly Axis[]} */
const AXES = Object.freeze(['row', 'col']);

const MAX_DEPTH = 32;
const SUM_TOLERANCE = 1e-6;
const EDGE_SHARE = 1 / 3;

/** @param {string} id @param {string} widget @returns {Leaf} */
export const leaf = (id, widget) => ({ kind: 'leaf', id, widget });

/** @param {Axis} axis @param {GridNode[]} children @param {number[]} [sizes] @returns {Branch} */
export const branch = (axis, children, sizes) => ({
  kind: 'branch',
  axis,
  children,
  sizes: sizes ?? children.map(() => 1 / children.length),
});

/** @param {Direction} dir @returns {Axis} */
const axisFor = (dir) => (dir === 'left' || dir === 'right' ? 'row' : 'col');
/** @param {Direction} dir */
const isBefore = (dir) => dir === 'left' || dir === 'up';

/** @param {Tree} node @returns {Leaf[]} */
export function listLeaves(node) {
  if (!node) return [];
  if (node.kind === 'leaf') return [node];
  return node.children.flatMap(listLeaves);
}

/** @param {Tree} tree @param {string} id */
export const findLeaf = (tree, id) => listLeaves(tree).find((l) => l.id === id) ?? null;

/** @param {Tree} tree @param {readonly number[]} path @returns {Tree} */
export const nodeAt = (tree, path) =>
  path.reduce((node, i) => (node?.kind === 'branch' ? (node.children[i] ?? null) : null), tree);

/** @param {GridNode} node @param {(leaf: Leaf) => Leaf} fn @returns {GridNode} */
function mapLeaves(node, fn) {
  if (node.kind === 'leaf') return fn(node);
  return { ...node, children: node.children.map((c) => mapLeaves(c, fn)) };
}

/**
 * Flatten same-axis nesting, lift single children, drop empties, repair sizes.
 * @param {Draft | null} node
 * @returns {Tree}
 */
export function normalize(node) {
  if (!node || node.kind === 'leaf') return node;

  const pairs = node.children.flatMap((child, i) => {
    const c = normalize(child);
    if (!c) return [];
    const size = Math.max(0, node.sizes[i] ?? 0);
    if (c.kind === 'branch' && c.axis === node.axis) {
      return c.children.map((grandchild, j) => /** @type {[GridNode, number]} */ ([grandchild, size * c.sizes[j]]));
    }
    return [/** @type {[GridNode, number]} */ ([c, size])];
  });

  if (pairs.length === 0) return null;
  if (pairs.length === 1) return pairs[0][0];

  const total = pairs.reduce((acc, [, s]) => acc + s, 0);
  const sizes = pairs.map(([, s]) => {
    if (total <= 0) return 1 / pairs.length;
    return Math.abs(total - 1) < SUM_TOLERANCE ? s : s / total;
  });

  return { kind: 'branch', axis: node.axis, children: pairs.map(([c]) => c), sizes };
}

/**
 * @param {GridNode} node @param {string} targetId @param {Axis} axis
 * @param {boolean} before @param {Leaf} newLeaf
 * @returns {GridNode}
 */
function insertInto(node, targetId, axis, before, newLeaf) {
  if (node.kind === 'leaf') {
    if (node.id !== targetId) return node;
    return branch(axis, before ? [newLeaf, node] : [node, newLeaf], [0.5, 0.5]);
  }

  const idx = node.children.findIndex((c) => c.kind === 'leaf' && c.id === targetId);
  if (idx !== -1 && node.axis === axis) {
    const half = node.sizes[idx] / 2;
    const at = before ? idx : idx + 1;
    return {
      ...node,
      children: node.children.toSpliced(at, 0, newLeaf),
      sizes: node.sizes.map((s, i) => (i === idx ? half : s)).toSpliced(at, 0, half),
    };
  }

  return { ...node, children: node.children.map((c) => insertInto(c, targetId, axis, before, newLeaf)) };
}

/**
 * Split `targetId` and place `newLeaf` on the `dir` side of it.
 * @param {Tree} tree @param {string} targetId @param {Direction} dir @param {Leaf} newLeaf
 * @returns {Tree}
 */
export function insertBeside(tree, targetId, dir, newLeaf) {
  if (!tree) return newLeaf;
  if (dir === 'center' || !findLeaf(tree, targetId)) return tree;
  return normalize(insertInto(tree, targetId, axisFor(dir), isBefore(dir), newLeaf));
}

/**
 * Place `newLeaf` along an outer edge of the whole grid, spanning it fully.
 * @param {Tree} tree @param {Direction} dir @param {Leaf} newLeaf
 * @returns {Tree}
 */
export function insertAtEdge(tree, dir, newLeaf) {
  if (!tree) return newLeaf;
  const axis = axisFor(dir);
  const before = isBefore(dir);

  if (tree.kind === 'branch' && tree.axis === axis) {
    const share = Math.min(EDGE_SHARE, 1 / (tree.children.length + 1));
    const scaled = tree.sizes.map((s) => s * (1 - share));
    return normalize({
      ...tree,
      children: before ? [newLeaf, ...tree.children] : [...tree.children, newLeaf],
      sizes: before ? [share, ...scaled] : [...scaled, share],
    });
  }

  const sizes = before ? [EDGE_SHARE, 1 - EDGE_SHARE] : [1 - EDGE_SHARE, EDGE_SHARE];
  return normalize(branch(axis, before ? [newLeaf, tree] : [tree, newLeaf], sizes));
}

/** @param {Draft} node @param {string} id @returns {Draft | null} */
function removeFrom(node, id) {
  if (node.kind === 'leaf') return node.id === id ? null : node;

  const idx = node.children.findIndex((c) => c?.kind === 'leaf' && c.id === id);
  if (idx === -1) {
    return { ...node, children: node.children.map((c) => c && removeFrom(c, id)) };
  }

  // Freed space goes to the adjacent sibling so the rest of the grid stays still.
  const receiver = idx > 0 ? idx - 1 : 1;
  const freed = node.sizes[idx];
  return {
    ...node,
    children: node.children.filter((_, i) => i !== idx),
    sizes: node.sizes.map((s, i) => (i === receiver ? s + freed : s)).filter((_, i) => i !== idx),
  };
}

/** @param {Tree} tree @param {string} id @returns {Tree} */
export function removeLeaf(tree, id) {
  if (!tree) return null;
  return normalize(removeFrom(tree, id));
}

/** @param {Tree} tree @param {string} aId @param {string} bId @returns {Tree} */
export function swapLeaves(tree, aId, bId) {
  const a = findLeaf(tree, aId);
  const b = findLeaf(tree, bId);
  if (!tree || !a || !b || aId === bId) return tree;
  return mapLeaves(tree, (l) => (l.id === aId ? b : l.id === bId ? a : l));
}

/**
 * Merges `patch` into one leaf's params. Unknown ids leave the tree unchanged.
 * @param {Tree} tree @param {string} id @param {LeafParams} patch @returns {Tree}
 */
export function setLeafParams(tree, id, patch) {
  if (!tree || !findLeaf(tree, id)) return tree;
  return mapLeaves(tree, (l) => (l.id === id ? { ...l, params: { ...l.params, ...patch } } : l));
}

/** @param {Tree} tree @param {string} id @param {string} targetId @param {Direction} dir @returns {Tree} */
export function moveLeaf(tree, id, targetId, dir) {
  if (id === targetId) return tree;
  const moving = findLeaf(tree, id);
  if (!moving || !findLeaf(tree, targetId)) return tree;
  if (dir === 'center') return swapLeaves(tree, id, targetId);
  return insertBeside(removeLeaf(tree, id), targetId, dir, moving);
}

/**
 * Whether `source` may land on the middle of window `id`: a new window marked `into`, onto a
 * window of the same widget type.
 * @param {Tree} tree @param {DropSource} source @param {string} id
 */
export const canDropInto = (tree, source, id) =>
  source.kind === 'new' && source.into === true && findLeaf(tree, id)?.widget === source.leaf.widget;

/**
 * Single entry point used by drag & drop and by previews.
 * @param {Tree} tree @param {DropOp} op
 * @returns {Tree}
 */
export function applyDrop(tree, { source, target, dir }) {
  const moving = source.kind === 'move' ? findLeaf(tree, source.id) : source.leaf;
  if (!moving) return tree;
  if (!tree || target.kind === 'empty') return tree ?? moving;

  if (target.kind === 'edge') {
    return insertAtEdge(source.kind === 'move' ? removeLeaf(tree, source.id) : tree, dir, moving);
  }
  if (target.kind === 'leaf') {
    if (source.kind === 'move') return moveLeaf(tree, source.id, target.id, dir);
    if (dir !== 'center') return insertBeside(tree, target.id, dir, moving);
    return canDropInto(tree, source, target.id) ? setLeafParams(tree, target.id, moving.params ?? {}) : tree;
  }
  return tree;
}

/** @param {GridNode} node @param {readonly number[]} path @param {readonly number[]} sizes @returns {GridNode} */
function resize(node, path, sizes) {
  if (node.kind !== 'branch') return node;
  if (path.length === 0) {
    return sizes.length === node.children.length ? { ...node, sizes: [...sizes] } : node;
  }
  const [head, ...rest] = path;
  return { ...node, children: node.children.map((c, i) => (i === head ? resize(c, rest, sizes) : c)) };
}

/** @param {Tree} tree @param {readonly number[]} path @param {readonly number[]} sizes @returns {Tree} */
export const setSizes = (tree, path, sizes) => tree && resize(tree, path, sizes);

/**
 * Schema check for untrusted data (e.g. layouts sent to or read by the daemon).
 * @param {unknown} data
 * @returns {data is Tree}
 */
export function isValidTree(data) {
  if (data === null) return true;
  const seen = new Set();

  /** @param {any} n @param {number} depth @returns {boolean} */
  const check = (n, depth) => {
    if (!n || typeof n !== 'object' || depth > MAX_DEPTH) return false;
    if (n.kind === 'leaf') {
      if (typeof n.id !== 'string' || typeof n.widget !== 'string' || seen.has(n.id)) return false;
      if ('params' in n && !isValidParams(n.params)) return false;
      seen.add(n.id);
      return true;
    }
    if (n.kind !== 'branch' || !AXES.includes(n.axis)) return false;
    if (!Array.isArray(n.children) || !Array.isArray(n.sizes)) return false;
    if (n.children.length < 2 || n.children.length !== n.sizes.length) return false;
    if (!n.sizes.every((/** @type {unknown} */ s) => typeof s === 'number' && Number.isFinite(s) && s >= 0)) return false;
    return n.children.every((/** @type {unknown} */ c) => check(c, depth + 1));
  };

  return check(data, 0);
}

/** @param {any} params @returns {boolean} */
function isValidParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return false;
  return Object.values(params).every(
    (v) => v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)),
  );
}
