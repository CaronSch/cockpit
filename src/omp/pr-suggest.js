/**
 * Pull request suggestions in the agent pane's message box: while the caret ends a `#`
 * mention and the conversation's directory is in a GitHub repository, the suggestion list
 * shows the pull requests it names, each with its title, and Tab, Enter or a click completes it
 * as GitHub writes it (see `github/pr-mention.js`). Typing part of a repository's name after the
 * `#` suggests the repositories of the conversation's repository's owner too; picking one
 * leaves `name#` to go on with, listing its pull requests. Without GitHub (no `gh`, signed out,
 * no repository), `#` is plain text.
 *
 * The repositories, and each repository's pull requests, are read once per mention typed,
 * however many keystrokes it takes.
 */
import { el } from '../ui/dom.js';
import { completePull, completeRepo, matchPulls, matchRepos, pullQueryAt, resolveRepo } from '../github/pr-mention.js';
/** @import { PullList, RepoList } from '../../daemon/wire.js' */
/** @import { Suggestions } from './suggestions.js' */

/** Rows shown at most; typing more of the number or title narrows the rest down. */
const MAX_ROWS = 30;
/** Repositories shown at most, above the pull requests. */
const MAX_REPO_ROWS = 5;

/** @param {unknown} err @returns {{ connected: false, reason: string }} */
const failed = (err) => ({ connected: false, reason: String(err) });

/**
 * @param {{
 *   draft: HTMLTextAreaElement,
 *   list: Suggestions,
 *   repos: () => Promise<RepoList>,
 *   pulls: (repo: string | null) => Promise<PullList>,
 *   replace: (start: number, end: number, text: string) => void,
 * }} options `repos` reads the conversation's repository and its owner's others; `pulls` reads
 * the pull requests of a repository (`owner/name`), or of the conversation's (null); `replace`
 * puts `text` in the draft in place of `start`…`end`, leaving the caret after it.
 */
export function createPullSuggest({ draft, list, repos, pulls, replace }) {
  /** The repositories read for the mention being typed. @type {Promise<RepoList> | null} */
  let reposRead = null;
  /** What they turned out to be, once read: until then the conversation's own pull requests show alone. @type {RepoList | null} */
  let reposKnown = null;
  /** The pull requests read for it, by repository (`''`: the conversation's). @type {Map<string, Promise<PullList>>} */
  const pullsRead = new Map();
  /** Where the mention shown starts, while one is. */
  let showing = -1;

  const current = () => (draft.selectionStart === draft.selectionEnd ? pullQueryAt(draft.value, draft.selectionStart) : null);

  /** @param {string | null} repo */
  function pullsOf(repo) {
    const key = repo ?? '';
    let read = pullsRead.get(key);
    if (!read) pullsRead.set(key, (read = pulls(repo).catch(failed)));
    return read;
  }

  function hide() {
    if (showing !== -1) list.hide();
    showing = -1;
  }

  /** Stops following a mention: the list closes, and the next one reads GitHub afresh. */
  function close() {
    reposRead = null;
    reposKnown = null;
    pullsRead.clear();
    hide();
  }

  /**
   * Follows the draft as it now stands: lists the pull requests (and repositories) the mention
   * the caret ends names, if any. Returns false when it ends none, having closed the list if it
   * showed one.
   */
  function update() {
    const q = current();
    if (!q) {
      close();
      return false;
    }
    if (!reposRead) {
      const read = (reposRead = repos().catch(failed));
      void read.then((known) => {
        if (reposRead !== read) return; // a later mention's
        reposKnown = known;
        // `#…` listed its own pull requests already (or none matched): now with the repositories it names too.
        if (current()?.repo === null) update();
      });
    }
    void (async () => {
      // `#…` is the conversation's own, listed at once; `name#…` the repository of that name, if there is one.
      const known = q.repo === null ? reposKnown : await reposRead;
      const own = known?.connected ? known.repo : null;
      const all = known?.connected ? known.repos : [];
      const repo = q.repo === null ? own : resolveRepo(q.repo, all);
      const found = q.repo === null || repo !== null ? await pullsOf(q.repo === null || repo === own ? null : repo) : null;
      const now = current();
      // The draft moved on while GitHub answered: what it ends now is followed by its own update.
      if (!now || now.start !== q.start || now.repo !== q.repo || now.query !== q.query) return;
      const repoRows = q.repo === null ? matchRepos(all, q.query, own).slice(0, MAX_REPO_ROWS) : [];
      const pullRows = found?.connected ? matchPulls(found.pulls, q.query).slice(0, MAX_ROWS) : [];
      if (!repoRows.length && !pullRows.length) return hide();
      const prefix = repo && repo !== own ? completeRepo(repo, own) : '#';
      showing = q.start;
      list.show(
        [
          ...repoRows.map((r) => ({
            cells: [el('span', 'omp-suggestion-name', completeRepo(r.repo, own)), el('span', 'omp-suggestion-desc', r.description), el('span', 'omp-muted', 'repository')],
            pick: () => {
              replace(q.start, draft.selectionStart, completeRepo(r.repo, own));
              close();
              // On to its pull requests.
              update();
            },
          })),
          ...pullRows.map((pull) => ({
            cells: [
              el('span', 'omp-suggestion-name', `${prefix}${pull.number}`),
              el('span', 'omp-suggestion-desc', pull.title),
              el('span', 'omp-muted', `${pull.isDraft ? 'draft' : pull.state.toLowerCase()} · ${pull.author}`),
            ],
            pick: () => {
              replace(q.start, draft.selectionStart, completePull(pull.number, repo, own));
              close();
            },
          })),
        ],
        // A bare `#` (or `name#`) takes Enter only once the arrows picked a row: Enter otherwise sends.
        { enter: q.query ? true : 'moved' },
      );
    })();
    return true;
  }

  return { update, close };
}
