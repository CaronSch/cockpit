/**
 * An image viewer over the workbench: a click on an image (in a reply, a prompt or a note)
 * shows it as large as the window allows, on a dimmed backdrop; Esc, a click outside it or ×
 * closes it. A ⌘-click (Ctrl-click elsewhere) still opens it in a new tab.
 */
import { button, el } from './dom.js';

/** @type {{ dialog: HTMLDialogElement, img: HTMLImageElement, caption: HTMLElement } | null} */
let viewer = null;

/** Shows the image at `src`, captioned `name`. @param {string} src @param {string} name */
export function showImage(src, name) {
  if (!viewer) {
    const dialog = /** @type {HTMLDialogElement} */ (el('dialog', 'image-viewer'));
    dialog.setAttribute('aria-label', 'Image');
    const img = /** @type {HTMLImageElement} */ (el('img', 'image-viewer-img'));
    const caption = el('p', 'image-viewer-caption');
    const close = button('image-viewer-close', '×', () => dialog.close());
    close.setAttribute('aria-label', 'Close');
    dialog.append(img, caption, close);
    // A click on the backdrop lands on the dialog itself, outside the picture.
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
    document.body.append(dialog);
    viewer = { dialog, img, caption };
  }
  viewer.img.src = src;
  viewer.img.alt = name;
  viewer.caption.textContent = name;
  viewer.dialog.showModal();
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
