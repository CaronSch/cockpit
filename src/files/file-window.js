/**
 * Opening a file window (widgets/file.js) from text that names a text file (marked by
 * omp/markdown-dom.js): a click opens it in the file window this screen used last, or beside
 * the window clicked in if there is none; a drag places a new one where it is dropped, or shows
 * it in the file window it is dropped on. A drag's release is never a click
 * (interaction/drag-controller.js).
 */
/** @import { LeafParams } from '../layout/grid-model.js' */
/** @import { WidgetContext } from '../widgets/registry.js' */

/**
 * The params of a file window showing `path` (absolute, or from home with `~/`) at `line`. Every
 * param is set, so a window it is dropped on shows only it.
 * @param {string} path @param {number | null} line @returns {LeafParams}
 */
export const fileParams = (path, line) => ({ path, line });

/**
 * `path` as written in text, made absolute: a relative one is in `cwd` (the conversation's
 * directory), or from home when there is none, as the daemon reads it.
 * @param {string} path @param {string | null} cwd
 */
export const placedPath = (path, cwd) => (/^[~/]/.test(path) || !cwd ? path : `${cwd.replace(/\/$/, '')}/${path.replace(/^\.\//, '')}`);

/**
 * Lets the text files named in `root`'s text be clicked open or dragged out as file windows.
 * Relative paths are in `cwd()`.
 * @param {{ root: HTMLElement, ctx: WidgetContext, cwd: () => string | null }} options
 * @returns {() => void} stops it
 */
export function attachFileRefs({ root, ctx, cwd }) {
  /** The file window params a marked path names, unless it is inside a link (which opens itself). @param {EventTarget | null} target */
  function named(target) {
    if (!(target instanceof Element)) return null;
    const ref = /** @type {HTMLElement | null} */ (target.closest('.md-file-ref'));
    if (!ref || !root.contains(ref) || ref.closest('a') || !ref.dataset.path) return null;
    const line = Number(ref.dataset.line);
    return { path: placedPath(ref.dataset.path, cwd()), line: Number.isInteger(line) && line > 0 ? line : null };
  }

  /** @param {PointerEvent} event */
  function onPointerDown(event) {
    const file = event.button === 0 ? named(event.target) : null;
    if (!file) return;
    // Pressing it starts no text selection: the press may become a drag. A click still clicks.
    event.preventDefault();
    const label = file.path.slice(file.path.lastIndexOf('/') + 1);
    ctx.dragWidget('file', fileParams(file.path, file.line), event, { label, into: true });
  }

  /** @param {MouseEvent} event */
  function onClick(event) {
    const file = event.button === 0 ? named(event.target) : null;
    if (!file) return;
    const params = fileParams(file.path, file.line);
    if (ctx.screen.get().windows.some((w) => w.widget === 'file')) ctx.showWidget('file', params);
    else ctx.openBeside('file', params);
  }

  root.addEventListener('pointerdown', onPointerDown);
  root.addEventListener('click', onClick);
  return () => {
    root.removeEventListener('pointerdown', onPointerDown);
    root.removeEventListener('click', onClick);
  };
}
