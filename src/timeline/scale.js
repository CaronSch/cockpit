/**
 * The timeline window's arithmetic, kept free of the DOM so it can be tested: where a moment in
 * the future sits on its log scale (the next hour spread out, next month squeezed in), the times
 * its axis marks, how labels share lanes without covering one another, and how long until a
 * scheduled prompt runs, and when, said briefly (the daemon's schedule tool says it the same way).
 */

/** The scale's knee: up to about this far ahead the scale is near linear, beyond it logarithmic. */
export const KNEE_MS = 10 * 60_000;
/** The least the future side spans: a day, so a lone prompt in ten minutes is not at the far end. */
export const MIN_SPAN_MS = 24 * 3_600_000;

/**
 * How far along the future side `ms` from now sits: 0 at now, 1 at `span`, on a log scale.
 * @param {number} ms @param {number} span
 */
export const position = (ms, span) => Math.min(1, Math.log1p(Math.max(0, ms) / KNEE_MS) / Math.log1p(span / KNEE_MS));

/**
 * How far ahead the future side reaches: a day, or a quarter beyond the furthest prompt, so it
 * is never at the very end.
 * @param {number} furthest how far ahead the furthest scheduled prompt is, in ms (0 for none)
 */
export const futureSpan = (furthest) => Math.max(MIN_SPAN_MS, furthest * 1.25);

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** @type {ReadonlyArray<readonly [number, string]>} */
const TICKS = [
  [5 * MIN, '5m'],
  [15 * MIN, '15m'],
  [HOUR, '1h'],
  [3 * HOUR, '3h'],
  [6 * HOUR, '6h'],
  [12 * HOUR, '12h'],
  [DAY, '1d'],
  [2 * DAY, '2d'],
  [7 * DAY, '1w'],
  [14 * DAY, '2w'],
  [30 * DAY, '1mo'],
  [91 * DAY, '3mo'],
  [182 * DAY, '6mo'],
  [365 * DAY, '1y'],
];

/**
 * The times the axis marks on a future side `width` pixels wide spanning `span`: those inside
 * it, each at least `gap` pixels from the one before (and from now), nearest first.
 * @param {number} span @param {number} width @param {number} [gap]
 * @returns {Array<{ ms: number, label: string, x: number }>}
 */
export function ticks(span, width, gap = 44) {
  /** @type {Array<{ ms: number, label: string, x: number }>} */
  const marked = [];
  let last = 0;
  for (const [ms, label] of TICKS) {
    if (ms >= span) break;
    const x = position(ms, span) * width;
    if (x - last < gap || width - x < gap / 2) continue;
    marked.push({ ms, label, x });
    last = x;
  }
  return marked;
}

/**
 * Which lane each label takes, so that none covers another: labels at `x` (their left edge, in
 * pixels) `width` wide, given in any order; each takes the lowest lane where it starts at least
 * `gap` past the end of the one before it there. Lane 0 is the axis's own.
 * @param {ReadonlyArray<{ x: number, width: number }>} labels @param {number} gap @returns {number[]}
 */
export function lanes(labels, gap) {
  /** Where each lane is taken up to. @type {number[]} */
  const ends = [];
  const lane = new Array(labels.length).fill(0);
  const order = labels.map((_, i) => i).sort((a, b) => labels[a].x - labels[b].x);
  for (const i of order) {
    const { x, width } = labels[i];
    let l = ends.findIndex((end) => end + gap <= x);
    if (l === -1) l = ends.push(0) - 1;
    ends[l] = x + width;
    lane[i] = l;
  }
  return lane;
}

/**
 * When a prompt runs, briefly, for its label: the time today, else the weekday and time within
 * a week, else the date.
 * @param {number} at @param {number} now
 */
export function whenLabel(at, now) {
  const then = new Date(at);
  const time = then.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (then.toDateString() === new Date(now).toDateString()) return time;
  if (at - now < 6 * DAY) return `${then.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/**
 * A moment as a `datetime-local` field holds it: this machine's date and time, to the minute.
 * @param {number} at
 */
export function toLocalInput(at) {
  const d = new Date(at);
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A while, roughly: `2 d 3 h`, `1 h 5 min`, `40 s`. @param {number} ms */
export function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  /** @type {[number, string][]} */
  const units = [
    [Math.floor(s / 86_400), 'd'],
    [Math.floor((s % 86_400) / 3600), 'h'],
    [Math.floor((s % 3600) / 60), 'min'],
  ];
  const first = units.findIndex(([n]) => n > 0);
  return units
    .slice(first, first + 2)
    .filter(([n]) => n > 0)
    .map(([n, unit]) => `${n} ${unit}`)
    .join(' ');
}
