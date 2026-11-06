/**
 * Where an agent pane's previous/next response buttons (⌘↑ / ⌘↓) scroll its transcript:
 * the arithmetic, kept apart from the DOM. A response is what `visibility.js` calls one (an
 * assistant message that ended without asking for tools); the pane measures where each one
 * starts, in the transcript's scroll coordinates, and moves its scroll position to the target.
 *
 * Up goes to the nearest response that starts above the viewport's top, and none left goes to
 * the very top; down goes to the first that starts below it, and none left goes to the bottom.
 * `slack` pixels either side of the top count as being there: a response the last press put at
 * the top (give or take rounding) is skipped, so every press steps one response.
 */

/** How close to the viewport's top a response counts as already being there, in pixels. */
export const RESPONSE_SLACK_PX = 4;

/**
 * The scroll position to move to, between 0 and `maxScrollTop` (the bottom: a response too
 * near the end to reach the top lands there too).
 * @param {readonly number[]} tops where each response starts, in scroll coordinates, any order
 * @param {number} scrollTop the transcript's scroll position now
 * @param {number} maxScrollTop its scroll position at the bottom (`scrollHeight - clientHeight`)
 * @param {'previous' | 'next'} direction
 * @param {number} [slack]
 * @returns {number}
 */
export function responseTarget(tops, scrollTop, maxScrollTop, direction, slack = RESPONSE_SLACK_PX) {
  const max = Math.max(0, maxScrollTop);
  if (direction === 'previous') {
    const above = tops.filter((top) => top < scrollTop - slack);
    return above.length ? Math.min(max, Math.max(0, Math.max(...above))) : 0;
  }
  const below = tops.filter((top) => top > scrollTop + slack);
  return below.length ? Math.min(max, Math.min(...below)) : max;
}
