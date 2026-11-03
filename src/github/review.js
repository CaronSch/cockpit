/**
 * A review written in the pull request window, for its agent: comments and questions on
 * highlighted parts of the pull request, and a note of the reviewer's own, sent to the agent's
 * conversation as one message. Until it is sent it is kept per pull request and browser
 * (ui/prefs.js), so it waits while the window is closed or the page reloads.
 */
import { asQuote } from '../omp/message.js';
import { readPref, writePref } from '../ui/prefs.js';

/**
 * A comment or a question on `quote`, a highlighted part of the pull request; `cite` says
 * where it is (a file and its lines, or the description) when that is known.
 * @typedef {{ kind: 'comment' | 'question', quote: string, cite: string | null, text: string }} ReviewNote
 */
/** What is written and not sent yet. @typedef {{ notes: ReviewNote[], text: string }} Review */

const PREFIX = 'cockpit.pr-review:';

/** @param {any} n @returns {n is ReviewNote} */
const isNote = (n) =>
  (n?.kind === 'comment' || n?.kind === 'question') && typeof n.quote === 'string' && typeof n.text === 'string' && (n.cite === null || typeof n.cite === 'string');

/** The review not sent yet on the pull request at `url`; an empty one if none (or unreadable). @param {string} url @returns {Review} */
export function readReview(url) {
  try {
    const kept = JSON.parse(readPref(PREFIX + url) ?? 'null');
    if (Array.isArray(kept?.notes) && typeof kept.text === 'string') return { notes: kept.notes.filter(isNote), text: kept.text };
  } catch {
    // Unreadable: nothing kept.
  }
  return { notes: [], text: '' };
}

/** Keeps `review` for the pull request at `url`; an empty one keeps nothing. @param {string} url @param {Review} review */
export const writeReview = (url, review) =>
  writePref(PREFIX + url, review.notes.length || review.text.trim() ? JSON.stringify(review) : null);

/**
 * The message the agent is sent: which pull request, then each note as a quote of what it is
 * about with the comment or question under it, then the reviewer's own note. '' when there is
 * nothing to send.
 * @param {{ number: number, title: string, url: string }} pull @param {Review} review
 */
export function reviewMessage(pull, review) {
  const text = review.text.trim();
  const notes = review.notes.filter((n) => n.text.trim());
  if (!notes.length && !text) return '';
  const parts = [`My review of PR #${pull.number} "${pull.title}" (${pull.url}):`];
  for (const note of notes) {
    const where = note.cite ? ` \`${note.cite}\`` : '';
    const head = note.kind === 'question' ? `Question about${where || ' this'}:` : `On${where || ' this'}:`;
    parts.push(`${head}\n${asQuote(note.quote)}\n\n${note.text.trim()}`);
  }
  if (text) parts.push(text);
  return parts.join('\n\n');
}
