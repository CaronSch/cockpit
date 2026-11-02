/**
 * Pull request suggestions in the agent pane's message box: while the caret ends a `#`
 * mention and the conversation's directory is in a GitHub repository, the suggestion list
 * shows the repository's pull requests that match it, each with its title, and Tab, Enter or a
 * click completes it as GitHub's `#123` (see `github/pr-mention.js`). Without GitHub (no `gh`,
 * signed out, no repository), `#` is plain text.
 *
 * The pull requests are read once per mention typed, however many keystrokes it takes.
 */
import { el } from '../ui/dom.js';
import { completePull, matchPulls, pullQueryAt } from '../github/pr-mention.js';
/** @import { PullList } from '../../daemon/wire.js' */
/** @import { Suggestions } from './suggestions.js' */

/** Rows shown at most; typing more of the number or title narrows the rest down. */
const MAX_ROWS = 30;

/**
 * @param {{
 *   draft: HTMLTextAreaElement,
 *   list: Suggestions,
 *   pulls: () => Promise<PullList>,
 *   replace: (start: number, end: number, text: string) => void,
 * }} options `pulls` reads the conversation's repository's pull requests; `replace` puts `text`
 * in the draft in place of `start`…`end`, leaving the caret after it.
 */
export function createPullSuggest({ draft, list, pulls, replace }) {
  /** The pull requests read for the mention being typed. @type {Promise<PullList> | null} */
  let read = null;
  /** Where the mention shown starts, while one is. */
  let showing = -1;

  const current = () => (draft.selectionStart === draft.selectionEnd ? pullQueryAt(draft.value, draft.selectionStart) : null);

  /** Stops following a mention: the list closes, and the next one reads the pull requests afresh. */
  function close() {
    read = null;
    if (showing !== -1) list.hide();
    showing = -1;
  }

  /**
   * Follows the draft as it now stands: lists the pull requests the mention the caret ends
   * names, if any. Returns false when it ends none, having closed the list if it showed one.
   */
  function update() {
    const q = current();
    if (!q) {
      close();
      return false;
    }
    read ??= pulls().catch((err) => /** @type {PullList} */ ({ connected: false, reason: String(err) }));
    void read.then((found) => {
      const now = current();
      // The draft moved on while GitHub answered: what it ends now is followed by its own update.
      if (!now || now.start !== q.start || now.query !== q.query) return;
      const matches = found.connected ? matchPulls(found.pulls, q.query).slice(0, MAX_ROWS) : [];
      if (!matches.length) {
        if (showing !== -1) list.hide();
        showing = -1;
        return;
      }
      showing = q.start;
      list.show(
        matches.map((pull) => ({
          cells: [
            el('span', 'omp-suggestion-name', `#${pull.number}`),
            el('span', 'omp-suggestion-desc', pull.title),
            el('span', 'omp-muted', `${pull.isDraft ? 'draft' : pull.state.toLowerCase()} · ${pull.author}`),
          ],
          pick: () => {
            replace(q.start, draft.selectionStart, completePull(pull.number));
            close();
          },
        })),
        // A bare `#` takes Enter only once the arrows picked a row: Enter otherwise sends.
        { enter: q.query ? true : 'moved' },
      );
    });
    return true;
  }

  return { update, close };
}
