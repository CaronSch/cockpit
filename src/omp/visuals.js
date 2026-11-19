/**
 * Diagrams and charts in agent replies: a closed ```mermaid fence is drawn by Mermaid, a
 * closed ```vega-lite fence (a Vega-Lite spec, JSON) by Vega. They are what an agent can add
 * in passing, written inline with no tool call, so a reply streams in with its visuals.
 *
 * The libraries are big, so each loads (a classic script, its UMD build) the first time a
 * reply needs it, and a drawing is drawn only once its card comes within about a screen of
 * being seen: not in a tab stacked behind another, nor far up a long transcript. A reply is
 * redrawn whenever it changes, so each drawing is kept as SVG by its source and shown again
 * at once, with no flicker and no work; drawn ones are also kept across reloads (IndexedDB,
 * the latest few hundred), so a reload or a workspace shown again draws none of them anew. A
 * kept drawing is named by the UI's version too (daemon/ui-files.js: every file served, the
 * libraries included), so an update of the drawing code or a library draws each again.
 * A drawing sits in a shadow root of its own, so its styles (Mermaid writes a `<style>` into
 * each) stay out of the page's. A chart turns live (its tooltips) when the pointer first rests
 * on it. Each sits in a card whose Save control (on hover) saves the drawing as an SVG or PNG
 * file, or copies it as an image. A card fires `load` once its drawing is in (or, failed, its
 * source), as an image does, so a transcript kept at its bottom (widgets/omp.js) stays there.
 *
 * Nothing reaches the network: Mermaid runs at its `strict` security level (its output
 * sanitised, no click handlers), and Vega's loader takes only files on this machine,
 * through the daemon (`/api/file`), so a spec can't carry what the agent read to a URL. A
 * drawing that fails shows its source, with the reason.
 */
import { getDaemon } from '../daemon/client.js';
import { button, el } from '../ui/dom.js';
import { errorMessage } from '../ui/format.js';
import { showDrawing } from '../ui/image-viewer.js';
import { renderCode } from './code-copy.js';
import { copyReport } from './table-copy.js';
/** @import { VisualLang } from './markdown.js' */

/** Each library's build, as the daemon serves it (ui-files.js), and the global it sets. */
const SCRIPTS = { mermaid: '/vendor/mermaid.min.js', vega: '/vendor/vega.min.js', vegaLite: '/vendor/vega-lite.min.js' };

/** @type {Map<string, Promise<void>>} */
const loading = new Map();
/** Runs a library's script once; resolves when it has. @param {string} src */
function load(src) {
  let done = loading.get(src);
  if (!done) {
    done = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`could not load ${src}`));
      document.head.append(script);
    });
    loading.set(src, done);
  }
  return done;
}

/** Drawings by their key (`drawingKey`), as SVG markup. @type {Map<string, Promise<string>>} */
const drawings = new Map();

/** How many drawings are kept across reloads; past that the one shown longest ago goes. */
const KEPT = 300;
/** @type {Promise<IDBDatabase | null> | null} */
let keeping = null;
/** The drawings kept across reloads, by key, each with when it was last shown; null where IndexedDB is not to be had. */
function keptStore() {
  keeping ??= new Promise((resolve) => {
    try {
      const open = indexedDB.open('cockpit-visuals', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('drawings', { keyPath: 'key' }).createIndex('shown', 'shown');
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return keeping.then((db) => {
    try {
      return db?.transaction('drawings', 'readwrite').objectStore('drawings') ?? null;
    } catch {
      return null; // the database was closed under the page (its site data cleared)
    }
  });
}

/** The drawing kept for `key`, marked as shown now; null if none is. @param {string} key @returns {Promise<string | null>} */
async function kept(key) {
  const store = await keptStore();
  return new Promise((resolve) => {
    if (!store) return resolve(null);
    const get = store.get(key);
    get.onsuccess = () => {
      const found = get.result;
      if (typeof found?.svg !== 'string') return resolve(null);
      store.put({ ...found, shown: Date.now() });
      resolve(found.svg);
    };
    get.onerror = () => resolve(null);
  });
}

/** Keeps a drawing across reloads, dropping the ones shown longest ago past KEPT. @param {string} key @param {string} svg */
async function keep(key, svg) {
  const store = await keptStore();
  if (!store) return;
  store.put({ key, svg, shown: Date.now() });
  const count = store.count();
  count.onsuccess = () => {
    let extra = count.result - KEPT;
    if (extra <= 0) return;
    const oldest = store.index('shown').openCursor();
    oldest.onsuccess = () => {
      const cursor = oldest.result;
      if (!cursor || extra-- <= 0) return;
      cursor.delete();
      cursor.continue();
    };
  };
}

/** The app's colours (tokens.css) in sRGB, which every SVG renderer takes. */
const INK = { text: '#fafafb', dim: '#bdbdc1', faint: '#85858b', line: '#2e2e31', grid: 'rgba(255, 255, 255, 0.07)' };
const SURFACE = { window: '#151517', raised: '#1f1f22', edge: '#3c3c42' };
/** Series colours, the accent first: clear apart on the dark surfaces, none of them shouting. */
const PALETTE = ['#818cf8', '#22d3ee', '#fbbf24', '#f472b6', '#34d399', '#a78bfa', '#fb923c', '#38bdf8', '#a3e635', '#fb7185'];
/** A diagram's edges and arrows: a grey with a little of the accent in it, quieter than the nodes. */
const EDGE = '#5d6080';
/**
 * Mermaid's own CSS, over its theme: no drop shadow under nodes (its "neo" look's light one reads
 * as a glow on a dark surface), rounder corners, labels a touch heavier, thin edges with labels
 * that read as notes on them, groups dashed with their names faint; a sequence diagram's text at
 * `size`, as a flowchart's (its own setting for it is not followed).
 * @param {string} size
 */
const mermaidCss = (size) => `
  .node rect, .node polygon, .node path, .node circle, .node ellipse, .cluster rect, .actor, .note, .labelBox { filter: none !important; }
  .node rect, .cluster rect, .actor, .note, .labelBox { rx: 8px; ry: 8px; }
  .node .label text, .nodeLabel, text.actor > tspan { font-weight: 500; }
  text.actor, text.actor > tspan, .messageText, .noteText, .noteText > tspan, .labelText, .loopText { font-size: ${size} !important; }
  .flowchart-link, .messageLine0, .messageLine1 { stroke-width: 1.25px; }
  .edgeLabel text, .edgeLabel tspan, .messageText { fill: ${INK.dim} !important; }
  .cluster rect { stroke-dasharray: 4 3; }
  .cluster-label text, .cluster-label tspan { fill: ${INK.faint} !important; }
  marker path, .arrowheadPath { fill: ${EDGE} !important; stroke: none !important; }
`;
/** The transcript's typeface (read when first drawing, not on import). */
const font = () => getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim() || 'monospace';
/** The transcript's reading size, in pixels (`--text-sm`, which follows the text size the top bar sets). */
function textSize() {
  const probe = el('span');
  probe.style.fontSize = 'var(--text-sm)';
  document.body.append(probe);
  const size = getComputedStyle(probe).fontSize;
  probe.remove();
  return size;
}

/** A file on this machine, as the daemon serves it; anything else is refused. @param {string} uri */
function localFile(uri) {
  if (!/^~?\//.test(uri) || uri.startsWith('//')) throw new Error(`only files on this machine can be loaded, not ${uri}`);
  return `/api/file?path=${encodeURIComponent(uri)}`;
}

/**
 * Mermaid's settings: the app's own colours on its plain theme, drawn as the charts are: flat
 * nodes (no glow) with round corners and room inside, thin quiet edges, dashed groups.
 */
function mermaidConfig() {
  const size = textSize();
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: 'base',
    // The transcript's own type, and labels that wrap at a line's width rather than a word's,
    // packed close: a diagram reads as part of the reply, not a poster beside it. Its size is
    // its own (see `fit`). Labels are SVG text, not HTML, so a diagram can be saved as an image.
    fontFamily: font(),
    themeVariables: {
      fontSize: size,
      fontFamily: font(),
      background: 'transparent',
      primaryColor: SURFACE.raised,
      primaryBorderColor: SURFACE.edge,
      primaryTextColor: INK.text,
      secondaryColor: SURFACE.window,
      secondaryBorderColor: SURFACE.edge,
      secondaryTextColor: INK.text,
      tertiaryColor: SURFACE.window,
      tertiaryBorderColor: SURFACE.edge,
      tertiaryTextColor: INK.text,
      mainBkg: SURFACE.raised,
      nodeBorder: SURFACE.edge,
      textColor: INK.text,
      titleColor: INK.text,
      lineColor: EDGE,
      clusterBkg: 'rgba(255, 255, 255, 0.02)',
      clusterBorder: SURFACE.edge,
      edgeLabelBackground: SURFACE.window,
      actorBkg: SURFACE.raised,
      actorBorder: SURFACE.edge,
      actorTextColor: INK.text,
      actorLineColor: INK.line,
      signalColor: EDGE,
      signalTextColor: INK.dim,
      labelBoxBkgColor: SURFACE.raised,
      labelBoxBorderColor: SURFACE.edge,
      labelTextColor: INK.text,
      loopTextColor: INK.dim,
      noteBkgColor: '#23243a',
      noteBorderColor: '#3f4275',
      noteTextColor: INK.text,
      activationBkgColor: SURFACE.raised,
      activationBorderColor: SURFACE.edge,
    },
    themeCSS: mermaidCss(size),
    htmlLabels: false,
    flowchart: { useMaxWidth: false, htmlLabels: false, curve: 'basis', wrappingWidth: 200, nodeSpacing: 28, rankSpacing: 40, padding: 12 },
    sequence: {
      useMaxWidth: false,
      mirrorActors: false,
      actorFontFamily: font(),
      messageFontFamily: font(),
      noteFontFamily: font(),
      width: 120,
      height: 36,
      boxMargin: 8,
      actorMargin: 48,
      messageMargin: 36,
      diagramMarginX: 8,
      diagramMarginY: 8,
    },
  };
}

let mermaidReady = false;
/** Diagrams drawn so far, so each gets an element id of its own. */
let mermaidCount = 0;
/** The diagram being drawn: Mermaid draws one at a time, so the next waits for it. */
let mermaidTurn = Promise.resolve();
/** @param {string} source @returns {Promise<string>} */
async function drawMermaid(source) {
  await load(SCRIPTS.mermaid);
  const mermaid = /** @type {any} */ (window).mermaid;
  if (!mermaidReady) {
    mermaid.initialize(looks().mermaid);
    mermaidReady = true;
  }
  const id = `md-mermaid-${++mermaidCount}`;
  const drawn = mermaidTurn.then(() => mermaid.render(id, source));
  mermaidTurn = drawn.catch(() => {});
  return (await drawn).svg;
}

/** @returns {Promise<{ vega: any, vegaLite: any }>} */
async function vegaLibs() {
  await load(SCRIPTS.vega);
  await load(SCRIPTS.vegaLite); // needs Vega's global
  const w = /** @type {any} */ (window);
  return { vega: w.vega, vegaLite: w.vegaLite };
}

/** Charts in the app's colours, drawn quietly (no frame, no ticks, faint gridlines): the agent's spec can set its own over these. */
const vegaConfig = () => ({
  background: null,
  font: font(),
  // A fixed size, as drawn ahead of any window; a wider spec scales down to fit (CSS).
  view: { stroke: null, continuousWidth: 560, continuousHeight: 260 },
  range: { category: PALETTE },
  title: { color: INK.text, subtitleColor: INK.dim, anchor: 'start', fontSize: 13, fontWeight: 600, offset: 14 },
  axis: {
    domain: false,
    ticks: false,
    gridColor: INK.grid,
    labelColor: INK.faint,
    labelFontSize: 11,
    labelPadding: 6,
    titleColor: INK.dim,
    titleFontSize: 11,
    titleFontWeight: 500,
    titlePadding: 10,
  },
  axisX: { grid: false, domain: true, domainColor: INK.line },
  axisBand: { grid: false },
  legend: { labelColor: INK.dim, labelFontSize: 11, titleColor: INK.faint, titleFontSize: 11, titleFontWeight: 500, symbolType: 'circle', symbolSize: 60, symbolStrokeWidth: 0 },
  header: { labelColor: INK.dim, titleColor: INK.dim },
  line: { strokeWidth: 2, strokeCap: 'round', strokeJoin: 'round', interpolate: 'monotone' },
  point: { filled: true, size: 24 },
  bar: { cornerRadiusEnd: 3 },
  area: { fillOpacity: 0.18, line: true, interpolate: 'monotone' },
  arc: { stroke: SURFACE.window, strokeWidth: 2 },
  text: { color: INK.text },
  rule: { color: INK.faint },
});

/**
 * @param {string} source
 * @returns {Promise<{ view: any, errors: unknown[], reads: string[] }>} the Vega View, not yet
 *   run, the errors it reports as it runs (Vega logs a failed load and draws on without the
 *   data), and the files it loads as it runs
 */
async function vegaView(source) {
  const spec = unstackLogScales(JSON.parse(source));
  const { vega, vegaLite } = await vegaLibs();
  const compiled = vegaLite.compile(spec, { config: vegaConfig() }).spec;
  const loader = vega.loader();
  /** @type {string[]} */
  const reads = [];
  // Data and images come from files on this machine; a link (`href`) may open a web page.
  const sanitize = loader.sanitize.bind(loader);
  loader.sanitize = (/** @type {string} */ uri, /** @type {any} */ options) => {
    if (options?.context === 'href') return sanitize(uri, options).then((/** @type {any} */ r) => (/^https?:/.test(r.href) ? r : { href: '' }));
    reads.push(uri);
    return Promise.resolve({ href: localFile(uri) });
  };
  /** @type {unknown[]} */
  const errors = [];
  /** A failed load is a warning to Vega (`'Loading failed', url, error`); it is the drawing's error here. @param {unknown[]} args */
  const failed = (...args) => void errors.push(args.find((a) => a instanceof Error) ?? args.join(' '));
  const logger = { level: () => logger, error: failed, warn: (/** @type {unknown[]} */ ...args) => args.some((a) => a instanceof Error) && failed(...args), info() {}, debug() {} };
  return { view: new vega.View(vega.parse(compiled), { loader, logger, renderer: 'svg', hover: true }), errors, reads };
}

/**
 * Bars on a log scale, drawn at all: Vega-Lite stacks a bar from zero, which a log scale has
 * no place for, so every bar is empty (it warns, and draws the axes). A channel on a log
 * scale that does not say how to stack is not stacked, so its bars run from the axis' start.
 * @param {any} spec parsed JSON, changed in place @returns {any}
 */
function unstackLogScales(spec) {
  if (Array.isArray(spec)) spec.forEach(unstackLogScales);
  else if (spec && typeof spec === 'object') {
    for (const channel of Object.values(spec.encoding ?? {})) {
      if (channel?.scale?.type === 'log' && !('stack' in channel)) channel.stack = false;
    }
    Object.values(spec).forEach(unstackLogScales);
  }
  return spec;
}

/**
 * @param {string} source
 * @returns {Promise<{ svg: string, lasting: boolean }>} the chart, and whether it may be kept
 *   across reloads: not if it read a file, which may have changed by the next one
 */
async function drawVegaLite(source) {
  const { view, errors, reads } = await vegaView(source);
  try {
    const svg = await view.toSVG();
    if (errors.length) throw errors[0];
    return { svg, lasting: reads.length === 0 };
  } finally {
    view.finalize();
  }
}

/** @type {{ mermaid: object, key: string } | null} */
let settings = null;
/**
 * The libraries' settings, read once per page (the type, at the size the page first draws one
 * at), and a short name for them, which keys drawings: one kept across reloads under other
 * settings (another text size, colours changed since) is drawn again.
 */
function looks() {
  if (!settings) {
    const mermaid = mermaidConfig();
    settings = { mermaid, key: hash(JSON.stringify([mermaid, vegaConfig()])) };
  }
  return settings;
}

/** A short name for a long text (FNV-1a, 32 bits). @param {string} text */
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

/**
 * What a drawing is kept by: the UI's version (so a new Mermaid, Vega or drawing code draws
 * again), the settings it is drawn with, its language and its source. Null before the daemon
 * has said which UI this is: kept for this page only, then.
 * @param {VisualLang} lang @param {string} source
 */
function drawingKey(lang, source) {
  const ui = getDaemon().uiVersion();
  return { key: `${ui ?? ''}\n${looks().key}\n${lang}\n${source}`, lasting: ui !== null };
}

/** The drawing, as kept (this page, then across reloads), else drawn now and kept. @param {{ key: string, lasting: boolean }} at @param {VisualLang} lang @param {string} source @returns {Promise<string>} */
function drawing({ key, lasting }, lang, source) {
  let svg = drawings.get(key);
  if (!svg) {
    svg = (lasting ? kept(key) : Promise.resolve(null)).then(async (found) => {
      if (found !== null) return found;
      const drawn = lang === 'mermaid' ? { svg: await drawMermaid(source), lasting: true } : await drawVegaLite(source);
      if (lasting && drawn.lasting) void keep(key, drawn.svg);
      return drawn.svg;
    });
    drawings.set(key, svg);
  }
  return svg;
}

/** How far beyond the window (and beyond a transcript's scrolled edge) a card is drawn: about a screen, so it is there by the time it scrolls in. */
const NEAR = '100% 0px';
/** Cards waiting to be drawn, each with what draws it. @type {Map<Element, () => void>} */
const waiting = new Map();
/** @type {IntersectionObserver | null} */
let nearing = null;
/** How often cards that left the page before they came near are let go, while any wait. */
const SWEEP_MS = 10_000;
/** @type {ReturnType<typeof setInterval> | undefined} */
let sweeping;
/**
 * Lets go of cards that left the page (their reply redrawn, their window closed) before they
 * came near: an observer holds what it observes, and with it the transcript they were in.
 */
function sweep() {
  for (const card of waiting.keys()) {
    if (card.isConnected) continue;
    nearing?.unobserve(card);
    waiting.delete(card);
  }
  idleIfDone();
}
/**
 * With no card waiting, the observer goes: while any is observed, Chrome runs a main-thread frame
 * for every frame of a running transform animation (the spinners), to keep intersections current.
 */
function idleIfDone() {
  if (waiting.size > 0) return;
  nearing?.disconnect();
  nearing = null;
  clearInterval(sweeping);
  sweeping = undefined;
}
/**
 * Runs `draw` once `card` comes within NEAR of being seen; never while it is in a tab stacked
 * behind another (`content-visibility: hidden`, which lays nothing out, so nothing intersects).
 * @param {Element} card @param {() => void} draw
 */
function whenNear(card, draw) {
  nearing ??= new IntersectionObserver(
    (entries) => {
      for (const { target, isIntersecting } of entries) {
        if (!isIntersecting) continue;
        nearing?.unobserve(target);
        waiting.get(target)?.();
        waiting.delete(target);
      }
      idleIfDone();
    },
    { rootMargin: NEAR, scrollMargin: NEAR },
  );
  waiting.set(card, draw);
  nearing.observe(card);
  // A card is still being built into its reply now; it is swept only later, once it could have left.
  sweeping ??= setInterval(sweep, SWEEP_MS);
}

/** How a drawing sits in its card, inside its shadow root (where `.md-visual svg` would not reach). */
let drawingSheet = /** @type {CSSStyleSheet | null} */ (null);
function drawingStyle() {
  if (!drawingSheet) {
    drawingSheet = new CSSStyleSheet();
    // As wide as the reply, down to a floor set per drawing (`fit`), then it scrolls.
    drawingSheet.replaceSync('svg { display: block; max-width: 100%; height: auto; }');
  }
  return drawingSheet;
}

/**
 * The block a closed ```mermaid or ```vega-lite fence shows: its drawing in a card, once drawn
 * (at once if it was before, else once the card nears the window), with Save; else its source
 * with why it could not be drawn. A click on the drawing (or Enter on it) shows it in the
 * image viewer, as large as the window allows; one that ends a text selection does not.
 * @param {VisualLang} lang @param {string} source @returns {HTMLElement}
 */
export function renderVisual(lang, source) {
  const kind = lang === 'mermaid' ? 'diagram' : 'chart';
  const name = lang === 'mermaid' ? 'Diagram' : 'Chart';
  const card = el('div', 'md-visual-block');
  const box = el('div', `md-visual is-${lang}`);
  box.setAttribute('role', 'img');
  box.setAttribute('aria-label', name);
  card.append(box);
  /** @param {string} svg */
  const show = (svg) => {
    const view = box.attachShadow({ mode: 'open' });
    view.adoptedStyleSheets = [drawingStyle()];
    view.innerHTML = svg; // Mermaid's sanitised output, or Vega's own: never the agent's markup
    fit(view);
    card.append(...saveControl(svg, kind));
    if (lang === 'vega-lite') box.addEventListener('pointerenter', () => void goLive(view, source), { once: true });
    box.setAttribute('role', 'button');
    box.setAttribute('aria-label', `${name}: show it larger`);
    box.tabIndex = 0;
    box.classList.add('is-zoomable');
    box.addEventListener('click', (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (!(document.getSelection()?.isCollapsed ?? true)) return;
      showDrawing(svg, name);
    });
    box.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      showDrawing(svg, name);
    });
    card.dispatchEvent(new Event('load')); // as an image does once it has loaded
  };
  /** @param {unknown} err */
  const failed = (err) => {
    const code = renderCode(source, lang);
    card.replaceWith(code, el('p', 'md-visual-error', `Could not draw this ${kind}: ${err instanceof Error ? err.message : String(err)}`));
    code.dispatchEvent(new Event('load'));
  };
  const at = drawingKey(lang, source);
  const draw = () => void drawing(at, lang, source).then(show, failed);
  // One drawn before (or on its way) shows at once, as the reply it is in is redrawn.
  if (drawings.has(at.key)) draw();
  else whenNear(card, draw);
  return card;
}

/**
 * The Save button and its menu (shown while the card is pointed at, as a table's Copy): the
 * drawing as an SVG file or a PNG file, or a PNG image on the clipboard.
 * @param {string} svg @param {string} kind @returns {[HTMLButtonElement, HTMLElement]}
 */
function saveControl(svg, kind) {
  const save = button('md-table-copy md-visual-save', 'Save');
  const menu = el('div', 'omp-menu md-table-copy-menu');
  menu.popover = 'auto';
  save.popoverTargetElement = menu;
  const report = copyReport(save, 'Save');
  /** @type {[string, () => Promise<unknown>][]} */
  const actions = [
    ['SVG file', async () => download(new Blob([svg], { type: 'image/svg+xml' }), `${kind}.svg`)],
    ['PNG file', async () => download(await pngOf(svg), `${kind}.png`)],
    // Handing over the promise keeps the click's user activation while the image is drawn.
    ['Copy image', async () => navigator.clipboard.write([new ClipboardItem({ 'image/png': pngOf(svg) })]).then(() => report('Copied'))],
  ];
  menu.append(
    ...actions.map(([label, act]) =>
      button('omp-menu-item', label, () => {
        menu.hidePopover();
        act().catch((err) => report('Save failed', errorMessage(err)));
      }),
    ),
  );
  return [save, menu];
}

/** Hands `blob` to the browser as a download named `name`. @param {Blob} blob @param {string} name */
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = el('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** How much finer than on screen a PNG is drawn, so it stays sharp on a Retina display. */
const PNG_SCALE = 2;

/**
 * The drawing as a PNG, at its own size times PNG_SCALE, on the window's colour (light text on
 * a transparent image would vanish on a light page).
 * @param {string} svg @returns {Promise<Blob>}
 */
async function pngOf(svg) {
  const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
  const box = (root.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
  const width = Number(root.getAttribute('width')) || box[2] || 600;
  const height = Number(root.getAttribute('height')) || box[3] || 400;
  root.setAttribute('width', String(width));
  root.setAttribute('height', String(height));
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(root)], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = el('canvas');
    canvas.width = Math.ceil(width * PNG_SCALE);
    canvas.height = Math.ceil(height * PNG_SCALE);
    const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
    ctx.fillStyle = SURFACE.window;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) => canvas.toBlob((png) => (png ? resolve(png) : reject(new Error('could not draw the image'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** How far a drawing may shrink to fit the reply: past that its text gets too small to read. */
const MIN_SCALE = 0.7;

/** How tall a drawing may be, as a share of the window, before it shrinks. */
const MAX_HEIGHT = 0.6;

/**
 * A drawing taller than MAX_HEIGHT of the window, or wider than the reply (CSS), shrinks to
 * fit, down to MIN_SCALE of its own size; past that it keeps that size, scrolling sideways
 * when too wide.
 * @param {ShadowRoot} view the shadow root the drawing is in
 */
function fit(view) {
  const svg = view.querySelector('svg');
  const width = Number(svg?.getAttribute('width'));
  const height = Number(svg?.getAttribute('height'));
  if (!svg || !(width > 0) || !(height > 0)) return;
  const scale = Math.max(MIN_SCALE, Math.min(1, (innerHeight * MAX_HEIGHT) / height));
  svg.style.width = `${Math.round(width * scale)}px`;
  svg.style.minWidth = `${Math.round(width * MIN_SCALE)}px`;
}

/** Swaps a chart's drawing for a live view of it (tooltips), drawn in the same place. @param {ShadowRoot} view @param {string} source */
async function goLive(view, source) {
  const { view: chart } = await vegaView(source);
  const live = el('div');
  await chart.initialize(live).runAsync();
  view.replaceChildren(live);
}
