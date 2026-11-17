/**
 * The workspace this browser window shows: picked as the page opens, switched from the top bar
 * or the keyboard, saved back as its layout changes, and kept in step with other browser
 * windows showing the same one.
 *
 * Picking: the one the address names (`?workspace=<id>`, which the address keeps, so a reload
 * or a duplicated tab shows it again), else the one this browser showed last, else the first.
 *
 * Saving: a change is saved after a short pause, and before a switch; a page going away sends its
 * last change in a keepalive request. Saves go one at a time, each naming the rev it was made
 * from. Another window's save of the same workspace (heard as a `workspaces` event) is shown
 * here once this window has nothing of its own waiting to be saved; a save of this window's that
 * the daemon refuses, as made from a layout another window changed meanwhile, gives way to that
 * window's layout. A workspace deleted elsewhere while shown here gives way to its neighbour.
 *
 * A page that cannot use the daemon (signed out) still works, with a layout kept only in memory;
 * `problem` says why.
 */
import { DaemonError } from '../daemon/client.js';
import { errorMessage } from '../ui/format.js';
import { keepUnchanged, workspaceFrom } from './model.js';
/** @import { DaemonClient } from '../daemon/client.js' */
/** @import { Workspace } from '../../daemon/wire.js' */
/** @import { Leaf, Tree } from '../layout/grid-model.js' */

/**
 * How the layout shown came to change: a switch (`step`: how many places along the list it
 * moved, for the slide), or another window's save.
 * @typedef {{ how: 'switch', step: number } | { how: 'elsewhere' }} TreeChange
 */
/**
 * @typedef {{
 *   id(): string,
 *   tree(): Tree,
 *   list(): readonly Workspace[],
 *   saveError(): string | null,
 *   update(tree: Tree): void,
 *   switchTo(id: string): Promise<void>,
 *   create(): Promise<string>,
 *   rename(id: string, name: string): Promise<void>,
 *   remove(id: string): Promise<void>,
 *   moveWindow(leaf: Leaf, to: string): Promise<void>,
 *   onTree(fn: (tree: Tree, change: TreeChange) => void): () => void,
 *   onChange(fn: () => void): () => void,
 * }} ShownWorkspace
 */
/** @typedef {{ ok: true, shown: ShownWorkspace } | { ok: false, problem: string }} OpenedWorkspace */

const SAVE_DELAY_MS = 250;
const RETRY_MS = 2000;
/** Where this browser notes the workspace it showed last. */
const LAST_KEY = 'cockpit.workspace';
const SIGNED_OUT =
  'This browser is not signed in, so this layout lasts only until the page closes. Open the URL printed by `bun start` to sign in.';

/** @param {{ daemon: DaemonClient }} options @returns {Promise<OpenedWorkspace>} */
export async function openWorkspace({ daemon }) {
  /** @type {readonly Workspace[]} */
  let all;
  try {
    all = await daemon.loadWorkspaces();
  } catch (err) {
    const signedOut = err instanceof DaemonError && (err.status === 401 || err.status === 403);
    return { ok: false, problem: signedOut ? SIGNED_OUT : `This layout cannot be saved: ${errorMessage(err)}` };
  }
  const wanted = [workspaceFrom(location.search), localStorage.getItem(LAST_KEY)];
  const first = wanted.map((id) => all.find((w) => w.id === id)).find(Boolean) ?? all[0];
  return { ok: true, shown: showWorkspace(daemon, first) };
}

/** @param {DaemonClient} daemon @param {Workspace} first @returns {ShownWorkspace} */
function showWorkspace(daemon, first) {
  let id = first.id;
  /** The rev the layout shown was made from. */
  let rev = first.rev;
  /** The layout shown. @type {Tree} */
  let latest = first.tree;
  /** Whether `latest` has changes not yet sent. */
  let dirty = false;
  /** The save on its way, if any. @type {Promise<void> | null} */
  let inflight = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @type {string | null} */
  let saveError = null;
  /** @type {Set<(tree: Tree, change: TreeChange) => void>} */
  const treeListeners = new Set();
  /** @type {Set<() => void>} */
  const listeners = new Set();
  const changed = () => {
    for (const fn of listeners) fn();
  };

  const list = () => daemon.workspaces() ?? [first];

  /** Notes `id` as the one shown: in the address, and for this browser's next new tab. */
  function remember() {
    const url = new URL(location.href);
    url.searchParams.set('workspace', id);
    history.replaceState(history.state, '', url);
    localStorage.setItem(LAST_KEY, id);
  }
  remember();

  /** @param {Tree} tree @param {TreeChange} change */
  function show(tree, change) {
    latest = tree;
    for (const fn of treeListeners) fn(tree, change);
  }

  /** Takes up the daemon's copy of the workspace shown, if another window saved it since. */
  function follow() {
    if (dirty || inflight) return;
    const stored = list().find((w) => w.id === id);
    if (!stored) {
      // Deleted elsewhere: its neighbour, as deleting it here would show.
      const next = list()[0];
      if (next) void switchTo(next.id);
      return;
    }
    if (stored.rev <= rev) return;
    rev = stored.rev;
    show(keepUnchanged(latest, stored.tree), { how: 'elsewhere' });
  }

  function saveSoon() {
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), SAVE_DELAY_MS);
  }

  /** Sends the layout's unsent changes, one save at a time; resolves once none are waiting. */
  async function flush() {
    clearTimeout(timer);
    if (inflight) {
      await inflight;
      return flush();
    }
    if (!dirty) return;
    dirty = false;
    const tree = latest;
    const before = saveError;
    let retry = false;
    inflight = (async () => {
      try {
        const result = await daemon.saveWorkspace(id, tree, rev);
        if (result.ok) rev = result.rev;
        else if (result.current) {
          // Another window changed it first: its layout stands, and this window shows it.
          rev = result.current.rev;
          show(keepUnchanged(latest, result.current.tree), { how: 'elsewhere' });
        }
        saveError = null;
      } catch (err) {
        dirty = true;
        retry = true;
        saveError = errorMessage(err);
      }
    })();
    await inflight;
    inflight = null;
    if (before !== saveError) changed();
    if (retry) timer = setTimeout(() => void flush(), RETRY_MS);
    else if (dirty) return flush(); // changed while the save was on its way
    else follow();
  }

  /** @param {string} target */
  async function switchTo(target) {
    if (target === id && list().some((w) => w.id === id)) return;
    const ids = list().map((w) => w.id);
    const step = ids.indexOf(target) - ids.indexOf(id);
    await flush().catch(() => {});
    const next = list().find((w) => w.id === target);
    if (!next) return;
    id = next.id;
    rev = next.rev;
    remember();
    show(next.tree, { how: 'switch', step });
    changed();
  }

  daemon.onWorkspaces(() => {
    follow();
    changed();
  });

  // A reload or close inside the pause would otherwise lose the last change.
  addEventListener('pagehide', () => {
    if (!dirty || inflight) return;
    clearTimeout(timer);
    dirty = false;
    void daemon.saveWorkspace(id, latest, rev, { keepalive: true }).catch(() => {});
  });

  return {
    id: () => id,
    tree: () => latest,
    list,
    saveError: () => saveError,
    update(tree) {
      if (tree === latest) return; // what this module showed, not a change
      latest = tree;
      dirty = true;
      saveSoon();
    },
    switchTo,
    async create() {
      const made = await daemon.createWorkspace();
      await switchTo(made.id);
      return made.id;
    },
    rename: (target, name) => daemon.renameWorkspace(target, name),
    async remove(target) {
      if (target === id) {
        // Its neighbour shows here first, so this window never shows a deleted workspace.
        const ids = list().map((w) => w.id);
        const at = ids.indexOf(target);
        const next = ids[at + 1] ?? ids[at - 1];
        if (!next) return;
        await switchTo(next);
      }
      await daemon.deleteWorkspace(target);
    },
    moveWindow: (leaf, to) => daemon.moveWindow(to, leaf),
    onTree(fn) {
      treeListeners.add(fn);
      return () => treeListeners.delete(fn);
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
