/**
 * Pull requests named in text the workbench shows (an agent's reply, a pull request's
 * description): a link to one on GitHub (`https://github.com/owner/repo/pull/123`, any page of
 * it), or GitHub's own short reference `#123`, which names a pull request of the repository
 * the text is about. Kept free of the DOM so they can be tested; `md` rendering marks them
 * (omp/markdown-dom.js) and windows let them be dragged out as pull request windows
 * (github/pull-drag.js).
 */

/** A repository, as `owner/name`, as GitHub allows them: never `.` or `..`, which a path would read as a directory. */
export const REPO = /^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.\.?$)[\w.-]+$/;
const PULL_URL = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*\/(?!\.\.?\/)[\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/;
/** `#123` on its own: after the start, whitespace or an opening bracket, and not run into a word. */
const SHORT_REF = /(^|[\s([{])#(\d+)(?![\w-])/g;

/**
 * The pull request a link goes to, or null when it goes to none.
 * @param {string} href @returns {{ repo: string, number: number } | null}
 */
export function pullOfUrl(href) {
  const match = PULL_URL.exec(href);
  return match ? { repo: match[1], number: Number(match[2]) } : null;
}

/**
 * `text` cut into its plain runs and its `#123` references, in order; text with none is one run.
 * @param {string} text @returns {Array<{ text: string } | { text: string, number: number }>}
 */
export function splitRefs(text) {
  /** @type {Array<{ text: string } | { text: string, number: number }>} */
  const parts = [];
  let at = 0;
  for (const match of text.matchAll(SHORT_REF)) {
    const start = match.index + match[1].length;
    if (start > at) parts.push({ text: text.slice(at, start) });
    parts.push({ text: `#${match[2]}`, number: Number(match[2]) });
    at = start + match[2].length + 1;
  }
  if (at < text.length || !parts.length) parts.push({ text: text.slice(at) });
  return parts;
}
