/**
 * Narrowing the pull request window's list of a repository's pull requests: each one's status
 * (a draft is its own, not an open one), the statuses and authors it can be narrowed to, and
 * which pull requests a choice of them keeps, kept free of the DOM so they can be tested.
 */
/** @import { PullSummary } from '../../daemon/wire.js' */

/** @typedef {'draft' | 'open' | 'merged' | 'closed'} PullStatus */

/** A pull request's status: GitHub's `state`, with an open draft told apart. @param {PullSummary} pull @returns {PullStatus} */
export function pullStatus(pull) {
  if (pull.state === 'MERGED') return 'merged';
  if (pull.state === 'CLOSED') return 'closed';
  return pull.isDraft ? 'draft' : 'open';
}

/** What the list can be narrowed to by status, in the order offered; `active` is open or draft. */
export const STATUS_FILTERS = /** @type {const} */ ([
  { key: 'all', label: 'Any status' },
  { key: 'active', label: 'Open or draft' },
  { key: 'open', label: 'Open' },
  { key: 'draft', label: 'Draft' },
  { key: 'merged', label: 'Merged' },
  { key: 'closed', label: 'Closed' },
]);
/** @typedef {(typeof STATUS_FILTERS)[number]['key']} StatusFilter */

/** `value` as a status filter, `all` for anything else (a window's saved param). @param {unknown} value @returns {StatusFilter} */
export const statusFilter = (value) => STATUS_FILTERS.find((f) => f.key === value)?.key ?? 'all';

/** The authors of `pulls`, A→Z, each once. @param {readonly PullSummary[]} pulls */
export const authorsOf = (pulls) => [...new Set(pulls.map((p) => p.author))].sort((a, b) => a.localeCompare(b));

/**
 * The pull requests of the status and author chosen, in their order; `author` null for any.
 * @param {readonly PullSummary[]} pulls @param {{ status: StatusFilter, author: string | null }} filter
 */
export function filterPulls(pulls, { status, author }) {
  return pulls.filter((pull) => {
    const is = pullStatus(pull);
    const statusOk = status === 'all' || status === is || (status === 'active' && (is === 'open' || is === 'draft'));
    return statusOk && (author === null || pull.author === author);
  });
}
