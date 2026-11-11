/**
 * Workspaces: the screens of each one (a layout tree per browser window), kept by the daemon
 * so a layout outlives a browser profile and an address change.
 *
 * One file per workspace, `<dir>/<name>.json`: `{ version: 1, screens: [{ id, rev, tree }] }`,
 * screens in the order they were created. A screen is stored once its window holds a window,
 * and deleted when its tree becomes empty, so blank screens never pile up; a workspace with
 * no screens has no file.
 *
 * `rev` counts a screen's saves. A save names the rev it was made from (null for a screen not
 * stored yet); if the screen has moved on since, the save is refused with what is there now.
 * Only one window shows a screen at a time (src/workspace/screen.js), so a refusal means two
 * windows at different addresses held it at once. A save that lands from rev `n` makes rev
 * `n + 1`, so a window can name the rev of a save still on its way. Writes are serialized.
 *
 * A file that cannot be read as a workspace is never overwritten or dropped: reading and
 * writing that workspace fail, naming the file, until it is fixed or moved away.
 *
 * Windows of widgets that no longer exist and held nothing (`RETIRED_WIDGETS`) are left out of
 * every layout read, and a screen left with no windows is no longer listed; the next save of
 * the workspace stores it so.
 */
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
// Pure and shared with the browser, so both agree on what a valid name, id and layout are.
import { SCREEN_ID, WORKSPACE_NAME } from '../src/workspace/model.js';
import { isValidTree, listLeaves, removeLeaf } from '../src/layout/grid-model.js';
/** @import { Screen, Workspace } from './wire.js' */
/** @import { Tree } from '../src/layout/grid-model.js' */

const VERSION = 1;
/** Widgets there are no more, whose windows held nothing: the empty Pane. */
const RETIRED_WIDGETS = new Set(['pane']);

/** @param {Tree} tree */
const withoutRetired = (tree) =>
  listLeaves(tree)
    .filter((leaf) => RETIRED_WIDGETS.has(leaf.widget))
    .reduce((rest, leaf) => removeLeaf(rest, leaf.id), tree);

/** @param {any} screen parsed untrusted JSON @returns {boolean} */
const isScreen = (screen) =>
  SCREEN_ID.test(screen?.id) && Number.isInteger(screen.rev) && screen.rev > 0 && screen.tree !== null && isValidTree(screen.tree);

/** @param {any} data parsed untrusted JSON @returns {data is { version: 1, screens: Screen[] }} */
function isWorkspaceFile(data) {
  if (data?.version !== VERSION || !Array.isArray(data.screens) || !data.screens.every(isScreen)) return false;
  return new Set(data.screens.map((/** @type {Screen} */ s) => s.id)).size === data.screens.length;
}

/** @param {{ dir: string }} options */
export function createWorkspaces({ dir }) {
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();
  let tmpSeq = 0;

  /** @param {string} name */
  const fileOf = (name) => {
    if (!WORKSPACE_NAME.test(name)) throw new RangeError(`not a workspace name: ${name}`);
    return join(dir, `${name}.json`);
  };

  /** Runs `fn` after every earlier change has landed. @template T @param {() => Promise<T>} fn */
  function serialized(fn) {
    const result = queue.then(fn);
    queue = result.catch(() => {});
    return result;
  }

  /** @param {string} name @returns {Promise<Workspace>} */
  async function read(name) {
    const path = fileOf(name);
    const file = Bun.file(path);
    if (!(await file.exists())) return { screens: [] };
    /** @type {any} */
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {}
    if (!isWorkspaceFile(data)) throw new Error(`${path} is not a workspace file this daemon can read; fix it or move it away`);
    const screens = data.screens.flatMap((screen) => {
      const tree = withoutRetired(screen.tree);
      return tree ? [{ ...screen, tree }] : [];
    });
    return { screens };
  }

  /** @param {string} name @param {Screen[]} screens */
  async function store(name, screens) {
    const file = fileOf(name);
    if (screens.length === 0) return rm(file, { force: true });
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // Write-then-rename: a crash mid-write leaves the old layout, never half of the new one.
    const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ version: VERSION, screens }, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
  }

  /**
   * @param {string} name @param {string} id @param {Tree} tree null deletes the screen
   * @param {number | null} base the rev this layout was made from; null for a screen not stored
   * @returns {Promise<{ ok: true, rev: number | null } | { ok: false, current: Screen | null }>}
   */
  async function write(name, id, tree, base) {
    if (!SCREEN_ID.test(id)) throw new RangeError(`not a screen id: ${id}`);
    if (!isValidTree(tree)) throw new RangeError('not a layout tree');
    const { screens } = await read(name);
    const at = screens.findIndex((s) => s.id === id);
    const current = screens[at] ?? null;
    if ((current?.rev ?? null) !== base) return { ok: false, current };
    if (tree === null) {
      if (current) {
        screens.splice(at, 1);
        await store(name, screens);
      }
      return { ok: true, rev: null };
    }
    const next = { id, rev: (base ?? 0) + 1, tree };
    if (current) screens[at] = next;
    else screens.push(next);
    await store(name, screens);
    return { ok: true, rev: next.rev };
  }

  return {
    read,
    /** @param {string} name @param {string} id @param {Tree} tree @param {number | null} base */
    write: (name, id, tree, base) => serialized(() => write(name, id, tree, base)),
  };
}
