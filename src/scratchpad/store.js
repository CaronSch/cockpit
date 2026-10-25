/**
 * The page's copy of one scratchpad: every window in the page showing that pad edits this one
 * object, so they agree as you type; it saves to the daemon after a pause and follows what
 * other pages save.
 *
 * Every save names the version its text was edited from (`base`). If another page or an
 * outside edit got there first, the daemon refuses, and the store holds both versions until
 * the user picks one: neither side's text is ever dropped silently.
 */
import { getDaemon } from '../daemon/client.js';
import { errorMessage } from '../ui/format.js';
/** @import { DaemonClient } from '../daemon/client.js' */
/** @import { Scratchpad } from '../../daemon/wire.js' */

/**
 * `loading` until the daemon has answered once; `conflict` while `theirs` waits for a choice.
 * @typedef {'loading' | 'saved' | 'saving' | 'error' | 'conflict'} ScratchpadPhase
 * @typedef {{ text: string, phase: ScratchpadPhase, error: string | null, theirs: Scratchpad | null }} ScratchpadState
 * @typedef {{ setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout }} Timers
 */

const SAVE_DELAY_MS = 400;

/** @param {{ daemon: DaemonClient, id: string, timers?: Timers, delayMs?: number }} options */
export function createScratchpadStore({ daemon, id, timers = globalThis, delayMs = SAVE_DELAY_MS }) {
  let text = '';
  /** The daemon's version `text` was edited from; null until the first load. @type {string | null} */
  let base = null;
  /** `text` has edits the daemon has not confirmed. */
  let dirty = false;
  /** Text of the save on its way, if any. @type {string | null} */
  let inflight = null;
  /** @type {Scratchpad | null} */
  let theirs = null;
  /** @type {string | null} */
  let error = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @type {Set<() => void>} */
  const listeners = new Set();

  const notify = () => {
    for (const fn of listeners) fn();
  };

  /** @returns {ScratchpadState} */
  function state() {
    /** @type {ScratchpadPhase} */
    let phase = 'saved';
    if (theirs) phase = 'conflict';
    else if (base === null) phase = 'loading';
    else if (error && dirty) phase = 'error';
    else if (dirty || inflight !== null) phase = 'saving';
    return { text, phase, error, theirs };
  }

  function schedule() {
    timers.clearTimeout(timer);
    timer = timers.setTimeout(() => void save(), delayMs);
  }

  /** @param {{ keepalive?: boolean }} [options] */
  async function save({ keepalive = false } = {}) {
    timers.clearTimeout(timer);
    if (!dirty || inflight !== null || theirs || base === null) return;
    const sent = text;
    inflight = sent;
    notify();
    let retry = false;
    try {
      const result = await daemon.saveScratchpad(id, sent, base, { keepalive });
      error = null;
      if (result.ok) accept({ text: sent, rev: result.rev });
      else if (result.current.text === sent) accept(result.current);
      else theirs = result.current;
      retry = dirty && !theirs;
    } catch (err) {
      error = errorMessage(err);
    } finally {
      inflight = null;
      notify();
    }
    if (retry) schedule();
  }

  /** The daemon now holds `pad`, which this page's text was edited from. @param {Scratchpad} pad */
  function accept(pad) {
    base = pad.rev;
    if (text === pad.text) dirty = false;
  }

  /** What the daemon holds, from a load or another page's save. @param {Scratchpad} pad */
  function arrive(pad) {
    if (base === null || (!dirty && inflight === null)) {
      if (pad.text !== text) {
        text = pad.text;
        dirty = false;
      }
      base = pad.rev;
    } else if (pad.text === text || pad.text === inflight) {
      // Our own save, seen on the stream (possibly before its response).
      accept(pad);
    } else if (pad.rev !== base) {
      theirs = pad;
    }
    notify();
  }

  async function load() {
    try {
      arrive(await daemon.scratchpad(id));
      error = null;
    } catch (err) {
      error = errorMessage(err);
    }
    notify();
    if (dirty) void save();
  }

  daemon.onScratchpad((padId, pad) => {
    if (padId === id) arrive(pad);
  });
  daemon.onStatus((status) => {
    if (status === 'open') void load();
  });
  if (daemon.status() === 'open') void load();
  // A page closed mid-pause still saves what was typed (small enough for a keepalive request).
  globalThis.addEventListener?.('pagehide', () => void save({ keepalive: true }));

  return {
    state,
    /** @param {() => void} fn */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** @param {string} next */
    edit(next) {
      if (next === text) return;
      text = next;
      dirty = true;
      notify();
      schedule();
    },
    /** Save now instead of after the pause. */
    flush: () => save(),
    /** Resolve a conflict by writing this page's text over the other version. */
    keepMine() {
      if (!theirs) return;
      base = theirs.rev;
      theirs = null;
      dirty = true;
      void save();
    },
    /** Resolve a conflict by taking the other version and dropping this page's edits. */
    takeTheirs() {
      if (!theirs) return;
      text = theirs.text;
      base = theirs.rev;
      theirs = null;
      dirty = false;
      timers.clearTimeout(timer);
      notify();
    },
  };
}

/** @typedef {ReturnType<typeof createScratchpadStore>} ScratchpadStore */

/** @type {Map<string, ScratchpadStore>} */
const stores = new Map();

/** The page's copy of pad `id`, created on first use. @param {string} id */
export function getScratchpad(id) {
  let store = stores.get(id);
  if (!store) stores.set(id, (store = createScratchpadStore({ daemon: getDaemon(), id })));
  return store;
}
