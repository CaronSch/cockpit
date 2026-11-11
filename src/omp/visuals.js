/**
 * Diagrams and charts in agent replies: a closed ```mermaid fence is drawn by Mermaid, a
 * closed ```vega-lite fence (a Vega-Lite spec, JSON) by Vega. They are what an agent can add
 * in passing, written inline with no tool call, so a reply streams in with its visuals.
 *
 * The libraries are big, so each loads (a classic script, its UMD build) the first time a
 * reply needs it. A reply is redrawn whenever it changes, so each drawing is kept as SVG by
 * its source and shown again at once, with no flicker and no work; a chart turns live (its
 * tooltips) when the pointer first rests on it. Each sits in a card whose Save control (on
 * hover) saves the drawing as an SVG or PNG file, or copies it as an image.
 *
 * Nothing reaches the network: Mermaid runs at its `strict` security level (its output
 * sanitised, no click handlers), and Vega's loader takes only files on this machine,
 * through the daemon (`/api/file`), so a spec can't carry what the agent read to a URL. A
 * drawing that fails shows its source, with the reason.
 */
import { button, el } from '../ui/dom.js';
import { errorMessage } from '../ui/format.js';
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

/** Drawings by their language and source, as SVG markup. @type {Map<string, Promise<string>>} */
const drawings = new Map();

/** The app's colours (tokens.css) in sRGB, which every SVG renderer takes. */
const INK = { text: '#fafafb', dim: '#bdbdc1', faint: '#85858b', line: '#2e2e31', grid: 'rgba(255, 255, 255, 0.07)' };
const SURFACE = { window: '#151517', raised: '#1f1f22', edge: '#3c3c42' };
/** Series colours, the accent first: clear apart on the dark surfaces, none of them shouting. */
const PALETTE = ['#818cf8', '#22d3ee', '#fbbf24', '#f472b6', '#34d399', '#a78bfa', '#fb923c', '#38bdf8', '#a3e635', '#fb7185'];
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

let mermaidReady = false;
/** @param {string} source @returns {Promise<string>} */
async function drawMermaid(source) {
  await load(SCRIPTS.mermaid);
  const mermaid = /** @type {any} */ (window).mermaid;
  if (!mermaidReady) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      // The app's own colours on Mermaid's plain theme: quiet rounded nodes, smooth edges.
      theme: 'base',
      // The transcript's own type, and labels that wrap at a line's width rather than a word's,
      // packed close: a diagram reads as part of the reply, not a poster beside it. Its size is
      // its own (see `fit`). Labels are SVG text, not HTML, so a diagram can be saved as an image.
      fontFamily: font(),
      themeVariables: {
        fontSize: textSize(),
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
        lineColor: '#6e7191',
        clusterBkg: 'rgba(255, 255, 255, 0.025)',
        clusterBorder: SURFACE.edge,
        edgeLabelBackground: SURFACE.window,
        actorBkg: SURFACE.raised,
        actorBorder: SURFACE.edge,
        actorTextColor: INK.text,
        actorLineColor: SURFACE.edge,
        signalColor: INK.dim,
        signalTextColor: INK.text,
        labelBoxBkgColor: SURFACE.raised,
        labelBoxBorderColor: SURFACE.edge,
        labelTextColor: INK.text,
        loopTextColor: INK.dim,
        noteBkgColor: '#25263a',
        noteBorderColor: '#4b4f8a',
        noteTextColor: INK.text,
        activationBkgColor: SURFACE.raised,
        activationBorderColor: SURFACE.edge,
      },
      themeCSS: '.node rect, .node polygon, .cluster rect, .actor, .note { rx: 6px; ry: 6px; } .flowchart-link { stroke-width: 1.5px; }',
      htmlLabels: false,
      flowchart: { useMaxWidth: false, htmlLabels: false, curve: 'basis', wrappingWidth: 200, nodeSpacing: 20, rankSpacing: 28, padding: 8 },
    });
    mermaidReady = true;
  }
  const { svg } = await mermaid.render(`md-mermaid-${drawings.size}`, source);
  return svg;
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
 * @returns {Promise<{ view: any, errors: unknown[] }>} the Vega View, not yet run, and the errors
 *   it reports as it runs (Vega logs a failed load and draws on without the data)
 */
async function vegaView(source) {
  const spec = unstackLogScales(JSON.parse(source));
  const { vega, vegaLite } = await vegaLibs();
  const compiled = vegaLite.compile(spec, { config: vegaConfig() }).spec;
  const loader = vega.loader();
  // Data and images come from files on this machine; a link (`href`) may open a web page.
  const sanitize = loader.sanitize.bind(loader);
  loader.sanitize = (/** @type {string} */ uri, /** @type {any} */ options) =>
    options?.context === 'href' ? sanitize(uri, options).then((/** @type {any} */ r) => (/^https?:/.test(r.href) ? r : { href: '' })) : Promise.resolve({ href: localFile(uri) });
  /** @type {unknown[]} */
  const errors = [];
  /** A failed load is a warning to Vega (`'Loading failed', url, error`); it is the drawing's error here. @param {unknown[]} args */
  const failed = (...args) => void errors.push(args.find((a) => a instanceof Error) ?? args.join(' '));
  const logger = { level: () => logger, error: failed, warn: (/** @type {unknown[]} */ ...args) => args.some((a) => a instanceof Error) && failed(...args), info() {}, debug() {} };
  return { view: new vega.View(vega.parse(compiled), { loader, logger, renderer: 'svg', hover: true }), errors };
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

/** @param {string} source @returns {Promise<string>} */
async function drawVegaLite(source) {
  const { view, errors } = await vegaView(source);
  try {
    const svg = await view.toSVG();
    if (errors.length) throw errors[0];
    return svg;
  } finally {
    view.finalize();
  }
}

/** @param {VisualLang} lang @param {string} source @returns {Promise<string>} */
function drawing(lang, source) {
  const key = `${lang}\n${source}`;
  let svg = drawings.get(key);
  if (!svg) {
    svg = lang === 'mermaid' ? drawMermaid(source) : drawVegaLite(source);
    drawings.set(key, svg);
  }
  return svg;
}

/**
 * The block a closed ```mermaid or ```vega-lite fence shows: its drawing in a card, once drawn
 * (at once if it was before), with Save; else its source with why it could not be drawn.
 * @param {VisualLang} lang @param {string} source @returns {HTMLElement}
 */
export function renderVisual(lang, source) {
  const kind = lang === 'mermaid' ? 'diagram' : 'chart';
  const card = el('div', 'md-visual-block');
  const box = el('div', `md-visual is-${lang}`);
  box.setAttribute('role', 'img');
  box.setAttribute('aria-label', lang === 'mermaid' ? 'Diagram' : 'Chart');
  card.append(box);
  drawing(lang, source).then(
    (svg) => {
      box.innerHTML = svg; // Mermaid's sanitised output, or Vega's own: never the agent's markup
      fit(box);
      card.append(...saveControl(svg, kind));
      if (lang === 'vega-lite') box.addEventListener('pointerenter', () => void goLive(box, source), { once: true });
    },
    (/** @type {unknown} */ err) => {
      card.replaceWith(renderCode(source, lang), el('p', 'md-visual-error', `Could not draw this ${kind}: ${err instanceof Error ? err.message : String(err)}`));
    },
  );
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
 * @param {HTMLElement} box
 */
function fit(box) {
  const svg = box.querySelector('svg');
  const width = Number(svg?.getAttribute('width'));
  const height = Number(svg?.getAttribute('height'));
  if (!svg || !(width > 0) || !(height > 0)) return;
  const scale = Math.max(MIN_SCALE, Math.min(1, (innerHeight * MAX_HEIGHT) / height));
  svg.style.width = `${Math.round(width * scale)}px`;
  svg.style.minWidth = `${Math.round(width * MIN_SCALE)}px`;
}

/** Swaps a chart's drawing for a live view of it (tooltips), drawn in the same place. @param {HTMLElement} box @param {string} source */
async function goLive(box, source) {
  const { view } = await vegaView(source);
  const live = el('div');
  await view.initialize(live).runAsync();
  box.replaceChildren(live);
}
