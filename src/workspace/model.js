/**
 * Workspaces, kept free of the DOM and shared with the daemon: valid ids and names, the name a
 * new one gets, which one a step to the left or right goes to, how one is described, and
 * another window's save of one taken up without disturbing the windows it left as they were.
 *
 * A workspace is a named layout of windows, as a macOS desktop is: a browser window shows one
 * at a time and switches between them, and two browser windows may show the same one.
 */
import { listLeaves } from '../layout/grid-model.js';
/** @import { GridNode, Leaf, Tree } from '../layout/grid-model.js' */

export const WORKSPACE_ID = /^ws_[0-9a-f]{8}$/;
/** The longest name a workspace may have. */
const NAME_MAX = 40;

export const newWorkspaceId = () => `ws_${crypto.randomUUID().slice(0, 8)}`;

/**
 * `name` as a workspace's name, trimmed, or null when it cannot be one (empty, too long, or
 * holding control characters).
 * @param {unknown} name @returns {string | null}
 */
export function workspaceName(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= NAME_MAX && !/[\u0000-\u001f\u007f]/.test(trimmed) ? trimmed : null;
}

/** The first "Workspace N" none of `taken` is called. @param {readonly string[]} taken */
export function nextWorkspaceName(taken) {
  const names = new Set(taken);
  let n = 1;
  while (names.has(`Workspace ${n}`)) n++;
  return `Workspace ${n}`;
}

/**
 * The workspace a page's query string names (`?workspace=<id>`), or null when it names none.
 * @param {string} search @returns {string | null}
 */
export function workspaceFrom(search) {
  const id = new URLSearchParams(search).get('workspace');
  return id !== null && WORKSPACE_ID.test(id) ? id : null;
}

/**
 * The workspace `step` places from `id` in `ids` (−1: the one before), or null past either
 * end: as on macOS, stepping does not wrap around.
 * @param {readonly string[]} ids @param {string} id @param {number} step @returns {string | null}
 */
export function stepFrom(ids, id, step) {
  const at = ids.indexOf(id);
  return at < 0 ? null : (ids[at + step] ?? null);
}

/**
 * `next`, a layout another browser window saved, with every window whose settings did not
 * change keeping its settings object from `prev` (the layout shown), so only the windows that
 * changed hear of it (registry.js `paramsChanged`).
 * @param {Tree} prev @param {Tree} next @returns {Tree}
 */
export function keepUnchanged(prev, next) {
  const before = new Map(listLeaves(prev).map((l) => [l.id, l]));
  /** @param {Leaf} leaf @returns {Leaf} */
  const keep = (leaf) => {
    const old = before.get(leaf.id);
    return old && old.widget === leaf.widget && JSON.stringify(old.params ?? null) === JSON.stringify(leaf.params ?? null) ? old : leaf;
  };
  /** @param {GridNode} node @returns {GridNode} */
  const walk = (node) => {
    if (node.kind === 'leaf') return keep(node);
    if (node.kind === 'branch') return { ...node, children: node.children.map(walk) };
    return { ...node, tabs: node.tabs.map(keep) };
  };
  return next && walk(next);
}

/**
 * What a workspace holds, e.g. "2 Agent, 1 Notes", kinds in the order they first appear.
 * @param {Tree} tree @param {(widget: string) => string} titleOf @returns {string}
 */
export function describeWindows(tree, titleOf) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const leaf of listLeaves(tree)) {
    const title = titleOf(leaf.widget);
    counts.set(title, (counts.get(title) ?? 0) + 1);
  }
  return counts.size ? [...counts].map(([title, n]) => `${n} ${title}`).join(', ') : 'no windows';
}
