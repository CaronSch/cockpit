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
 * (ui/settings.js), the same in every agent window.
 *
 * New, Fork, Accounts and Stop sit in the window's top bar, beside its close button.
 */
import { button, el, setText } from '../ui/dom.js';
import { errorMessage, tildeHome } from '../ui/format.js';
import { DaemonError, getDaemon } from '../daemon/client.js';
import { addNote, applyEvent, conversationName, createTranscript, needsLogin, seedConversation } from '../omp/transcript.js';
import { renderItem } from '../omp/items-view.js';
import { renderDialog } from '../omp/dialogs-view.js';
import { createComposer } from '../omp/composer.js';
import { composeAsk, composeFollowUp, isCommand, shellCommand } from '../omp/message.js';
import { attachSelectionPopup } from '../omp/selection-popup.js';
import { attachDragHighlight } from '../omp/drag-highlight.js';
import { createSuggestions } from '../omp/suggestions.js';
import { createFileSuggest } from '../omp/file-suggest.js';
import { MENTIONS, PLAIN_PATH } from '../omp/file-mention.js';
import { awaitedAfter } from '../omp/activity.js';
import { promptsAndResponses } from '../omp/visibility.js';
import { turnProgress } from '../omp/todos.js';
import { elapsed, runningWork } from '../omp/running-work.js';
import { createPromptHistory, sentPrompts } from '../omp/prompt-history.js';
import { branchEntry, pointKey, rewindPoint } from '../omp/rewind.js';
import { conversationKey, isRunning } from '../sessions/running.js';
import { readDraft, writeDraft } from '../omp/drafts.js';
import { focusOnClick } from '../ui/click-focus.js';
import { settings } from '../ui/settings.js';
/** @import { WidgetContext } from './registry.js' */
/** @import { RpcResponse, SessionEvent } from '../../daemon/wire.js' */
/** @import { DaemonClient } from '../daemon/client.js' */
/** @import { SlashCommand } from '../omp/transcript.js' */

/**
 * `fork` is a journal to fork into a new conversation as soon as the window is placed (set by
 * another pane's Fork); it is cleared once the fork runs, so it is never taken twice. `prompt`
 * is cleared as it is sent.
 * @typedef {{ session: string | null, cwd: string | null, sessionFile: string | null, name: string | null, fork: string | null, prompt: string | null }} OmpParams
 */
/** @typedef {{ label: string, detail?: string, current?: boolean, pick: () => void }} MenuEntry */
/** How often, at most, a window being used tells the daemon so (it keeps the session awake). */
const SEEN_EVERY_MS = 60_000;
const MAX_SUGGESTIONS = 8;
const BOTTOM_SLACK_PX = 24;
const REFUSED = 'The daemon refused this page.';
const FORK_TITLE = 'Fork: continue a copy of this conversation in a new window';
const NOTHING_TO_FORK = 'Nothing to fork yet: the conversation is saved once the agent has replied';
const SEND_TITLE = 'Drag onto the grid to send this in a fork of the conversation instead';

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
  daemon
    .config()
    .then((c) => {
      home = c.home;
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
  let pointerInside = false;
  /** Looking at this window: the pointer is over it, in a page that has focus. */
  const reading = () => pointerInside && document.visibilityState === 'visible' && document.hasFocus();
  const markRead = () => view?.markRead();

  // Moving over the pane, scrolling it, clicking or typing in it: all count as reading it.
  body.addEventListener('pointerenter', () => {
    pointerInside = true;
  });
  body.addEventListener('pointerleave', () => {
    pointerInside = false;
  });
  for (const type of ['pointermove', 'pointerdown', 'wheel', 'keydown', 'focusin']) {
    body.addEventListener(type, markRead, { passive: true });
  }

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
      if (!dir) return;
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
    // The list drops down over what is below the field, so nothing moves as it opens and closes.
    const field = el('div', 'omp-setup-field');
    field.append(input, suggestions.root);
    const row = el('div', 'omp-row');
    row.append(field, start);
    form.append(el('p', 'omp-setup-title', 'Start an agent'), label, row, error);
    queueMicrotask(() => input.focus());
    return [form];
  }

  /** Forks `params.fork` right away; on failure offers to retry or start fresh. */
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
      daemon
        .createSession({ cwd: cwd ?? '~', fork })
        .then((meta) => {
          // A fork's own journal is not known until omp reports it; update() saves it then.
          ctx.setParams({ session: meta.id, cwd: meta.cwd, sessionFile: meta.sessionFile, fork: null });
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
   * @typedef {{ id: number, root: HTMLElement, shows(p: OmpParams): boolean, update(): void, focus(): void, markRead(): void, destroy(): void }} SessionView
   * @returns {SessionView}
   */
  function createSessionView() {
    const state = createTranscript();
    const started = params();
    /** The session whose events the window shows, or null while it shows the journal. @type {string | null} */
    let session = null;
    /** The conversation's journal, as the window was given it or omp has reported it. */
    let file = started.sessionFile;
    /** What the journal said of the conversation, while asleep. @type {{ id: string, cwd: string | null } | null} */
    let asleep = null;
    /** Waking the conversation: resolves with the session once it is ready. @type {Promise<string> | null} */
    let waking = null;
    let unsubscribe = () => {};
    /** When the session last waited on its user here (omp/activity.js), and the last mark this window read. */
    let awaitedAt = 0;
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
    const newBtn = toolButton('New', 'Start a new conversation in this window (Sessions keeps this one)');
    const forkBtn = toolButton('Fork', FORK_TITLE);
    // Model providers and accounts omp can use: connect another, or switch.
    const accountsBtn = toolButton('Accounts', 'Connect a model provider or another account');
    const stopBtn = toolButton('Stop', 'Stop the agent and restore queued messages (Esc)');
    // Shown only while the session's model has no account signed in to talk to it with.
    const signInBtn = toolButton('Sign in', 'Sign in to a model provider: this conversation’s model needs it');
    toolbar.append(cwdEl, modelBtn, thinkingBtn, activity, progressEl, contextEl, costEl, errorBadge, spacer, signInBtn);
    // The conversation's own controls go in the window's top bar, for as long as it is shown.
    ctx.headActions.replaceChildren(newBtn, forkBtn, accountsBtn, stopBtn);

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
      awaitedAt = 0;
      unsubscribe = daemon.subscribe(id, (event) => {
        applyEvent(state, event);
        awaitedAt = awaitedAfter(awaitedAt, event);
        schedule();
      });
      // The subscription replayed history synchronously: requests in it are already handled.
      editorSeen = state.editorText?.seq ?? 0;
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
          asleep = { id: conversation.id, cwd: conversation.cwd };
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
      /** @type {Record<string, unknown>} */
      const request =
        shell !== null
          ? { type: 'bash', command: shell }
          : state.streaming
            ? { type: 'prompt', message: text, streamingBehavior: 'steer' }
            : { type: 'prompt', message: text };
      void rpc(request).then((res) => {
        // Give it all back if omp refused it and nothing new has been written since.
        if ((!res || !res.success) && !leaving) taken.restore();
      });
    }

    async function stop() {
      if (!ready() || !state.streaming) return;
      const res = await rpc({ type: 'abort_and_restore_queue' });
      if (!res?.success) return;
      /** @type {Array<{ text?: unknown }>} */
      const restored = [...(res.data?.steering ?? []), ...(res.data?.followUp ?? [])];
      const texts = restored.map((m) => str(m?.text)).filter((t) => t !== null);
      if (texts.length) {
        composer.setText([...texts, draft.value].filter(Boolean).join('\n\n'));
        draft.focus();
      }
    }

    // ── menus (model, thinking, login) ──
    /**
     * Gives `anchor` a popover menu of what `load` lists, loaded afresh each time it opens.
     * @param {HTMLButtonElement} anchor @param {() => Promise<MenuEntry[]>} load
     * @param {{ filter?: boolean, className?: string }} [options] `className` places it (a top-bar menu)
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
                    return item;
                  }),
              );
              if (!list.childElementCount) list.append(el('p', 'omp-muted', 'Nothing to choose.'));
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

    stopBtn.addEventListener('click', () => void stop());
    // The copy is omp's own (`--fork`): a new conversation in a new window; this one carries on.
    forkBtn.addEventListener('click', () => {
      if (forkable()) ctx.addWidget('omp', { fork: file, cwd: cwd() || null, session: null, sessionFile: null, name: params().name });
    });
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

    /** A path in a message names a file in the conversation's directory, unless it says otherwise. @param {string} dir */
    function listMentioned(dir) {
      return daemon.listFiles(/^[~/]/.test(dir) || !cwd() ? dir : `${cwd().replace(/\/$/, '')}/${dir}`);
    }

    function hideSuggestions() {
      files.close();
      suggestions.hide();
    }

    /** Suggests what the draft is starting to name: a slash command, or a file after `@`. */
    function updateSuggestions() {
      const match = /^\/(\S*)$/.exec(draft.value);
      if (!match) {
        if (!files.update()) suggestions.hide();
        return;
      }
      files.close();
      const q = match[1].toLowerCase();
      const starts = (/** @type {SlashCommand} */ c) => [c.name, ...c.aliases].some((n) => n.toLowerCase().startsWith(q));
      const contains = (/** @type {SlashCommand} */ c) => [c.name, ...c.aliases].some((n) => n.toLowerCase().includes(q));
      const commands = [...state.commands.filter(starts), ...state.commands.filter((c) => !starts(c) && contains(c))].slice(0, MAX_SUGGESTIONS);
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
      if (e.key === 'Enter' && !e.shiftKey) {
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
    // dropped, continuing a copy of this conversation. This box lets go of it once it is placed.
    sendBtn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || sendBtn.disabled || !forkable()) return;
      const outgoing = composer.compose({ withCards: !isCommand(draft.value) });
      const line = outgoing.message.replace(/\s+/g, ' ').trim();
      ctx.dragWidget('omp', { fork: file, cwd: cwd() || null, session: null, sessionFile: null, name: params().name, prompt: outgoing.message || null }, e, {
        label: line ? `Fork: ${line.length > 40 ? `${line.slice(0, 39)}…` : line}` : 'Fork',
        onEnd: ({ dropped }) => {
          if (!dropped) return;
          outgoing.take();
          hideSuggestions();
        },
      });
    });

    // ── drawing ──
    /** @type {Map<string, { rev: number, node: HTMLElement }>} */
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
      const shown = onlyResponses ? promptsAndResponses(state.items, state.streaming) : { items: state.items, working: null };
      const live = new Set();
      const itemCtx = { tools: state.tools, open: openDetails };
      shown.items.forEach((item, i) => {
        live.add(item.key);
        let entry = drawn.get(item.key);
        if (!entry || entry.rev !== item.rev) {
          const fresh = renderItem(item, itemCtx);
          if (entry) {
            resizes.unobserve(entry.node);
            entry.node.replaceWith(fresh);
          }
          resizes.observe(fresh);
          entry = { rev: item.rev, node: fresh };
          drawn.set(item.key, entry);
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
        c.append(el('span', 'omp-chip-kind', which === 'steering' ? 'steer' : 'next'), el('span', 'omp-chip-text', text));
        const remove = button('omp-chip-remove', '×');
        remove.setAttribute('aria-label', `Remove queued message: ${text}`);
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
      const key = JSON.stringify([m?.status, m?.exitCode, m?.error, connection, params().sessionFile]);
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
      }
      banner.hidden = banner.childElementCount === 0;
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
      forkBtn.disabled = !forkable();
      forkBtn.title = forkable() ? FORK_TITLE : NOTHING_TO_FORK;
    }

    function drawComposer() {
      sendBtn.title = forkable() ? SEND_TITLE : '';
      // The message waits in the box while the conversation wakes; it goes once omp is up.
      composer.root.classList.toggle('is-waking', waking !== null);
      draft.placeholder = state.streaming ? 'Steer the agent… (Esc stops)' : 'Message the agent… (@ files, / commands, ! shell)';
      if (state.editorText && state.editorText.seq > editorSeen) {
        editorSeen = state.editorText.seq;
        composer.setText(state.editorText.text);
        updateSuggestions();
        draft.focus();
      }
    }

    /**
     * Sends the message this window was forked with (dragged off another pane's Send), once:
     * the param is cleared as it goes. A session that is not that fork after all (the fork
     * failed and a fresh one was started) gets it in the box, unsent.
     */
    function sendCarried() {
      const { prompt } = params();
      if (!prompt) return;
      ctx.setParams({ prompt: null });
      composer.setText(prompt);
      if (meta()?.fork) void send();
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
      if (ready()) sendCarried();
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
      drawToolbar();
      drawStrips();
      drawBanner();
      drawTranscript();
      drawDialogs();
      drawRunning();
      drawQueue();
      drawComposer();
      selectionPopup.refresh();
      // News that lands under the reader's eyes is read as it comes. A mark the user made
      // themselves (newer than any news here) waits for them to come back to the window.
      const since = unreadSince();
      if (since !== null && since <= awaitedAt && reading()) markRead();
      ctx.setUnread(unreadSince() !== null);
    }

    /** The window is being used: what it shows is read, and the session stays awake. */
    function used() {
      markRead();
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
      markRead: used,
      destroy() {
        closed = true;
        unsubscribe();
        if (runningTimer) clearInterval(runningTimer);
        ctx.headActions.replaceChildren();
        resizes.disconnect();
        composer.destroy();
        selectionPopup.destroy();
        offHighlight();
        highlight.destroy();
      },
    };
  }

  /** @param {string} label @param {string} title */
  function toolButton(label, title) {
    const b = button('omp-tool-btn', label);
    b.title = title;
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
      // The session runs on: the daemon's, not this window's.
      view?.destroy();
      view = null;
      root.remove();
    },
  };
}
