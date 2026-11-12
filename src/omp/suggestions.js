/**
 * The suggestion list above the agent pane's message box (slash commands, `@` file entries),
 * driven from the draft's keys so focus never leaves it.
 *
 * Arrows move the selection, Tab completes (the selected row, unless the rows say otherwise),
 * Enter picks the selected row when the rows take it, and a click picks a row. Closing it is
 * the owner's (Esc, sending): `hide()`.
 */
import { button, el } from '../ui/dom.js';

/** One row: what it shows, and what choosing it does. @typedef {{ cells: Element[], pick: () => void }} Suggestion */
/**
 * `tab` replaces Tab's default (picking the selected row), told whether the selection was
 * moved; `enter` makes Enter pick (otherwise the draft keeps it: a slash command is sent as
 * typed), or, as `'moved'`, only a row the arrows picked; `note` is a line under the rows.
 * @typedef {{ tab?: (moved: boolean, selected: Suggestion) => void, enter?: boolean | 'moved', note?: string }} SuggestOptions
 */

export function createSuggestions() {
  const root = el('div', 'omp-suggest');
  root.setAttribute('role', 'listbox');
  root.hidden = true;
  /** @type {Suggestion[]} */
  let rows = [];
  /** @type {SuggestOptions} */
  let options = {};
  let selected = 0;
  let moved = false;

  function draw() {
    const nodes = rows.map((row, i) => {
      const node = button(`omp-suggestion${i === selected ? ' is-selected' : ''}`);
      node.setAttribute('role', 'option');
      node.setAttribute('aria-selected', String(i === selected));
      node.append(...row.cells);
      node.addEventListener('pointerdown', (e) => e.preventDefault()); // keep focus in the draft
      node.addEventListener('click', () => row.pick());
      return node;
    });
    root.replaceChildren(...nodes, ...(options.note ? [el('p', 'omp-suggest-note', options.note)] : []));
    nodes[selected]?.scrollIntoView({ block: 'nearest' });
  }

  return {
    root,
    get open() {
      return rows.length > 0;
    },
    /** Shows `next` (none hides the list), selecting the first. @param {Suggestion[]} next @param {SuggestOptions} [opts] */
    show(next, opts = {}) {
      rows = next;
      options = opts;
      selected = 0;
      moved = false;
      root.hidden = rows.length === 0;
      draw();
    },
    hide() {
      rows = [];
      options = {};
      root.hidden = true;
      root.replaceChildren();
    },
    /** A key pressed in the draft: true when the list took it. @param {KeyboardEvent} e */
    key(e) {
      if (!rows.length) return false;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        selected = (selected + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length;
        moved = true;
        draw();
      } else if (e.key === 'Tab' && !e.shiftKey) {
        if (options.tab) options.tab(moved, rows[selected]);
        else rows[selected].pick();
      } else if (e.key === 'Enter' && !e.shiftKey && (options.enter === true || (options.enter === 'moved' && moved))) {
        rows[selected].pick();
      } else {
        return false;
      }
      e.preventDefault();
      return true;
    },
  };
}

/** @typedef {ReturnType<typeof createSuggestions>} Suggestions */
