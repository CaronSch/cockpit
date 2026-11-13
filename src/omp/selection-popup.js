/**
 * Actions on highlighted transcript text: select part of a reply and Comment and Ask buttons
 * appear at the end of the selection; C and A press them while they show. A selection dragged
 * with the pointer snaps out to whole words when it is let go, so a rough drag quotes clean text.
 * Either button opens a box in the transcript itself, right under the block the selection ends
 * in (a paragraph, a list, a table, a diff line), the width of the transcript and set like the
 * message box: the quote, a field, and the action clicked, which Enter does too. Comment hands
 * the comment to the composer with the selected text as its quote. Ask asks a side question
 * about it, whose short answer streams into the box and never enters the chat (omp's `btw`);
 * follow-up questions continue the same topic there, one at a time. Where questions are queued
 * instead (the pull request window's review), Ask hands the question over as Comment does.
 *
 * In an agent window a comment or a question on an agent's reply is kept as an annotation
 * (daemon/annotations.js), which keeps its text highlighted (annotation-marks.js): `open` shows
 * the same box again for it, the comment in its field to edit (emptied, it goes), or the
 * questions with their answers, a field for another and Remove.
 */
import { button, el } from '../ui/dom.js';
import { autosize } from '../ui/autosize.js';
import { renderMarkdown } from './markdown-dom.js';
import { snapToWords } from '../ui/word-snap.js';
import { withMentions } from './file-suggest.js';
/** @import { SideAnswer } from './transcript.js' */
/** @import { ListDir } from './file-suggest.js' */
/** @import { Anchor } from './annotation-marks.js' */
/** @import { Annotation, AnnotationPatch, AnnotationQA, NewAnnotation } from '../../daemon/annotations.js' */

const GAP_PX = 6;
const EDGE_PX = 8;
const INPUT_MAX_PX = 200;
/** Where the box goes: after the block of a reply or a diff the selection ends in. */
const BLOCK = '.omp-md > *, .gh-item-body > *, .gh-line, .gh-thread';

/**
 * How Ask reaches omp: `send` asks a side question about `quote`, or a follow-up in topic
 * `topic`, and answers with omp's id for the topic and the question's turn in it (or why it
 * could not); `answers` reads a topic's answers so far, one per turn; `cancel` stops the one
 * running in a topic.
 * @typedef {{
 *   send(quote: string, question: string, topic?: string): Promise<{ id: string, turn: number } | { error: string }>,
 *   answers(id: string): SideAnswer[] | undefined,
 *   cancel(id: string): void,
 * }} SideQuestions
 */
/**
 * Questions kept to be sent later with other notes, instead of answered at once: `queue`
 * takes one about `quote` (found at `cite`, when the window says where).
 * @typedef {{ queue(quote: string, question: string, cite: string | null): void }} QueuedQuestions
 */

/**
 * Where comments and questions are kept as annotations: `anchor` says where a selection of
 * `quote` is (null: nowhere an annotation can be); `add` keeps a new one and answers with its id
 * (null if it could not); `update` and `remove` change and forget one.
 * @typedef {{
 *   anchor(range: Range, quote: string): Anchor | null,
 *   add(annotation: NewAnnotation): Promise<string | null>,
 *   update(id: string, patch: AnnotationPatch): Promise<void>,
 *   remove(id: string): Promise<void>,
 * }} AnnotationStore
 */

/**
 * A question asked in the shown thread: its topic and turn in it once omp has taken it, or why
 * it could not be asked; or, asked before the box was opened again, as it was kept (`kept`).
 * @typedef {{ question: string, topic: string | null, turn: number | null, error: string | null, kept: AnnotationQA | null }} Asked
 */

/**
 * @param {{
 *   host: HTMLElement,
 *   transcript: HTMLElement,
 *   onComment: (quote: string, comment: string, cite: string | null, anchor: Anchor | null) => void,
 *   ask: SideQuestions | QueuedQuestions,
 *   cite?: (range: Range) => string | null,
 *   listDir?: ListDir,
 *   annotations?: AnnotationStore,
 * }} options `host`: the positioned element the buttons float in; `transcript`: where selections
 * count, and where the box goes; `cite` says where a selection is, for the comment or question
 * on it (e.g. a file and its lines); `listDir`, if given, lists the folders `@` paths typed in
 * the box name, to suggest their entries; `annotations` keeps comments (with `anchor`, handed to
 * `onComment`) and questions, and edits them.
 * Call `refresh()` whenever the session's state changes, so a shown thread keeps up.
 */
export function attachSelectionPopup({ host, transcript, onComment, ask, cite = () => null, listDir, annotations }) {
  const queued = 'queue' in ask ? ask : null;
  const side = 'queue' in ask ? null : ask;
  const pop = el('div', 'omp-quote-pop');
  pop.hidden = true;
  host.append(pop);
  const panel = el('div', 'omp-quote-panel');
  /** @type {'closed' | 'buttons' | 'editing' | 'thread'} */
  let mode = 'closed';
  /** What C and A do while the buttons show: press Comment and Ask. @type {Record<string, () => void>} */
  let keyed = {};
  let quote = '';
  /** Where the quote is, as `cite` said. @type {string | null} */
  let quoteCite = null;
  /** Where the quote is, for an annotation on it. @type {Anchor | null} */
  let quoteAnchor = null;
  /** The annotation keeping the shown thread, once it has one: its id, after every save asked for so far. @type {Promise<string | null> | null} */
  let threadNote = null;
  /** The thread as last saved. @type {string | null} */
  let savedThread = null;
  /** omp's id for the side topic the thread asks in now, once it has taken a question in it. @type {string | null} */
  let topic = null;
  /** The questions asked in the shown thread, oldest first. @type {Asked[]} */
  let asked = [];
  /** Bumped on close, so a question still on its way is cancelled once omp names it. */
  let generation = 0;
  /** Redraws the shown thread; null unless one is shown. @type {(() => void) | null} */
  let drawThread = null;

  /** omp's answer to `entry` so far (or as kept); undefined until omp has taken it and said so. @param {Asked} entry */
  const answerTo = (entry) => entry.kept ?? (entry.turn === null || entry.topic === null ? undefined : side?.answers(entry.topic)?.[entry.turn]);
  /** Whether the thread's newest question is still on its way or being answered: omp runs one at a time. */
  const running = () => {
    const newest = asked.at(-1);
    return mode === 'thread' && newest !== undefined && newest.error === null && (answerTo(newest)?.status ?? 'running') === 'running';
  };

  /**
   * Keeps the shown thread in its annotation, made with the first question omp takes. An answer
   * on its way is kept as interrupted, without its text, until it ends (`stopping`: it is being
   * stopped, with what it said so far).
   */
  function saveThread(stopping = false) {
    if (!annotations || !quoteAnchor) return;
    /** @type {AnnotationQA[]} */
    const thread = asked.flatMap((entry) => {
      if (entry.kept) return [entry.kept];
      if (entry.error !== null) return [{ question: entry.question, answer: '', status: /** @type {const} */ ('error'), error: entry.error }];
      const answer = answerTo(entry);
      if (entry.turn === null) return [];
      if (!answer || answer.status === 'running') {
        return [{ question: entry.question, answer: stopping ? (answer?.answer ?? '') : '', status: stopping ? /** @type {const} */ ('cancelled') : /** @type {const} */ ('interrupted'), error: null }];
      }
      return [{ question: entry.question, answer: answer.answer, status: answer.status, error: answer.error }];
    });
    const key = JSON.stringify(thread);
    if (key === savedThread) return;
    if (!threadNote) {
      // Made once omp has taken a question: one it never took is no annotation.
      if (!asked.some((entry) => entry.turn !== null)) return;
      threadNote = annotations.add({ kind: 'ask', ...quoteAnchor, quote, comment: null, thread });
    } else {
      const store = annotations;
      // One save after another, so the last one asked for is the one kept.
      threadNote = threadNote.then(async (id) => {
        if (id) await store.update(id, { thread });
        return id;
      });
    }
    savedThread = key;
  }
  /** The comment the box opened with, when it opened on one kept (`open`). */
  let prefilled = '';
  /** Whether the box holds something written and not sent yet. */
  const drafted = () => {
    const text = panel.querySelector('textarea')?.value.trim();
    return Boolean(text) && text !== prefilled;
  };

  function close() {
    if (topic !== null && running()) {
      saveThread(true);
      side?.cancel(topic);
    }
    generation++;
    topic = null;
    asked = [];
    threadNote = null;
    savedThread = null;
    prefilled = '';
    drawThread = null;
    mode = 'closed';
    keyed = {};
    pop.hidden = true;
    pop.replaceChildren();
    panel.replaceChildren();
    panel.remove();
  }

  /** Floats the buttons under (or, without room, over) `rect`, inside the host. @param {DOMRect} rect */
  function place(rect) {
    pop.hidden = false;
    const box = host.getBoundingClientRect();
    const width = pop.offsetWidth;
    const height = pop.offsetHeight;
    const left = Math.min(Math.max(EDGE_PX, rect.right - box.left - width / 2), box.width - width - EDGE_PX);
    let top = rect.bottom - box.top + GAP_PX;
    if (top + height > box.height - EDGE_PX) top = Math.max(EDGE_PX, rect.top - box.top - height - GAP_PX);
    pop.style.left = `${Math.max(EDGE_PX, left)}px`;
    pop.style.top = `${top}px`;
  }

  /**
   * Where the box goes for a selection ending at `node`: after the block it ends in, or at the
   * end of the transcript's entry holding it (never between entries, which the window places).
   * @param {Node} node @returns {{ below: Element } | { inside: Element } | null}
   */
  function spot(node) {
    const start = node instanceof Element ? node : node.parentElement;
    const block = start?.closest(BLOCK);
    if (block && transcript.contains(block)) {
      // A list item or a table cell takes the box after its whole list or table.
      const list = block.parentElement?.closest('.omp-md > ul, .omp-md > ol');
      return { below: list ?? block };
    }
    let entry = start;
    while (entry && entry.parentElement !== transcript) entry = entry.parentElement;
    return entry ? { inside: entry } : null;
  }

  /** The selected transcript text, where its last line ends, where the box would go and what it cites. */
  function selection() {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!transcript.contains(range.commonAncestorContainer) || panel.contains(range.commonAncestorContainer)) return null;
    const text = sel.toString().trim();
    const rects = range.getClientRects();
    const end = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    const at = spot(range.endContainer);
    return text && at ? { text, end, at, range } : null;
  }

  /** @param {string} label @param {string} key the letter that presses it too @param {() => void} onClick */
  function actionButton(label, key, onClick) {
    const action = button('omp-quote-btn', label, onClick);
    action.title = `${label} (${key.toUpperCase()})`;
    action.setAttribute('aria-keyshortcuts', key.toUpperCase());
    // Keep the selection (and its highlight) while the button is pressed.
    action.addEventListener('pointerdown', (e) => e.preventDefault());
    keyed[key] = onClick;
    return action;
  }

  function offerButtons() {
    if (mode === 'editing' && drafted()) return;
    const found = selection();
    // A shown thread stays until it is closed, or replaced by a new selection once nothing in
    // it is running or written and not sent.
    if (mode === 'thread' && (!found || running() || drafted())) return;
    if (!found) {
      if (mode === 'buttons') close();
      return;
    }
    if (mode === 'buttons' && found.text === quote) return; // already offered for it
    close();
    quote = found.text;
    quoteCite = cite(found.range);
    quoteAnchor = annotations?.anchor(found.range, found.text) ?? null;
    pop.replaceChildren(
      actionButton('Comment', 'c', () => openBox(found.at, 'comment')),
      actionButton('Ask', 'a', () => openBox(found.at, 'ask')),
    );
    mode = 'buttons';
    place(found.end);
  }

  /** Puts the box where `at` says, and keeps it in view. @param {{ below: Element } | { inside: Element }} at */
  function insertPanel(at) {
    if ('below' in at) at.below.after(panel);
    else at.inside.append(panel);
    panel.scrollIntoView({ block: 'nearest' });
  }

  /** The field, grown with its text, Enter sending and Shift+Enter starting a new line. @param {string} placeholder @param {() => void} enter */
  function field(placeholder, enter) {
    const box = el('textarea', 'omp-quote-input');
    box.rows = 1;
    box.placeholder = placeholder;
    box.setAttribute('aria-label', placeholder);
    box.addEventListener('input', () => autosize(box, { max: INPUT_MAX_PX }));
    box.addEventListener('keydown', (e) => {
      if (e.isComposing || e.defaultPrevented) return; // an open @ list took it
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        enter();
      }
    });
    return box;
  }

  /**
   * The box for a comment or a question on the quote, as `action` chose; Enter sends it. With
   * `editing`, the comment kept for it, there to edit: emptied, it goes.
   * @param {{ below: Element } | { inside: Element }} at @param {'comment' | 'ask'} action
   * @param {Annotation | null} [editing]
   */
  function openBox(at, action, editing = null) {
    mode = 'editing';
    pop.hidden = true;
    const submit = () => {
      const text = box.value.trim();
      if (editing) {
        if (!text) void annotations?.remove(editing.id);
        else if (text !== editing.comment) void annotations?.update(editing.id, { comment: text });
        close();
        return;
      }
      if (!text) return;
      document.getSelection()?.removeAllRanges();
      if (action === 'comment') {
        onComment(quote, text, quoteCite, quoteAnchor);
        close();
      } else if (queued) {
        queued.queue(quote, text, quoteCite);
        close();
      } else {
        openThread();
        askInThread(text);
      }
    };
    const box = field(
      action === 'comment' ? 'Your comment on this…' : queued ? 'Your question about this; it goes to the agent with your review…' : 'Ask about this; the answer stays out of the chat…',
      submit,
    );
    const go = button('btn btn-accent', action === 'comment' ? (queued ? 'Add comment' : 'Comment') : queued ? 'Add question' : 'Ask', submit);
    if (editing) box.value = prefilled = editing.comment ?? '';
    const sync = () => {
      go.disabled = !editing && !box.value.trim();
    };
    box.addEventListener('input', sync);
    sync();
    const actions = el('div', 'omp-quote-actions');
    actions.append(button('btn', 'Cancel', close), go);
    panel.replaceChildren(el('blockquote', 'omp-quote-preview', quote), withMentions(box, listDir), actions);
    insertPanel(at);
    autosize(box, { max: INPUT_MAX_PX });
    box.focus({ preventScroll: true });
  }

  /**
   * Shows the side questions about the quote in the box, each with its answer as it streams
   * in, and a field for a follow-up that is available whenever no answer is on its way.
   * Reopened on annotation `reopened`, it also offers to remove it.
   * @param {string | null} [reopened]
   */
  function openThread(reopened = null) {
    mode = 'thread';
    const thread = el('div', 'omp-ask-thread');
    thread.setAttribute('aria-live', 'polite');
    const askBtn = button('btn btn-accent', 'Ask');
    const closeBtn = button('btn', 'Close', close);
    const send = () => {
      const text = box.value.trim();
      if (!text || running()) return;
      box.value = '';
      autosize(box, { max: INPUT_MAX_PX });
      askBtn.disabled = true;
      closeBtn.focus();
      askInThread(text);
    };
    const box = field('Ask a follow-up…', send);
    askBtn.addEventListener('click', send);
    box.addEventListener('input', () => {
      askBtn.disabled = !box.value.trim() || running();
    });
    askBtn.disabled = true;
    const actions = el('div', 'omp-quote-actions');
    if (reopened) {
      const removeBtn = button('btn omp-quote-remove', 'Remove', () => {
        void annotations?.remove(reopened);
        close();
      });
      actions.append(closeBtn, removeBtn, askBtn);
    } else actions.append(closeBtn, askBtn);
    panel.replaceChildren(el('blockquote', 'omp-quote-preview', quote), thread, withMentions(box, listDir), actions);
    closeBtn.focus({ preventScroll: true }); // Esc closes from here while the field is unavailable

    /** Each question's answer as drawn, by its place in `asked`. @type {{ body: HTMLElement, key: string }[]} */
    const drawn = [];
    let wasRunning = false;
    drawThread = () => {
      let changed = false;
      asked.forEach((entry, i) => {
        let view = drawn[i];
        if (!view) {
          view = drawn[i] = { body: el('div', 'omp-ask-answer'), key: '' };
          thread.append(el('p', 'omp-ask-question', entry.question), view.body);
        }
        const [key, build] = answerView(entry);
        if (key === view.key) return;
        view.key = key;
        view.body.replaceChildren(...build());
        changed = true;
      });
      // omp answers one side question at a time: the field waits while one is on its way.
      const busy = running();
      box.disabled = busy;
      // Once the answer is in, the field takes over from Close, unless the reader moved on.
      if (wasRunning && !busy && document.activeElement === closeBtn) box.focus({ preventScroll: true });
      wasRunning = busy;
      if (changed && panel.isConnected) panel.scrollIntoView({ block: 'nearest' });
      saveThread();
    };
    drawThread();
  }

  /**
   * What the thread shows under a question, and a key that changes whenever that does.
   * @param {Asked} entry @returns {[string, () => Node[]]}
   */
  function answerView(entry) {
    const line = (/** @type {string} */ text, cls = 'omp-ask-status') => el('p', cls, text);
    const failed = entry.error;
    if (failed !== null) return [`failed:${failed}`, () => [line(failed, 'omp-ask-error')]];
    const answer = answerTo(entry);
    if (!answer || (answer.status === 'running' && !answer.answer)) return ['waiting', () => [line('Thinking…')]];
    const { answer: text, status, error } = answer;
    return [
      `${status}:${error}:${text}`,
      () => {
        /** @type {Node[]} */
        const parts = text ? [renderMarkdown(text)] : [];
        if (status === 'error') parts.push(line(error ?? 'The question failed.', 'omp-ask-error'));
        else if (status === 'cancelled' || status === 'interrupted') parts.push(line(text ? 'Stopped.' : 'Stopped before it answered.'));
        return parts;
      },
    ];
  }

  /**
   * Asks `question` in the shown thread: about the quote, or as a follow-up once omp has a
   * topic for the thread.
   * @param {string} question
   */
  function askInThread(question) {
    if (!side) return;
    /** @type {Asked} */
    const entry = { question, topic: null, turn: null, error: null, kept: null };
    asked.push(entry);
    drawThread?.();
    const sent = generation;
    void side.send(quote, question, topic ?? undefined).then((result) => {
      if (sent !== generation) {
        if ('id' in result) side.cancel(result.id); // closed before omp took it
        return;
      }
      if ('error' in result) entry.error = result.error;
      else {
        topic = entry.topic = result.id;
        entry.turn = result.turn;
      }
      drawThread?.();
    });
  }

  // A selection is finished once no pointer button holds it: when the button lets go, and
  // on every change made without one (Shift+arrows, a click that collapses it on release).
  let pressed = false;
  const onPointerDown = () => {
    pressed = true;
  };
  const onPointerUp = () => {
    pressed = false;
    const sel = document.getSelection();
    const within = sel && sel.rangeCount ? sel.getRangeAt(0).commonAncestorContainer : null;
    if (sel && within && transcript.contains(within) && !panel.contains(within)) snapToWords(sel);
    offerButtons();
  };
  const onPointerCancel = () => {
    pressed = false;
  };
  const onSelectionChange = () => {
    if (!pressed) offerButtons();
    else if (mode === 'buttons' && !selection()) close();
  };
  // New output scrolls the transcript under a selection: the buttons follow it, and go only
  // with it.
  const onScroll = () => {
    if (mode !== 'buttons') return;
    const found = selection();
    if (!found) return close();
    // Scrolled out of view, the selection keeps its buttons hidden until it is back.
    const view = transcript.getBoundingClientRect();
    if (found.end.bottom < view.top || found.end.top > view.bottom) pop.hidden = true;
    else place(found.end);
  };
  /** @param {KeyboardEvent} e */
  const onKeyDown = (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return; // an open @ list closes first
    e.stopPropagation(); // not the pane's Esc-to-stop
    close();
  };
  /**
   * C or A while the buttons show presses Comment or Ask. Wherever focus is: a selection in the
   * transcript means no field is being typed in, but a field that has the key anyway keeps it.
   * The key is taken, so the box it opens and focuses does not get the letter.
   * @param {KeyboardEvent} e
   */
  const onShortcut = (e) => {
    if (mode !== 'buttons' || pop.hidden || e.defaultPrevented || e.isComposing || e.repeat) return;
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return; // ⌘C copies the selection
    const target = /** @type {HTMLElement} */ (e.target);
    if (target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    const press = keyed[e.key.toLowerCase()];
    if (!press || !selection()) return;
    e.preventDefault();
    e.stopPropagation();
    press();
  };
  /** @param {PointerEvent} e */
  const onOutside = (e) => {
    const target = /** @type {Node} */ (e.target);
    if (pop.contains(target) || panel.contains(target)) return;
    // A written box and an answer still coming are not thrown away by a stray click.
    if (drafted()) return;
    if ((mode === 'editing' || mode === 'thread') && !running()) close();
  };
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointerup', onPointerUp, true);
  document.addEventListener('pointercancel', onPointerCancel, true);
  transcript.addEventListener('scroll', onScroll);
  pop.addEventListener('keydown', onKeyDown);
  panel.addEventListener('keydown', onKeyDown);
  document.addEventListener('selectionchange', onSelectionChange);
  document.addEventListener('keydown', onShortcut);
  document.addEventListener('pointerdown', onOutside, true);

  return {
    /**
     * Shows the box for `annotation` again, under the block its text (`range`) ends in: the
     * comment to edit, or the questions and their answers, with a field for another (asked in
     * a new topic about the quote, as omp's topic may be gone). Nothing changes while a box holds
     * something written or an answer on its way.
     * @param {Annotation} annotation @param {Range} range
     */
    open(annotation, range) {
      if (drafted() || running()) return;
      const at = spot(range.endContainer);
      if (!at) return;
      close();
      quote = annotation.quote;
      quoteCite = null;
      quoteAnchor = { at: annotation.at, occurrence: annotation.occurrence };
      if (annotation.kind === 'comment') return openBox(at, 'comment', annotation);
      asked = annotation.thread.map((qa) => ({ question: qa.question, topic: null, turn: null, error: null, kept: qa }));
      threadNote = Promise.resolve(annotation.id);
      savedThread = JSON.stringify(annotation.thread);
      insertPanel(at);
      openThread(annotation.id);
    },
    /** Redraws a shown thread from the latest session state. */
    refresh() {
      drawThread?.();
    },
    destroy() {
      close();
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointerup', onPointerUp, true);
      document.removeEventListener('pointercancel', onPointerCancel, true);
      transcript.removeEventListener('scroll', onScroll);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('keydown', onShortcut);
      document.removeEventListener('pointerdown', onOutside, true);
      pop.remove();
    },
  };
}
