/**
 * Spotlight: a floating search over every conversation, as macOS's. ⌘K (Ctrl+K) or the top
 * bar's Search opens it over whatever is on screen; typing ranks conversations by what was
 * asked and answered in them (the daemon's search, daemon/search.js), each with the passage
 * that matched; with nothing typed it lists the latest. ↑/↓ pick one, Enter (or a click)
 * shows it in the agent window this screen used last, as a click in Sessions does, and Esc
 * (or a click outside) closes it.
 *
 * It is a modal <dialog>: the browser keeps the focus in it and gives it Esc.
 */
import { button, el } from './dom.js';
import { errorMessage, tildeHome } from './format.js';
import { displayTitle, relativeTime } from '../sessions/order.js';
import { isRunning, showConversation } from '../sessions/running.js';
import { snippetLine } from '../sessions/snippet.js';
/** @import { DaemonClient } from '../daemon/client.js' */
/** @import { PastSession } from '../../daemon/wire.js' */
/** @import { LeafParams } from '../layout/grid-model.js' */

const SEARCH_DEBOUNCE_MS = 120;
/** How many conversations it lists: the latest with nothing typed, else the best. */
const RECENT = 8;
const FOUND = 30;

/**
 * @param {{ daemon: DaemonClient, show: (params: LeafParams) => void }} options
 * @returns {{ root: HTMLButtonElement }} the top bar's Search button
 */
export function createSpotlight({ daemon, show }) {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const open = button('btn spotlight-open', `Search ${mac ? '⌘K' : 'Ctrl+K'}`, () => toggle());
  open.title = 'Find a conversation: type words, or ask where something was said';

  const dialog = el('dialog', 'spotlight');
  dialog.setAttribute('aria-label', 'Search conversations');
  // Plain text, not a search field: in one, Esc clears the text before the dialog hears it.
  const input = el('input', 'spotlight-input');
  input.type = 'text';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = 'Search conversations, or ask: where did we find…';
  input.setAttribute('aria-label', 'Search conversations');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-controls', 'spotlight-results');
  const list = el('ul', 'spotlight-results');
  list.id = 'spotlight-results';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Conversations');
  const status = el('p', 'spotlight-status');
  dialog.append(input, list, status);
  document.body.append(dialog);

  /** @type {PastSession[]} */
  let found = [];
  let picked = 0;
  let seq = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @type {string | null} */
  let home = null;

  function toggle() {
    if (dialog.open) return dialog.close();
    dialog.showModal();
    input.select();
    if (home === null) daemon.config().then((c) => ((home = c.home), draw()), () => {});
    void search();
  }

  async function search() {
    const query = input.value.trim();
    const mine = ++seq;
    try {
      const sessions = await daemon.history(query);
      if (mine !== seq) return;
      // The daemon lists a search best first, and everything else unordered: latest first here.
      found = query ? sessions.slice(0, FOUND) : sessions.sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, RECENT);
      picked = 0;
      status.textContent = found.length ? '' : query ? 'Nothing found.' : 'No conversations yet.';
    } catch (err) {
      if (mine !== seq) return;
      found = [];
      status.textContent = `Could not search: ${errorMessage(err)}`;
    }
    draw();
  }

  function draw() {
    const now = Date.now();
    list.replaceChildren(
      ...found.map((s, i) => {
        const row = el('li', 'spotlight-item');
        row.id = `spotlight-item-${i}`;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(i === picked));
        const facts = el('div', 'spotlight-facts', `${s.cwd ? tildeHome(s.cwd, home) : ''}  ${relativeTime(s.modifiedAt, now)}`);
        row.append(el('div', 'spotlight-title', displayTitle(s)), facts);
        if (s.match?.snippet) row.append(snippetLine(s.match, 'spotlight-snippet'));
        row.addEventListener('click', () => choose(s));
        row.addEventListener('pointermove', () => pick(i));
        return row;
      }),
    );
    if (found.length) input.setAttribute('aria-activedescendant', `spotlight-item-${picked}`);
    else input.removeAttribute('aria-activedescendant');
  }

  /** @param {number} i */
  function pick(i) {
    if (i === picked || !found.length) return;
    picked = (i + found.length) % found.length;
    for (const [n, row] of [...list.children].entries()) row.setAttribute('aria-selected', String(n === picked));
    input.setAttribute('aria-activedescendant', `spotlight-item-${picked}`);
    list.children[picked]?.scrollIntoView({ block: 'nearest' });
  }

  /** Shows `s` where Sessions would, read, and closes. @param {PastSession} s */
  function choose(s) {
    const meta = daemon.sessions().find((m) => isRunning(m) && m.sessionFile === s.file) ?? null;
    show(showConversation({ file: s.file, meta, cwd: s.cwd, name: displayTitle(s) }));
    const since = daemon.unreadSince(s.id);
    if (since !== null) daemon.markRead(s.id, since).catch(() => {});
    dialog.close();
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => void search(), SEARCH_DEBOUNCE_MS);
  });
  input.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      pick(picked + (event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key === 'Enter' && found[picked]) {
      event.preventDefault();
      choose(found[picked]);
    }
  });
  // A click on the backdrop lands on the dialog itself, outside its box.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      toggle();
    }
  });

  return { root: open };
}
