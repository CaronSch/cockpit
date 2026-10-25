/**
 * Drop-zone hit testing. VS Code's editor drop target uses fixed edge bands and
 * thirds; here we pick the nearest edge in normalized space, which behaves the
 * same on wide and tall widgets.
 */

/** @import { Direction } from './grid-model.js' */
/** @import { Rect } from './compute-layout.js' */
/** Zone under the pointer within a widget. @typedef {Direction} DropZone */
/** Outer grid edge the pointer hugs. @typedef {Exclude<Direction, 'center'>} EdgeZone */

/** Pointer must be this far (normalized) from every edge to count as center. */
const CENTER_BAND = 0.25;

/** @param {number} v */
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/**
 * @param {number} px @param {number} py @param {Rect} rect @param {{ allowCenter?: boolean }} [options]
 * @returns {DropZone}
 */
export function computeDropZone(px, py, rect, { allowCenter = true } = {}) {
  const nx = clamp01((px - rect.x) / rect.w);
  const ny = clamp01((py - rect.y) / rect.h);
  const dx = Math.min(nx, 1 - nx);
  const dy = Math.min(ny, 1 - ny);

  if (allowCenter && dx > CENTER_BAND && dy > CENTER_BAND) return 'center';
  if (dx < dy) return nx < 0.5 ? 'left' : 'right';
  return ny < 0.5 ? 'up' : 'down';
}

/**
 * Returns a direction when the pointer hugs an outer edge of the grid, else null.
 * @param {number} px @param {number} py @param {Rect} bounds @param {number} threshold
 * @returns {EdgeZone | null}
 */
export function detectEdgeZone(px, py, bounds, threshold) {
  const right = bounds.x + bounds.w;
  const bottom = bounds.y + bounds.h;
  if (px < bounds.x || py < bounds.y || px > right || py > bottom) return null;

  /** @type {[EdgeZone, number][]} */
  const distances = [
    ['left', px - bounds.x],
    ['right', right - px],
    ['up', py - bounds.y],
    ['down', bottom - py],
  ];
  const [dir, dist] = distances.reduce((best, entry) => (entry[1] < best[1] ? entry : best));
  return dist <= threshold ? dir : null;
}
