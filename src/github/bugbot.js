/**
 * Cursor Bugbot's reviews, read from GitHub as the daemon's watcher (daemon/bugbot.js) finds
 * them, and told to the agent: which review answers a `bugbot go` comment, and its findings as
 * one message, kept free of I/O so they can be tested.
 *
 * Bugbot reviews as the `cursor[bot]` user: a review whose body is marked
 * `<!-- BUGBOT_REVIEW -->` (one it later replaced is also marked `BUGBOT_REVIEW_STALE`) and
 * says what it found, with one inline comment per finding: a `### title`, a `**… Severity**`
 * line, its description between `DESCRIPTION START`/`END` markers and the places it is about
 * between `LOCATIONS START`/`END` (`path#L1-L2`, one a line).
 */
import { readableBody } from './text.js';

/** The comment that asks Bugbot for a review. */
export const BUGBOT_COMMAND = 'bugbot go';
/** The GitHub user Bugbot reviews as. */
export const BUGBOT_LOGIN = 'cursor[bot]';

/** A review as GitHub lists it, in the fields used here. @typedef {{ id: number, author: string, body: string, submittedAt: string }} Review */
/** An inline comment as GitHub lists it, in the fields used here. @typedef {{ body: string, path: string, line: number | null, startLine: number | null }} InlineComment */
/** @typedef {{ title: string, severity: string | null, description: string, locations: string[] }} Finding */

/**
 * The review that answers a `bugbot go` posted at `since` (an ISO time, as GitHub gives
 * them): Bugbot's first current review submitted since then, if there is one yet.
 * @param {readonly Review[]} reviews @param {string} since @returns {Review | null}
 */
export function bugbotReviewSince(reviews, since) {
  const after = Date.parse(since);
  return (
    reviews
      .filter((r) => r.author === BUGBOT_LOGIN && r.body.includes('<!-- BUGBOT_REVIEW -->') && !r.body.includes('BUGBOT_REVIEW_STALE') && Date.parse(r.submittedAt) >= after)
      .sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt))[0] ?? null
  );
}

/** The text between `<!-- NAME START` and `NAME END -->`-style markers, if `body` has them. @param {string} body @param {RegExp} marker */
const between = (body, marker) => marker.exec(body)?.[1].trim() ?? null;

/**
 * One finding, from its inline comment: what Bugbot calls it, how severe it says it is, what
 * it says, and where.
 * @param {InlineComment} comment @returns {Finding}
 */
export function parseFinding(comment) {
  const { body } = comment;
  const title = /^#{1,6}\s+(.+)$/m.exec(body)?.[1].trim() ?? 'Finding';
  const severity = /\*\*([^*\n]*Severity)\*\*/.exec(body)?.[1].trim() ?? null;
  const described = between(body, /<!-- DESCRIPTION START -->([\s\S]*?)<!-- DESCRIPTION END -->/);
  const description = readableBody(described ?? body.replace(/^#{1,6}\s+.+$/m, '').replace(/\*\*[^*\n]*Severity\*\*/, ''));
  const listed = between(body, /<!-- LOCATIONS START([\s\S]*?)LOCATIONS END -->/);
  const own = comment.line === null ? comment.path : `${comment.path}#L${comment.startLine && comment.startLine !== comment.line ? `${comment.startLine}-L${comment.line}` : comment.line}`;
  const locations = listed ? listed.split('\n').map((l) => l.trim()).filter(Boolean) : [own];
  return { title, severity, description, locations };
}

/**
 * What the agent is told of a Bugbot review of pull request `number`: what Bugbot said, then
 * each finding with where it is.
 * @param {{ number: number, url: string, review: Review, comments: readonly InlineComment[] }} options
 */
export function bugbotMessage({ number, url, review, comments }) {
  // The summary is the review's first line of prose: "found 1 potential issue", "no new issues".
  const summary = readableBody(review.body).split('\n').find((line) => line.trim()) ?? 'Bugbot reviewed the changes.';
  const findings = comments.map(parseFinding);
  const parts = [`Cursor Bugbot reviewed PR #${number} (${url}): ${summary.trim()}`];
  findings.forEach((f, i) => {
    const where = f.locations.map((l) => `\`${l}\``).join(', ');
    parts.push(`${i + 1}. **${f.title}**${f.severity ? ` (${f.severity})` : ''}, ${where}\n\n${f.description}`);
  });
  return parts.join('\n\n');
}
