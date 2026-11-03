/**
 * `#` pull request mentions typed in the agent pane's message box, as GitHub writes them
 * (`#123`): the one the caret ends, the repository's pull requests that match what is typed (by
 * number, or by words of the title), and the text that completes it, kept free of the DOM so
 * they can be tested.
 */
/** @import { PullSummary } from '../../daemon/wire.js' */

/** A `#` at the start or after whitespace, then what is typed of the mention, up to the caret. */
const QUERY = /(?:^|\s)#([^\s#]*)$/;

/** The mention being typed: from its `#` (`start`) to the caret (`end`), and what follows the `#`. @typedef {{ start: number, end: number, query: string }} PullQuery */

/**
 * The mention the caret ends, or null when it ends none.
 * @param {string} text @param {number} caret @returns {PullQuery | null}
 */
export function pullQueryAt(text, caret) {
  const match = QUERY.exec(text.slice(0, caret));
  if (!match) return null;
  return { start: caret - match[1].length - 1, end: caret, query: match[1] };
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

/** The text that replaces the mention once pull request `number` is picked: GitHub's own reference, then a space. @param {number} number */
export const completePull = (number) => `#${number} `;
