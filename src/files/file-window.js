/**
 * Opening a file window (widgets/file.js) from text that names a text file, or a note through an
 * Obsidian wiki link (both marked by omp/markdown-dom.js): a click opens it in the file window this
 * screen used last, or as a tab of the window clicked in if there is none; a drag places a new one
 * where it is dropped, or shows it in the file window it is dropped on. A drag's release is never
 * a click (interaction/drag-controller.js). The daemon finds a wiki link's note in a vault
 * (daemon/vaults.js): a click asks it first, a dropped window asks it itself.
 */
import { DaemonError, getDaemon } from '../daemon/client.js';
/** @import { LeafParams } from '../layout/grid-model.js' */
/** @import { WidgetContext } from '../widgets/registry.js' */

/**
 * What a file window shows: a file (absolute, or from home with `~/`) at a line, or the note wiki
 * link `wiki` names from text in folder `from`.
 * @typedef {{ path: string, line: number | null } | { wiki: string, from: string | null }} Shown
 */

/**
 * The params of a file window showing `shown`. Every param is set, so a window it is dropped on
 * shows only it.
 * @param {Shown} shown @returns {LeafParams}
 */
const fileParams = (shown) => ('wiki' in shown ? { path: null, line: null, wiki: shown.wiki, from: shown.from } : { path: shown.path, line: shown.line, wiki: null, from: null });

/**
 * `path` as written in text, made absolute: a relative one is in `cwd` (the conversation's
 * directory), or from home when there is none, as the daemon reads it.
 * @param {string} path @param {string | null} cwd
 */
const placedPath = (path, cwd) => (/^[~/]/.test(path) || !cwd ? path : `${cwd.replace(/\/$/, '')}/${path.replace(/^\.\//, '')}`);

/**
 * Lets the text files and wiki links named in `root`'s text be clicked open or dragged out as file
 * windows. Relative paths, and wiki links, are read from `cwd()`.
 * @param {{ root: HTMLElement, ctx: WidgetContext, cwd: () => string | null }} options
 * @returns {() => void} stops it
 */
export function attachFileRefs({ root, ctx, cwd }) {
  /**
   * The marked path or wiki link a pointer is on, unless it is inside a link (which opens itself).
   * @param {EventTarget | null} target
   */
  function marked(target) {
    if (!(target instanceof Element)) return null;
    const ref = /** @type {HTMLElement | null} */ (target.closest('.md-file-ref, .md-wiki-link'));
    return ref && root.contains(ref) && !ref.closest('a') ? ref : null;
  }

  /** What a marked path or wiki link names, as a file window shows it. @param {HTMLElement} ref @returns {Shown | null} */
  function named(ref) {
    const wiki = ref.dataset.wiki;
    if (wiki) return { wiki, from: cwd() };
    if (!ref.dataset.path) return null;
    const line = Number(ref.dataset.line);
    return { path: placedPath(ref.dataset.path, cwd()), line: Number.isInteger(line) && line > 0 ? line : null };
  }

  /** @param {PointerEvent} event */
  function onPointerDown(event) {
    const ref = event.button === 0 ? marked(event.target) : null;
    const shown = ref && named(ref);
    if (!shown) return;
    // Pressing it starts no text selection: the press may become a drag. A click still clicks.
    event.preventDefault();
    const name = 'wiki' in shown ? shown.wiki : shown.path;
    ctx.dragWidget('file', fileParams(shown), event, { label: name.slice(name.lastIndexOf('/') + 1), into: true });
  }

  /**
   * Opens the file a click names, once the daemon says it is there: a name a reply mentions may
   * be of a file elsewhere (another repository), and a window saying "no such file" helps no one.
   * One that is not there is marked so (struck through) and opens nothing.
   * @param {MouseEvent} event
   */
  function onClick(event) {
    const ref = event.button === 0 ? marked(event.target) : null;
    const shown = ref && named(ref);
    if (!ref || !shown) return;
    const daemon = getDaemon();
    const found = 'wiki' in shown ? daemon.wikiTarget(shown.wiki, shown.from ?? '') : daemon.textFile(shown.path);
    found
      .then(({ path }) => {
        const params = fileParams('wiki' in shown ? { path, line: null } : shown);
        if (ctx.screen.get().windows.some((w) => w.widget === 'file')) ctx.showWidget('file', params);
        else ctx.openTab('file', params);
      })
      .catch((err) => {
        if (err instanceof DaemonError && err.status === 404) ref.classList.add('is-missing');
        else ctx.openTab('file', fileParams(shown)); // the window says what went wrong
      });
  }

  root.addEventListener('pointerdown', onPointerDown);
  root.addEventListener('click', onClick);
  return () => {
    root.removeEventListener('pointerdown', onPointerDown);
    root.removeEventListener('click', onClick);
  };
}
