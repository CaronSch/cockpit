/**
 * One `selectionchange` listener for every agent window: a change reaches only the windows whose
 * transcript the selection touches, and once more those it has just left (to take down what they
 * showed for it), so a caret moving in one window's message box runs nothing in the others.
 */

/** Each handler, the node it watches and whether the selection touched it at the last change. @type {Map<() => void, { within: Node, held: boolean }>} */
const watchers = new Map();

function dispatch() {
  const sel = document.getSelection();
  const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  for (const [handler, watch] of watchers) {
    const holds = range !== null && range.intersectsNode(watch.within);
    if (holds || watch.held) handler();
    watch.held = holds;
  }
}

/**
 * Calls `handler` on each selection change that touches `within`, or that takes the selection
 * out of it. Returns what stops it.
 * @param {Node} within @param {() => void} handler @returns {() => void}
 */
export function onSelectionIn(within, handler) {
  if (watchers.size === 0) document.addEventListener('selectionchange', dispatch);
  watchers.set(handler, { within, held: false });
  return () => {
    watchers.delete(handler);
    if (watchers.size === 0) document.removeEventListener('selectionchange', dispatch);
  };
}
