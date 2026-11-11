/**
 * Workspaces and their screens, kept free of the DOM and shared with the daemon: valid names
 * and ids, and which screen a new window claims.
 *
 * A workspace is everything one user lays out across their browser windows; each window is
 * one of its screens, like an extra monitor, with a layout tree of its own.
 */
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
