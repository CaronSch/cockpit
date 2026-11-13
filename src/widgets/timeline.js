/**
 * A timeline of the agents: on its left, idle conversations by how recently they were active (in
 * order, not to scale), the latest beside now; at now, those whose agents are busy (starting,
 * working, asking their user something, or running work in the background); on its right, the
 * prompts agents scheduled for their conversations (daemon/schedule.js), each where it runs, on a
 * log scale (timeline/scale.js) that reaches as far as the furthest one: the next hour spread
 * out, the next month squeezed in. Laid out for a wide, short window: everything on one axis
 * along its bottom, labels of scheduled prompts above it in as many lanes as fit.
 *
 * A label is the start of its conversation's name; pointing at it shows the whole. One with news
 * its user has not read (a scheduled prompt that ran, say) is ringed in blue until it is read,
 * here or anywhere. A scheduled prompt dragged along the axis runs where it is dropped (to the
 * minute, a minute ahead at the least). Any label dragged out of the window says what dropping it
 * there does, and dropping does it: the scheduled prompt is deleted, the conversation archived; a
 * conversation dropped back inside stays as it was. A click on a conversation shows it in the
 * agent window this screen used last; on a scheduled prompt it edits the prompt and its time, in
 * place.
 *
 * Archived conversations are not shown, nor the prompts scheduled for them, which wait until the
 * conversation is restored. A prompt missed while the daemon was off or the Mac slept is marked
 * missed where it runs now, ten minutes after the daemon found it, so its user can decide whether
 * it is still wanted; one whose last delivery failed is marked so, with the reason.
 */
import { button, el } from '../ui/dom.js';
import { swallowReleaseClick } from '../interaction/drag-controller.js';
import { errorMessage } from '../ui/format.js';
import { getDaemon } from '../daemon/client.js';
import { displayTitle, sortSessions } from '../sessions/order.js';
import { conversationMatch, listConversations, runningState, showConversation } from '../sessions/running.js';
import { futureSpan, offsetAt, pack, position, ticks, toLocalInput, whenLabel } from '../timeline/scale.js';
/** @import { WidgetContext } from './registry.js' */
/** @import { DaemonClient } from '../daemon/client.js' */
/** @import { PastSession, ScheduledTask } from '../../daemon/wire.js' */
/** @import { Listed } from '../sessions/running.js' */

/** How often the future side is redrawn as now moves on. */
const CLOCK_MS = 30_000;
/** Space between two labels in one lane of the future side, and between lanes. */
const GAP_PX = 6;
/** How far a press on a label moves before it is a drag. */
const DRAG_PX = 4;
const MINUTE_MS = 60_000;

/** When a dragged prompt would run, as its ghost says it: the date and the time. @param {number} at */
const runsAt = (at) => new Date(at).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export default {
  type: 'timeline',
  title: 'Timeline',
  glyph: '⇥',
  description: 'Agents by when they were last active, and the prompts they scheduled: drag a prompt along the axis to move it, or a label out to delete or archive it',

  /** @param {HTMLElement} body @param {WidgetContext} ctx */
  mount(body, ctx) {
    return createTimeline(body, ctx, getDaemon());
  },
};

/** @param {HTMLElement} body @param {WidgetContext} ctx @param {DaemonClient} daemon */
function createTimeline(body, ctx, daemon) {
  const root = el('div', 'timeline');
  const track = el('div', 'timeline-track');
  const past = el('div', 'timeline-past');
  const pastList = el('ol', 'timeline-list timeline-past-list');
  pastList.setAttribute('aria-label', 'Idle conversations by when they were last active, the latest last');
  past.append(pastList);
  const now = el('div', 'timeline-now');
  const nowList = el('ol', 'timeline-list timeline-now-list');
  nowList.setAttribute('aria-label', 'Conversations whose agents are busy now');
  now.append(nowList, el('span', 'timeline-now-label', 'now'));
  const future = el('div', 'timeline-future');
  const axis = el('div', 'timeline-axis');
  const futureList = el('ol', 'timeline-list timeline-future-list');
  futureList.setAttribute('aria-label', 'Scheduled prompts, the soonest first');
  const nothing = el('p', 'timeline-empty', 'Nothing scheduled');
  // While a scheduled prompt is dragged along the axis: the time it would run at.
  const mark = el('span', 'timeline-drop-mark');
  mark.hidden = true;
  future.append(axis, futureList, nothing, mark);
  track.append(past, now, future);
  const status = el('p', 'timeline-status');
  status.setAttribute('aria-live', 'polite');
  // The editor of a scheduled prompt: in the top layer (a popover), so it is not cut off by the
  // timeline's edges.
  const editor = createEditor();
  root.append(track, status, editor.el);
  body.append(root);

  /** @type {PastSession[]} */
  let sessions = [];
  /** @type {string | null} */
  let error = null;
  /** Why the last archive, delete or move failed, until the next one. @type {string | null} */
  let actionError = null;
  let requestSeq = 0;
  /**
   * Conversations' labels by key (one keeps its label as it moves between the past and now),
   * scheduled prompts' by id: each made once, then kept up to date.
   * @type {Map<string, HTMLElement>}
   */
  const conversationNodes = new Map();
  /** @type {Map<string, HTMLElement>} */
  const futureNodes = new Map();
  /** What each label shows, as last drawn: its conversation, and for a future one its prompt. @type {Map<HTMLElement, { conversation: Listed, task: ScheduledTask | null }>} */
  let shown = new Map();
  /** Whether the past keeps its latest label beside now: until the user scrolls back to older ones. */
  let followNow = true;
  /** The latest conversation as last drawn. @type {string | null} */
  let shownLatest = null;
  /** The future side's span as last drawn: a drag along the axis reads times off it. */
  let shownSpan = futureSpan(0);
  /** The drag a press on a label began, until it is released. @type {{ cancel: () => void } | null} */
  let drag = null;
  let frame = 0;
  const scheduleDraw = () => {
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      draw();
    });
  };

  async function load() {
    const seq = ++requestSeq;
    try {
      const next = await daemon.history('');
      if (seq !== requestSeq) return;
      sessions = next;
      error = null;
    } catch (err) {
      if (seq !== requestSeq) return;
      error = `Could not list sessions: ${errorMessage(err)}`;
    }
    draw();
  }

  /** Every conversation not archived, the least recently active first. */
  const listed = () => sortSessions(listConversations(sessions, daemon.sessions(), { directory: null }), 'active', 'asc');

  /** @param {Listed} c */
  const nameOf = (c) => (c.meta && daemon.activity(c.meta.id)?.name) ?? (c.title || c.firstPrompt ? displayTitle(c) : 'New session');
  /** @param {Listed} c */
  const ompIdOf = (c) => c.meta?.ompId ?? (c.id || null);
  /** @param {Listed} c */
  const isUnread = (c) => daemon.unreadSince(ompIdOf(c)) !== null;
  /** @param {Listed} c */
  const stateOf = (c) => (c.meta ? runningState(daemon.activity(c.meta.id), c.meta, isUnread(c)) : null);
  /** An awake session with no listed journal: a new one nothing was sent to. @param {Listed} c */
  const isEmpty = (c) => c.meta !== null && !sessions.some((s) => s.file === c.file);
  /** Work an awake conversation's agent runs in the background (shells, subagents). @param {Listed} c */
  const workOf = (c) => (c.meta ? (daemon.activity(c.meta.id)?.work ?? 0) : 0);
  /**
   * Whether its agent is busy, so it is at now: starting, working, asking its user something, or
   * with work running in the background after its turn.
   * @param {Listed} c
   */
  const isBusy = (c) => {
    const state = stateOf(c);
    return state === 'starting' || state === 'working' || state === 'asking' || workOf(c) > 0;
  };

  /**
   * The conversation a prompt is scheduled for, if it is listed: by its journal, else (a new one
   * omp has not named one for) by the session that scheduled it.
   * @param {ScheduledTask} task @param {Listed[]} conversations
   */
  const conversationOf = (task, conversations) =>
    conversations.find((c) => (task.target.sessionFile ? c.file === task.target.sessionFile : c.meta?.id === task.target.session)) ?? null;

  /**
   * A new label: a state dot and a name, and for a scheduled prompt when it runs and the stem
   * down to its time.
   * @param {boolean} scheduled
   */
  function newLabel(scheduled) {
    const chip = el('li', 'timeline-chip');
    chip.tabIndex = 0;
    const dot = el('span', 'timeline-dot');
    dot.setAttribute('aria-hidden', 'true');
    chip.append(dot, el('span', 'timeline-name'));
    if (scheduled) chip.append(el('span', 'timeline-when'), el('span', 'timeline-stem'));
    return chip;
  }

  /** Sets `prop` of `node` to `value`, unless it is that already. @template {object} T @param {T} node @param {keyof T} prop @param {unknown} value */
  const put = (node, prop, value) => {
    if (node[prop] !== value) node[prop] = /** @type {any} */ (value);
  };

  /**
   * Shows conversation `c` in label `chip`: its name, how it is doing, and `classes` besides.
   * @param {HTMLElement} chip @param {Listed} c @param {string} classes
   */
  function paint(chip, c, classes) {
    const state = stateOf(c);
    const name = nameOf(c);
    // Dragged, it stays dimmed as it is redrawn.
    const dragged = chip.classList.contains('is-drag-source') ? ' is-drag-source' : '';
    put(chip, 'className', `timeline-chip ${classes}${state ? ` is-${state}` : ''}${isUnread(c) ? ' is-unread' : ''}${dragged}`);
    if (chip.getAttribute('aria-label') !== name) chip.setAttribute('aria-label', name);
    put(/** @type {HTMLElement} */ (chip.querySelector('.timeline-name')), 'textContent', name);
  }

  /**
   * The conversations: idle ones in the past, the least recently active first; busy ones at now,
   * the one woken first first (so none moves as its agent writes).
   * @param {Listed[]} conversations @param {number} at
   */
  function drawConversations(conversations, at) {
    const busy = conversations.filter(isBusy).sort((a, b) => (a.meta?.startedAt ?? 0) - (b.meta?.startedAt ?? 0));
    const busyOnes = new Set(busy);
    const idle = conversations.filter((c) => !busyOnes.has(c));
    const live = new Set();
    /**
     * Puts `cs` in `list`, in order. A label in the other list is moved: the past is drawn first,
     * then now, so one moving either way is where it belongs by the end.
     * @param {HTMLElement} list @param {Listed[]} cs @param {string} where
     */
    const place = (list, cs, where) =>
      cs.forEach((c, i) => {
        live.add(c.key);
        let chip = conversationNodes.get(c.key);
        if (!chip) conversationNodes.set(c.key, (chip = newLabel(false)));
        paint(chip, c, where);
        shown.set(chip, { conversation: c, task: null });
        if (list.children[i] !== chip) list.insertBefore(chip, list.children[i] ?? null);
      });
    place(pastList, idle, 'is-past');
    place(nowList, busy, 'is-now');
    for (const [key, chip] of conversationNodes) {
      if (live.has(key)) continue;
      chip.remove();
      conversationNodes.delete(key);
    }
    now.classList.toggle('is-busy', busy.length > 0);
    // The latest stays beside now, unless the user scrolled back to look at older ones; a
    // conversation newly the latest is shown there either way.
    const latest = idle.at(-1)?.key ?? null;
    if (followNow || latest !== shownLatest) past.scrollLeft = past.scrollWidth;
    shownLatest = latest;
  }

  /** @param {Listed[]} conversations @param {number} at */
  function drawFuture(conversations, at) {
    const tasks = daemon
      .schedule()
      .flatMap((task) => {
        const conversation = conversationOf(task, conversations);
        return conversation ? [{ task, conversation }] : [];
      })
      .sort((a, b) => a.task.dueAt - b.task.dueAt);
    const width = future.clientWidth;

    const live = new Set();
    tasks.forEach(({ task, conversation }, i) => {
      live.add(task.id);
      let chip = futureNodes.get(task.id);
      if (!chip) futureNodes.set(task.id, (chip = newLabel(true)));
      paint(chip, conversation, `is-future${task.missedAt === null ? '' : ' is-missed'}${task.error ? ' is-failed' : ''}`);
      const when = whenLabel(task.dueAt, at);
      put(/** @type {HTMLElement} */ (chip.querySelector('.timeline-when')), 'textContent', task.missedAt === null ? when : `missed · ${when}`);
      shown.set(chip, { conversation, task });
      if (futureList.children[i] !== chip) futureList.insertBefore(chip, futureList.children[i] ?? null);
    });
    for (const [id, chip] of futureNodes) {
      if (live.has(id)) continue;
      chip.remove();
      futureNodes.delete(id);
    }

    // The scale reaches past the furthest prompt, however far, by as much as its label needs to
    // start at its time.
    const furthest = tasks.at(-1);
    const room = furthest && width > 0 ? (/** @type {HTMLElement} */ (futureNodes.get(furthest.task.id)).offsetWidth + GAP_PX) / width : 0;
    const span = futureSpan(furthest ? furthest.task.dueAt - at : 0, room);
    shownSpan = span;
    axis.replaceChildren(
      ...ticks(span, width).map((t) => {
        const tick = el('span', 'timeline-tick', t.label);
        tick.style.left = `${t.x}px`;
        return tick;
      }),
    );
    nothing.hidden = tasks.length > 0;

    // Each label starts at its time, or as near as it fits; a stem joins it to its time on the axis.
    const placed = tasks.map(({ task }) => {
      const node = /** @type {HTMLElement} */ (futureNodes.get(task.id));
      const x = position(task.dueAt - at, span) * width;
      const w = node.offsetWidth;
      return { node, x, left: Math.max(0, Math.min(x, width - w)), width: w, height: node.offsetHeight };
    });
    const boxes = placed.map((p) => ({ x: p.left, width: p.width }));
    let packed = pack(boxes, GAP_PX);
    const needed = Math.max(1, ...packed.map((p) => p.lane + 1));
    root.style.setProperty('--timeline-lanes', String(needed));
    // As many lanes as the window is tall enough for (the track grows to `needed`, up to the
    // window's height); past that, a label goes on past the one in the lane free soonest, its
    // stem bent back along the axis to its time.
    const tall = placed[0]?.height ?? 0;
    const fits = tall ? Math.max(1, Math.floor((futureList.clientHeight + GAP_PX) / (tall + GAP_PX))) : needed;
    if (needed > fits) packed = pack(boxes, GAP_PX, fits, width);
    placed.forEach((p, i) => {
      const { lane, x: left } = packed[i];
      const rise = lane * (p.height + GAP_PX);
      p.node.style.left = `${left}px`;
      p.node.style.bottom = `${rise}px`;
      // Lower lanes over higher ones' stems.
      p.node.style.zIndex = String(needed - lane);
      p.node.style.setProperty('--stem-x', `${Math.max(0, p.x - left)}px`);
      p.node.style.setProperty('--stem-w', `${Math.max(0, left - p.x)}px`);
      p.node.style.setProperty('--stem-h', `${rise + GAP_PX}px`);
    });
    return tasks.length;
  }

  function draw() {
    const at = Date.now();
    const conversations = listed();
    shown = new Map();
    drawConversations(conversations, at);
    const scheduled = drawFuture(conversations, at);
    status.textContent = actionError ?? error ?? '';
    ctx.setLabel(scheduled ? `${scheduled} scheduled` : null);
    if (editor.editing && !daemon.schedule().some((t) => t.id === editor.editing)) editor.close();
  }

  // ── labels: pointing, dragging, clicking ──
  /** @param {EventTarget | null} target */
  const chipAt = (target) => /** @type {HTMLElement | null} */ (/** @type {Element} */ (target)?.closest?.('.timeline-chip'));

  past.addEventListener('scroll', () => {
    followNow = past.scrollLeft + past.clientWidth >= past.scrollWidth - 4;
  });
  // A mouse wheel scrolls back through the past.
  past.addEventListener(
    'wheel',
    (event) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      past.scrollLeft += event.deltaY;
      event.preventDefault();
    },
    { passive: false },
  );

  /** Shows the conversation as a Sessions row does (a new tab, or the window showing it); that reads it. @param {Listed} c */
  function show(c) {
    const params = showConversation({ file: c.file, meta: c.meta, cwd: c.cwd, name: nameOf(c) });
    ctx.showInTab('omp', params, conversationMatch(params));
    read(c);
  }

  /** @param {Listed} c */
  function read(c) {
    const id = ompIdOf(c);
    const since = daemon.unreadSince(id);
    if (id !== null && since !== null) daemon.markRead(id, since).catch(() => {});
  }

  /** Archives the conversation, as the Sessions window's Archive does. @param {Listed} c */
  async function archive(c) {
    actionError = null;
    try {
      if (isEmpty(c)) {
        // A new session nothing was sent to has no journal: archiving it ends it, once it is idle.
        if (stateOf(c) !== 'idle') throw new Error('it is still starting or working; archive it once it is done');
        await daemon.end(/** @type {NonNullable<Listed['meta']>} */ (c.meta).id);
      } else {
        await daemon.archivePastSession(c.file);
      }
    } catch (err) {
      actionError = `Could not archive “${nameOf(c)}”: ${errorMessage(err)}`;
    }
    await load();
  }

  /** @param {ScheduledTask} task */
  async function unschedule(task) {
    actionError = null;
    try {
      await daemon.unschedule(task.id);
    } catch (err) {
      actionError = `Could not delete the scheduled prompt: ${errorMessage(err)}`;
    }
    draw();
  }

  /** Moves a scheduled prompt to run at `dueAt`; as an edit does, that ends its missed or failed mark. @param {ScheduledTask} task @param {number} dueAt */
  async function reschedule(task, dueAt) {
    actionError = null;
    try {
      await daemon.editScheduled(task.id, { dueAt });
    } catch (err) {
      actionError = `Could not move the scheduled prompt: ${errorMessage(err)}`;
    }
    draw();
  }

  /**
   * A press on a label, until it is released: past `DRAG_PX`, a drag, its ghost following the
   * pointer. A scheduled prompt moves along the scale as far as the pointer does from where it was
   * pressed, its new date and time on the ghost and marked on the axis. Out of the window (its
   * head included) the ghost says what dropping does: "Delete Task" for a prompt, "Archive
   * Session" for a conversation. A conversation dropped inside stays as it was; Esc ends any drag
   * with nothing done.
   * @param {HTMLElement} chip @param {{ conversation: Listed, task: ScheduledTask | null }} what @param {PointerEvent} event
   */
  function startDrag(chip, { conversation, task }, event) {
    const pane = body.parentElement ?? body;
    const { pointerId, clientX: originX, clientY: originY } = event;
    // The scale as drawn when the press began, and where on it the prompt was.
    const span = shownSpan;
    const from = task ? position(task.dueAt - Date.now(), span) : 0;
    /** @type {HTMLElement | null} */
    let ghost = null;
    let outside = false;
    /** When a scheduled prompt dropped now runs; null while dropping moves nothing. @type {number | null} */
    let dueAt = null;

    /** @param {number} x @param {number} y */
    function follow(x, y) {
      if (!ghost) return;
      const box = pane.getBoundingClientRect();
      outside = x < box.left || x > box.right || y < box.top || y > box.bottom;
      const at = Date.now();
      const width = future.clientWidth;
      dueAt = null;
      if (task && !outside && x !== originX && width > 0) {
        const moved = Math.round((at + offsetAt(from + (x - originX) / width, span)) / MINUTE_MS) * MINUTE_MS;
        // A minute ahead at the least, so a prompt dropped on now does not run as it lands.
        dueAt = Math.max(moved, Math.ceil((at + MINUTE_MS) / MINUTE_MS) * MINUTE_MS);
      }
      ghost.classList.toggle('is-removing', outside);
      if (outside) ghost.textContent = task ? 'Delete Task' : 'Archive Session';
      // The time first: a long name is cut short at the ghost's end.
      else if (task) ghost.textContent = `${runsAt(dueAt ?? task.dueAt)} · ${nameOf(conversation)}`;
      else ghost.textContent = nameOf(conversation);
      ghost.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      mark.hidden = dueAt === null;
      if (dueAt !== null) mark.style.left = `${position(dueAt - at, span) * width}px`;
    }

    /** @param {PointerEvent} e */
    function onMove(e) {
      if (e.pointerId !== pointerId) return;
      if (!ghost) {
        if (Math.hypot(e.clientX - originX, e.clientY - originY) < DRAG_PX) return;
        ghost = el('div', 'drag-ghost timeline-ghost');
        document.body.append(ghost);
        document.body.classList.add('is-dragging');
        chip.classList.add('is-drag-source');
      }
      e.preventDefault();
      follow(e.clientX, e.clientY);
    }
    /** @param {PointerEvent} e */
    function onUp(e) {
      if (e.pointerId !== pointerId) return;
      // The release that ends a drag is no click: it would show the conversation or edit the prompt.
      if (ghost) swallowReleaseClick();
      follow(e.clientX, e.clientY);
      end(true);
    }
    /** @param {PointerEvent} e */
    function onCancel(e) {
      if (e.pointerId === pointerId) end(false);
    }
    /** @param {KeyboardEvent} e */
    function onKey(e) {
      if (e.key !== 'Escape' || !ghost) return;
      e.stopPropagation();
      e.preventDefault();
      end(false);
      // The pointer is still down: its release ends the gesture Esc cancelled.
      window.addEventListener('pointerup', swallowReleaseClick, { once: true });
    }

    /** @param {boolean} commit */
    function end(commit) {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      drag = null;
      if (!ghost) return;
      ghost.remove();
      document.body.classList.remove('is-dragging');
      chip.classList.remove('is-drag-source');
      mark.hidden = true;
      if (!commit) return;
      if (outside) void (task ? unschedule(task) : archive(conversation));
      else if (task && dueAt !== null) void reschedule(task, dueAt);
    }

    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
    return { cancel: () => end(false) };
  }

  root.addEventListener('pointerdown', (event) => {
    const chip = chipAt(event.target);
    const what = chip && shown.get(chip);
    if (event.button !== 0 || !what || drag) return;
    drag = startDrag(chip, what, event);
  });
  /** @param {HTMLElement} chip */
  function activate(chip) {
    const what = shown.get(chip);
    if (!what) return;
    if (what.task) editor.open(what.task, chip);
    else show(what.conversation);
  }
  root.addEventListener('click', (event) => {
    const chip = chipAt(event.target);
    if (chip) activate(chip);
  });
  root.addEventListener('keydown', (event) => {
    const chip = /** @type {HTMLElement} */ (event.target);
    if (!chip.classList?.contains('timeline-chip') || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    activate(chip);
  });

  /**
   * The editor of a scheduled prompt, opened in place under its label: its prompt and when it
   * runs. Saved, it is no longer marked missed or failed: its user has looked at it.
   */
  function createEditor() {
    const form = el('div', 'timeline-editor');
    form.popover = 'manual';
    form.setAttribute('role', 'dialog');
    form.setAttribute('aria-label', 'Edit scheduled prompt');
    const prompt = el('textarea', 'timeline-editor-prompt');
    prompt.rows = 5;
    prompt.setAttribute('aria-label', 'Prompt');
    const when = el('input', 'timeline-editor-when');
    when.type = 'datetime-local';
    when.setAttribute('aria-label', 'Runs at');
    const problem = el('p', 'timeline-editor-error');
    const cancel = button('timeline-editor-cancel', 'Cancel');
    const save = button('timeline-editor-save', 'Save');
    const actions = el('div', 'timeline-editor-actions');
    actions.append(when, cancel, save);
    form.append(prompt, actions, problem);

    /** The time the field showed when it opened: unchanged, the prompt keeps its exact time. */
    let opened = '';
    /** @type {HTMLElement | null} */
    let from = null;
    const state = {
      el: form,
      /** The scheduled prompt being edited. @type {string | null} */
      editing: /** @type {string | null} */ (null),
      /** @param {ScheduledTask} task @param {HTMLElement} chip */
      open(task, chip) {
        state.editing = task.id;
        from = chip;
        prompt.value = task.prompt;
        when.value = opened = toLocalInput(task.dueAt);
        problem.textContent = '';
        save.disabled = false;
        const box = chip.getBoundingClientRect();
        form.style.left = `${Math.max(8, Math.min(box.left, innerWidth - 368))}px`;
        form.style.top = `${box.bottom + 6}px`;
        if (!form.matches(':popover-open')) form.showPopover();
        // Room below the label, else above it.
        const height = form.offsetHeight;
        if (box.bottom + 6 + height > innerHeight) form.style.top = `${Math.max(8, box.top - 6 - height)}px`;
        prompt.focus();
      },
      close() {
        state.editing = null;
        if (form.matches(':popover-open')) form.hidePopover();
        if (from?.isConnected) from.focus();
        from = null;
      },
    };

    async function commit() {
      const id = state.editing;
      if (!id) return;
      /** @type {{ prompt: string, dueAt?: number }} */
      const patch = { prompt: prompt.value };
      if (when.value !== opened) {
        const at = new Date(when.value).getTime();
        if (!Number.isFinite(at)) {
          problem.textContent = 'Pick a date and time.';
          return;
        }
        patch.dueAt = at;
      }
      save.disabled = true;
      try {
        await daemon.editScheduled(id, patch);
        state.close();
      } catch (err) {
        problem.textContent = `Not saved: ${errorMessage(err)}`;
        save.disabled = false;
      }
    }
    save.addEventListener('click', () => void commit());
    cancel.addEventListener('click', () => state.close());
    form.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        state.close();
      } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void commit();
      }
    });
    return state;
  }

  const offSchedule = daemon.onSchedule(scheduleDraw);
  const offSessions = daemon.onSessions(scheduleDraw);
  const offActivity = daemon.onActivity(scheduleDraw);
  const offUnread = daemon.onUnread(scheduleDraw);
  const offHistory = daemon.onHistory(() => void load());
  const offStatus = daemon.onStatus((s) => {
    if (s === 'open') void load();
  });
  const clock = setInterval(scheduleDraw, CLOCK_MS);
  const resized = new ResizeObserver(scheduleDraw);
  resized.observe(future);

  draw();
  void load();

  return {
    destroy() {
      requestSeq++; // drop any answer still on its way
      offSchedule();
      offSessions();
      offActivity();
      offUnread();
      offHistory();
      offStatus();
      clearInterval(clock);
      resized.disconnect();
      cancelAnimationFrame(frame);
      drag?.cancel();
      editor.close();
      root.remove();
    },
  };
}
