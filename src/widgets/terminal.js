/**
 * A terminal: the user's login shell in a directory, shown as a terminal app shows it (xterm.js).
 * It lives in its window: closing the window ends it, as a terminal app's tab; the daemon runs it
 * (daemon/terminals.js) so a reload, or the browser closed and opened again, finds it running.
 *
 * Params (persisted with the layout): `terminal` (the id of the shell shown), `cwd` (its
 * directory) and `startIn` (a directory to start a shell in at once, as the + after the window's
 * title asks for). Without a terminal, the window offers to start one. A reload, or another
 * window given the same id, shows the same shell with what it printed (its scrollback). A shell
 * ends when it exits (`exit`, Ctrl+D) or its window is closed (unless another window of this
 * screen shows it); a window whose shell ended (an `exit`, a daemon restart) says so, and offers
 * a new one.
 *
 * Keys typed in the terminal go to the shell, the app's shortcuts with Ctrl too (Ctrl+K is the
 * shell's); those with Cmd stay the app's and the browser's (Cmd+K, Cmd+C, Cmd+V).
 */
import { button, el } from '../ui/dom.js';
import { errorMessage, tildeHome } from '../ui/format.js';
import { onZoom } from '../ui/zoom.js';
import { directoryForm } from '../ui/directory-form.js';
import { getDaemon } from '../daemon/client.js';
/** @import { WidgetContext } from './registry.js' */
/** @import { LeafParams } from '../layout/grid-model.js' */
/** @import { DaemonClient } from '../daemon/client.js' */
/** @import { ITheme, Terminal } from '@xterm/xterm' */
/** @import { FitAddon } from '@xterm/addon-fit' */

export default {
  type: 'terminal',
  title: 'Terminal',
  glyph: '❯',
  description: 'A shell in a directory; closing its window ends it',
  /** The + after its title: another terminal beside it, started in the same directory. @param {LeafParams} params */
  newTab: (params) => ({ startIn: typeof params.cwd === 'string' ? params.cwd : null }),

  /** @param {HTMLElement} body @param {WidgetContext} ctx */
  mount(body, ctx) {
    return createTerminalWindow(body, ctx, getDaemon());
  },
};

/** How many lines a terminal keeps above its screen. */
const SCROLLBACK_LINES = 5000;
/** The size a shell starts at when its window cannot be measured, as a terminal app's default. */
const FALLBACK_SIZE = Object.freeze({ cols: 80, rows: 24 });

/**
 * A terminal as a window draws one in `screen`: the code font at `screen`'s text size, once that
 * font is in (or its cells are measured from the fallback font's), in the app's colours.
 * @param {typeof Terminal} XTerm xterm.js's terminal class @param {HTMLElement} screen
 * @returns {Promise<Terminal>}
 */
async function xtermIn(XTerm, screen) {
  const fontFamily = getComputedStyle(document.documentElement).getPropertyValue('--font-code').trim();
  const fontSize = parseFloat(getComputedStyle(screen).fontSize);
  await document.fonts.load(`${fontSize}px ${fontFamily}`).catch(() => {});
  return new XTerm({ fontFamily, fontSize, theme: appTheme(), cursorBlink: true, scrollback: SCROLLBACK_LINES });
}

/** xterm.js and its stylesheet, loaded once, when a terminal is first shown. @type {Promise<{ Terminal: typeof Terminal, FitAddon: typeof FitAddon }> | null} */
let xterm = null;
function loadXterm() {
  xterm ??= (async () => {
    const sheet = el('link');
    sheet.rel = 'stylesheet';
    sheet.href = '/vendor/xterm.css';
    const styled = new Promise((resolve, reject) => {
      sheet.onload = resolve;
      sheet.onerror = () => reject(new Error('xterm.css did not load'));
    });
    document.head.append(sheet);
    const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), styled]);
    return { Terminal, FitAddon };
  })();
  // A failure is not kept: the next terminal shown tries again.
  xterm.catch(() => (xterm = null));
  return xterm;
}

/**
 * A CSS colour as xterm.js reads one (`#rrggbbaa`): the tokens are `oklch()` and `color-mix()`,
 * which it only reads when opaque, so the browser draws each and reads it back.
 * @param {CanvasRenderingContext2D} ctx @param {string} css
 */
function hexColor(ctx, css) {
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  return `#${[...ctx.getImageData(0, 0, 1, 1).data].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

/** The app's colours as a terminal theme: its surface and text, the accent for the cursor and selection, and the ANSI colours from its own. @returns {ITheme} */
function appTheme() {
  const canvas = el('canvas');
  canvas.width = canvas.height = 1;
  const paint = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d', { willReadFrequently: true }));
  const style = getComputedStyle(document.documentElement);
  const token = (/** @type {string} */ name) => hexColor(paint, style.getPropertyValue(name).trim());
  const ansi = {
    black: token('--color-surface-raised'),
    red: token('--color-danger'),
    green: token('--color-ok'),
    yellow: token('--color-warn'),
    blue: token('--color-accent'),
    magenta: token('--color-family-3'),
    cyan: token('--color-family-2'),
    white: token('--color-text-dim'),
  };
  return {
    background: token('--color-surface'),
    foreground: token('--color-text'),
    cursor: token('--color-accent'),
    cursorAccent: token('--color-surface'),
    selectionBackground: token('--color-selection'),
    ...ansi,
    brightBlack: token('--color-text-faint'),
    brightRed: ansi.red,
    brightGreen: ansi.green,
    brightYellow: ansi.yellow,
    brightBlue: ansi.blue,
    brightMagenta: ansi.magenta,
    brightCyan: ansi.cyan,
    brightWhite: token('--color-text'),
  };
}

/** @param {HTMLElement} body @param {WidgetContext} ctx @param {DaemonClient} daemon */
function createTerminalWindow(body, ctx, daemon) {
  const params = () => ({
    terminal: typeof ctx.params.terminal === 'string' && ctx.params.terminal ? ctx.params.terminal : null,
    cwd: typeof ctx.params.cwd === 'string' && ctx.params.cwd ? ctx.params.cwd : null,
    startIn: typeof ctx.params.startIn === 'string' && ctx.params.startIn ? ctx.params.startIn : null,
  });
  const root = el('div', 'term');
  body.append(root);
  /** The view shown: its key, and what ends it. @type {{ key: string, destroy: () => void } | null} */
  let view = null;
  /** Whether the next terminal shown takes the focus: it was just started here. */
  let focusNext = false;
  /** Why the last start failed, shown on the form it falls back to. @type {string | null} */
  let failed = null;
  /** @type {string | null} */
  let home = null;
  daemon
    .config()
    .then((c) => {
      home = c.home;
      render();
    })
    .catch(() => {});

  /** Shows the view `key` names, built by `build` unless it is the one shown. @param {string} key @param {() => { root: HTMLElement, destroy?: () => void }} build */
  function show(key, build) {
    if (view?.key === key) return;
    view?.destroy();
    const next = build();
    view = { key, destroy: next.destroy ?? (() => {}) };
    root.replaceChildren(next.root);
  }

  /** Starts a shell in `dir`, at the size this window draws it at, and shows it here. @param {string} dir */
  async function start(dir) {
    const { cols, rows } = await measure().catch(() => FALLBACK_SIZE);
    const terminal = await daemon.startTerminal({ cwd: dir, cols, rows });
    focusNext = true;
    ctx.setParams({ terminal: terminal.id, cwd: terminal.cwd, startIn: null });
  }

  /**
   * The size a terminal is drawn at in this window, measured by laying one out unseen where the
   * terminal will be: a shell started at another size draws its first prompt for that one (zsh's
   * end-of-line `%` is left showing in a wider window), before the window's resize reaches it.
   * `FALLBACK_SIZE` when the window has no size (a tab behind another).
   */
  async function measure() {
    const { Terminal, FitAddon } = await loadXterm();
    const probe = el('div', 'term-view term-probe');
    const screen = el('div', 'term-screen');
    probe.append(screen);
    root.append(probe);
    try {
      const t = await xtermIn(Terminal, screen);
      const fit = new FitAddon();
      t.loadAddon(fit);
      t.open(screen);
      const size = fit.proposeDimensions();
      t.dispose();
      return size && size.cols > 0 && size.rows > 0 ? { cols: size.cols, rows: size.rows } : FALLBACK_SIZE;
    } finally {
      probe.remove();
    }
  }

  function render() {
    const p = params();
    ctx.setLabel(p.terminal && p.cwd ? tildeHome(p.cwd, home) : null);
    if (p.terminal) return show(`terminal:${p.terminal}`, () => terminalView(p.terminal ?? ''));
    const status = daemon.status();
    if (status !== 'open') return show(`status:${status}`, () => statusView(status));
    if (p.startIn) {
      const dir = p.startIn;
      return show(`start:${dir}`, () => {
        start(dir).catch((err) => {
          failed = errorMessage(err);
          ctx.setParams({ startIn: null, cwd: dir });
        });
        return { root: el('p', 'term-note', `Starting a shell in ${tildeHome(dir, home)}…`) };
      });
    }
    show('setup', setupView);
  }

  /** @param {string} status */
  function statusView(status) {
    const text =
      status === 'unauthorized'
        ? 'This browser is not signed in to the daemon: open the URL printed by `bun start`.'
        : status === 'down'
          ? 'Daemon not reachable; this window reconnects by itself.'
          : 'Connecting to the daemon…';
    return { root: el('p', status === 'connecting' ? 'term-note' : 'term-note omp-error', text) };
  }

  /** The form to start a shell: a directory, or one of the recent ones. */
  function setupView() {
    const form = directoryForm({
      daemon,
      title: 'Start a shell',
      startLabel: 'Start shell',
      recentLabel: (dir) => `Start a shell in ${dir}`,
      cwd: params().cwd,
      start,
      failed,
    });
    failed = null;
    const box = el('div', 'term-setup');
    box.append(form);
    return { root: box };
  }

  /** Terminal `id`, live: what it prints, what is typed into it, its size following the window's. @param {string} id */
  function terminalView(id) {
    const box = el('div', 'term-view');
    const screen = el('div', 'term-screen');
    const ended = el('div', 'term-ended');
    ended.hidden = true;
    ended.append(
      el('p', 'term-note', 'This shell has ended.'),
      button('omp-tool-btn', 'New shell here', () => {
        const { cwd } = params();
        ctx.setParams({ terminal: null, startIn: cwd });
      }),
      button('omp-tool-btn', 'Another directory', () => ctx.setParams({ terminal: null, startIn: null })),
    );
    box.append(screen, ended);

    /** @type {Terminal | null} */
    let term = null;
    /** @type {FitAddon | null} */
    let fit = null;
    let destroyed = false;
    /**
     * Whether the scrollback is being written: the answers xterm.js gives to the queries in it
     * (where is the cursor, which terminal is this) were given when they were asked, and what
     * the shell prints meanwhile (`held`) follows it. `replays` counts them, so a newer one (a
     * reconnect) stops an older one.
     */
    let replaying = false;
    let replays = 0;
    /** @type {string[]} */
    let held = [];
    /** The size last sent to the daemon, as `cols x rows`; empty to send it again. */
    let sent = '';
    /** @type {Array<() => void>} */
    const cleanup = [];

    const isEnded = () => daemon.status() === 'open' && !daemon.terminals().some((t) => t.id === id);
    const drawEnded = () => {
      const over = isEnded();
      ended.hidden = !over;
      if (term) term.options.disableStdin = over;
    };
    cleanup.push(daemon.onTerminals(drawEnded), daemon.onStatus(drawEnded));
    drawEnded();

    /** Fits the terminal to the window and, when that changed it, tells the daemon. */
    function fitToWindow() {
      if (!term || !fit || replaying || !screen.clientWidth || !screen.clientHeight) return; // a tab behind another: no size
      const size = fit.proposeDimensions();
      if (!size || !(size.cols > 0) || !(size.rows > 0)) return;
      if (size.cols !== term.cols || size.rows !== term.rows) term.resize(size.cols, size.rows);
      const now = `${term.cols}x${term.rows}`;
      if (now === sent || isEnded()) return;
      sent = now;
      daemon.resizeTerminal(id, term.cols, term.rows).catch(() => (sent = ''));
    }
    let fitting = 0;
    const scheduleFit = () => {
      cancelAnimationFrame(fitting);
      fitting = requestAnimationFrame(fitToWindow);
    };

    loadXterm()
      .then(async ({ Terminal, FitAddon }) => {
        if (destroyed) return;
        const fontSize = () => parseFloat(getComputedStyle(screen).fontSize);
        const t = await xtermIn(Terminal, screen);
        if (destroyed) return t.dispose();
        term = t;
        fit = new FitAddon();
        t.loadAddon(fit);
        t.open(screen);
        t.onData((data) => replaying || daemon.typeInto(id, data));
        t.onBinary((data) => replaying || daemon.typeInto(id, data, true));
        const write = (/** @type {string} */ data) => new Promise((resolve) => t.write(data, () => resolve(undefined)));
        cleanup.push(
          daemon.watchTerminal(id, async (event) => {
            if ('data' in event) {
              if (replaying) held.push(event.data);
              else t.write(event.data);
              return;
            }
            // What it printed so far, from the top, each part at the size it was printed at, as a
            // window showing it all along has it; then this window's size.
            const replay = ++replays;
            replaying = true;
            held = [];
            t.reset();
            for (const part of event.replay) {
              if (part.cols !== t.cols || part.rows !== t.rows) t.resize(part.cols, part.rows);
              await write(part.data);
              if (replay !== replays || destroyed) return;
            }
            replaying = false;
            for (const data of held) t.write(data);
            held = [];
            sent = '';
            fitToWindow();
          }),
          onZoom(() => {
            t.options.fontSize = fontSize();
            scheduleFit();
          }),
          () => t.dispose(),
        );
        const resizes = new ResizeObserver(scheduleFit);
        resizes.observe(screen);
        cleanup.push(() => resizes.disconnect());
        drawEnded();
        fitToWindow();
        if (focusNext) {
          focusNext = false;
          t.focus();
        }
      })
      .catch((err) => {
        if (!destroyed) screen.replaceChildren(el('p', 'term-note omp-error', `The terminal could not load: ${errorMessage(err)}`));
      });

    // Keys go to the shell, not to the app's shortcuts, except those with Cmd.
    screen.addEventListener('keydown', (e) => {
      if (!e.metaKey) e.stopPropagation();
    });
    // A click anywhere in the window types into the terminal, as in a terminal app.
    box.addEventListener('click', (e) => {
      if (!(e.target instanceof Element && e.target.closest('button'))) term?.focus();
    });

    return {
      root: box,
      destroy() {
        destroyed = true;
        cancelAnimationFrame(fitting);
        for (const fn of cleanup) fn();
      },
    };
  }

  const offStatus = daemon.onStatus(render);
  render();
  return {
    paramsChanged: render,
    closed() {
      const id = ctx.params.terminal;
      if (typeof id !== 'string' || !id) return;
      const showing = ctx.screen.get().windows.filter((w) => w.widget === 'terminal' && w.params?.terminal === id);
      if (showing.length <= 1) daemon.endTerminal(id).catch(() => {}); // this window alone
    },
    destroy() {
      offStatus();
      view?.destroy();
    },
  };
}
