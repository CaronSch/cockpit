/**
 * omp conversations, one list, searchable and sortable. A click shows a conversation in the
 * agent window this screen used last (or a new one); dragging it shows it in the agent window it
 * is dropped on, or in a new window where it is dropped.
 *
 * Every journal is listed, with how it is doing while a session holds it (sessions/running.js):
 * working, needs you, done (unread) or idle; asleep or awake is the daemon's business, not
 * the list's. Showing a conversation needs no omp: its window shows the journal until
 * something is sent.
 *
 * Search runs in the daemon (daemon/search.js), over titles, directories, prompts and the
 * agents' replies: a question in plain words finds the conversations that answer it, best
 * first, each with the passage that matched and its words marked. While searching the list is
 * in that order; otherwise sorting runs here. Narrowing to one directory runs here too. The query, directory and sort order are
 * this window's own settings, so two Sessions windows can show different slices.
 *
 * Archive moves a conversation out of omp's sessions into the daemon's archive (omp's own
 * resume no longer offers it); "Archived" switches the window to the archived ones, each with
 * Restore. One whose agent is working is not archived until it is done. A new session
 * nothing was sent to has no journal yet: archiving it ends it, and it is gone, not archived.
 *
 * A conversation with news its user has not read (daemon/unread.js) has a blue dot and a bold
 * title, archived or not, and the window's top bar counts those it lists. Showing one from
 * here reads it. Each row's menu (a right-click, the ContextMenu key, Shift+F10, or its ⋯
 * button) marks it read or unread, beside the row's other actions.
 *
 * Pinned conversations (daemon/pins.js) come first, in the window's order, each with a ★; the
 * ☆ on a row pointed at, or its menu, pins it.
 *
 * Rows show where their conversations are on this screen (sessions/links.js): a bar at the
 * left edge for one shown in an agent window, brighter for the one in the agent window used last
 * (where a click shows conversations). Pointing at a row (hover, or keyboard focus: a click
 * also focuses a row, but that is not pointing at it once the pointer moves on) outlines its
 * windows, and pointing at an agent window lights its conversation's row.
 */
import { button, el } from '../ui/dom.js';
import { errorMessage, tildeHome } from '../ui/format.js';
import { getDaemon } from '../daemon/client.js';
import { SORT_KEYS, directoryCounts, displayTitle, isSortKey, naturalDir, relativeTime, sortSessions } from '../sessions/order.js';
import { STATE_LABELS, follow, followedName, isRunning, listConversations, noteEvent, runningState, showConversation } from '../sessions/running.js';
import { sessionLinks } from '../sessions/links.js';
import { snippetLine } from '../sessions/snippet.js';
import { runningWork } from '../omp/running-work.js';
import { openContextMenu, opensContextMenu } from '../ui/context-menu.js';
/** @import { WidgetContext } from './registry.js' */
/** @import { DaemonClient } from '../daemon/client.js' */
/** @import { PastSession, SessionMeta } from '../../daemon/wire.js' */
/** @import { Followed, Listed, RunningState } from '../sessions/running.js' */
/** @import { SortDir, SortKey } from '../sessions/order.js' */

const SEARCH_DEBOUNCE_MS = 200;

export default {
  type: 'sessions',
  title: 'Sessions',
  glyph: '☰',
  description: 'Agent conversations: click or drag one to show it in an agent window',

  /** @param {HTMLElement} body @param {WidgetContext} ctx */
  mount(body, ctx) {
    return createSessionsWindow(body, ctx, getDaemon());
  },
};

/** @param {HTMLElement} body @param {WidgetContext} ctx @param {DaemonClient} daemon */
function createSessionsWindow(body, ctx, daemon) {
  const root = el('div', 'sessions');
  body.append(root);

  /** @returns {SortKey} */
  const sortKey = () => (isSortKey(ctx.params.sort) ? ctx.params.sort : 'active');
  /** @returns {SortDir} */
  const sortDir = () => (ctx.params.dir === 'asc' || ctx.params.dir === 'desc' ? ctx.params.dir : naturalDir(sortKey()));
  const query = () => (typeof ctx.params.query === 'string' ? ctx.params.query : '');
  const showArchived = () => ctx.params.archived === true;
  /** The one directory this window shows, or null for all. */
  const directory = () => (typeof ctx.params.directory === 'string' && ctx.params.directory ? ctx.params.directory : null);

  // ── toolbar ──
  const bar = el('div', 'sessions-bar');
  const search = el('input', 'sessions-search');
  search.type = 'search';
  search.placeholder = 'Search, or ask: where did we find…';
  search.setAttribute('aria-label', 'Search sessions');
  search.value = query();
  const directories = el('select', 'sessions-sort sessions-directory');
  directories.setAttribute('aria-label', 'Directory');
  /** What the directory options were last built from, so an open menu is not rebuilt for nothing. */
  let directoriesSignature = '';
  const sort = el('select', 'sessions-sort');
  sort.setAttribute('aria-label', 'Sort by');
  for (const { key, label } of SORT_KEYS) {
    const option = el('option', '', label);
    option.value = key;
    sort.append(option);
  }
  const direction = button('sessions-icon-btn');
  direction.setAttribute('aria-label', 'Reverse sort order');
  const refresh = button('sessions-icon-btn', '⟳');
  refresh.title = 'Refresh';
  refresh.setAttribute('aria-label', 'Refresh');
  const archivedToggle = button('sessions-toggle', 'Archived');
  archivedToggle.title = 'Show archived sessions instead';
  bar.append(search, directories, sort, direction, archivedToggle, refresh);
  const status = el('p', 'sessions-status');
  status.setAttribute('aria-live', 'polite');
  const list = el('ul', 'sessions-list');
  list.setAttribute('aria-label', 'Sessions');
  root.append(bar, status, list);

  /** @type {PastSession[]} */
  let sessions = [];
  /** @type {string | null} */
  let error = null;
  /** Why the last row action (Archive, Restore, a mark) failed, until the next one. @type {string | null} */
  let moveError = null;
  let loading = false;
  let loaded = false;
  let requestSeq = 0;
  /** @type {string | null} */
  let home = null;
  /** Rows, by conversation key. @type {Map<string, { signature: string, node: HTMLElement }>} */
  const rows = new Map();
  /** What each row shows, by its key, as last drawn. @type {Map<string, Listed>} */
  let shown = new Map();
  /** Where conversations are shown on this screen (see drawLinks). */
  let links = sessionLinks(ctx.screen.get());
  /** The rows pointed at: under the pointer, and holding focus. @type {{ hovered: string | null, focused: string | null }} */
  const pointing = { hovered: null, focused: null };
  /** What this window follows of each awake session, from its events. @type {Map<string, { followed: Followed, off: () => void }>} */
  const followed = new Map();
  let frame = 0;
  /** Redraws once per frame however many events arrive. */
  const scheduleDraw = () => {
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      draw();
    });
  };

  daemon
    .config()
    .then((c) => {
      home = c.home;
      draw();
    })
    .catch(() => {});

  /** Follows every awake session's events (to tell how it is doing), and lets go of the others. */
  function syncFollowed() {
    const awake = new Set(daemon.sessions().filter(isRunning).map((m) => m.id));
    for (const [id, entry] of followed) {
      if (awake.has(id)) continue;
      entry.off();
      followed.delete(id);
    }
    for (const id of awake) {
      if (followed.has(id)) continue;
      const entry = { followed: follow(), off: () => {} };
      followed.set(id, entry);
      entry.off = daemon.subscribe(id, (event) => {
        noteEvent(entry.followed, event);
        scheduleDraw();
      });
    }
  }

  async function load() {
    const seq = ++requestSeq;
    loading = true;
    drawStatus();
    try {
      const next = await daemon.history(query(), { archived: showArchived() });
      if (seq !== requestSeq) return;
      sessions = next;
      error = null;
      loaded = true;
    } catch (err) {
      if (seq !== requestSeq) return;
      error = errorMessage(err);
    } finally {
      if (seq === requestSeq) {
        loading = false;
        draw();
      }
    }
  }

  /** @param {string | null} cwd */
  function shortDir(cwd) {
    if (!cwd) return 'unknown directory';
    return tildeHome(cwd, home);
  }

  /** The conversations this window lists: archived ones on their own, else every one, awake or not. */
  const listed = () =>
    listConversations(sessions, showArchived() ? [] : daemon.sessions(), { searching: query() !== '', directory: directory() });

  /** What a row's conversation is called: its awake session's name, else its journal's. @param {Listed} c */
  const nameOf = (c) => {
    const f = c.meta && followed.get(c.meta.id)?.followed;
    return (f && followedName(f)) ?? (c.title || c.firstPrompt ? displayTitle(c) : null);
  };

  /** @param {Listed} c */
  const isUnread = (c) => daemon.unreadSince(c.meta?.ompId ?? (c.id || null)) !== null;

  /** @param {Listed} c */
  const isPinned = (c) => daemon.isPinned(c.meta?.ompId ?? (c.id || null));

  /** How an awake conversation is doing, or null for one asleep. @param {Listed} c @returns {RunningState | null} */
  function stateOf(c) {
    if (!c.meta) return null;
    const f = followed.get(c.meta.id)?.followed;
    return f ? runningState(f, c.meta, isUnread(c)) : 'starting';
  }

  /** How many shells and subagents an awake conversation has running (omp/running-work.js). @param {Listed} c */
  function workOf(c) {
    const f = c.meta ? followed.get(c.meta.id)?.followed : null;
    return f ? runningWork(f.transcript).length : 0;
  }

  /**
   * Whether Archive is offered for `c`: a listed journal, or a new session omp has not written
   * one for (nothing sent yet, nothing to keep), unless it is still starting or working.
   * @param {Listed} c
   */
  const archivable = (c) => (isEmpty(c) ? stateOf(c) === 'idle' : sessions.some((s) => s.file === c.file));

  /** An awake session with no listed journal: a new one nothing was sent to. @param {Listed} c */
  const isEmpty = (c) => c.meta !== null && !sessions.some((s) => s.file === c.file);

  /** The row's conversation, as last drawn. @param {HTMLElement} row */
  const conversationAt = (row) => shown.get(row.dataset.key ?? '') ?? null;

  /**
   * The agent window settings that show the row's conversation, or null for an archived one (it
   * must be restored first).
   * @param {HTMLElement} row @returns {import('../layout/grid-model.js').LeafParams | null}
   */
  function paramsFor(row) {
    const c = conversationAt(row);
    return c && !showArchived() ? showConversation({ file: c.file, meta: c.meta, cwd: c.cwd, name: nameOf(c) }) : null;
  }

  /** omp's id for the row's conversation (what its unread mark is kept under), if known. @param {HTMLElement} row */
  function ompIdOf(row) {
    const c = conversationAt(row);
    return c?.meta?.ompId ?? (c?.id || null);
  }

  /** Marks the row's conversation read or unread. @param {HTMLElement} row @param {boolean} unread */
  function mark(row, unread) {
    const id = ompIdOf(row);
    const since = daemon.unreadSince(id);
    if (id === null || unread === (since !== null)) return;
    (since === null ? daemon.markUnread(id) : daemon.markRead(id, since)).catch((err) => {
      moveError = `Could not mark it ${unread ? 'unread' : 'read'}: ${errorMessage(err)}`;
      draw();
    });
  }

  /** Pins the row's conversation to the top, or unpins it. @param {HTMLElement} row @param {boolean} pinned */
  function pin(row, pinned) {
    const id = ompIdOf(row);
    if (id === null) return;
    daemon.pin(id, pinned).catch((err) => {
      moveError = `Could not ${pinned ? 'pin' : 'unpin'} it: ${errorMessage(err)}`;
      draw();
    });
  }

  /** Shows the row's conversation in the agent window this screen used last; that reads it. @param {HTMLElement} row */
  function show(row) {
    const params = paramsFor(row);
    if (!params) return;
    ctx.showWidget('omp', params);
    mark(row, false);
  }

  /**
   * Opens the row's menu: show it, mark it read or unread, and its own last action.
   * @param {HTMLElement} row @param {HTMLElement} anchor @param {{ x: number, y: number }} [at]
   */
  function openRowMenu(row, anchor, at) {
    /** @type {import('../ui/context-menu.js').MenuItem[]} */
    const items = [];
    const c = conversationAt(row);
    if (paramsFor(row)) items.push({ label: 'Show', run: () => show(row) });
    const id = ompIdOf(row);
    if (id !== null) {
      const unread = daemon.unreadSince(id) !== null;
      items.push({ label: unread ? 'Mark as read' : 'Mark as unread', run: () => mark(row, !unread) });
      const pinned = daemon.isPinned(id);
      items.push({ label: pinned ? 'Unpin' : 'Pin to top', run: () => pin(row, !pinned) });
    }
    /** The row's own button for an action, which shows that the action is under way. @param {string} kind */
    const control = (kind) => /** @type {HTMLButtonElement} */ (row.querySelector(`.sessions-${kind}`));
    if (c?.file && showArchived()) items.push({ label: 'Restore', run: () => void move(c, control('restore')) });
    else if (c && archivable(c)) items.push({ label: 'Archive', run: () => void move(c, control('archive')) });
    openContextMenu(anchor, items, at);
  }

  /**
   * Archives or restores `c`, then lists again: the row moves to the other list.
   * @param {Listed} c @param {HTMLButtonElement} control
   */
  async function move(c, control) {
    control.disabled = true;
    moveError = null;
    try {
      if (showArchived()) await daemon.restorePastSession(c.file);
      else if (c.meta && isEmpty(c)) await daemon.end(c.meta.id);
      else await daemon.archivePastSession(c.file);
    } catch (err) {
      moveError = `Could not ${showArchived() ? 'restore' : 'archive'} “${nameOf(c) ?? c.file}”: ${errorMessage(err)}`;
      control.disabled = false;
    }
    await load();
  }

  /**
   * A row's text: its title on one line, and a dimmer line of facts below it.
   * @param {string} title @param {string[]} facts
   */
  function rowText(title, facts) {
    const main = el('div', 'sessions-main');
    const meta = el('div', 'sessions-meta');
    // The spaces keep the facts separate words for copy and screen readers; flex layout ignores them.
    facts.forEach((fact, i) => meta.append(...(i ? [' '] : []), el('span', i === 0 ? 'sessions-dir' : '', fact)));
    main.append(el('div', 'sessions-title', title), meta);
    return main;
  }

  /**
   * The dot before a row's title: how an awake conversation is doing, and blue while unread
   * (then it says so to screen readers too).
   * @param {boolean} unread
   */
  function rowDot(unread) {
    const dot = el('span', 'sessions-dot');
    if (unread) {
      dot.setAttribute('role', 'img');
      dot.setAttribute('aria-label', 'Unread');
    } else dot.setAttribute('aria-hidden', 'true');
    return dot;
  }

  /** The row's ⋯ button, which opens its menu. */
  function moreButton() {
    const more = button('sessions-action sessions-more', '⋯');
    more.title = 'More: mark read or unread, and the rest (or right-click the row)';
    more.setAttribute('aria-label', 'More actions');
    more.setAttribute('aria-haspopup', 'menu');
    return more;
  }

  /** The row's ★ (pinned) or ☆, which pins or unpins it. @param {boolean} pinned */
  function pinButton(pinned) {
    const star = button('sessions-action sessions-pin', pinned ? '★' : '☆');
    star.title = pinned ? 'Unpin' : 'Pin to the top';
    star.setAttribute('aria-label', 'Pin to top');
    star.setAttribute('aria-pressed', String(pinned));
    return star;
  }

  /** States worth a word in the row: the rest read from the dot (done) or need none (idle). */
  const SAID = new Set(['starting', 'working', 'asking']);

  /** @param {Listed} c @param {number} now */
  function renderRow(c, now) {
    const archived = showArchived();
    const unread = isUnread(c);
    const pinned = isPinned(c);
    const state = stateOf(c);
    const row = el('li', `sessions-item${state ? ` is-${state}` : ''}${archived ? ' is-archived' : ''}${unread ? ' is-unread' : ''}${pinned ? ' is-pinned' : ''}`);
    row.tabIndex = 0;
    row.dataset.key = c.key;
    const hint = archived ? 'Archived: Restore to show it' : 'Click to show it in the last agent window used, or drag it onto one';
    row.title = `${c.title && c.firstPrompt ? `${c.firstPrompt}\n` : ''}${c.file || c.cwd}\nLast active ${new Date(c.modifiedAt).toLocaleString()}\n${hint}`;
    const facts = [shortDir(c.cwd), relativeTime(c.modifiedAt, now), ...(c.prompts ? [`${c.prompts} prompt${c.prompts === 1 ? '' : 's'}`] : [])];
    const main = rowText(nameOf(c) ?? 'New session', facts);
    if (state && SAID.has(state)) main.querySelector('.sessions-meta')?.append(' ', el('span', 'sessions-state', STATE_LABELS[state]));
    const work = workOf(c);
    if (work) main.querySelector('.sessions-meta')?.append(' ', el('span', 'sessions-state', `${work} running`));
    if (c.match?.snippet) main.append(snippetLine(c.match, 'sessions-snippet'));
    const actions = el('div', 'sessions-actions');
    if (archived) actions.append(button('sessions-action sessions-restore', 'Restore'));
    else if (archivable(c)) actions.append(button('sessions-action sessions-archive', 'Archive'));
    actions.append(moreButton());
    // Over the row's right end, not beside its text: hidden, they take none of its width.
    const tools = el('div', 'sessions-tools');
    tools.append(actions, ...(c.meta?.ompId || c.id ? [pinButton(pinned)] : []));
    row.append(rowDot(unread), main, tools);
    return row;
  }

  function drawDirectories() {
    const options = directoryCounts(sessions, directory()).map((d) => ({ value: d.cwd, text: `${shortDir(d.cwd)} (${d.count})` }));
    const signature = JSON.stringify(options);
    if (signature !== directoriesSignature) {
      directoriesSignature = signature;
      const all = el('option', '', 'All directories');
      all.value = '';
      directories.replaceChildren(
        all,
        ...options.map((o) => {
          const option = el('option', '', o.text);
          option.value = o.value;
          return option;
        }),
      );
    }
    directories.value = directory() ?? '';
  }

  /** @param {number} count how many conversations are listed */
  function drawStatus(count = shown.size) {
    const kind = showArchived() ? 'archived session' : 'session';
    status.classList.toggle('is-error', error !== null || moveError !== null);
    if (error) status.textContent = `Could not list sessions: ${error}`;
    else if (moveError) status.textContent = moveError;
    else if (!loaded) status.textContent = 'Loading sessions…';
    else if (count === 0) status.textContent = query() || directory() ? 'No session matches.' : showArchived() ? 'No archived sessions.' : 'No sessions yet.';
    else status.textContent = `${count} ${kind}${count === 1 ? '' : 's'}${loading ? ' · refreshing…' : ''}`;
  }

  function draw() {
    sort.value = sortKey();
    const dir = sortDir();
    direction.textContent = dir === 'asc' ? '↑' : '↓';
    direction.title = `${dir === 'asc' ? 'Ascending' : 'Descending'}: click to reverse`;
    archivedToggle.setAttribute('aria-pressed', String(showArchived()));
    list.setAttribute('aria-label', showArchived() ? 'Archived sessions' : 'Sessions');
    drawDirectories();

    const now = Date.now();
    // A search lists by relevance, as the daemon ranked it; otherwise pinned ones come first.
    const searching = query().trim() !== '';
    const sorted = searching ? listed() : sortSessions(listed(), sortKey(), dir);
    const conversations = searching ? sorted : [...sorted.filter(isPinned), ...sorted.filter((c) => !isPinned(c))];
    sort.disabled = direction.disabled = searching;
    sort.title = searching ? 'Sorted by relevance while searching' : '';
    if (searching) direction.title = sort.title;
    shown = new Map(conversations.map((c) => [c.key, c]));
    drawStatus(conversations.length);
    // Rows are rebuilt only when what they show changed, so a redraw does not steal focus.
    const live = new Set();
    conversations.forEach((c, i) => {
      live.add(c.key);
      const signature = JSON.stringify([nameOf(c), c.firstPrompt, c.match?.snippet, c.cwd, c.prompts, relativeTime(c.modifiedAt, now), home, showArchived(), isUnread(c), isPinned(c), stateOf(c), workOf(c), sessions.some((s) => s.file === c.file)]);
      let entry = rows.get(c.key);
      if (!entry || entry.signature !== signature) {
        const node = renderRow(c, now);
        if (entry) {
          const hadFocus = entry.node.contains(document.activeElement);
          entry.node.replaceWith(node);
          if (hadFocus) node.focus();
        }
        entry = { signature, node };
        rows.set(c.key, entry);
      }
      const at = list.children[i];
      if (at !== entry.node) list.insertBefore(entry.node, at ?? null);
    });
    for (const [key, entry] of rows) {
      if (!live.has(key)) {
        entry.node.remove();
        rows.delete(key);
      }
    }
    drawLinks();
    const unread = conversations.filter(isUnread).length;
    ctx.setLabel(unread ? `${unread} unread` : null);
  }

  // ── interaction ──
  /** @param {EventTarget | null} target @returns {HTMLElement | null} */
  const rowAt = (target) => /** @type {HTMLElement | null} */ (/** @type {Element} */ (target)?.closest?.('.sessions-item'));

  // A row drags out from anywhere on it; its actions only act.
  root.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || /** @type {Element} */ (event.target).closest('.sessions-action')) return;
    const row = rowAt(event.target);
    const params = row && paramsFor(row);
    if (!row || !params) return;
    const label = row.querySelector('.sessions-title')?.textContent ?? 'Agent';
    // Dropped, it shows in an agent window: that reads it, as a click does.
    ctx.dragWidget('omp', params, event, { label, into: true, onEnd: ({ dropped }) => dropped && mark(row, false) });
  });
  root.addEventListener('contextmenu', (event) => {
    const row = rowAt(event.target);
    if (!row) return;
    event.preventDefault();
    row.focus();
    openRowMenu(row, row, { x: event.clientX, y: event.clientY });
  });
  root.addEventListener('click', (event) => {
    const row = rowAt(event.target);
    if (!row) return;
    const control = /** @type {Element} */ (event.target).closest('button');
    const c = conversationAt(row);
    if (!control) show(row);
    else if (c && control.classList.contains('sessions-pin')) pin(row, !isPinned(c));
    else if (control.classList.contains('sessions-more')) openRowMenu(row, /** @type {HTMLElement} */ (control));
    else if (c && (control.classList.contains('sessions-archive') || control.classList.contains('sessions-restore'))) void move(c, /** @type {HTMLButtonElement} */ (control));
  });
  root.addEventListener('keydown', (event) => {
    const row = /** @type {HTMLElement} */ (event.target);
    if (!row.classList?.contains('sessions-item')) return;
    if (opensContextMenu(event)) {
      event.preventDefault();
      openRowMenu(row, row);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      show(row);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const rowsShown = [...root.querySelectorAll('.sessions-item')];
      const next = rowsShown[rowsShown.indexOf(row) + (event.key === 'ArrowDown' ? 1 : -1)];
      /** @type {HTMLElement | undefined} */ (next)?.focus();
    }
  });

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let searchTimer;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      ctx.setParams({ query: search.value.trim() });
      void load();
    }, SEARCH_DEBOUNCE_MS);
  });
  directories.addEventListener('change', () => {
    ctx.setParams({ directory: directories.value || null });
    draw();
  });
  sort.addEventListener('change', () => {
    const key = isSortKey(sort.value) ? sort.value : 'active';
    ctx.setParams({ sort: key, dir: naturalDir(key) });
    draw();
  });
  direction.addEventListener('click', () => {
    ctx.setParams({ dir: sortDir() === 'asc' ? 'desc' : 'asc' });
    draw();
  });
  refresh.addEventListener('click', () => void load());
  archivedToggle.addEventListener('click', () => {
    ctx.setParams({ archived: !showArchived() });
    // The other list's rows are not these; show none until it arrives.
    sessions = [];
    loaded = false;
    moveError = null;
    draw();
    void load();
  });

  const offUnread = daemon.onUnread(scheduleDraw);
  const offPins = daemon.onPins(scheduleDraw);
  const offSessions = daemon.onSessions(() => {
    syncFollowed();
    scheduleDraw();
  });
  syncFollowed();
  const offStatus = daemon.onStatus((s) => {
    if (s === 'open') void load();
  });
  // The daemon says when a journal changes: omp wrote one, or a session was archived or restored.
  const offHistory = daemon.onHistory(() => void load());

  // ── links to this screen's agent windows ──
  /** Marks each row by where its conversation is shown, and outlines the pointed row's windows. */
  function drawLinks() {
    for (const [key, { node }] of rows) {
      node.classList.toggle('is-shown', links.windows.has(key));
      node.classList.toggle('is-current', links.current === key);
      node.classList.toggle('is-pointed', links.pointed === key);
      if (links.current === key) node.setAttribute('aria-current', 'true');
      else node.removeAttribute('aria-current');
    }
    const key = pointing.hovered ?? pointing.focused;
    ctx.outline(key ? (links.windows.get(key) ?? []) : []);
  }
  const offScreen = ctx.screen.subscribe((screen) => {
    links = sessionLinks(screen);
    drawLinks();
  });
  /** @param {EventTarget | null} target */
  const keyAt = (target) => rowAt(target)?.dataset.key ?? null;
  root.addEventListener('pointerover', (event) => {
    const key = keyAt(event.target);
    if (key === pointing.hovered) return;
    pointing.hovered = key;
    drawLinks();
  });
  root.addEventListener('pointerleave', () => {
    pointing.hovered = null;
    drawLinks();
  });
  // Only keyboard focus points: a click focuses its row too, and that focus would otherwise
  // keep the row's windows outlined after the pointer has moved on.
  root.addEventListener('focusin', (event) => {
    const target = /** @type {Element} */ (event.target);
    pointing.focused = target.matches(':focus-visible') ? keyAt(target) : null;
    drawLinks();
  });
  root.addEventListener('focusout', (event) => {
    if (root.contains(/** @type {Node | null} */ (event.relatedTarget))) return; // focusin follows
    pointing.focused = null;
    drawLinks();
  });

  draw();
  void load();

  return {
    destroy() {
      offHistory();
      offScreen();
      ctx.outline([]);
      clearTimeout(searchTimer);
      requestSeq++; // drop any answer still on its way
      offSessions();
      offUnread();
      offPins();
      offStatus();
      for (const entry of followed.values()) entry.off();
      cancelAnimationFrame(frame);
      root.remove();
    },
  };
}
