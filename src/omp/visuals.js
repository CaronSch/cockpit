/**
 * Diagrams and charts in agent replies: a closed ```mermaid fence is drawn by Mermaid, a
 * closed ```vega-lite fence (a Vega-Lite spec, JSON) by Vega. They are what an agent can add
 * in passing, written inline with no tool call, so a reply streams in with its visuals.
 *
 * The libraries are big, so each loads (a classic script, its UMD build) the first time a
 * reply needs it. A reply is redrawn whenever it changes, so each drawing is kept as SVG by
 * its source and shown again at once, with no flicker and no work; a chart turns live (its
 * tooltips) when the pointer first rests on it.
 *
 * Nothing reaches the network: Mermaid runs at its `strict` security level (its output
 * sanitised, no click handlers), and Vega's loader takes only files on this machine,
 * through the daemon (`/api/file`), so a spec can't carry what the agent read to a URL. A
 * drawing that fails shows its source, with the reason.
 */
import { el } from '../ui/dom.js';
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

/** Graphite, as the app's tokens (tokens.css) in sRGB, which every SVG renderer takes. */
const INK = { text: '#e6e6e6', dim: '#a5a8b0', faint: '#7d8089', line: '#3d4048' };
/** The app's typeface (read when first drawing, not on import). */
const font = () => getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'monospace';
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
      theme: 'dark',
      darkMode: true,
      // The transcript's own type, and labels that wrap at a line's width rather than a word's,
      // packed close: a diagram reads as part of the reply, not a poster beside it. Its size is
      // its own (see `fit`).
      fontFamily: font(),
      themeVariables: { fontSize: textSize() },
      flowchart: { useMaxWidth: false, wrappingWidth: 200, nodeSpacing: 20, rankSpacing: 28, padding: 6 },
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

/** Charts in the app's colours: the agent's spec can set its own over these. */
const vegaConfig = () => ({
  background: null,
  font: font(),
  // A fixed size, as drawn ahead of any window; a wider spec scales down to fit (CSS).
  view: { stroke: INK.line, continuousWidth: 560, continuousHeight: 260 },
  title: { color: INK.text, subtitleColor: INK.dim },
  axis: { domainColor: INK.line, gridColor: INK.line, tickColor: INK.line, labelColor: INK.dim, titleColor: INK.dim },
  legend: { labelColor: INK.dim, titleColor: INK.dim },
  header: { labelColor: INK.dim, titleColor: INK.dim },
  text: { color: INK.text },
  rule: { color: INK.faint },
});

/**
 * @param {string} source
 * @returns {Promise<{ view: any, errors: unknown[] }>} the Vega View, not yet run, and the errors
 *   it reports as it runs (Vega logs a failed load and draws on without the data)
 */
async function vegaView(source) {
  const spec = JSON.parse(source);
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
 * The block a closed ```mermaid or ```vega-lite fence shows: its drawing, once drawn (at once
 * if it was before), else its source with why it could not be drawn.
 * @param {VisualLang} lang @param {string} source @returns {HTMLElement}
 */
export function renderVisual(lang, source) {
  const box = el('div', `md-visual is-${lang}`);
  box.setAttribute('role', 'img');
  box.setAttribute('aria-label', lang === 'mermaid' ? 'Diagram' : 'Chart');
  drawing(lang, source).then(
    (svg) => {
      box.innerHTML = svg; // Mermaid's sanitised output, or Vega's own: never the agent's markup
      fit(box);
      if (lang === 'vega-lite') box.addEventListener('pointerenter', () => void goLive(box, source), { once: true });
    },
    (/** @type {unknown} */ err) => {
      const pre = el('pre', 'md-code', source);
      pre.dataset.lang = lang;
      box.replaceWith(pre, el('p', 'md-visual-error', `Could not draw this ${lang === 'mermaid' ? 'diagram' : 'chart'}: ${err instanceof Error ? err.message : String(err)}`));
    },
  );
  return box;
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
