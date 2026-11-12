/**
 * Spotlight: a floating search over every conversation, as macOS's. ⌘K (Ctrl+K) or the top
 * bar's Search opens it over whatever is on screen; typing finds conversations by what was
 * asked and answered in them (the daemon's search, daemon/search.js, which keeps those that
 * match well): those whose name matches first, then those matched in what was said, each with
 * the passage that matched and the most recently active first; with nothing typed it lists the
 * latest. Ask (or ⌘Enter, Ctrl+Enter elsewhere)
 * hands what is typed to an agent instead (daemon/ask.js), which reads the conversations and
 * answers in a few sentences, shown above the conversations it names. ↑/↓ pick one, Enter (or a
 * click) shows it in the agent window this screen used last, as a click in Sessions does, and
 * Esc (or a click outside) closes it.
 *
 * It is a modal <dialog>: the browser keeps the focus in it and gives it Esc.
 */
import { button, el } from './dom.js';
import { errorMessage, tildeHome } from './format.js';
import { displayTitle, relativeTime } from '../sessions/order.js';
import { isRunning, showConversation } from '../sessions/running.js';
import { mentions, snippetLine } from '../sessions/snippet.js';
import { renderMarkdown } from '../omp/markdown-dom.js';
/** @import { DaemonClient } from '../daemon/client.js' */
/** @import { PastSession } from '../../daemon/wire.js' */
/** @import { LeafParams } from '../layout/grid-model.js' */

const SEARCH_DEBOUNCE_MS = 120;
/** How many conversations it lists: the latest with nothing typed, else the latest of the best matches. */
const RECENT = 8;
const FOUND = 30;

/**
 * @param {{ daemon: DaemonClient, show: (params: LeafParams) => void }} options
 * @returns {{ root: HTMLButtonElement }} the top bar's Search button
 */
export function createSpotlight({ daemon, show }) {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const open = button('btn spotlight-open', undefined, () => toggle());
  open.append(el('span', '', 'Search'), el('kbd', 'spotlight-key', mac ? '⌘K' : 'Ctrl+K'));
  open.setAttribute('aria-label', 'Search');
  open.setAttribute('aria-keyshortcuts', mac ? 'Meta+K' : 'Control+K');

  const dialog = el('dialog', 'spotlight');
  dialog.setAttribute('aria-label', 'Search conversations');
  // Plain text, not a search field: in one, Esc clears the text before the dialog hears it.
  const input = el('input', 'spotlight-input');
  input.type = 'text';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = `Search conversations, or ask an agent (${mac ? '⌘↵' : 'Ctrl+Enter'})`;
  input.setAttribute('aria-label', 'Search conversations');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-controls', 'spotlight-results');
  const askBtn = button('btn spotlight-ask', 'Ask', () => void ask());
  const bar = el('div', 'spotlight-bar');
  bar.append(input, askBtn);
  // The agent's answer, above the conversations it names.
  const answer = el('div', 'spotlight-answer omp-md');
  answer.setAttribute('aria-live', 'polite');
  answer.hidden = true;
  const list = el('ul', 'spotlight-results');
  list.id = 'spotlight-results';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Conversations');
  const status = el('p', 'spotlight-status');
  dialog.append(bar, answer, list, status);
  document.body.append(dialog);

  /** @type {PastSession[]} */
  let found = [];
  /** How many of `found`, first, matched by their name, while they are a search's; null otherwise. @type {number | null} */
  let named = null;
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
    answer.hidden = true;
    try {
      const sessions = await daemon.history(query);
      if (mine !== seq) return;
      // The daemon lists a search best first (the weak matches left out), and everything else
      // unordered: the best matches, or the latest conversations, most recently active first here,
      // a search's matched by their name before those matched in what was said.
      const latestFirst = (/** @type {PastSession[]} */ list) => list.sort((a, b) => b.modifiedAt - a.modifiedAt);
      if (query) {
        const best = sessions.slice(0, FOUND);
        const byName = best.filter((s) => mentions(displayTitle(s), s.match?.terms ?? []));
        found = [...latestFirst(byName), ...latestFirst(best.filter((s) => !byName.includes(s)))];
        named = byName.length;
      } else {
        found = latestFirst(sessions).slice(0, RECENT);
        named = null;
      }
      picked = 0;
      status.textContent = found.length ? '' : query ? 'Nothing found.' : 'No conversations yet.';
    } catch (err) {
      if (mine !== seq) return;
      found = [];
      named = null;
      status.textContent = `Could not search: ${errorMessage(err)}`;
    }
    draw();
  }

  /** Hands what is typed to an agent, and shows its answer above the conversations it names. */
  async function ask() {
    const question = input.value.trim();
    if (!question) {
      status.textContent = 'Type a question first.';
      return input.focus();
    }
    clearTimeout(timer);
    const mine = ++seq;
    answer.hidden = true;
    found = [];
    named = null;
    draw();
    status.textContent = 'Asking an agent: it reads your conversations, which can take a minute…';
    try {
      const result = await daemon.ask(question);
      if (mine !== seq) return;
      answer.replaceChildren(renderMarkdown(result.answer || 'The agent gave no answer.'));
      answer.hidden = false;
      found = result.sessions;
      picked = 0;
      status.textContent = '';
    } catch (err) {
      if (mine !== seq) return;
      status.textContent = `Could not ask: ${errorMessage(err)}`;
    }
    draw();
  }

  /** A heading over one group of a search's conversations. @param {string} text */
  const groupHead = (text) => {
    const head = el('li', 'spotlight-group', text);
    head.setAttribute('role', 'presentation');
    return head;
  };

  function draw() {
    const now = Date.now();
    const rows = found.map((s, i) => {
      const row = el('li', 'spotlight-item');
      row.id = `spotlight-item-${i}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === picked));
      const facts = el('div', 'spotlight-facts', `${s.cwd ? tildeHome(s.cwd, home) : ''}  ${relativeTime(s.modifiedAt, now)}`);
      const title = s.match ? snippetLine({ snippet: displayTitle(s), terms: s.match.terms }, 'spotlight-title') : el('div', 'spotlight-title', displayTitle(s));
      row.append(title, facts);
      if (s.match?.snippet) row.append(snippetLine(s.match, 'spotlight-snippet'));
      row.addEventListener('click', () => choose(s));
      row.addEventListener('pointermove', () => pick(i));
      return row;
    });
    // A search's conversations in two groups, each under its heading: by name, then by what was said.
    if (named !== null && found.length) {
      if (named < found.length) rows.splice(named, 0, groupHead('In the conversation'));
      if (named > 0) rows.unshift(groupHead('In the name'));
    }
    list.replaceChildren(...rows);
    if (found.length) input.setAttribute('aria-activedescendant', `spotlight-item-${picked}`);
    else input.removeAttribute('aria-activedescendant');
  }

  /** @param {number} i */
  function pick(i) {
    if (i === picked || !found.length) return;
    picked = (i + found.length) % found.length;
    const rows = list.querySelectorAll('.spotlight-item');
    for (const [n, row] of rows.entries()) row.setAttribute('aria-selected', String(n === picked));
    input.setAttribute('aria-activedescendant', `spotlight-item-${picked}`);
    rows[picked]?.scrollIntoView({ block: 'nearest' });
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
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void ask();
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
