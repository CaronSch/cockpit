/**
 * Terminals: shells the daemon runs in pseudo-terminals for the Terminal window
 * (src/widgets/terminal.js), each the user's login shell in a directory, running whatever
 * becomes of the windows that show it.
 *
 * A window shows a terminal by its id. What the shell prints goes to the watchers of that
 * terminal as it comes (a page's event stream, for its windows showing it), and the last
 * `SCROLLBACK_CHARS` of it are kept, in parts at the size it was printed at, so a window that
 * starts watching (a reload, a second window) first replays what is on the screen and above it
 * as a window watching all along shows it: each part written at its size, then fitted to the
 * window. Any window showing a terminal types into it and sizes it; the last size asked for is
 * the shell's. A terminal ends when its shell exits (`exit`), when a window ends it, or with the
 * daemon: nothing of it is kept on disk.
 *
 * The pseudo-terminal is Bun's own (`Bun.spawn`'s `terminal` option).
 */
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
/** @import { ScrollbackPart, TerminalInfo } from './wire.js' */

/** How much of a terminal's output is kept for a window that starts showing it. */
export const SCROLLBACK_CHARS = 256 * 1024;
/** Trimmed back to this much at a time, so a busy shell does not copy its scrollback on every write. */
const SCROLLBACK_KEEP = 192 * 1024;
/** Output arriving within this long goes to watchers as one piece, so a flood of small writes is a few events, not thousands. */
const FLUSH_MS = 4;
/** How long an ended shell has to exit after its hang-up before it is killed. */
const KILL_AFTER_MS = 3000;
/** Sizes a window may ask for: xterm.js's own range is narrower. */
const MAX_CELLS = 1000;
/** A request about a terminal refused: `status` 404 for one not running, 400 for a size that is not one. */
export class TerminalRefused extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** @param {unknown} n */
const isCells = (n) => Number.isInteger(n) && /** @type {number} */ (n) >= 1 && /** @type {number} */ (n) <= MAX_CELLS;

/**
 * The environment a shell starts with: the daemon's, as a terminal app passes on its own, saying
 * which terminal it is in. Set by the terminal the daemon was started from (tmux, iTerm), what
 * would tell the shell it runs there is left out.
 * @param {Record<string, string | undefined>} env
 */
function shellEnv(env) {
  const { TMUX: _tmux, TMUX_PANE: _pane, TERM_PROGRAM_VERSION: _version, TERM_SESSION_ID: _session, ...rest } = env;
  return { ...rest, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Cockpit' };
}

/**
 * @typedef {{
 *   info: TerminalInfo,
 *   proc: import('bun').Subprocess,
 *   pty: Bun.Terminal,
 *   scrollback: ScrollbackPart[],
 *   kept: number,
 *   pending: string,
 *   flush: ReturnType<typeof setTimeout> | undefined,
 *   watchers: Set<(data: string) => void>,
 * }} Running
 */

/**
 * @param {{ shell?: string, env?: Record<string, string | undefined> }} [options] `shell`: the
 * login shell to run, `$SHELL` unless given
 */
export function createTerminals({ shell = process.env.SHELL || '/bin/sh', env = process.env } = {}) {
  /** @type {Map<string, Running>} */
  const running = new Map();
  /** @type {Set<(terminals: TerminalInfo[]) => void>} */
  const listeners = new Set();

  const list = () => [...running.values()].map((t) => t.info);
  const changed = () => {
    const all = list();
    for (const fn of listeners) fn(all);
  };

  /** @param {string} id */
  function get(id) {
    const terminal = running.get(id);
    if (!terminal) throw new TerminalRefused(404, 'no such terminal: its shell has ended');
    return terminal;
  }

  /** Sends what came since the last flush to the watchers, and keeps it. @param {Running} t */
  function flush(t) {
    clearTimeout(t.flush);
    t.flush = undefined;
    const data = t.pending;
    t.pending = '';
    if (!data) return;
    t.scrollback[t.scrollback.length - 1].data += data;
    t.kept += data.length;
    if (t.kept > SCROLLBACK_CHARS) trim(t);
    for (const fn of t.watchers) fn(data);
  }

  /** Drops the oldest output, down to `SCROLLBACK_KEEP`. @param {Running} t */
  function trim(t) {
    let excess = t.kept - SCROLLBACK_KEEP;
    while (t.scrollback.length > 1 && t.scrollback[0].data.length <= excess) {
      excess -= t.scrollback[0].data.length;
      t.scrollback.shift();
    }
    const first = t.scrollback[0];
    // Cut at a line's start where one is near, so the replay starts on a line of its own.
    const line = first.data.indexOf('\n', excess);
    first.data = first.data.slice(line !== -1 && line - excess < 4096 ? line + 1 : excess);
    t.kept = t.scrollback.reduce((sum, part) => sum + part.data.length, 0);
  }

  /**
   * Starts the login shell in `cwd`, at `cols` × `rows`.
   * @param {{ cwd?: string, cols: number, rows: number }} options
   * @returns {TerminalInfo}
   */
  function start({ cwd = homedir(), cols, rows }) {
    if (!isCells(cols) || !isCells(rows)) throw new TerminalRefused(400, `a terminal is 1 to ${MAX_CELLS} columns and rows`);
    const id = randomBytes(8).toString('hex');
    const decoder = new TextDecoder();
    /** @type {Running | undefined} */
    let t;
    const pty = new Bun.Terminal({
      cols,
      rows,
      data(_, bytes) {
        if (!t) return;
        // Streamed, so a character split across two reads is decoded whole.
        t.pending += decoder.decode(bytes, { stream: true });
        t.flush ??= setTimeout(flush, FLUSH_MS, t);
      },
    });
    const proc = Bun.spawn([shell, '-l'], {
      cwd,
      env: shellEnv(env),
      terminal: pty,
      onExit() {
        if (!t) return;
        flush(t);
        pty.close();
        running.delete(id);
        changed();
      },
    });
    t = { info: { id, cwd }, proc, pty, scrollback: [{ cols, rows, data: '' }], kept: 0, pending: '', flush: undefined, watchers: new Set() };
    running.set(id, t);
    changed();
    return t.info;
  }

  /**
   * Ends terminal `id`, as closing a terminal app's window does: its shell is hung up on, and
   * killed if it has not exited a little later. Resolves once it has.
   * @param {string} id
   */
  async function end(id) {
    const { proc } = get(id);
    proc.kill('SIGHUP');
    const kill = setTimeout(() => proc.kill('SIGKILL'), KILL_AFTER_MS);
    await proc.exited;
    clearTimeout(kill);
  }

  return {
    /** The terminals running, oldest first. */
    list,
    start,
    end,
    /** Types `data` into terminal `id`; `binary`: its characters are bytes (xterm.js `onBinary`). @param {string} id @param {string} data @param {boolean} [binary] */
    input(id, data, binary = false) {
      get(id).pty.write(binary ? Uint8Array.from(data, (c) => c.charCodeAt(0) & 0xff) : data);
    },
    /** @param {string} id @param {unknown} cols @param {unknown} rows */
    resize(id, cols, rows) {
      const t = get(id);
      if (!isCells(cols) || !isCells(rows)) throw new TerminalRefused(400, `a terminal is 1 to ${MAX_CELLS} columns and rows`);
      const size = { cols: /** @type {number} */ (cols), rows: /** @type {number} */ (rows) };
      flush(t); // printed at the size before
      const last = t.scrollback[t.scrollback.length - 1];
      if (last.cols === size.cols && last.rows === size.rows) return;
      t.pty.resize(size.cols, size.rows);
      if (last.data) t.scrollback.push({ ...size, data: '' });
      else t.scrollback[t.scrollback.length - 1] = { ...size, data: '' };
    },
    /**
     * Has `fn` hear terminal `id`'s output from now on; returns its scrollback up to now (what
     * `fn` hears follows on from it) and what stops it. Throws for a terminal not running.
     * @param {string} id @param {(data: string) => void} fn
     * @returns {{ scrollback: ScrollbackPart[], stop: () => void }}
     */
    watch(id, fn) {
      const t = get(id);
      flush(t); // what came before it is in the scrollback
      t.watchers.add(fn);
      return { scrollback: t.scrollback.map((part) => ({ ...part })), stop: () => t.watchers.delete(fn) };
    },
    /** Calls `fn` with every terminal running whenever one starts or ends. @param {(terminals: TerminalInfo[]) => void} fn */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Ends every terminal (the daemon is stopping). */
    async closeAll() {
      await Promise.all([...running.keys()].map(end));
    },
  };
}

/** @typedef {ReturnType<typeof createTerminals>} Terminals */
