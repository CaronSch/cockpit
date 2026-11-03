/**
 * `#` pull request mentions typed in the agent pane's message box: the one the caret ends, the
 * pull requests and repositories that match what is typed, and the text that completes it, kept
 * free of the DOM so they can be tested.
 *
 * A mention names a pull request of the conversation's repository (`#123`), or of another one,
 * typed whichever way comes naturally: `k8s-infra#859`, `blink-labs/k8s-infra#859` or
 * `#k8s-infra:859`, or found by typing `#` and part of the repository's name, which is then
 * suggested beside the pull requests. A picked pull request goes in as GitHub writes it, so
 * GitHub, the agent and the workbench all read it the same: `#859` in the conversation's own
 * repository, `owner/name#859` in another.
 */
/** @import { PullSummary, RepoSummary } from '../../daemon/wire.js' */

/** A repository as typed: a name, or `owner/name`. */
const TYPED_REPO = /^[A-Za-z0-9][\w.-]*(?:\/[\w.-]+)?$/;
/** The mention up to the caret: `repo#…` (or `owner/repo#…`), or `#…`, at the start or after whitespace. */
const QUERY = /(?:^|\s)(?:([A-Za-z0-9][\w.-]*(?:\/[\w.-]+)?)#|#)([^\s#]*)$/;

/**
 * The mention being typed: from its start (`start`, its repository or its `#`) to the caret
 * (`end`); the repository it names as typed (null: the conversation's), and what is typed of the
 * pull request.
 * @typedef {{ start: number, end: number, repo: string | null, query: string }} PullQuery
 */

/**
 * The mention the caret ends, or null when it ends none.
 * @param {string} text @param {number} caret @returns {PullQuery | null}
 */
export function pullQueryAt(text, caret) {
  const before = text.slice(0, caret);
  const match = QUERY.exec(before);
  if (!match) return null;
  const start = caret - match[0].trimStart().length;
  if (match[1]) return { start, end: caret, repo: match[1], query: match[2] };
  // `#k8s-infra:859`: a repository right after the `#`, then a colon.
  const colon = match[2].indexOf(':');
  const named = colon > 0 ? match[2].slice(0, colon) : '';
  if (named && TYPED_REPO.test(named)) return { start, end: caret, repo: named, query: match[2].slice(colon + 1) };
  return { start, end: caret, repo: null, query: match[2] };
}

/**
 * The pull requests `query` names, best first: numbers starting with its digits; else titles
 * holding every word of it, those starting with it first. An empty query lists them all, in the
 * order given (the newest first, as GitHub lists them).
 * @param {readonly PullSummary[]} prs @param {string} query @returns {PullSummary[]}
 */
export function matchPulls(prs, query) {
  const q = query.trim().toLowerCase();
  if (!q) return [...prs];
  if (/^\d+$/.test(q)) return prs.filter((pr) => String(pr.number).startsWith(q));
  const words = q.split(/[\s_-]+/).filter(Boolean);
  const holding = prs.filter((pr) => words.every((w) => pr.title.toLowerCase().includes(w)));
  const starts = (/** @type {PullSummary} */ pr) => pr.title.toLowerCase().startsWith(q);
  return [...holding.filter(starts), ...holding.filter((pr) => !starts(pr))];
}

/** A repository's name without its owner. @param {string} repo */
const nameOf = (repo) => repo.slice(repo.indexOf('/') + 1);

/**
 * The repositories, other than the conversation's (`own`), whose name `query` is part of: those
 * it starts first. None for a query of digits only, which names a pull request.
 * @param {readonly RepoSummary[]} repos @param {string} query @param {string | null} own @returns {RepoSummary[]}
 */
export function matchRepos(repos, query, own) {
  const q = query.trim().toLowerCase();
  if (!q || /^\d+$/.test(q)) return [];
  const others = repos.filter((r) => r.repo !== own && nameOf(r.repo).toLowerCase().includes(q));
  const starts = (/** @type {RepoSummary} */ r) => nameOf(r.repo).toLowerCase().startsWith(q);
  return [...others.filter(starts), ...others.filter((r) => !starts(r))];
}

/**
 * The repository (`owner/name`) a mention's typed repository is: as typed if it names its
 * owner, else the one of that name among `repos`; null when none is.
 * @param {string} typed @param {readonly RepoSummary[]} repos @returns {string | null}
 */
export function resolveRepo(typed, repos) {
  if (typed.includes('/')) return typed;
  const name = typed.toLowerCase();
  return repos.find((r) => nameOf(r.repo).toLowerCase() === name)?.repo ?? null;
}

/**
 * The text that replaces the mention once a repository is picked: its name and a `#`, so its
 * pull requests are suggested next; with its owner when that is not the conversation's
 * repository's (`own`).
 * @param {string} repo @param {string | null} own
 */
export function completeRepo(repo, own) {
  const sameOwner = own !== null && repo.split('/')[0] === own.split('/')[0];
  return `${sameOwner ? nameOf(repo) : repo}#`;
}

/**
 * The text that replaces the mention once pull request `number` of `repo` is picked, as GitHub
 * writes it, then a space: `#123` in the conversation's own repository (`own`), `owner/name#123`
 * in another.
 * @param {number} number @param {string | null} repo @param {string | null} own
 */
export const completePull = (number, repo, own) => `${repo && repo !== own ? repo : ''}#${number} `;
