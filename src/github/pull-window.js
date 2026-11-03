/**
 * Opening a pull request window (widgets/github.js) from another window: the params that name
 * the pull request and the conversation it is reviewed for, and dragging one out of text, where
 * a pull request is linked or referred to as `owner/name#123` or `#123` (marked by omp/markdown-dom.js): dropped on
 * the grid it opens a pull request window there, dropped on a pull request window it shows there.
 * A click on a link still opens it on GitHub.
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

/**
 * Lets the pull requests linked or referred to in `root`'s text be dragged out as pull request
 * windows. `base` is where a bare `#123` is (the repository the text is about), null when the
 * text has none; `parent` the conversation the window reviews for.
 * @param {{ root: HTMLElement, ctx: WidgetContext, base: () => PullPlace | null, parent: () => ConversationTarget | null }} options
 * @returns {() => void} stops it
 */
export function attachPullDrag({ root, ctx, base, parent }) {
  /** @param {PointerEvent} event */
  function onPointerDown(event) {
    if (event.button !== 0 || !(event.target instanceof Element)) return;
    const link = /** @type {HTMLElement | null} */ (event.target.closest('.md-pr-link'));
    const ref = link ? null : /** @type {HTMLElement | null} */ (event.target.closest('.md-pr-ref'));
    const marked = link ?? ref;
    if (!marked || !root.contains(marked)) return;
    const number = Number(marked.dataset.number);
    const at = marked.dataset.repo ? { repo: marked.dataset.repo, cwd: null } : base();
    if (!at || !Number.isInteger(number)) return;
    // Pressing it starts no text selection: the press may become a drag. A click still clicks.
    event.preventDefault();
    const label = at.repo ? `${at.repo}#${number}` : `#${number}`;
    ctx.dragWidget('github', pullParams(at, { number }, parent()), event, { label, into: true });
  }
  root.addEventListener('pointerdown', onPointerDown);
  return () => root.removeEventListener('pointerdown', onPointerDown);
}
