/**
 * The agent pane: a conversation with an omp coding agent in a chosen directory, through the
 * daemon, rendered from omp's structured event stream.
 *
 * The window shows one conversation at a time, named by its journal (`sessionFile`). Whether
 * an omp process holds it is the daemon's business (daemon/sleep.js): awake, the window
 * follows the session's events; asleep, it shows the conversation from its journal, and
 * focusing or typing in the message box wakes it (`omp --resume`), anything sent meanwhile
 * going once it is up. New starts another conversation here and Sessions shows any other
 * here; the one shown before carries on, or sleeps.
 *
 * Params (persisted with the layout): `sessionFile` (the conversation), `session` (the daemon
 * session last seen holding it, or a new one's until omp names its journal), `cwd`, `name`
 * (the conversation's title, shown in the window's top bar), `fork` while the window is
 * starting a copy of another journal, and `prompt` while a fork waits to send the message it
 * was dragged off another pane's Send with. What the pane shows follows the app's settings
 * (ui/settings.js), the same in every agent window. Each turn's decision review, when the
 * daemon made one (daemon/decisions.js), shows where the turn ends (omp/decisions.js).
 *
 * New, Fork, PRs (shown while the conversation's directory is in a GitHub repository), Accounts
 * and Stop sit in the window's top bar, beside its close button. PRs lists the repository's pull
 * requests: a click opens one beside this window, to review for this conversation
 * (widgets/github.js); dragging one places it where it is dropped. Typing `#` in the message box
 * suggests them too (omp/pr-suggest.js).
 */
import { button, el, setText } from '../ui/dom.js';
import { errorMessage, tildeHome } from '../ui/format.js';
import { DaemonError, getDaemon } from '../daemon/client.js';
import { addNote, applyEvent, conversationName, createTranscript, needsLogin, seedConversation } from '../omp/transcript.js';
import { renderItem, renderReview } from '../omp/items-view.js';
import { renderDialog } from '../omp/dialogs-view.js';
import { createComposer } from '../omp/composer.js';
import { composeAsk, composeFollowUp, forkPrompt, isCommand, isContinueDirective, outgoingPrompt, shellCommand } from '../omp/message.js';
import { attachSelectionPopup } from '../omp/selection-popup.js';
import { attachDragHighlight } from '../omp/drag-highlight.js';
import { createSuggestions } from '../omp/suggestions.js';
import { createFileSuggest } from '../omp/file-suggest.js';
import { MENTIONS, PLAIN_PATH } from '../omp/file-mention.js';
import { createPullSuggest } from '../omp/pr-suggest.js';
import { pullOfUrl } from '../github/pr-refs.js';
import { attachPullDrag, pullParams } from '../github/pull-window.js';
import { attachFileRefs } from '../files/file-window.js';
import { awaitedAfter } from '../omp/activity.js';
import { isResponse, promptsAndResponses } from '../omp/visibility.js';
import { responseTarget } from '../omp/response-nav.js';
import { placeReviews } from '../omp/decisions.js';
import { coldAt } from '../omp/cold.js';
import { turnProgress } from '../omp/todos.js';
import { elapsed, runningWork } from '../omp/running-work.js';
import { createPromptHistory, sentPrompts } from '../omp/prompt-history.js';
import { branchEntry, pointKey, rewindPoint } from '../omp/rewind.js';
import { conversationKey, isRunning, listConversations, showConversation } from '../sessions/running.js';
import { recentDirs } from '../omp/recent-dirs.js';
import { familyOf, relatives } from '../omp/fork-family.js';
import { readDraft, writeDraft } from '../omp/drafts.js';
import { focusOnClick } from '../ui/click-focus.js';
import { settings } from '../ui/settings.js';
/** @import { WidgetContext } from './registry.js' */
/** @import { LeafParams } from '../layout/grid-model.js' */
/** @import { RpcResponse, SessionEvent, SessionMeta } from '../../daemon/wire.js' */
/** @import { DaemonClient } from '../daemon/client.js' */
/** @import { SlashCommand } from '../omp/transcript.js' */

/**
 * `fork` is a journal to fork into a new conversation as soon as the window is placed (set by
 * another pane's Send, dragged); it is cleared once the fork runs, so it is never taken twice.
 * `prompt` is the message the fork is sent once it is up (by the daemon), cleared with `fork`.
 * @typedef {{ session: string | null, cwd: string | null, sessionFile: string | null, name: string | null, fork: string | null, prompt: string | null }} OmpParams
 */
/** @typedef {{ label: string, detail?: string, current?: boolean, pick: () => void, drag?: (event: PointerEvent, close: () => void) => void }} MenuEntry */
/** How often, at most, a window being used tells the daemon so (it keeps the session awake). */
const SEEN_EVERY_MS = 60_000;
const MAX_SUGGESTIONS = 8;
const BOTTOM_SLACK_PX = 24;
/** ⌘ on Apple's keyboards, Ctrl elsewhere: the modifier of the previous/next response keys. */
const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const REFUSED = 'The daemon refused this page.';
const FORKS_TITLE = 'Forks of this conversation, and the one it was forked from: click one to show it beside this window, or drag it where you want it';
const NO_FORKS = 'No forks yet. /fork <prompt> starts one in the background; dragging Send onto the grid starts one beside.';
const NOTHING_TO_FORK = 'Nothing to fork yet: the conversation is saved once the agent has replied';
const SEND_TITLE = 'Drag onto the grid to send this in a fork of the conversation instead';
/** The workbench's own command, in the suggestions beside omp's (`/fork` is omp's terminal UI's only). @type {SlashCommand} */
const FORK_COMMAND = { name: 'fork', aliases: [], hint: '<prompt>', description: 'Fork this conversation in the background and send the fork this prompt (listed under Forks)' };

/**
 * Whether the page is going away: its requests are cut off then, which says nothing of whether
 * omp got them, so a message cut off this way is not given back to the box (and kept there).
 * Set from `beforeunload`, which comes before the browser cuts them off (a busy page can hear
 * of the cut-off request before `pagehide`), and from `pagehide`, for a page left without it.
 */
let leaving = false;
addEventListener('beforeunload', () => (leaving = true));
addEventListener('pagehide', () => (leaving = true));
addEventListener('pageshow', () => (leaving = false));

export default {
  type: 'omp',
  title: 'Agent',
  glyph: '✦',
  description: 'Chat with a coding agent in a directory',

  /** @param {HTMLElement} body @param {WidgetContext} ctx */
  mount(body, ctx) {
    return createPane(body, ctx, getDaemon());
  },
};

/** @param {unknown} v @returns {string | null} */
const str = (v) => (typeof v === 'string' && v ? v : null);

/**
 * @param {HTMLElement} body @param {WidgetContext} ctx @param {DaemonClient} daemon
 */
function createPane(body, ctx, daemon) {
  const root = el('div', 'omp');
  body.append(root);

  /** @returns {OmpParams} */
  const params = () => ({
    session: str(ctx.params.session),
    cwd: str(ctx.params.cwd),
    sessionFile: str(ctx.params.sessionFile),
    name: str(ctx.params.name),
    fork: str(ctx.params.fork),
    prompt: str(ctx.params.prompt),
  });

  /** @type {string | null} */
  let mode = null;
  let frame = 0;
  let destroyed = false;
  /** @type {SessionView | null} */
  let view = null;
  /** Views made so far, so each gets its own id. */
  let views = 0;
  /** Whether the next view to show takes the focus: the agent just started from the setup form. */
  let focusNext = false;
  /** @type {string | null} */
  let home = null;
  /** How long after its last request a conversation's window dims (omp/cold.js); null until the daemon says. @type {number | null} */
  let coldAfterMs = null;
  daemon
    .config()
    .then((c) => {
      home = c.home;
      coldAfterMs = c.idleCompactAfterMs;
      schedule();
    })
    .catch(() => {});

  // Draw now, then on every status change: the connection may already be settled (open,
  // or refused for want of the token) when this window mounts, and then never changes.
  schedule();
  const offStatus = daemon.onStatus(() => schedule());
  const offSettings = settings.subscribe(() => schedule());
  const offReset = daemon.onReset(() => {
    // The daemon restarted: its sessions are gone, and the conversation is in its journal.
    view?.destroy();
    view = null;
    schedule();
  });
  // Another window may wake the conversation this one shows: follow it then.
  const offSessions = daemon.onSessions(() => schedule());

  // ── unread: a final response or question nobody has looked at (omp/activity.js) ──
  // Which conversations are unread is the daemon's (daemon/unread.js), so every window showing
  // the session, and the Sessions window, agree on it, across reloads and restarts.
  const offUnread = daemon.onUnread(() => schedule());
  // Decision reviews (daemon/decisions.js) arrive after the turn, for any conversation.
  const offDecisions = daemon.onDecisions(() => schedule());
  // Forks started or moved (daemon/forks.js): the Forks count, and which windows are related.
  const offForks = daemon.onForks(() => schedule());
  let pointerInside = false;
  /** The user's last click, keystroke or move of focus was in this window. */
  let inside = false;
  /**
   * The page lost focus and the user has not clicked or typed in it since: the focus the browser
   * gives back to a message box as they return to the page is not them coming back to its window.
   */
  let away = !document.hasFocus();
  /** A touch screen (a phone): no pointer rests on a window, and Enter is a new line. */
  const coarse = matchMedia('(pointer: coarse)');
  /**
   * Looking at this window: the user is in it and pointing at it, in a page that has focus. On a
   * touch screen, which leaves no pointer anywhere, a focused page showing it is enough.
   */
  const reading = () => (coarse.matches || (inside && pointerInside)) && document.visibilityState === 'visible' && document.hasFocus();
  const read = () => view?.read();
  const seen = () => view?.seen();
  /** @param {Event} event */
  const isHere = (event) => event.target instanceof Node && body.contains(event.target);
  /** @param {Event} event */
  const pressed = (event) => {
    away = false;
    inside = isHere(event);
  };
  /** @param {Event} event */
  const focused = (event) => {
    if (!away) inside = isHere(event);
  };
  /** @param {Event} event */
  const left = (event) => {
    if (event.target === window) away = true;
  };
  document.addEventListener('pointerdown', pressed, { capture: true });
  document.addEventListener('keydown', pressed, { capture: true });
  document.addEventListener('focusin', focused, { capture: true });
  window.addEventListener('blur', left);
  body.addEventListener('pointerenter', () => {
    pointerInside = true;
  });
  body.addEventListener('pointerleave', () => {
    pointerInside = false;
  });
  // Clicking in the window, typing in it or moving focus into it reads it. Hovering over it or
  // scrolling it does not: what is unread stays so until the user comes into the window. Both
  // still use the window, which keeps its session awake. A shortcut held with ⌘, Ctrl or Alt
  // (⌘K, ⌘-Tab to another app) or a modifier on its own types nothing here: it reads nothing.
  body.addEventListener('pointerdown', read, { passive: true });
  body.addEventListener('keydown', (event) => {
    if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key !== 'Shift') read();
  });
  body.addEventListener('focusin', () => {
    if (!away) read();
  });
  for (const type of ['pointermove', 'wheel']) body.addEventListener(type, seen, { passive: true });

  function schedule() {
    if (frame || destroyed) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!destroyed) render();
    });
  }

  /** @param {string} next @param {() => HTMLElement[]} build */
  function show(next, build) {
    if (mode === next) return;
    mode = next;
    root.replaceChildren(...build());
  }

  function render() {
    const status = daemon.status();
    const p = params();
    ctx.setLabel(p.name);
    if (view && !view.shows(p)) {
      view.destroy();
      view = null;
      ctx.setUnread(false);
    }
    if (!view && status !== 'open') {
      mode = null; // the status text changes with the status: always redraw it
      return show('status', () => statusScreen(status));
    }
    if (!p.session && !p.sessionFile) return p.fork ? show(`fork:${p.fork}`, forkScreen) : show('setup', setupScreen);
    if (!view) {
      mode = null;
      view = createSessionView();
    }
    show(`view:${view.id}`, () => [view?.root ?? el('div')]);
    view.update();
    if (focusNext) {
      focusNext = false;
      view.focus();
    }
  }

  /** @param {string} status */
  function statusScreen(status) {
    const box = el('div', 'omp-center');
    if (status === 'unauthorized') {
      box.append(
        el('p', 'omp-error', REFUSED),
        el('p', 'omp-muted', 'Open the URL printed by `bun start` to authorise this browser.'),
      );
    } else if (status === 'down') {
      box.append(el('p', 'omp-error', 'Daemon not reachable.'), el('p', 'omp-muted', 'Start it with `bun start`; this pane reconnects by itself.'));
    } else {
      box.append(el('p', 'omp-muted', 'Connecting to the daemon…'));
    }
    return [box];
  }

  function setupScreen() {
    const form = el('form', 'omp-setup');
    const label = el('label', 'omp-label', 'Directory');
    const input = el('input', 'omp-field');
    input.type = 'text';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.placeholder = '~/code/project';
    input.id = `omp-cwd-${Math.random().toString(36).slice(2)}`;
    label.htmlFor = input.id;
    // Folders are suggested as the path is typed, read as the daemon reads a new session's
    // directory (relative to home); an empty field lists home's own folders.
    const suggestions = createSuggestions();
    const folders = createFileSuggest({
      draft: input,
      syntax: PLAIN_PATH,
      foldersOnly: true,
      // Enter starts omp in the folder typed; it takes a suggestion only once the arrows picked one.
      enter: 'moved',
      list: suggestions,
      listDir: (dir) => daemon.listFiles(dir),
      replace: (start, end, text) => input.setRangeText(text, start, end, 'end'),
    });
    input.addEventListener('focus', () => folders.update());
    input.addEventListener('input', () => folders.update());
    input.addEventListener('blur', () => folders.close());
    input.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (suggestions.key(e)) {
        // Enter takes the folder and closes the list, so the next Enter starts omp; Tab and a
        // click go on into the folder's own folders.
        if (e.key === 'Enter') folders.close();
      } else if (e.key === 'Escape' && suggestions.open) {
        e.preventDefault();
        folders.close();
      }
    });
    const cwd = params().cwd;
    if (cwd) input.value = cwd;
    else {
      // The default can arrive while the user is typing: never write over what they typed,
      // and select the default so that typing replaces it instead of appending to it.
      let typed = false;
      input.addEventListener('input', () => (typed = true), { once: true });
      daemon
        .config()
        .then((c) => {
          if (typed || input.value) return;
          input.value = c.defaultCwd;
          input.select(); // kept when the field is focused later
          folders.update();
        })
        .catch(() => {});
    }
    const start = el('button', 'btn btn-accent', 'Start agent');
    start.type = 'submit';
    const error = el('p', 'omp-error');
    error.hidden = true;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const dir = input.value.trim();
      // One agent at a time: a second Enter, or a recent directory clicked, while one starts does nothing.
      if (!dir || start.disabled) return;
      folders.close();
      start.disabled = true;
      error.hidden = true;
      daemon
        .createSession({ cwd: dir })
        .then((meta) => {
          ctx.setParams({ session: meta.id, cwd: meta.cwd, sessionFile: null });
          // The folder picked, the prompt comes next: its box takes the focus from the form.
          focusNext = true;
          schedule();
        })
        .catch((err) => {
          error.textContent = errorMessage(err);
          error.hidden = false;
        })
        .finally(() => {
          start.disabled = false;
        });
    });
    // The directories of the latest conversations, each a click from starting there, as the form
    // would with it typed. They arrive after the form is drawn, into a strip whose height is kept
    // from the start, so nothing moves and the field keeps the focus; without any, it stays empty.
    const recent = el('div', 'omp-recent');
    Promise.all([daemon.config(), daemon.history()])
      .then(([c, past]) => {
        const dirs = recentDirs(listConversations(past, daemon.sessions(), { searching: false, directory: null }));
        if (!dirs.length) return;
        recent.setAttribute('role', 'group');
        recent.setAttribute('aria-label', 'Recent directories');
        const title = el('span', 'omp-label', 'Recent');
        title.setAttribute('aria-hidden', 'true');
        recent.append(
          title,
          ...dirs.map((dir) => {
            const shown = tildeHome(dir, c.home);
            const pick = button('omp-tool-btn omp-recent-dir', shown, () => {
              input.value = dir;
              form.requestSubmit();
            });
            pick.title = dir;
            pick.setAttribute('aria-label', `Start an agent in ${shown}`);
            return pick;
          }),
        );
      })
      .catch(() => {});
    // The list drops down over what is below the field, so nothing moves as it opens and closes.
    const field = el('div', 'omp-setup-field');
    field.append(input, suggestions.root);
    const row = el('div', 'omp-row');
    row.append(field, start);
    form.append(el('p', 'omp-setup-title', 'Start an agent'), label, row, recent, error);
    queueMicrotask(() => input.focus());
    return [form];
  }

  /**
   * Forks `params.fork` right away, with the message dragged off another pane's Send for the
   * daemon to send once the fork is up (daemon/forks.js); on failure offers to retry or start
   * fresh (the message then waits in the new conversation's box).
   */
  function forkScreen() {
    const { fork, cwd } = params();
    const box = el('div', 'omp-center');
    const status = el('p', 'omp-muted', 'Forking session…');
    box.append(status);
    if (!fork) return [box];
    const actions = el('div', 'omp-row');
    actions.hidden = true;
    const attempt = () => {
      status.className = 'omp-muted';
      status.textContent = 'Forking session…';
      actions.hidden = true;
      const { prompt } = params();
      daemon
        .createSession({ cwd: cwd ?? '~', fork, ...(prompt ? { prompt } : {}) })
        .then((meta) => {
          // A fork's own journal is not known until omp reports it; update() saves it then.
          ctx.setParams({ session: meta.id, cwd: meta.cwd, sessionFile: meta.sessionFile, fork: null, prompt: null });
          schedule();
        })
        .catch((err) => {
          status.className = 'omp-error';
          status.textContent = `Could not fork: ${errorMessage(err)}`;
          actions.hidden = false;
        });
    };
    const retry = button('btn btn-accent', 'Try again', attempt);
    const fresh = button('btn', 'New session', () => {
      ctx.setParams({ fork: null });
      schedule();
    });
    actions.append(retry, fresh);
    box.append(actions);
    attempt();
    return [box];
  }

  /** @param {string} cwd */
  function shortCwd(cwd) {
    const display = tildeHome(cwd, home);
    const parts = display.split('/').filter(Boolean);
    return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : display;
  }

  /** The running session that holds journal `file`, if one does. @param {string | null} file */
  const holding = (file) => (file && daemon.sessions().find((m) => isRunning(m) && m.sessionFile === file)?.id) ?? null;

  /**
   * The conversation the window's params name: awake (a session's events) or asleep (its
   * journal), and woken by what needs omp.
   * @typedef {{ id: number, root: HTMLElement, shows(p: OmpParams): boolean, update(): void, focus(): void, read(): void, seen(): void, destroy(): void }} SessionView
   * @returns {SessionView}
   */
  function createSessionView() {
    const state = createTranscript();
    const started = params();
    /** The session whose events the window shows, or null while it shows the journal. @type {string | null} */
    let session = null;
    /** The conversation's journal, as the window was given it or omp has reported it. */
    let file = started.sessionFile;
    /** What the journal said of the conversation, while asleep. @type {{ id: string, cwd: string | null, archived: boolean } | null} */
    let asleep = null;
    /** Waking the conversation: resolves with the session once it is ready. @type {Promise<string> | null} */
    let waking = null;
    let unsubscribe = () => {};
    /**
     * When the session last waited on its user (omp/activity.js) as they were looking at the
     * window (`reading`), and the last mark this window read.
     */
    let readLive = 0;
    let readSent = -Infinity;
    let seenAt = -Infinity;
    let closed = false;
    const ompId = () => (session ? daemon.meta(session)?.ompId : null) ?? asleep?.id ?? null;
    /** When the conversation became unread, unless this window has read that already. */
    const unreadSince = () => {
      const since = daemon.unreadSince(ompId());
      return since !== null && since > readSent ? since : null;
    };
    function markRead() {
      const id = ompId();
      const since = unreadSince();
      if (id === null || since === null) return;
      readSent = since;
      ctx.setUnread(false);
      daemon.markRead(id, since).catch(() => {});
    }
    /** omp's last request to fill the box that was carried out (none is, from replayed history). */
    let editorSeen = 0;
    /** @type {Set<string>} */
    const openDetails = new Set();

    // ── skeleton ──
    const node = el('div', 'omp-session');
    const toolbar = el('div', 'omp-toolbar');
    const cwdEl = el('span', 'omp-cwd');
    const modelBtn = toolButton('model…', 'Choose model');
    modelBtn.classList.add('omp-model');
    const thinkingBtn = toolButton('think…', 'Choose thinking level');
    const activity = el('span', 'omp-activity');
    // How far through its todo list the agent is, while a turn runs (omp/todos.js).
    const progressEl = el('span', 'omp-progress');
    const progressBar = el('progress');
    progressBar.setAttribute('aria-label', 'Tasks done');
    const progressCount = el('span', 'omp-progress-count');
    progressEl.append(progressBar, progressCount);
    progressEl.hidden = true;
    const contextEl = el('span', 'omp-meter');
    contextEl.title = 'Context window used';
    const costEl = el('span', 'omp-meter');
    costEl.title = 'Cost of this session';
    const errorBadge = el('span', 'omp-badge-error', 'error');
    const spacer = el('span', 'omp-spacer');
    const newBtn = toolButton('New', 'Start a new conversation in this window (Sessions keeps this one)', 'omp-new');
    // The conversation's forks and the one it was forked from; forks start from `/fork <prompt>`
    // (in the background) or by dragging Send onto the grid (in a new window).
    const forksBtn = toolButton('Forks', FORKS_TITLE, 'omp-forks');
    const prsBtn = toolButton('PRs', 'Pull requests of this repository: click one to review it beside this conversation, or drag it where you want it', 'omp-prs');
    prsBtn.hidden = true; // until GitHub says the directory is in a repository
    // Model providers and accounts omp can use: connect another, or switch.
    const accountsBtn = toolButton('Accounts', 'Connect a model provider or another account', 'omp-accounts');
    const stopBtn = toolButton('Stop', 'Stop the agent and restore queued messages (Esc)', 'omp-stop');
    // Shown only while the session's model has no account signed in to talk to it with.
    const signInBtn = toolButton('Sign in', 'Sign in to a model provider: this conversation’s model needs it');
    toolbar.append(cwdEl, modelBtn, thinkingBtn, activity, progressEl, contextEl, costEl, errorBadge, spacer, signInBtn);
    // Previous/next response: in a long conversation, steps through the agent's answers.
    const navKey = MAC ? '⌘' : 'Ctrl+';
    const prevBtn = navButton('↑', `Previous response (${navKey}↑)`, () => toResponse('previous'));
    const nextBtn = navButton('↓', `Next response (${navKey}↓)`, () => toResponse('next'));
    // The conversation's own controls go in the window's top bar, for as long as it is shown.
    ctx.headActions.replaceChildren(prevBtn, nextBtn, newBtn, forksBtn, prsBtn, accountsBtn, stopBtn);

    const strip = el('div', 'omp-strip');
    const loginStrip = el('div', 'omp-login');
    const banner = el('div', 'omp-banner');
    const transcript = el('div', 'omp-transcript');
    transcript.setAttribute('role', 'log');
    transcript.setAttribute('aria-live', 'polite');
    // Follow new output only while the reader is at the bottom; scrolling up stops it.
    let stickToBottom = true;
    transcript.addEventListener('scroll', () => {
      stickToBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < BOTTOM_SLACK_PX;
    });
    const pinToBottom = () => {
      if (stickToBottom) transcript.scrollTop = transcript.scrollHeight;
    };
    // Heights keep changing after a draw: the dialogs, queue and composer below resize the
    // transcript, and fonts or expanded blocks reflow items. Re-pin whenever either moves.
    const resizes = new ResizeObserver(pinToBottom);
    resizes.observe(transcript);
    /**
     * Scrolls the transcript so the previous or next response starts at its top, or to its very
     * top or bottom when there is none (omp/response-nav.js). Going up stops following new
     * output at once, before the next draw re-pins; reaching the bottom follows it again.
     * @param {'previous' | 'next'} direction
     */
    function toResponse(direction) {
      const origin = transcript.getBoundingClientRect().top + transcript.clientTop - transcript.scrollTop;
      /** @type {number[]} */
      const tops = [];
      for (const item of state.items) {
        const at = item.kind === 'assistant' && isResponse(item) ? drawn.get(item.key)?.node : null;
        if (at?.isConnected) tops.push(at.getBoundingClientRect().top - origin);
      }
      const max = transcript.scrollHeight - transcript.clientHeight;
      const target = responseTarget(tops, transcript.scrollTop, max, direction);
      stickToBottom = target >= max;
      transcript.scrollTop = stickToBottom ? transcript.scrollHeight : target;
    }
    // ⌘↑ / ⌘↓ (Ctrl elsewhere) anywhere in the window, the message box too, where they would
    // move its caret to the start or end; an open suggestion list keeps its arrows.
    /** @param {KeyboardEvent} e */
    const onNavKey = (e) => {
      if (e.defaultPrevented || e.isComposing || e.shiftKey || e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
      if (MAC ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      toResponse(e.key === 'ArrowUp' ? 'previous' : 'next');
    };
    node.addEventListener('keydown', onNavKey);
    ctx.headActions.addEventListener('keydown', onNavKey);
    const dialogs = el('div', 'omp-dialogs');
    const queue = el('div', 'omp-queue');
    const running = el('div', 'omp-running');
    running.hidden = true;
    const suggestions = createSuggestions();
    const composer = createComposer({
      pane: node,
      upload: (file, name) => daemon.uploadAttachment(file, name),
      onError: (text) => {
        addNote(state, 'error', 'attach', text);
        schedule();
      },
      shellDir: () => ({ label: tildeHome(cwd(), home), path: cwd() }),
      // Kept for the conversation; while rewinding, what the box held before (see `rewind`).
      onChange: () => keepDraft(),
    });
    const { draft, sendBtn } = composer;
    const selectionPopup = attachSelectionPopup({
      host: node,
      transcript,
      listDir: listMentioned,
      onComment: (quote, comment) => {
        composer.addComment(quote, comment);
        draft.focus();
      },
      // Side questions go to omp's `btw`: answered from the session's context, never added to it.
      ask: {
        async send(quote, question, topic) {
          const command = topic === undefined ? { type: 'btw', question: composeAsk(quote, question) } : { type: 'btw', question: composeFollowUp(question), recordId: topic };
          try {
            const res = await daemon.rpc(await wake(), command);
            const record = res.success ? res.data?.record : null;
            if (typeof record?.id !== 'string') return { error: res.error ?? 'The agent did not take the question.' };
            // omp's record is the topic's first turn; the question just taken is its newest.
            return { id: record.id, turn: Array.isArray(record.followUps) ? record.followUps.length : 0 };
          } catch (err) {
            return { error: errorMessage(err) };
          }
        },
        answers: (id) => state.sideAnswers.get(id),
        cancel: (id) => void (session && daemon.rpc(session, { type: 'btw_cancel', recordId: id }).catch(() => {})),
      },
    });
    node.append(toolbar, strip, loginStrip, banner, transcript, dialogs, running, queue, suggestions.root, composer.root);
    const highlight = attachDragHighlight({ host: node, transcript, enabled: () => settings.get().animatedSelection });
    const offHighlight = settings.subscribe(() => highlight.refresh());
    // A click on the pane that is not on a control, in a dialog omp asked for or in the
    // selection popup puts the caret in the message box, as in a terminal.
    focusOnClick(node, draft, '.omp-dialogs, .omp-quote-pop');

    const meta = () => (session ? daemon.meta(session) : null);
    const ready = () => meta()?.status === 'ready';
    /** The conversation's directory: where omp runs, and where `!` commands run. */
    const cwd = () => params().cwd ?? meta()?.cwd ?? asleep?.cwd ?? '';
    /**
     * Whether omp has this conversation on disk, so it can be resumed or forked: read from its
     * journal, or a journal the session started from, or omp wrote a new one's as the model replied.
     */
    const saved = () => asleep !== null || Boolean(meta()?.resume || meta()?.fork) || state.items.some((i) => i.kind === 'assistant' && i.ended);
    const forkable = () => Boolean(file) && saved();

    // ── awake or asleep ──
    /**
     * Shows session `id`'s events from the start: its history is the first thing in them (the
     * daemon fetched it), so whatever the window showed before is replaced.
     * @param {string} id
     */
    function follow(id) {
      unsubscribe();
      session = id;
      asleep = null;
      Object.assign(state, createTranscript());
      clearDrawn();
      let live = false;
      editorSeen = 0;
      unsubscribe = daemon.subscribe(id, (event) => {
        applyEvent(state, event);
        // History, replayed now or (from a stream reopened for it) a moment later: requests to
        // fill the box in it were carried out already, and it is no news to read live. News is
        // read as it lands under its reader's eyes. News that landed while they were elsewhere,
        // the history included, waits for them to come into the window, even once they are
        // looking at it again.
        if (!live || daemon.replayed(event)) editorSeen = Math.max(editorSeen, state.editorText?.seq ?? 0);
        else if (reading()) readLive = awaitedAfter(readLive, event);
        schedule();
      });
      live = true;
      if (params().session !== id) ctx.setParams({ session: id });
      schedule();
    }

    /** Shows the conversation from its journal; one never saved (nothing was said) is no conversation: New. */
    function load() {
      const want = file;
      if (!want) return;
      daemon
        .conversation(want)
        .then((conversation) => {
          if (closed || session !== null || file !== want) return;
          asleep = { id: conversation.id, cwd: conversation.cwd, archived: conversation.archived === true };
          seedConversation(state, conversation);
          schedule();
        })
        .catch((err) => {
          if (closed || session !== null || file !== want) return;
          if (err instanceof DaemonError && err.status === 404) {
            ctx.setParams({ session: null, sessionFile: null, name: null });
            return schedule();
          }
          addNote(state, 'error', 'conversation', errorMessage(err));
          schedule();
        });
    }

    /**
     * The session holding the conversation, once it is ready: this one (still starting, perhaps),
     * the one another window woke, or a new one resuming the journal (or, for a conversation omp
     * never saved, a new one in its directory). Rejects when omp cannot start.
     * @returns {Promise<string>}
     */
    function wake() {
      if (ready() && session) return Promise.resolve(session);
      waking ??= (async () => {
        const own = meta();
        const running = own && isRunning(own) ? own.id : holding(file);
        const id = running ?? (await daemon.createSession(file && saved() ? { cwd: cwd() || '~', resume: file } : { cwd: cwd() || '~' })).id;
        if (id !== session) follow(id);
        await untilReady(id);
        return id;
      })().finally(() => {
        waking = null;
        schedule();
      });
      schedule();
      return waking;
    }

    /** Resolves once session `id` is ready; rejects if it ends first. @param {string} id @returns {Promise<void>} */
    const untilReady = (id) =>
      new Promise((resolve, reject) => {
        let settled = false;
        let off = () => {};
        off = daemon.subscribe(id, (event) => {
          if (settled || event.kind !== 'session' || event.meta.status === 'starting') return;
          settled = true;
          off();
          if (event.meta.status === 'ready') resolve();
          else reject(new Error(event.meta.error ?? 'The agent exited before it was ready'));
        });
        if (settled) off(); // settled during the synchronous replay, before `off` was assigned
      });

    // ── commands ──
    /**
     * Sends one omp command, waking the conversation first. Failed answers are surfaced by the
     * transcript (they come back through the stream); a transport failure becomes a note here.
     * @param {Record<string, unknown>} command @returns {Promise<RpcResponse | null>}
     */
    async function rpc(command) {
      try {
        return await daemon.rpc(await wake(), command);
      } catch (err) {
        addNote(state, 'error', String(command.type), errorMessage(err));
        schedule();
        return null;
      }
    }

    // ── rewind ──
    // Rewind on one of the user's prompts puts it back in the box to reword, and marks what
    // sending would set aside; nothing reaches omp until then, so Undo (or Esc) only puts the
    // box back. Sending rewinds omp to just before the prompt (`branch`, which keeps the old
    // path in the journal) and sends the box as the prompt in its place.
    /** The prompt this window is rewinding to (`key` as the transcript has it now), and the box as it was before. @type {{ key: string, point: import('../omp/rewind.js').RewindPoint, draft: string } | null} */
    let rewind = null;

    // ── the unsent message, kept for the conversation (omp/drafts.js) ──
    const draftKey = () => conversationKey({ sessionFile: file, session: session ?? started.session });
    /** Keeps what the box holds; while rewinding, what it held before (see `rewind`). */
    function keepDraft() {
      const key = draftKey();
      if (key) writeDraft(key, rewind ? { ...composer.kept, text: rewind.draft } : composer.kept);
    }
    const kept = draftKey();
    if (kept) composer.load(readDraft(kept));

    const rewindBar = el('div', 'omp-rewind-bar');
    rewindBar.setAttribute('role', 'status');
    const rewindText = el('span', 'omp-rewind-text');
    rewindBar.append(rewindText, button('btn omp-rewind-undo', 'Undo', () => undoRewind()));
    /** Sends waiting for the transcript to be replaced after a rewind (`state.rewinds` passing `after`). @type {Array<{ after: number, resolve: () => void }>} */
    let reseedWaiters = [];

    transcript.addEventListener('click', (e) => {
      const target = /** @type {Element} */ (e.target).closest?.('.omp-rewind-btn');
      const key = /** @type {HTMLElement | null} */ (target?.closest('.omp-user'))?.dataset.key;
      if (key) startRewind(key);
    });

    /** @param {string} key */
    function startRewind(key) {
      if (state.streaming) return;
      const point = rewindPoint(state.items, key);
      if (!point) return;
      // Picking another prompt keeps the box as it was before the first.
      rewind = { key, point, draft: rewind?.draft ?? draft.value };
      composer.setText(point.text);
      hideSuggestions();
      draft.focus();
      schedule();
    }

    function undoRewind() {
      if (!rewind) return;
      composer.setText(rewind.draft);
      rewind = null;
      draft.focus();
      schedule();
    }

    /**
     * The prompt being rewound to, as the transcript has it now: found again by its place and
     * text when the transcript was replaced. Gone (another window rewound past it), the rewind
     * is over: there is nothing left to rewind to here.
     */
    function rewindKey() {
      if (rewind && !rewindPoint(state.items, rewind.key)) {
        const key = pointKey(state.items, rewind.point);
        if (key) rewind.key = key;
        else rewind = null;
      }
      return rewind?.key ?? null;
    }

    /** Marks the prompt being rewound to and dims what sending would set aside. */
    function drawRewind() {
      for (const n of transcript.querySelectorAll('.is-set-aside')) n.classList.remove('is-set-aside');
      rewindBar.remove();
      const key = rewindKey();
      const point = key && rewindPoint(state.items, key);
      const at = key && drawn.get(key)?.node;
      if (!point || !at) return;
      rewindText.textContent = `Rewinding here: sending sets aside ${point.setAside} prompt${point.setAside === 1 ? '' : 's'} and what followed`;
      for (let n = /** @type {Element | null} */ (at); n; n = n.nextElementSibling) n.classList.add('is-set-aside');
      transcript.insertBefore(rewindBar, at);
    }

    /**
     * Rewinds omp to just before the prompt `key`, once omp's conversation is the one this
     * window shows; resolves once the transcript has been replaced, so the prompt sent next
     * lands after it. False, with a note why, when it did not rewind.
     * @param {string} key @returns {Promise<boolean>}
     */
    async function applyRewind(key) {
      const point = rewindPoint(state.items, key);
      const listed = point && (await rpc({ type: 'get_branch_messages' }));
      if (!point || !listed?.success) return false;
      const entryId = branchEntry(listed.data?.messages ?? [], point);
      if (!entryId) {
        addNote(state, 'error', 'rewind', 'Not rewound, and nothing sent: the agent’s conversation no longer matches this window’s.');
        schedule();
        return false;
      }
      const after = state.rewinds;
      const res = await rpc({ type: 'branch', entryId });
      if (!res?.success) return false;
      rewind = null;
      keepDraft();
      if (state.rewinds === after) await new Promise((resolve) => reseedWaiters.push({ after, resolve: () => resolve(undefined) }));
      return true;
    }

    async function send() {
      // `/fork <prompt>` is the workbench's: a fork of this conversation, in the background.
      const forking = forkPrompt(draft.value);
      if (forking !== null) return forkInBackground(forking);
      // `/command` and `!shell` go as typed; comments and attachments wait for the next prompt.
      const command = isCommand(draft.value);
      // A bare `!` names no command: leave it in the box rather than run nothing.
      if (shellCommand(draft.value) === '') return;
      // A file dropped a moment ago may still be on its way to the daemon: send it too.
      if (!command) await composer.settled();
      // Asleep, the message waits in the box while the conversation wakes, then goes.
      if (!ready()) {
        try {
          await wake();
        } catch (err) {
          addNote(state, 'error', 'wake', `The agent did not start: ${errorMessage(err)}`);
          return schedule();
        }
      }
      const outgoing = composer.compose({ withCards: !command });
      const text = outgoing.message;
      if (!text) return;
      // A command runs as it would anyway; the rewind waits for a prompt.
      const rewindTo = command ? null : rewindKey();
      if (rewindTo && state.streaming) {
        addNote(state, 'error', 'rewind', 'Not rewound, and nothing sent: the agent is working. Stop it first, or Undo.');
        return schedule();
      }
      const taken = outgoing.take();
      hideSuggestions();
      if (rewindTo && !(await applyRewind(rewindTo))) return taken.restore();
      const shell = shellCommand(text);
      // A bare `.` goes as omp's continue directive, a steer like any message while a turn
      // runs: the agent carries on with what it was doing instead of answering a prompt.
      const message = outgoingPrompt(text);
      /** @type {Record<string, unknown>} */
      const request =
        shell !== null
          ? { type: 'bash', command: shell }
          : state.streaming
            ? { type: 'prompt', message, streamingBehavior: 'steer' }
            : { type: 'prompt', message };
      void rpc(request).then((res) => {
        // Give it all back if omp refused it and nothing new has been written since.
        if ((!res || !res.success) && !leaving) taken.restore();
      });
    }

    /**
     * `/fork <prompt>`: starts a fork of this conversation that gets `prompt` (with the comment
     * and file cards) once it is up, without a window of its own; Forks lists it, and a desktop
     * notification (if on) tells when it is done. The daemon forks a working conversation as of
     * its last completed response.
     * @param {string} prompt
     */
    async function forkInBackground(prompt) {
      hideSuggestions();
      if (!forkable()) {
        addNote(state, 'error', 'fork', `Not forked. ${NOTHING_TO_FORK}.`);
        return schedule();
      }
      await composer.settled();
      const outgoing = composer.compose({ withCards: true, draft: () => prompt });
      if (!outgoing.message) {
        addNote(state, 'error', 'fork', 'Not forked: say what the fork should do, as in /fork try the other approach.');
        return schedule();
      }
      const taken = outgoing.take();
      try {
        await daemon.createSession({ cwd: cwd() || '~', fork: /** @type {string} */ (file), prompt: outgoing.message });
        addNote(state, 'info', 'fork', 'Forked in the background with that prompt: Forks lists it.');
      } catch (err) {
        if (!leaving) taken.restore();
        addNote(state, 'error', 'fork', `Not forked: ${errorMessage(err)}`);
      }
      schedule();
    }

    async function stop() {
      if (!ready() || !state.streaming) return;
      const res = await rpc({ type: 'abort_and_restore_queue' });
      if (!res?.success) return;
      /** @type {Array<{ text?: unknown }>} */
      const restored = [...(res.data?.steering ?? []), ...(res.data?.followUp ?? [])];
      const texts = restored.map((m) => str(m?.text)).filter((t) => t !== null).map((t) => (isContinueDirective(t) ? '.' : t));
      if (texts.length) {
        composer.setText([...texts, draft.value].filter(Boolean).join('\n\n'));
        draft.focus();
      }
    }

    // ── menus (model, thinking, login) ──
    /**
     * Gives `anchor` a popover menu of what `load` lists, loaded afresh each time it opens.
     * @param {HTMLButtonElement} anchor @param {() => Promise<MenuEntry[]>} load
     * @param {{ filter?: boolean, className?: string, empty?: string }} [options] `className` places it (a top-bar menu); `empty` says why nothing is listed
     */
    function attachMenu(anchor, load, options = {}) {
      const menu = el('div', `omp-menu${options.className ? ` ${options.className}` : ''}`);
      menu.popover = 'auto';
      anchor.popoverTargetElement = menu;
      const isOpen = () => menu.matches(':popover-open');
      menu.addEventListener('toggle', (event) => {
        if (/** @type {ToggleEvent} */ (event).newState !== 'open') return menu.replaceChildren();
        menu.replaceChildren(el('p', 'omp-muted', 'Loading…'));
        load()
          .then((entries) => {
            if (!isOpen()) return;
            const list = el('div', 'omp-menu-list');
            const filter = el('input', 'omp-field');
            const fill = () => {
              const q = filter.value.trim().toLowerCase();
              list.replaceChildren(
                ...entries
                  .filter((e) => !q || e.label.toLowerCase().includes(q) || e.detail?.toLowerCase().includes(q))
                  .map((entry) => {
                    const item = button(`omp-menu-item${entry.current ? ' is-current' : ''}`);
                    item.append(el('span', '', entry.label));
                    if (entry.detail) item.append(el('span', 'omp-muted', entry.detail));
                    item.addEventListener('click', () => {
                      menu.hidePopover();
                      entry.pick();
                    });
                    if (entry.drag) {
                      const drag = entry.drag;
                      item.addEventListener('pointerdown', (e) => {
                        if (e.button === 0) drag(e, () => menu.hidePopover());
                      });
                    }
                    return item;
                  }),
              );
              if (!list.childElementCount) list.append(el('p', 'omp-muted omp-menu-empty', q ? 'Nothing to choose.' : (options.empty ?? 'Nothing to choose.')));
            };
            menu.replaceChildren();
            if (options.filter) {
              filter.type = 'search';
              filter.placeholder = 'Filter';
              filter.addEventListener('input', fill);
              // Esc closes the menu at once, where a search field would first clear itself.
              filter.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') menu.hidePopover();
              });
              menu.append(filter);
              filter.focus();
            }
            fill();
            menu.append(list);
          })
          .catch((err) => {
            if (isOpen()) menu.replaceChildren(el('p', 'omp-error', errorMessage(err)));
          });
      });
      anchor.after(menu);
    }

    /** @param {Record<string, unknown>} command @param {string} key */
    async function listFrom(command, key) {
      const res = await rpc(command);
      if (!res) throw new Error('daemon not reachable');
      if (!res.success) throw new Error(res.error ?? `${command.type} failed`);
      const list = res.data?.[key];
      return Array.isArray(list) ? list : [];
    }

    attachMenu(
      modelBtn,
      async () =>
        (await listFrom({ type: 'get_available_models' }, 'models')).map((m) => ({
          label: String(m?.name ?? m?.id ?? '?'),
          detail: `${m?.provider}/${m?.id}`,
          current: m?.provider === state.session.model?.provider && m?.id === state.session.model?.id,
          pick: () => void rpc({ type: 'set_model', provider: m?.provider, modelId: m?.id }),
        })),
      { filter: true },
    );

    attachMenu(thinkingBtn, async () =>
      (await listFrom({ type: 'get_available_thinking_levels' }, 'levels')).map((level) => ({
        label: String(level),
        current: level === state.session.thinkingLevel,
        pick: () => void rpc({ type: 'set_thinking_level', level }),
      })),
    );

    const loginProviders = async () =>
      (await listFrom({ type: 'get_login_providers' }, 'providers'))
        .filter((p) => p?.available !== false)
        .map((p) => ({
          label: String(p?.name ?? p?.id),
          detail: p?.authenticated ? '✓ logged in' : undefined,
          current: Boolean(p?.authenticated),
          pick: () => void rpc({ type: 'login', providerId: p?.id }),
        }));
    attachMenu(signInBtn, loginProviders, { filter: true });
    attachMenu(accountsBtn, loginProviders, { filter: true, className: 'omp-head-menu' });

    // ── pull requests of the conversation's repository (widgets/github.js) ──
    /** The conversation, for a pull request window reviewing for it. */
    const asTarget = () => ({ sessionFile: file, session, cwd: cwd() });
    /** Where a pull request of the conversation's repository is. @param {import('../../daemon/wire.js').PullSummary} pull */
    const placeOf = (pull) => ({ repo: pullOfUrl(pull.url)?.repo ?? null, cwd: cwd() });
    /** @param {import('../../daemon/wire.js').PullSummary} pull */
    function openPull(pull) {
      const at = placeOf(pull);
      const open = ctx.screen
        .get()
        .windows.find((w) => w.widget === 'github' && w.params?.number === pull.number && (at.repo ? w.params?.repo === at.repo : w.params?.cwd === at.cwd));
      if (open) {
        // Already beside it: point at it rather than open it twice.
        ctx.outline([open.id]);
        setTimeout(() => ctx.outline([]), 1500);
        return;
      }
      ctx.openBeside('github', pullParams(at, pull, asTarget()));
    }
    // Pull requests the conversation links or refers to (`#123`: of its directory's repository)
    // drag out of the transcript as pull request windows, and a click opens one on GitHub.
    const offPullDrag = attachPullDrag({ root: transcript, ctx, base: () => (cwd() ? { repo: githubRepo, cwd: cwd() } : null), parent: asTarget });
    // Text files the conversation names (relative ones in its directory) open in a file window.
    const offFileRefs = attachFileRefs({ root: transcript, ctx, cwd: () => cwd() || null });
    attachMenu(
      prsBtn,
      async () => {
        const found = await daemon.pulls({ cwd: cwd() || '~' });
        if (!found.connected) throw new Error(found.reason);
        return found.pulls.map((pull) => ({
          label: `#${pull.number} ${pull.title}`,
          detail: `${pull.isDraft ? 'draft' : pull.state.toLowerCase()} · ${pull.author}`,
          pick: () => openPull(pull),
          drag: (e, close) =>
            ctx.dragWidget('github', pullParams(placeOf(pull), pull, asTarget()), e, {
              label: `#${pull.number} ${pull.title}`,
              onEnd: ({ dropped }) => dropped && close(),
            }),
        }));
      },
      { filter: true, className: 'omp-head-menu' },
    );
    /** The directory GitHub was last asked about, so it is asked once per directory. */
    let githubCwd = '';
    /** The GitHub repository (`owner/name`) that directory is in, once GitHub has said. @type {string | null} */
    let githubRepo = null;
    function checkGithub() {
      const dir = cwd();
      if (!dir || dir === githubCwd) return;
      githubCwd = dir;
      githubRepo = null;
      daemon
        .pulls({ cwd: dir })
        .then((found) => {
          if (!closed && githubCwd === dir) prsBtn.hidden = !found.connected;
        })
        .catch(() => {});
      daemon
        .repos(dir)
        .then((found) => {
          if (githubCwd === dir && found.connected) githubRepo = found.repo;
        })
        .catch(() => {});
    }

    stopBtn.addEventListener('click', () => void stop());

    // ── forks (daemon/forks.js): the conversation this one was forked from, and its own ──
    /** Shows a conversation beside this window, or points at the window already showing it. @param {LeafParams} shown */
    function openRelative(shown) {
      const open = ctx.screen
        .get()
        .windows.find((w) => w.widget === 'omp' && ((shown.sessionFile && w.params?.sessionFile === shown.sessionFile) || (shown.session && w.params?.session === shown.session)));
      if (open) {
        ctx.outline([open.id]);
        setTimeout(() => ctx.outline([]), 1500);
        return;
      }
      ctx.openBeside('omp', shown);
    }
    attachMenu(
      forksBtn,
      async () => {
        const forks = daemon.forks();
        const { parent, children } = relatives(forks, ompId());
        if (!parent && !children.length) return [];
        const past = new Map((await daemon.history()).map((s) => [s.id, s]));
        /** @type {Map<string, SessionMeta>} */
        const awake = new Map(daemon.sessions().flatMap((m) => (m.ompId && isRunning(m) ? [[m.ompId, m]] : [])));
        /** @param {string} id @param {string} relation @returns {MenuEntry[]} */
        const entry = (id, relation) => {
          const listed = past.get(id) ?? null;
          const meta = awake.get(id) ?? null;
          if (!listed && !meta) return []; // deleted or archived since
          // A fork by the title the daemon keeps for it: its journal's is its source's until
          // its first prompt has named it.
          const name = Object.hasOwn(forks, id) ? (forks[id].title ?? 'Fork, not named yet') : (listed?.title ?? listed?.firstPrompt ?? null);
          const label = name ?? 'Untitled';
          const shown = showConversation({ file: listed?.file ?? null, meta, cwd: listed?.cwd ?? null, name: Object.hasOwn(forks, id) ? forks[id].title : name });
          const unread = daemon.unreadSince(id) !== null;
          return [
            {
              label,
              detail: [relation, meta ? (meta.status === 'starting' ? 'starting' : 'awake') : null, unread ? 'unread' : null].filter(Boolean).join(' · '),
              // Shown on purpose, as from Sessions: that reads it.
              pick: () => {
                openRelative(shown);
                const since = daemon.unreadSince(id);
                if (since !== null) daemon.markRead(id, since).catch(() => {});
              },
              drag: (e, close) => ctx.dragWidget('omp', shown, e, { label, onEnd: ({ dropped }) => dropped && close() }),
            },
          ];
        };
        return [...(parent ? entry(parent, 'forked from') : []), ...children.flatMap((child) => entry(child, 'fork'))];
      },
      { className: 'omp-head-menu', empty: NO_FORKS },
    );
    newBtn.addEventListener('click', () => {
      // The setup screen starts it, in this conversation's directory unless the user picks another.
      ctx.setParams({ session: null, cwd: cwd() || null, sessionFile: null, name: null, fork: null, prompt: null });
      schedule();
    });
    // Whatever needs omp is about to: start it as the box is reached for, not once it is sent.
    draft.addEventListener('focus', () => {
      if (!ready()) wake().catch(() => {}); // send() says why, if the message cannot go
    });

    // ── composer: `/` commands and `@` files suggested as they are typed ──
    const files = createFileSuggest({
      draft,
      syntax: MENTIONS,
      list: suggestions,
      listDir: listMentioned,
      replace: (start, end, text) => composer.replace(start, end, text),
    });
    const pulls = createPullSuggest({
      draft,
      list: suggestions,
      repos: () => (cwd() ? daemon.repos(cwd()) : Promise.resolve({ connected: false, reason: 'the conversation has no directory yet' })),
      pulls: (repo) =>
        repo ? daemon.pulls({ repo }) : cwd() ? daemon.pulls({ cwd: cwd() }) : Promise.resolve({ connected: false, reason: 'the conversation has no directory yet' }),
      replace: (start, end, text) => composer.replace(start, end, text),
    });

    /** A path in a message names a file in the conversation's directory, unless it says otherwise. @param {string} dir */
    function listMentioned(dir) {
      return daemon.listFiles(/^[~/]/.test(dir) || !cwd() ? dir : `${cwd().replace(/\/$/, '')}/${dir}`);
    }

    function hideSuggestions() {
      files.close();
      pulls.close();
      suggestions.hide();
    }

    /** Suggests what the draft is starting to name: a slash command, a file after `@`, or a pull request after `#`. */
    function updateSuggestions() {
      const match = /^\/(\S*)$/.exec(draft.value);
      if (!match) {
        if (!files.update() && !pulls.update()) suggestions.hide();
        return;
      }
      files.close();
      pulls.close();
      const q = match[1].toLowerCase();
      const starts = (/** @type {SlashCommand} */ c) => [c.name, ...c.aliases].some((n) => n.toLowerCase().startsWith(q));
      const contains = (/** @type {SlashCommand} */ c) => [c.name, ...c.aliases].some((n) => n.toLowerCase().includes(q));
      // `/fork` is the workbench's own (send()): omp's is its terminal UI's only.
      const all = [FORK_COMMAND, ...state.commands.filter((c) => c.name !== 'fork')];
      const commands = [...all.filter(starts), ...all.filter((c) => !starts(c) && contains(c))].slice(0, MAX_SUGGESTIONS);
      suggestions.show(
        commands.map((c) => {
          const cells = [el('span', 'omp-suggestion-name', `/${c.name}`)];
          if (c.aliases.length) cells.push(el('span', 'omp-muted', c.aliases.map((a) => `/${a}`).join(' ')));
          if (c.hint) cells.push(el('span', 'omp-suggestion-hint', c.hint));
          if (c.description) cells.push(el('span', 'omp-suggestion-desc', c.description));
          return { cells, pick: () => complete(c) };
        }),
      );
    }

    /** @param {SlashCommand} command */
    function complete(command) {
      composer.setText(`/${command.name} `);
      hideSuggestions();
      draft.focus();
    }

    const history = createPromptHistory(() => sentPrompts(state.items));
    draft.addEventListener('input', updateSuggestions);
    draft.addEventListener('keydown', (e) => {
      // An open suggestion list takes the arrows, Tab and Enter first; closed, Up and Down
      // step through what was sent, as in omp's own editor (omp/prompt-history.js).
      if (e.isComposing || suggestions.key(e)) return;
      const plain = !(e.shiftKey || e.altKey || e.metaKey || e.ctrlKey);
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && plain && draft.selectionStart === draft.selectionEnd) {
        const older = e.key === 'ArrowUp';
        const text = history.step(older ? 'older' : 'newer', draft.value, draft.selectionStart);
        if (text !== null) {
          e.preventDefault();
          composer.setText(text);
          // Up opens an entry at its top and Down at its bottom, so one press steps one entry.
          const at = older ? 0 : text.length;
          draft.setSelectionRange(at, at);
        }
        return;
      }
      // On a touch screen Enter is a new line, as its keyboard shows it; Send sends.
      if (e.key === 'Enter' && !e.shiftKey && !coarse.matches) {
        e.preventDefault();
        void send();
      } else if (e.key === 'Escape') {
        if (suggestions.open) hideSuggestions();
        else if (rewind) undoRewind();
        else if (state.streaming) void stop();
      }
    });
    sendBtn.addEventListener('click', () => void send());
    // Dragging Send sends the message in a fork instead: a new window, placed where it is
    // dropped, continuing a copy of this conversation (named anew by its first prompt, by the
    // daemon). This box lets go of it once it is placed.
    sendBtn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || sendBtn.disabled || !forkable()) return;
      const forking = forkPrompt(draft.value);
      const outgoing = forking !== null ? composer.compose({ withCards: true, draft: () => forking }) : composer.compose({ withCards: !isCommand(draft.value) });
      const line = outgoing.message.replace(/\s+/g, ' ').trim();
      ctx.dragWidget('omp', { fork: file, cwd: cwd() || null, session: null, sessionFile: null, name: null, prompt: outgoing.message || null }, e, {
        label: line ? `Fork: ${line.length > 40 ? `${line.slice(0, 39)}…` : line}` : 'Fork',
        onEnd: ({ dropped }) => {
          if (!dropped) return;
          outgoing.take();
          hideSuggestions();
        },
      });
    });

    // ── drawing ──
    /** What is drawn, by key: transcript items, and decision reviews (`review:<prompt time>`, `rev` their JSON). @type {Map<string, { rev: number | string, node: HTMLElement }>} */
    const drawn = new Map();
    /** @type {Map<string, HTMLElement>} */
    const dialogNodes = new Map();
    let queueKey = '';
    let runningKey = '';
    /** Ticks the Running line's times while it shows. @type {ReturnType<typeof setInterval> | null} */
    let runningTimer = null;
    let stripKey = '';
    let bannerKey = '';
    let loginKey = '';
    /** Which view `drawn` holds: an item draws differently when only responses show. */
    let drawnOnlyResponses = false;
    /** Stands in for the hidden work of a running turn when only responses show. */
    const workingEl = el('div', 'omp-working');
    workingEl.setAttribute('role', 'status');

    /** Forgets every item drawn, so the next draw builds them all afresh. */
    function clearDrawn() {
      for (const entry of drawn.values()) {
        resizes.unobserve(entry.node);
        entry.node.remove();
      }
      drawn.clear();
    }

    function drawTranscript() {
      rewindBar.remove(); // items are placed by index; drawRewind puts it back
      const { onlyResponses } = settings.get();
      if (onlyResponses !== drawnOnlyResponses) {
        drawnOnlyResponses = onlyResponses;
        clearDrawn();
      }
      // omp's continue directive (a `.` sent) is never shown, in either view.
      const shown = onlyResponses ? promptsAndResponses(state.items, state.streaming) : { items: state.items.filter((i) => i.kind !== 'user' || !i.continues), working: null };
      const live = new Set();
      const itemCtx = { tools: state.tools, open: openDetails };
      /** @type {Array<{ key: string, rev: number | string, render: () => HTMLElement }>} */
      const entries = shown.items.map((item) => ({ key: item.key, rev: item.rev, render: () => renderItem(item, itemCtx) }));
      // Each turn's decision review shows where the turn ends (placed from the last, so the
      // places before it hold); one that found no decisions shows nothing.
      for (const { index, at, review } of placeReviews(shown.items, daemon.decisions(ompId()) ?? {}).reverse()) {
        if (review.status === 'done' && review.decisions.length === 0) continue;
        entries.splice(index, 0, { key: `review:${at}`, rev: JSON.stringify(review), render: () => renderReview(review) });
      }
      entries.forEach(({ key, rev, render }, i) => {
        live.add(key);
        let entry = drawn.get(key);
        if (!entry || entry.rev !== rev) {
          const fresh = render();
          if (entry) {
            resizes.unobserve(entry.node);
            entry.node.replaceWith(fresh);
          }
          resizes.observe(fresh);
          entry = { rev, node: fresh };
          drawn.set(key, entry);
        }
        const at = transcript.children[i];
        if (at !== entry.node) transcript.insertBefore(entry.node, at ?? null);
      });
      for (const [key, entry] of drawn) {
        if (!live.has(key)) {
          resizes.unobserve(entry.node);
          entry.node.remove();
          drawn.delete(key);
        }
      }
      if (shown.working) {
        const { steps } = shown.working;
        workingEl.textContent = steps ? `Working… ${steps} step${steps === 1 ? '' : 's'}` : 'Working…';
        if (transcript.lastElementChild !== workingEl) transcript.append(workingEl);
      } else {
        workingEl.remove();
      }
      transcript.classList.toggle('is-streaming', state.streaming);
      drawRewind();
      pinToBottom();
    }

    function drawDialogs() {
      const ids = new Set(state.dialogs.map((d) => d.id));
      for (const [id, n] of dialogNodes) {
        if (!ids.has(id)) {
          n.remove();
          dialogNodes.delete(id);
        }
      }
      for (const dialog of state.dialogs) {
        if (dialogNodes.has(dialog.id)) continue;
        // The daemon reports the answer as `sent` before it replies, which removes the dialog.
        const n = renderDialog(dialog, (payload) => {
          // A dialog only comes from a session that is awake.
          daemon.respondUi(/** @type {string} */ (session), { type: 'extension_ui_response', id: dialog.id, ...payload }).catch((err) => {
            addNote(state, 'error', 'dialog', errorMessage(err));
            schedule();
          });
        }, listMentioned);
        dialogNodes.set(dialog.id, n);
        dialogs.append(n);
      }
      dialogs.hidden = state.dialogs.length === 0;
    }

    function drawQueue() {
      const key = JSON.stringify(state.queue);
      if (key === queueKey) return;
      queueKey = key;
      /** @param {string} text @param {'steering' | 'followUp'} which */
      const chip = (text, which) => {
        const c = el('span', `omp-chip is-${which}`);
        // A queued continue reads as the `.` it was sent as, not omp's directive.
        const shown = isContinueDirective(text) ? '. (continue)' : text;
        c.append(el('span', 'omp-chip-kind', which === 'steering' ? 'steer' : 'next'), el('span', 'omp-chip-text', shown));
        const remove = button('omp-chip-remove', '×');
        remove.setAttribute('aria-label', `Remove queued message: ${shown}`);
        remove.addEventListener('click', () => void rpc({ type: 'remove_queued_message', message: text, queue: which }));
        c.append(remove);
        return c;
      };
      queue.replaceChildren(...state.queue.steering.map((t) => chip(t, 'steering')), ...state.queue.followUp.map((t) => chip(t, 'followUp')));
      queue.hidden = queue.childElementCount === 0;
    }

    /** The shells and subagents running now, each with how long it has run (omp/running-work.js). */
    function drawRunning() {
      const work = runningWork(state);
      const key = JSON.stringify(work);
      if (key === runningKey) return;
      runningKey = key;
      running.replaceChildren(
        ...(work.length ? [el('span', 'omp-label', 'Running')] : []),
        ...work.map((w) => {
          const c = el('span', `omp-chip is-running${w.background ? ' is-background' : ''}`);
          c.title = `${w.label}\n${w.background ? 'In the background: the agent goes on meanwhile' : 'The agent waits for it'}`;
          const time = el('span', 'omp-chip-time');
          if (w.startedAt !== null) time.dataset.since = String(w.startedAt);
          c.append(el('span', 'omp-chip-kind', w.kind), el('span', 'omp-chip-text', w.label), time);
          return c;
        }),
      );
      running.hidden = work.length === 0;
      tickRunning();
      if (work.length && !runningTimer) runningTimer = setInterval(tickRunning, 1000);
      else if (!work.length && runningTimer) {
        clearInterval(runningTimer);
        runningTimer = null;
      }
    }
    function tickRunning() {
      for (const time of running.querySelectorAll('.omp-chip-time')) {
        const since = Number(/** @type {HTMLElement} */ (time).dataset.since);
        time.textContent = since ? elapsed(Date.now() - since) : '';
      }
    }

    function drawStrips() {
      const key = JSON.stringify([state.title, state.statuses, state.widgets]);
      if (key !== stripKey) {
        stripKey = key;
        const parts = [];
        if (state.title) parts.push(el('span', 'omp-strip-title', state.title));
        for (const text of Object.values(state.statuses)) parts.push(el('span', 'omp-strip-status', text));
        for (const lines of Object.values(state.widgets)) parts.push(el('pre', 'omp-strip-widget', lines.join('\n')));
        strip.replaceChildren(...parts);
        strip.hidden = parts.length === 0;
      }
      const login = state.openUrl;
      const lkey = JSON.stringify(login);
      if (lkey !== loginKey) {
        loginKey = lkey;
        loginStrip.replaceChildren();
        if (login) {
          const target = login.launchUrl ?? login.url;
          const link = el('a', 'omp-login-link', login.url);
          // Only http(s) targets are clickable; anything else is shown, not linked.
          if (/^https?:\/\//i.test(target)) link.href = target;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          loginStrip.append(el('span', 'omp-label', 'Sign in:'), link);
          if (login.instructions) loginStrip.append(el('p', 'omp-muted', login.instructions));
        }
        loginStrip.hidden = !login;
      }
    }

    function drawBanner() {
      const m = meta();
      const connection = daemon.status();
      const archived = asleep?.archived === true;
      const key = JSON.stringify([m?.status, m?.exitCode, m?.error, connection, params().sessionFile, archived]);
      if (key === bannerKey) return;
      bannerKey = key;
      banner.replaceChildren();
      banner.className = 'omp-banner';
      if (connection !== 'open') {
        banner.append(el('span', 'omp-error', connection === 'unauthorized' ? REFUSED : 'Daemon not reachable; reconnecting…'));
      } else if (m?.status === 'failed' || (m?.status === 'exited' && (m.error || (m.exitCode ?? 0) !== 0))) {
        // Going to sleep is not news; omp failing is (the next message tries again).
        banner.classList.add('is-ended');
        const text = m.status === 'failed' ? `The agent failed${m.error ? `: ${m.error}` : ''}` : `The agent exited${m.exitCode !== null ? ` (code ${m.exitCode})` : ''}${m.error ? `: ${m.error}` : ''}`;
        banner.append(el('span', 'omp-error', text));
      } else if (archived) {
        // An archived conversation is only to read here: carrying it on means restoring it.
        banner.append(el('span', 'omp-muted', 'Archived: restore it to carry it on.'), button('btn', 'Restore', restore));
      }
      composer.root.hidden = archived;
      banner.hidden = banner.childElementCount === 0;
    }

    /** Moves the archived conversation back into omp's sessions, and shows it from there. */
    function restore() {
      const want = file;
      if (!want) return;
      daemon
        .restorePastSession(want)
        .then((restored) => {
          if (!closed && file === want) ctx.setParams({ sessionFile: restored });
        })
        .catch((err) => {
          addNote(state, 'error', 'restore', `Not restored: ${errorMessage(err)}`);
          schedule();
        });
    }

    function drawToolbar() {
      setText(cwdEl, shortCwd(cwd()));
      cwdEl.title = cwd();
      const s = state.session;
      setText(modelBtn, s.model ? s.model.name || s.model.id : 'model…');
      modelBtn.title = s.model ? `${s.model.provider}/${s.model.id}` : 'Choose model';
      setText(thinkingBtn, s.thinkingLevel ? `think: ${s.thinkingLevel}` : 'think…');
      setText(activity, state.streaming ? 'working' : waking ? 'waking…' : 'idle');
      activity.classList.toggle('is-streaming', state.streaming);
      const progress = turnProgress(state);
      progressEl.hidden = !progress;
      if (progress) {
        progressBar.max = progress.total;
        progressBar.value = progress.done;
        setText(progressCount, `${progress.done}/${progress.total}`);
        progressEl.title = `${progress.done} of ${progress.total} tasks done${progress.current ? `\nNow: ${progress.current}` : ''}`;
      }
      setText(contextEl, s.contextPercent !== null ? `ctx ${s.contextPercent.toFixed(1)}%` : '');
      setText(costEl, state.cost > 0 ? `$${state.cost < 1 ? state.cost.toFixed(3) : state.cost.toFixed(2)}` : '');
      errorBadge.hidden = !state.lastError;
      errorBadge.title = state.lastError ?? '';
      const live = ready();
      // Only an awake session knows whether its model needs an account; the menus wake it.
      signInBtn.hidden = !live || !needsLogin(state);
      stopBtn.disabled = !live || !state.streaming;
      // Its forks counted; related windows on the screen coloured alike (app.js).
      const forks = daemon.forks();
      const { children } = relatives(forks, ompId());
      setText(forksBtn, children.length ? `Forks ${children.length}` : 'Forks');
      ctx.setFamily(familyOf(forks, ompId()));
    }

    function drawComposer() {
      sendBtn.title = forkable() ? SEND_TITLE : '';
      // The message waits in the box while the conversation wakes; it goes once omp is up.
      composer.root.classList.toggle('is-waking', waking !== null);
      draft.placeholder = state.streaming ? 'Steer the agent… (Esc stops)' : 'Message the agent… (@ files, # pull requests, / commands, ! shell)';
      if (state.editorText && state.editorText.seq > editorSeen) {
        editorSeen = state.editorText.seq;
        composer.setText(state.editorText.text);
        updateSuggestions();
        draft.focus();
      }
    }

    /**
     * Puts the message this window was to be forked with (dragged off another pane's Send) in
     * the box, unsent, once: the param is cleared as it goes. A fork gets it from the daemon
     * (forkScreen); a window holding it still is one whose fork failed, and the user started a
     * fresh conversation instead.
     */
    function fillCarried() {
      const { prompt } = params();
      if (!prompt) return;
      ctx.setParams({ prompt: null });
      composer.setText(prompt);
    }

    /** Redraws the window when it is due to dim. @type {ReturnType<typeof setTimeout> | undefined} */
    let coldTimer;
    /** Dims the window once its conversation is quiet past idle compaction's cutoff (omp/cold.js). */
    function drawCold() {
      const at = coldAfterMs === null ? null : coldAt(state, coldAfterMs);
      const wait = at === null ? null : at - Date.now();
      node.classList.toggle('is-cold', wait !== null && wait <= 0);
      clearTimeout(coldTimer);
      coldTimer = wait !== null && wait > 0 ? setTimeout(schedule, wait + 50) : undefined;
    }

    function update() {
      // Woken elsewhere (another window, another tab): show the session that holds it now.
      const running = !ready() && !waking ? holding(file) : null;
      if (running && running !== session) follow(running);
      // A rewind's prompt goes once the transcript holds the rewound conversation, or once
      // there is no session left to send it to.
      const waiting = reseedWaiters;
      reseedWaiters = waiting.filter((w) => ready() && state.rewinds === w.after);
      for (const w of waiting) if (!reseedWaiters.includes(w)) w.resolve();
      // A ready session holds its earlier history already (the daemon fetched it first).
      if (ready()) fillCarried();
      // The journal names the conversation, and the name labels the window: both are saved
      // with it. omp reports a new conversation's journal as it starts (and another on /new).
      const reported = meta()?.sessionFile;
      if (reported && reported !== file) {
        // The conversation's key may change with it (a new one's session named it so far).
        const before = draftKey();
        file = reported;
        if (before && before !== draftKey()) writeDraft(before, { text: '', cards: [] });
        keepDraft();
        ctx.setParams({ sessionFile: reported });
      }
      const name = conversationName(state);
      if (name && name !== params().name) {
        ctx.setParams({ name });
        schedule(); // the next draw labels the window with it
      }
      drawCold();
      drawToolbar();
      checkGithub();
      drawStrips();
      drawBanner();
      drawTranscript();
      drawDialogs();
      drawRunning();
      drawQueue();
      drawComposer();
      selectionPopup.refresh();
      // News heard as it landed under the reader's eyes is read (see follow). A mark the user
      // made themselves (newer than any news here) waits for them to come into the window.
      const since = unreadSince();
      if (since !== null && since <= readLive) markRead();
      ctx.setUnread(unreadSince() !== null);
    }

    /** The window is being used: the session stays awake. */
    function seen() {
      if (!ready() || !session || performance.now() - seenAt < SEEN_EVERY_MS) return;
      seenAt = performance.now();
      daemon.seen(session).catch(() => {});
    }

    // Awake, the session's events; asleep, the journal. A new conversation whose omp has gone
    // before anything was said has neither: the window starts afresh.
    const startedIn = started.session && daemon.meta(started.session);
    const runningNow = startedIn && isRunning(startedIn) ? started.session : holding(file);
    if (runningNow) follow(runningNow);
    else if (file) load();
    else
      queueMicrotask(() => {
        ctx.setParams({ session: null });
        schedule();
      });

    return {
      id: ++views,
      root: node,
      shows: (p) => (p.sessionFile !== null && p.sessionFile === file) || (p.session !== null && (p.session === session || p.session === started.session)),
      update,
      focus: () => draft.focus(),
      /** The user came into the window: what it shows is read, and the session stays awake. */
      read() {
        markRead();
        seen();
      },
      seen,
      destroy() {
        closed = true;
        unsubscribe();
        if (runningTimer) clearInterval(runningTimer);
        ctx.headActions.replaceChildren();
        ctx.setFamily(null);
        ctx.headActions.removeEventListener('keydown', onNavKey);
        resizes.disconnect();
        composer.destroy();
        selectionPopup.destroy();
        offHighlight();
        highlight.destroy();
        offPullDrag();
        offFileRefs();
        clearTimeout(coldTimer);
      },
    };
  }

  /** @param {string} label @param {string} title @param {string} [name] a class naming it, for styles */
  function toolButton(label, title, name) {
    const b = button(name ? `omp-tool-btn ${name}` : 'omp-tool-btn', label);
    b.title = title;
    return b;
  }

  /** An arrow of the top bar, named by its title. @param {string} arrow @param {string} title @param {() => void} onClick */
  function navButton(arrow, title, onClick) {
    const b = button('omp-tool-btn omp-nav-btn', arrow, onClick);
    b.title = title;
    b.setAttribute('aria-label', title);
    return b;
  }

  return {
    // Sessions or a drop switched this window to another session: show it.
    paramsChanged: schedule,
    destroy() {
      destroyed = true;
      if (frame) cancelAnimationFrame(frame);
      offStatus();
      offSettings();
      offReset();
      offUnread();
      offDecisions();
      offForks();
      document.removeEventListener('pointerdown', pressed, { capture: true });
      document.removeEventListener('keydown', pressed, { capture: true });
      document.removeEventListener('focusin', focused, { capture: true });
      window.removeEventListener('blur', left);
      // The session runs on: the daemon's, not this window's.
      view?.destroy();
      view = null;
      root.remove();
    },
  };
}
