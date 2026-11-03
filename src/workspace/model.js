/**
 * Workspaces and their screens, kept free of the DOM and shared with the daemon: valid names
 * and ids, which screen a new window claims, and how a screen is described.
 *
 * A workspace is everything one user lays out across their browser windows; each window is
 * one of its screens, like an extra monitor, with a layout tree of its own.
 */
import { listLeaves } from '../layout/grid-model.js';
/** @import { Tree } from '../layout/grid-model.js' */

export const DEFAULT_WORKSPACE = 'main';
/** A workspace name becomes a file name: lowercase only, since macOS disks ignore case. */
export const WORKSPACE_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const SCREEN_ID = /^s_[0-9a-f]{8}$/;

export const newScreenId = () => `s_${crypto.randomUUID().slice(0, 8)}`;

/**
 * The workspace a page's query string names (`?workspace=<name>`), `main` when it names none,
 * or null when the name is not a valid one.
 * @param {string} search @returns {string | null}
 */
export function workspaceFrom(search) {
  const name = new URLSearchParams(search).get('workspace');
  if (name === null) return DEFAULT_WORKSPACE;
  return WORKSPACE_NAME.test(name) ? name : null;
}

/** The Web Lock a window holds while it shows a screen. @param {string} workspace @param {string} id */
export const lockName = (workspace, id) => `cockpit:${workspace}:${id}`;

/**
 * The screens a window tries to claim, in order: the one this tab showed before (a reload
 * keeps its screen), then every saved screen in creation order (a browser restart brings its
 * windows back). If all are taken, the window starts a new screen.
 * @param {string | null} remembered @param {readonly string[]} saved @returns {string[]}
 */
export const claimOrder = (remembered, saved) =>
  remembered ? [remembered, ...saved.filter((id) => id !== remembered)] : [...saved];

/**
 * A copy of a layout for a new screen: the same windows with the same settings, each with an
 * id of its own (as the registry gives a new window).
 * @param {Tree} tree @param {() => string} [newId] @returns {Tree}
 */
export function copyLayout(tree, newId = () => `w_${crypto.randomUUID().slice(0, 8)}`) {
  /** @param {import('../layout/grid-model.js').GridNode} node @returns {import('../layout/grid-model.js').GridNode} */
  const copy = (node) =>
    node.kind === 'leaf'
      ? { ...node, id: newId(), ...(node.params ? { params: { ...node.params } } : {}) }
      : { ...node, children: node.children.map(copy), sizes: [...node.sizes] };
  return tree && copy(tree);
}

/**
 * What a screen holds, e.g. "2 Agent, 1 Notes", kinds in the order they first appear.
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
