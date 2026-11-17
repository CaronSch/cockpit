/**
 * Workspaces: named layouts, each a tree of windows, which a browser window shows one at a time
 * and switches between (src/workspace/shown.js), kept by the daemon so a layout outlives a
 * browser profile and an address change.
 *
 * `<file>` (state-file.js): `{ version: 2, workspaces: [{ id, name, rev, tree }] }`, in the order
 * the top bar lists them (and ⌃⌥←/→ steps through them). There is always at least one; a
 * workspace with no windows is kept, empty, until it is deleted. Every page hears every change.
 *
 * `rev` counts a workspace's layout saves. A save names the rev it was made from; if the
 * workspace has moved on since (another browser window showing it saved first), the save is
 * refused with what is there now, which the window then shows.
 *
 * Before workspaces were named layouts, a workspace held a layout per browser window (a
 * "screen"), one file each in `<legacyDir>`: the first time the daemon starts without `<file>`,
 * each of those screens becomes a workspace of its own (the files are left as they were).
 *
 * Windows of widgets that no longer exist and held nothing (`RETIRED_WIDGETS`) are left out of
 * every layout read.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadStateFile } from './state-file.js';
// Pure and shared with the browser, so both agree on what a valid id, name and layout are.
import { WORKSPACE_ID, newWorkspaceId, nextWorkspaceName, workspaceName } from '../src/workspace/model.js';
import { applyDrop, findLeaf, isValidTree, listLeaves, removeLeaf } from '../src/layout/grid-model.js';
/** @import { Workspace } from './wire.js' */
/** @import { Leaf, Tree } from '../src/layout/grid-model.js' */

const VERSION = 2;
/** Widgets there are no more, whose windows held nothing: the empty Pane. */
const RETIRED_WIDGETS = new Set(['pane']);

/** @param {Tree} tree */
const withoutRetired = (tree) =>
  listLeaves(tree)
    .filter((leaf) => RETIRED_WIDGETS.has(leaf.widget))
    .reduce((rest, leaf) => removeLeaf(rest, leaf.id), tree);

/** @param {any} w parsed untrusted JSON @returns {boolean} */
const isWorkspace = (w) =>
  WORKSPACE_ID.test(w?.id) && workspaceName(w.name) === w.name && Number.isInteger(w.rev) && w.rev >= 0 && isValidTree(w.tree);

/** @param {any} data parsed untrusted JSON @returns {Workspace[] | null} */
function readFile(data) {
  if (data?.version !== VERSION || !Array.isArray(data.workspaces) || data.workspaces.length === 0 || !data.workspaces.every(isWorkspace)) return null;
  if (new Set(data.workspaces.map((/** @type {Workspace} */ w) => w.id)).size !== data.workspaces.length) return null;
  return data.workspaces.map((/** @type {Workspace} */ w) => ({ id: w.id, name: w.name, rev: w.rev, tree: withoutRetired(w.tree) }));
}

/** @param {string} name @returns {Workspace} */
const emptyWorkspace = (name) => ({ id: newWorkspaceId(), name, rev: 0, tree: null });

/**
 * The screens of the workspaces the daemon kept before (one `<name>.json` per workspace, its
 * screens in creation order), `main`'s first, each as a workspace of its own; none if there
 * were none, or none could be read.
 * @param {string} dir @returns {Promise<Workspace[]>}
 */
async function legacyScreens(dir) {
  const files = (await readdir(dir).catch(() => /** @type {string[]} */ ([]))).filter((f) => f.endsWith('.json')).sort((a, b) => Number(b === 'main.json') - Number(a === 'main.json') || a.localeCompare(b));
  /** @type {Workspace[]} */
  const found = [];
  for (const file of files) {
    /** @type {any} */
    let data;
    try {
      data = JSON.parse(await Bun.file(join(dir, file)).text());
    } catch {}
    if (data?.version !== 1 || !Array.isArray(data.screens)) continue;
    for (const screen of data.screens) {
      const tree = isValidTree(screen?.tree) ? withoutRetired(screen.tree) : null;
      if (tree) found.push({ ...emptyWorkspace(nextWorkspaceName(found.map((w) => w.name))), tree });
    }
  }
  return found;
}

/**
 * Loads the workspaces kept in `file`, from the screens in `legacyDir` the first time.
 * @param {{ file: string, legacyDir: string }} options
 */
export async function loadWorkspaces({ file, legacyDir }) {
  const fresh = !(await Bun.file(file).exists());
  const migrated = fresh ? await legacyScreens(legacyDir) : [];
  const store = await loadStateFile({
    file,
    what: 'a workspaces file',
    initial: /** @type {readonly Workspace[]} */ (migrated.length > 0 ? migrated : [emptyWorkspace(nextWorkspaceName([]))]),
    read: readFile,
    write: (workspaces) => ({ version: VERSION, workspaces }),
  });
  if (fresh) await store.set([...store.get()]); // written at once, so the migration runs once

  /** @param {string} id */
  const indexOf = (id) => {
    if (!WORKSPACE_ID.test(id)) throw new RangeError(`not a workspace id: ${id}`);
    return store.get().findIndex((w) => w.id === id);
  };
  /** @param {number} at @param {Workspace} next */
  const replace = (at, next) => store.set(store.get().map((w, i) => (i === at ? next : w)));

  return {
    /** Every workspace, in order. */
    all: store.get,
    /**
     * Adds an empty workspace after the others, named `name` or the next free "Workspace N".
     * @param {string | null} name @returns {Workspace}
     */
    create(name) {
      const all = store.get();
      const made = emptyWorkspace(name ?? nextWorkspaceName(all.map((w) => w.name)));
      void store.set([...all, made]);
      return made;
    },
    /** @param {string} id @param {string} name @returns {boolean} false: no such workspace */
    rename(id, name) {
      const at = indexOf(id);
      if (at < 0) return false;
      void replace(at, { ...store.get()[at], name });
      return true;
    },
    /**
     * Stores workspace `id`'s layout, made from rev `base`.
     * @param {string} id @param {Tree} tree @param {number} base
     * @returns {{ ok: true, rev: number } | { ok: false, current: Workspace | null }}
     */
    save(id, tree, base) {
      if (!isValidTree(tree)) throw new RangeError('not a layout tree');
      const at = indexOf(id);
      const current = store.get()[at] ?? null;
      if (!current || current.rev !== base) return { ok: false, current };
      const rev = base + 1;
      void replace(at, { ...current, rev, tree });
      return { ok: true, rev };
    },
    /**
     * Adds window `leaf` to workspace `id`, along its right edge (or as its only window), as a
     * window dragged out of another workspace goes there.
     * @param {string} id @param {Leaf} leaf
     * @returns {'moved' | 'missing' | 'there'} `there`: a window with its id is there already
     */
    addWindow(id, leaf) {
      const at = indexOf(id);
      const current = store.get()[at];
      if (!current) return 'missing';
      if (findLeaf(current.tree, leaf.id)) return 'there';
      const tree = applyDrop(current.tree, { source: { kind: 'new', leaf }, target: { kind: 'edge' }, dir: 'right' });
      void replace(at, { ...current, rev: current.rev + 1, tree });
      return 'moved';
    },
    /**
     * Deletes workspace `id`, with its windows; the last one is never deleted.
     * @param {string} id @returns {Workspace | 'missing' | 'last'} what was deleted
     */
    remove(id) {
      const at = indexOf(id);
      const all = store.get();
      if (at < 0) return 'missing';
      if (all.length === 1) return 'last';
      void store.set(all.filter((_, i) => i !== at));
      return all[at];
    },
    /** Hears every change, with every workspace. */
    subscribe: store.subscribe,
  };
}

/** @typedef {Awaited<ReturnType<typeof loadWorkspaces>>} Workspaces */
