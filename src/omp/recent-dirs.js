/**
 * The directories an agent window's setup screen offers to start in: those of the user's
 * conversations, most recently active first, so the few repositories they work in are a click
 * away instead of typed again; kept free of the DOM so they can be tested.
 *
 * The conversations are the Sessions window's (sessions/running.js `listConversations`): every
 * journal omp kept that is not archived, and the sessions awake now omp has not written yet.
 */

/** How many directories the setup screen offers. */
export const RECENT_DIRS = 5;

/** `dir` without trailing slashes, so `/a/b/` and `/a/b` are one directory (`/` stays). @param {string} dir */
const withoutSlash = (dir) => dir.replace(/(?<=.)\/+$/, '');

/**
 * The distinct directories of `conversations`, the one active last first, at most `limit`;
 * a conversation with no directory is left out.
 * @param {readonly { cwd: string | null, modifiedAt: number }[]} conversations
 * @param {number} [limit]
 * @returns {string[]}
 */
export function recentDirs(conversations, limit = RECENT_DIRS) {
  const dirs = new Set(
    conversations
      .filter((c) => c.cwd)
      .sort((a, b) => b.modifiedAt - a.modifiedAt)
      .map((c) => withoutSlash(c.cwd ?? '')),
  );
  return [...dirs].slice(0, limit);
}
