/**
 * One animation frame for every window that draws: first each window's drawing (DOM writes),
 * then the layout reads they asked for (`measure`), then the writes those reads decided. However
 * many windows draw in a frame, the page is laid out once for all of them; a window reading
 * layout right after its own drawing would lay the whole page out once per window.
 *
 * A read may also write what needs no layout again (a `scrollTop`); a write that changes the
 * DOM goes in the function it returns, run after every window's reads.
 */

/** @type {Set<() => void>} */
const draws = new Set();
/** @type {Set<() => (void | (() => void))>} */
const reads = new Set();
let requested = 0;
/** Whether this frame's drawing is under way: reads asked for now are this frame's. */
let drawing = false;

function run() {
  requested = 0;
  drawing = true;
  for (const fn of take(draws)) guarded(fn);
  drawing = false;
  const writes = take(reads).map((read) => guarded(read));
  for (const write of writes) if (typeof write === 'function') guarded(write);
}

/** @template T @param {Set<T>} set */
function take(set) {
  const all = [...set];
  set.clear();
  return all;
}

/** One window failing to draw leaves the others drawing. @template T @param {() => T} fn @returns {T | undefined} */
function guarded(fn) {
  try {
    return fn();
  } catch (err) {
    reportError(err);
    return undefined;
  }
}

/** Runs `fn` in the next frame, once however often it is asked. @param {() => void} fn */
export function draw(fn) {
  draws.add(fn);
  // Asked while drawing, it is the next frame's: this one has taken its draws already.
  requested ||= requestAnimationFrame(run);
}

/**
 * Runs `read` once the frame's drawing is done (this frame's, while it is drawing, else the
 * next one's), once however often it is asked; the function it returns runs after every read.
 * @param {() => (void | (() => void))} read
 */
export function measure(read) {
  reads.add(read);
  if (!drawing) requested ||= requestAnimationFrame(run);
}

/** Forgets `fn`, asked for with `draw` or `measure`: a window gone draws nothing. @param {() => void} fn */
export function cancel(fn) {
  draws.delete(fn);
  reads.delete(fn);
}
