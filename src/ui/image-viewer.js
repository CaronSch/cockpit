/**
 * An image viewer over the workbench: a click on an image (in a reply, a prompt or a note), or
 * on a diagram or chart an agent drew, shows it as large as the window allows, on a dimmed
 * backdrop; Esc or a click anywhere closes it. A ⌘-click (Ctrl-click elsewhere) on an image
 * still opens it in a new tab.
 */
import { el } from './dom.js';

/** How much larger than drawn a diagram or chart may be shown: enough to read, not a poster. */
const MAX_ZOOM = 2.5;

/** @type {{ dialog: HTMLDialogElement, stage: HTMLElement, caption: HTMLElement } | null} */
let viewer = null;

/** Opens the viewer on `shown`, captioned `name`. @param {Element} shown @param {string} name */
function open(shown, name) {
  if (!viewer) {
    const dialog = /** @type {HTMLDialogElement} */ (el('dialog', 'image-viewer'));
    dialog.setAttribute('aria-label', 'Image');
    const stage = el('div', 'image-viewer-stage');
    const caption = el('p', 'image-viewer-caption');
    dialog.append(stage, caption);
    dialog.addEventListener('click', () => dialog.close());
    document.body.append(dialog);
    viewer = { dialog, stage, caption };
  }
  viewer.stage.replaceChildren(shown);
  viewer.caption.textContent = name;
  viewer.dialog.showModal();
}

/** Shows the image at `src`, captioned `name`. @param {string} src @param {string} name */
export function showImage(src, name) {
  const img = /** @type {HTMLImageElement} */ (el('img', 'image-viewer-img'));
  img.src = src;
  img.alt = name;
  open(img, name);
}

/**
 * Shows a drawing (a diagram's or chart's SVG markup, as drawn: never the agent's own) on its
 * card's surface, scaled to fill the window, captioned `name`. Drawn inline, not as an image,
 * so its text keeps the app's typeface.
 * @param {string} svg @param {string} name
 */
export function showDrawing(svg, name) {
  const panel = el('div', 'image-viewer-drawing');
  panel.innerHTML = svg;
  const drawing = panel.querySelector('svg');
  if (!drawing) return;
  const box = drawing.viewBox.baseVal;
  const width = box?.width || Number(drawing.getAttribute('width')) || 0;
  const height = box?.height || Number(drawing.getAttribute('height')) || 0;
  if (width > 0 && height > 0) {
    // Room the panel's padding and the caption leave, as `.image-viewer-drawing` sets them.
    const scale = Math.min((innerWidth * 0.92 - 64) / width, (innerHeight * 0.92 - 96) / height, MAX_ZOOM);
    drawing.setAttribute('width', String(Math.round(width * scale)));
    drawing.setAttribute('height', String(Math.round(height * scale)));
    drawing.style.maxWidth = 'none';
  }
  drawing.setAttribute('role', 'img');
  drawing.setAttribute('aria-label', name);
  open(panel, name);
}

/**
 * Makes a link to an image open the viewer on a plain click, keeping the link's own behaviour
 * (a new tab) for ⌘/Ctrl/Shift-clicks.
 * @param {HTMLAnchorElement} link @param {string} name
 */
export function opensInViewer(link, name) {
  link.addEventListener('click', (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    showImage(link.href, name);
  });
}
