/**
 * Split-tree layout model (same shape as VS Code's GridView).
 *
 * `sizes` are fractions of the branch's space (excluding gaps) and sum to 1. A slot of the grid
 * holds one window (a leaf) or a stack: several windows, shown one at a time as tabs, each
 * keeping its own id, widget and params.
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
/**
 * Windows sharing one slot as tabs, in tab order: at least two, `active` the id of the one shown.
 * @typedef {{ kind: 'stack', tabs: Leaf[], active: string }} Stack
 */
/** One slot of the grid: a window, or a stack of them. @typedef {Leaf | Stack} Slot */
/** @typedef {{ kind: 'branch', axis: Axis, children: GridNode[], sizes: number[] }} Branch */
/** @typedef {Slot | Branch} GridNode */
/** A whole layout; `null` is the empty grid. @typedef {GridNode | null} Tree */
/**
 * A tree mid-edit: children may be `null` until `normalize` drops them.
 * @typedef {{ kind: 'branch', axis: Axis, children: (Draft | null)[], sizes: number[] }} DraftBranch
 * @typedef {Slot | DraftBranch} Draft
 */
/**
 * What is dropped: a window already in the tree, or a new one. Dropped on the middle of a
 * window, it joins that window's slot as a tab; but a new one marked `into` dropped on the
 * middle of a window of its own widget type gives that window its params (shows what was
 * dragged there) instead of a window being added.
 * @typedef {{ kind: 'move', id: string } | { kind: 'new', leaf: Leaf, into?: boolean }} DropSource
 */
/**
 * Where it is dropped: beside or into window `id` (`leaf`, the drop's `dir` saying where), into
 * the tab strip of the slot holding window `id` (`tab`, at `index` among the tabs there other
 * than the one dropped), along an outer edge of the grid, or into an empty grid.
 * @typedef {{ kind: 'leaf', id: string } | { kind: 'tab', id: string, index: number } | { kind: 'edge' } | { kind: 'empty' }} DropTarget
 */
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

/** A slot's windows, in tab order. @param {Slot} slot @returns {Leaf[]} */
export const tabsOf = (slot) => (slot.kind === 'stack' ? slot.tabs : [slot]);

/**
 * The slot holding `tabs`, showing `active` (else the first): a stack, or the window alone.
 * @param {readonly Leaf[]} tabs at least one @param {string} active @returns {Slot}
 */
function slotOf(tabs, active) {
  const [first, ...more] = tabs;
  if (more.length === 0) return first;
  return { kind: 'stack', tabs: [...tabs], active: tabs.some((t) => t.id === active) ? active : first.id };
}

/** @param {Draft} node @param {string} id */
const holds = (node, id) => node.kind !== 'branch' && tabsOf(node).some((t) => t.id === id);

/** Every window, a stack's tabs included, in screen order. @param {Tree} node @returns {Leaf[]} */
export function listLeaves(node) {
  if (!node) return [];
  if (node.kind !== 'branch') return tabsOf(node);
  return node.children.flatMap(listLeaves);
}

/** @param {Tree} node @returns {Stack[]} */
export function listStacks(node) {
  if (!node || node.kind === 'leaf') return [];
  if (node.kind === 'stack') return [node];
  return node.children.flatMap(listStacks);
}

/** @param {Tree} tree @param {string} id */
export const findLeaf = (tree, id) => listLeaves(tree).find((l) => l.id === id) ?? null;

/** The slot holding window `id`: the window itself, or the stack it is a tab of. @param {Tree} tree @param {string} id @returns {Slot | null} */
export function findSlot(tree, id) {
  if (!tree) return null;
  if (tree.kind !== 'branch') return holds(tree, id) ? tree : null;
  for (const child of tree.children) {
    const slot = findSlot(child, id);
    if (slot) return slot;
  }
  return null;
}

/** @param {Tree} tree @param {readonly number[]} path @returns {Tree} */
export const nodeAt = (tree, path) =>
  path.reduce((node, i) => (node?.kind === 'branch' ? (node.children[i] ?? null) : null), tree);

/** @param {GridNode} node @param {(leaf: Leaf) => Leaf} fn @returns {GridNode} */
function mapLeaves(node, fn) {
  if (node.kind === 'leaf') return fn(node);
  if (node.kind === 'stack') return { ...node, tabs: node.tabs.map(fn) };
  return { ...node, children: node.children.map((c) => mapLeaves(c, fn)) };
}

/** Replaces the slot holding window `id`. @param {GridNode} node @param {string} id @param {(slot: Slot) => Slot} fn @returns {GridNode} */
function mapSlot(node, id, fn) {
  if (node.kind !== 'branch') return holds(node, id) ? fn(node) : node;
  return { ...node, children: node.children.map((c) => mapSlot(c, id, fn)) };
}

/**
 * Flatten same-axis nesting, lift single children, drop empties, repair sizes.
 * @param {Draft | null} node
 * @returns {Tree}
 */
export function normalize(node) {
  if (!node || node.kind !== 'branch') return node;

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
  if (node.kind !== 'branch') {
    if (!holds(node, targetId)) return node;
    return branch(axis, before ? [newLeaf, node] : [node, newLeaf], [0.5, 0.5]);
  }

  const idx = node.children.findIndex((c) => holds(c, targetId));
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
 * Split the slot holding `targetId` and place `newLeaf` on the `dir` side of it.
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
  if (node.kind === 'stack') {
    const at = node.tabs.findIndex((t) => t.id === id);
    if (at === -1) return node;
    const tabs = node.tabs.toSpliced(at, 1);
    // Closing the tab shown shows the one that took its place, else the one before it.
    const next = node.active === id ? tabs[Math.min(at, tabs.length - 1)].id : node.active;
    return slotOf(tabs, next);
  }

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

/**
 * Adds `newLeaf` to the slot holding `targetId` as a tab, at `index` among its tabs (at the
 * end by default), and shows it. A window already in the tree is not added twice.
 * @param {Tree} tree @param {string} targetId @param {Leaf} newLeaf @param {number} [index]
 * @returns {Tree}
 */
export function addTab(tree, targetId, newLeaf, index = Infinity) {
  if (!tree || !findLeaf(tree, targetId) || findLeaf(tree, newLeaf.id)) return tree;
  return mapSlot(tree, targetId, (slot) => slotOf(tabsOf(slot).toSpliced(Math.max(0, index), 0, newLeaf), newLeaf.id));
}

/** Shows window `id`, if it is a tab of a stack. @param {Tree} tree @param {string} id @returns {Tree} */
export function activateTab(tree, id) {
  const slot = findSlot(tree, id);
  if (!tree || slot?.kind !== 'stack' || slot.active === id) return tree;
  return mapSlot(tree, id, () => ({ ...slot, active: id }));
}

/**
 * Moves tab `id` within its stack to `index` among the stack's other tabs.
 * @param {Tree} tree @param {string} id @param {number} index @returns {Tree}
 */
export function moveTab(tree, id, index) {
  const slot = findSlot(tree, id);
  if (!tree || slot?.kind !== 'stack') return tree;
  const from = slot.tabs.findIndex((t) => t.id === id);
  const others = slot.tabs.toSpliced(from, 1);
  const to = Math.min(Math.max(0, index), others.length);
  if (to === from) return tree;
  return mapSlot(tree, id, () => ({ ...slot, tabs: others.toSpliced(to, 0, slot.tabs[from]) }));
}

/**
 * Merges `patch` into one leaf's params. Unknown ids leave the tree unchanged.
 * @param {Tree} tree @param {string} id @param {LeafParams} patch @returns {Tree}
 */
export function setLeafParams(tree, id, patch) {
  if (!tree || !findLeaf(tree, id)) return tree;
  return mapLeaves(tree, (l) => (l.id === id ? { ...l, params: { ...l.params, ...patch } } : l));
}

/**
 * Moves window `id` to the `dir` side of the slot holding `targetId`, or into it as a tab
 * (`center`). A tab moved beside its own stack leaves it, for a slot of its own beside it.
 * @param {Tree} tree @param {string} id @param {string} targetId @param {Direction} dir @returns {Tree}
 */
export function moveLeaf(tree, id, targetId, dir) {
  const moving = findLeaf(tree, id);
  const slot = findSlot(tree, targetId);
  if (!moving || !slot) return tree;
  if (!holds(slot, id)) {
    const rest = removeLeaf(tree, id);
    return dir === 'center' ? addTab(rest, targetId, moving) : insertBeside(rest, targetId, dir, moving);
  }
  const stays = tabsOf(slot).find((t) => t.id !== id);
  if (dir === 'center' || !stays) return tree;
  return insertBeside(removeLeaf(tree, id), stays.id, dir, moving);
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

  const rest = () => (source.kind === 'move' ? removeLeaf(tree, source.id) : tree);
  if (target.kind === 'edge') return insertAtEdge(rest(), dir, moving);
  if (target.kind === 'tab') {
    const slot = findSlot(tree, target.id);
    if (slot && holds(slot, moving.id)) return moveTab(tree, moving.id, target.index);
    return addTab(rest(), target.id, moving, target.index);
  }
  if (target.kind === 'leaf') {
    if (source.kind === 'move') return moveLeaf(tree, source.id, target.id, dir);
    if (dir !== 'center') return insertBeside(tree, target.id, dir, moving);
    return canDropInto(tree, source, target.id) ? setLeafParams(tree, target.id, moving.params ?? {}) : addTab(tree, target.id, moving);
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
    if (n.kind === 'stack') {
      if (!Array.isArray(n.tabs) || n.tabs.length < 2 || typeof n.active !== 'string') return false;
      if (!n.tabs.every((/** @type {any} */ t) => t?.kind === 'leaf' && check(t, depth + 1))) return false;
      return n.tabs.some((/** @type {Leaf} */ t) => t.id === n.active);
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
