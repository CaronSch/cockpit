/**
 * This window's screen of its workspace: claimed for as long as the window is open, loaded
 * from the daemon, and saved back as its layout changes.
 *
 * Claiming: a window holds the Web Lock `cockpit:<workspace>:<screen>` until it goes away,
 * and tries screens in `claimOrder`: the one its address names (`?screen=`, a tab New screen
 * opened, which the address then drops), else the one its tab showed before (kept in sessionStorage),
 * then each saved screen, else a new one. A page going away notes in sessionStorage which
 * screen it lets go of, with its navigation entry; the page that replaces it in the tab (a
 * reload) finds that entry as `navigation.activation.from` and waits for the lock, which the
 * old page may still hold for a moment. A duplicated or restored tab replaced no page (its
 * `from` is null), so it takes only free screens, at once. The lock keeps windows that open
 * at once (a restored browser session) off each other's screens. Locks are per origin:
 * windows open at two different addresses at the same time do not see each other's claims.
 *
 * Saving: a change is saved after a short pause, and a page going away sends its last
 * change in a keepalive request. A screen is stored once it holds a window and deleted when
 * it holds none (see daemon/workspace.js). When the daemon refuses a save because the screen
 * changed meanwhile (a window at another address held it too), neither layout is dropped:
 * the stored one stays with that window, and this window carries on as a new screen.
 *
 * A page that cannot use the daemon (signed out, an invalid workspace name, an unreadable
 * workspace file) still works, with a layout kept only in memory; `problem` says why.
 */
import { DaemonError } from '../daemon/client.js';
import { isValidTree } from '../layout/grid-model.js';
import { errorMessage } from '../ui/format.js';
import { DEFAULT_WORKSPACE, SCREEN_ID, claimOrder, copyLayout, lockName, newScreenId, workspaceFrom } from './model.js';
/** @import { DaemonClient } from '../daemon/client.js' */
/** @import { Screen } from '../../daemon/wire.js' */
/** @import { Tree } from '../layout/grid-model.js' */

/**
 * One screen as the switcher lists it; `open` is where it is shown: in this window, in
 * another one, or nowhere.
 * @typedef {{ id: string, rev: number | null, tree: Tree, open: 'here' | 'elsewhere' | null }} ScreenEntry
 */
/**
 * @typedef {{
 *   workspace: string,
 *   tree(): Tree,
 *   saveError(): string | null,
 *   update(tree: Tree): void,
 *   list(): Promise<ScreenEntry[]>,
 *   openHere(id: string): void,
 *   openCopy(): Promise<void>,
 *   remove(entry: ScreenEntry): Promise<boolean>,
 *   onChange(fn: () => void): () => void,
 * }} WindowScreen
 */
/** @typedef {{ ok: true, screen: WindowScreen } | { ok: false, problem: string }} OpenedScreen */

const SAVE_DELAY_MS = 250;
const RETRY_MS = 2000;
/** Where a page going away notes the screen it lets go of (see `handedOver`). */
const HANDOVER_KEY = 'cockpit.handover';
const SIGNED_OUT =
  'This browser is not signed in, so this layout lasts only until the page closes. Open the URL printed by `bun start` to sign in.';
/** Where versions before workspaces kept the layout (see `legacyLayout`). */
const LEGACY_LAYOUT_KEY = 'cockpit.layout.v1';

/**
 * Takes lock `name` and holds it until the page goes away or the returned release is called.
 * Unless told to wait for it, null when another window holds it.
 * @param {string} name @param {{ wait?: boolean }} [options] @returns {Promise<(() => void) | null>}
 */
function hold(name, { wait = false } = {}) {
  return new Promise((resolve, reject) => {
    navigator.locks
      .request(name, wait ? {} : { ifAvailable: true }, (lock) => {
        if (!lock) return resolve(null);
        return new Promise((release) => resolve(() => release(undefined)));
      })
      .catch(reject);
  });
}

/**
 * Whether the page this one replaced in its tab (a reload, or a navigation from it) let go of
 * lock `name` as it went: then it is about to release it, if it has not yet. A duplicated or
 * restored tab carries a copy of the note but replaced no page, so it never matches.
 * @param {string} name
 */
function handedOver(name) {
  const from = globalThis.navigation?.activation?.from?.id;
  if (!from) return false;
  try {
    const note = JSON.parse(sessionStorage.getItem(HANDOVER_KEY) ?? 'null');
    return note?.lock === name && note.entry === from;
  } catch {
    return false;
  }
}

/**
 * One-shot import, for workspace `main` while it has no screens: the layout this origin's
 * localStorage kept before layouts moved to the daemon. Delete this, and its call, once every
 * browser that ran Cockpit before workspaces has opened it once.
 * @returns {Tree}
 */
function legacyLayout() {
  try {
    const data = JSON.parse(localStorage.getItem(LEGACY_LAYOUT_KEY) ?? 'null');
    return data?.version === 1 && data.tree && isValidTree(data.tree) ? data.tree : null;
  } catch {
    return null;
  }
}

/** @param {{ daemon: DaemonClient }} options @returns {Promise<OpenedScreen>} */
export async function openScreen({ daemon }) {
  const workspace = workspaceFrom(location.search);
  if (workspace === null) {
    const given = new URLSearchParams(location.search).get('workspace');
    return { ok: false, problem: `“${given}” is not a workspace name (lowercase letters, digits and dashes), so this layout is not saved.` };
  }
  /** @type {Screen[]} */
  let saved;
  try {
    saved = (await daemon.workspace(workspace)).screens;
  } catch (err) {
    const signedOut = err instanceof DaemonError && (err.status === 401 || err.status === 403);
    return { ok: false, problem: signedOut ? SIGNED_OUT : `This layout cannot be saved: ${errorMessage(err)}` };
  }
  return { ok: true, screen: await claimScreen(daemon, workspace, saved) };
}

/**
 * Claims a screen of `workspace`, whose stored screens are `saved`, for this window.
 * @param {DaemonClient} daemon @param {string} workspace @param {Screen[]} saved
 * @returns {Promise<WindowScreen>}
 */
async function claimScreen(daemon, workspace, saved) {
  const tabKey = `cockpit.screen.${workspace}`;
  /** @type {() => void} */
  let release = () => {};

  /** A screen no window has claimed yet. */
  async function claimNew() {
    for (;;) {
      const id = newScreenId();
      const got = await hold(lockName(workspace, id));
      if (got) {
        release = got;
        return id;
      }
    }
  }

  /** The screen the address names, once: the address drops it, so a reload goes by the tab's. */
  function named() {
    const url = new URL(location.href);
    const id = url.searchParams.get('screen');
    if (id === null) return null;
    url.searchParams.delete('screen');
    history.replaceState(history.state, '', url);
    return SCREEN_ID.test(id) ? id : null;
  }

  async function claim() {
    const remembered = sessionStorage.getItem(tabKey);
    const own = named() ?? (remembered && SCREEN_ID.test(remembered) ? remembered : null);
    for (const id of claimOrder(own, saved.map((s) => s.id))) {
      const name = lockName(workspace, id);
      const got = await hold(name, { wait: id === own && handedOver(name) });
      if (got) {
        release = got;
        return id;
      }
    }
    return claimNew();
  }

  let id = await claim();
  sessionStorage.setItem(tabKey, id);
  // For the page that replaces this one in the tab (see `handedOver`); a page kept in the
  // back/forward cache keeps its lock, so it lets go of nothing.
  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    const note = { lock: lockName(workspace, id), entry: globalThis.navigation?.currentEntry?.id };
    sessionStorage.setItem(HANDOVER_KEY, JSON.stringify(note));
  });
  const mine = saved.find((s) => s.id === id);
  /** The newest layout. @type {Tree} */
  let latest = mine?.tree ?? null;
  /** The rev stored for this screen; null while it is not stored. @type {number | null} */
  let rev = mine?.rev ?? null;

  if (workspace === DEFAULT_WORKSPACE && saved.length === 0) {
    const legacy = legacyLayout();
    const adopted = legacy && (await daemon.saveScreen(workspace, id, legacy, null).catch(() => null));
    if (adopted?.ok) {
      localStorage.removeItem(LEGACY_LAYOUT_KEY);
      latest = legacy;
      rev = adopted.rev;
    }
  }

  let dirty = false;
  /** The save on its way, as the rev it will make. @type {{ rev: number | null } | null} */
  let inflight = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @type {string | null} */
  let saveError = null;
  /** @type {Set<() => void>} */
  const listeners = new Set();
  const changed = () => {
    for (const fn of listeners) fn();
  };

  /**
   * The daemon refused a save: another window changed this screen, one whose lock this
   * window cannot see (it is open at another address). Keep both layouts: the stored one
   * stays that window's, and this window carries on as a new screen of its own.
   */
  async function moveToNewScreen() {
    const old = release;
    id = await claimNew();
    old();
    sessionStorage.setItem(tabKey, id);
    rev = null;
    dirty = true;
  }

  async function flush() {
    clearTimeout(timer);
    if (!dirty || inflight) return;
    const tree = latest;
    const base = rev;
    dirty = false;
    if (tree === null && base === null) return; // never stored: nothing to delete
    inflight = { rev: tree === null ? null : (base ?? 0) + 1 };
    const before = { id, stored: base !== null, error: saveError };
    let retry = false;
    try {
      const result = await daemon.saveScreen(workspace, id, tree, base);
      if (result.ok) rev = result.rev;
      else await moveToNewScreen();
      saveError = null;
    } catch (err) {
      dirty = true;
      retry = true;
      saveError = errorMessage(err);
    } finally {
      inflight = null;
    }
    // Stored, deleted, moved or failing: what the switcher shows changed.
    if (before.id !== id || before.stored !== (rev !== null) || before.error !== saveError) changed();
    if (retry) timer = setTimeout(flush, RETRY_MS);
    else if (dirty) void flush(); // changed while the save was on its way
  }

  // A reload or close inside the pause would otherwise lose the last change.
  addEventListener('pagehide', () => {
    if (!dirty) return;
    clearTimeout(timer);
    const base = inflight ? inflight.rev : rev;
    dirty = false;
    if (latest === null && base === null) return;
    void daemon.saveScreen(workspace, id, latest, base, { keepalive: true }).catch(() => {});
  });

  return {
    workspace,
    tree: () => latest,
    saveError: () => saveError,
    update(tree) {
      latest = tree;
      dirty = true;
      clearTimeout(timer);
      timer = setTimeout(flush, SAVE_DELAY_MS);
    },

    async list() {
      const [{ screens }, { held = [] }] = await Promise.all([daemon.workspace(workspace), navigator.locks.query()]);
      const prefix = lockName(workspace, '');
      const open = new Set(held.flatMap((lock) => (lock.name?.startsWith(prefix) ? [lock.name.slice(prefix.length)] : [])));
      /** @type {ScreenEntry} */
      const here = { id, rev, tree: latest, open: 'here' };
      /** @type {ScreenEntry[]} */
      const entries = screens.map((s) => (s.id === id ? here : { ...s, open: open.has(s.id) ? 'elsewhere' : null }));
      // A new window's screen is not stored until it holds a window; it still is one.
      if (!entries.includes(here)) entries.push(here);
      return entries;
    },

    openHere(target) {
      // A reload, not a remount: unmounting this screen's windows would end their agents.
      sessionStorage.setItem(tabKey, target);
      location.reload();
    },

    async openCopy() {
      // The tab opens at once, while the click still lets it; it goes to the copy once it is stored.
      const tab = open('', '_blank');
      if (!tab) throw new Error('the browser blocked the new tab');
      try {
        const url = new URL(location.href);
        // An empty screen is not stored: a new tab starts one of its own anyway.
        if (latest) {
          const copy = newScreenId();
          const saved = await daemon.saveScreen(workspace, copy, copyLayout(latest), null);
          if (!saved.ok) throw new Error('a screen with its id was stored meanwhile');
          url.searchParams.set('screen', copy);
        }
        tab.opener = null;
        tab.location.href = url.href;
      } catch (err) {
        tab.close();
        throw err;
      }
    },

    remove(entry) {
      // Held while deleting, so no window at this address opens the screen meanwhile.
      return navigator.locks.request(lockName(workspace, entry.id), { ifAvailable: true }, async (lock) => {
        if (!lock || entry.rev === null) return false;
        return (await daemon.saveScreen(workspace, entry.id, null, entry.rev)).ok;
      });
    },

    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
