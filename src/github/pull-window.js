/**
 * Opening a pull request window (widgets/github.js) from another window: the params that name
 * the pull request and the conversation it is reviewed for, and dragging one out of text, where
 * a pull request is linked or referred to as `owner/name#123` or `#123` (marked by omp/markdown-dom.js): dropped on
 * the grid it opens a pull request window there, dropped on a pull request window it shows there.
 *
 * A click is not a drag: pressed and released without moving, a link opens on GitHub in a new
 * tab, as any link does, and so does a reference, once its repository is known. A drag's
 * release is never a click (interaction/drag-controller.js).
 */
/** @import { ConversationTarget } from '../../daemon/wire.js' */
/** @import { LeafParams } from '../layout/grid-model.js' */
/** @import { WidgetContext } from '../widgets/registry.js' */

/**
 * Where a pull request is: a repository (`owner/name`) if known, else the one directory `cwd`
 * is in.
 * @typedef {{ repo: string | null, cwd: string | null }} PullPlace
 */

/**
 * The params of a pull request window showing pull request `number` at `at`, reviewed for
 * `parent`'s conversation. Every param is set, so a window it is dropped on shows only it.
 * @param {PullPlace} at @param {{ number: number, title?: string | null }} pull @param {ConversationTarget | null} parent
 * @returns {LeafParams}
 */
export const pullParams = (at, pull, parent) => ({
  repo: at.repo,
  cwd: at.cwd,
  number: pull.number,
  name: pull.title ? `#${pull.number} ${pull.title}` : `#${pull.number}`,
  tab: 'conversation',
  parentFile: parent?.sessionFile ?? null,
  parentSession: parent?.session ?? null,
  parentCwd: parent?.cwd ?? null,
});

/** A pull request's page on GitHub. @param {string} repo `owner/name` @param {number} number */
const pullUrl = (repo, number) => `https://github.com/${repo}/pull/${number}`;

/**
 * Lets the pull requests linked or referred to in `root`'s text be dragged out as pull request
 * windows, and a reference be clicked open on GitHub. `base` is where a bare `#123` is (the
 * repository the text is about; a click needs its `repo`), null when the text has none;
 * `parent` the conversation the window reviews for.
 * @param {{ root: HTMLElement, ctx: WidgetContext, base: () => PullPlace | null, parent: () => ConversationTarget | null }} options
 * @returns {() => void} stops it
 */
export function attachPullDrag({ root, ctx, base, parent }) {
  /** The pull request `marked` names, and where it is. @param {HTMLElement} marked */
  function named(marked) {
    const number = Number(marked.dataset.number);
    const at = marked.dataset.repo ? { repo: marked.dataset.repo, cwd: null } : base();
    return at && Number.isInteger(number) ? { at, number } : null;
  }

  /** @param {PointerEvent} event */
  function onPointerDown(event) {
    if (event.button !== 0 || !(event.target instanceof Element)) return;
    const link = /** @type {HTMLElement | null} */ (event.target.closest('.md-pr-link'));
    const ref = link ? null : /** @type {HTMLElement | null} */ (event.target.closest('.md-pr-ref'));
    const marked = link ?? ref;
    if (!marked || !root.contains(marked)) return;
    const pull = named(marked);
    if (!pull) return;
    // Pressing it starts no text selection: the press may become a drag. A click still clicks.
    event.preventDefault();
    const label = pull.at.repo ? `${pull.at.repo}#${pull.number}` : `#${pull.number}`;
    ctx.dragWidget('github', pullParams(pull.at, { number: pull.number }, parent()), event, { label, into: true });
  }

  /** A reference clicked (a link opens by itself) opens on GitHub, as a link would. @param {MouseEvent} event */
  function onClick(event) {
    if (event.button !== 0 || !(event.target instanceof Element) || event.target.closest('a')) return;
    const ref = /** @type {HTMLElement | null} */ (event.target.closest('.md-pr-ref'));
    const pull = ref && root.contains(ref) ? named(ref) : null;
    if (!pull?.at.repo) return;
    window.open(pullUrl(pull.at.repo, pull.number), '_blank', 'noopener,noreferrer');
  }

  root.addEventListener('pointerdown', onPointerDown);
  root.addEventListener('click', onClick);
  return () => {
    root.removeEventListener('pointerdown', onPointerDown);
    root.removeEventListener('click', onClick);
  };
}
