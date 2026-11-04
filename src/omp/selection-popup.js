/**
 * Actions on highlighted transcript text: select part of a reply and Comment and Ask buttons
 * appear at the end of the selection. A selection dragged with the pointer snaps out to whole
 * words when it is let go, so a rough drag quotes clean text. Comment opens a box for a comment, handed to the
 * composer with the selected text as its quote. Ask opens a box for a side question about it,
 * whose short answer streams into the popup and never enters the chat (omp's `btw`); follow-up
 * questions continue the same topic there, one at a time. Where questions are queued instead
 * (the pull request window's review), Ask hands the question over as Comment does.
 */
import { button, el } from '../ui/dom.js';
import { autosize } from '../ui/autosize.js';
import { renderMarkdown } from './markdown-dom.js';
import { snapToWords } from '../ui/word-snap.js';
import { withMentions } from './file-suggest.js';
/** @import { SideAnswer } from './transcript.js' */
/** @import { ListDir } from './file-suggest.js' */

const GAP_PX = 6;
const EDGE_PX = 8;
const INPUT_MAX_PX = 160;

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
 * A question asked in the shown thread: its turn in omp's topic once omp has taken it, or why
 * it could not be asked.
 * @typedef {{ question: string, turn: number | null, error: string | null }} Asked
 */

/** What each action's box says. */
const ACTIONS = {
  comment: { placeholder: 'Your comment on this…', label: 'Comment on the selected text', submit: 'Add comment' },
  ask: { placeholder: 'Ask about this; the answer stays out of the chat…', label: 'Ask about the selected text', submit: 'Ask' },
  queue: { placeholder: 'Your question about this; it goes to the agent with your review…', label: 'Ask about the selected text', submit: 'Add question' },
};

/**
 * @param {{
 *   host: HTMLElement,
 *   transcript: HTMLElement,
 *   onComment: (quote: string, comment: string, cite: string | null) => void,
 *   ask: SideQuestions | QueuedQuestions,
 *   cite?: (range: Range) => string | null,
 *   listDir?: ListDir,
 * }} options `host`: the positioned element the popup lives in; `transcript`: where selections count;
 * `cite` says where a selection is, for the comment or question on it (e.g. a file and its lines);
 * `listDir`, if given, lists the folders `@` paths typed in its boxes name, to suggest their entries.
 * Call `refresh()` whenever the session's state changes, so a shown thread keeps up.
 */
export function attachSelectionPopup({ host, transcript, onComment, ask, cite = () => null, listDir }) {
  const queued = 'queue' in ask ? ask : null;
  const side = 'queue' in ask ? null : ask;
  const pop = el('div', 'omp-quote-pop');
  pop.hidden = true;
  host.append(pop);
  /** @type {'closed' | 'buttons' | 'editing' | 'thread'} */
  let mode = 'closed';
  let quote = '';
  /** Where the quote is, as `cite` said. @type {string | null} */
  let quoteCite = null;
  /** omp's id for the side topic shown, once it has taken a question in it. @type {string | null} */
  let topic = null;
  /** The questions asked in the shown thread, oldest first. @type {Asked[]} */
  let asked = [];
  /** Bumped on close, so a question still on its way is cancelled once omp names it. */
  let generation = 0;
  /** Redraws the shown thread; null unless one is shown. @type {(() => void) | null} */
  let drawThread = null;

  /** omp's answer to `entry` so far; undefined until omp has taken it and said so. @param {Asked} entry */
  const answerTo = (entry) => (entry.turn === null || topic === null ? undefined : side?.answers(topic)?.[entry.turn]);
  /** Whether the thread's newest question is still on its way or being answered: omp runs one at a time. */
  const running = () => {
    const newest = asked.at(-1);
    return mode === 'thread' && newest !== undefined && newest.error === null && (answerTo(newest)?.status ?? 'running') === 'running';
  };
  /** Whether the popup's box holds something written and not sent yet. */
  const drafted = () => Boolean(pop.querySelector('textarea')?.value.trim());

  function close() {
    if (topic !== null && running()) side?.cancel(topic);
    generation++;
    topic = null;
    asked = [];
    drawThread = null;
    mode = 'closed';
    pop.hidden = true;
    pop.classList.remove('is-answer');
    pop.replaceChildren();
  }

  /** Places the popup under (or, without room, over) `rect`, inside the host. @param {DOMRect} rect */
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

  /** The selected transcript text, where its last line ends, and where it is, if there is one. */
  function selection() {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!transcript.contains(range.commonAncestorContainer)) return null;
    const text = sel.toString().trim();
    const rects = range.getClientRects();
    const end = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    return text ? { text, end, cite: cite(range) } : null;
  }

  /** @param {string} label @param {string} title @param {() => void} onClick */
  function actionButton(label, title, onClick) {
    const action = button('btn omp-quote-btn', label, onClick);
    action.title = title;
    // Keep the selection (and its highlight) while the button is pressed.
    action.addEventListener('pointerdown', (e) => e.preventDefault());
    return action;
  }

  function offerButtons() {
    if (mode === 'editing') return;
    const found = selection();
    // A shown thread stays until it is closed, or replaced by a new selection once nothing in
    // it is running or written and not sent.
    if (mode === 'thread' && (!found || running() || drafted())) return;
    if (!found) return close();
    if (mode === 'buttons' && found.text === quote) return; // already offered for it
    close();
    quote = found.text;
    quoteCite = found.cite;
    pop.replaceChildren(
      actionButton('Comment', `Comment on the selected text; the comment goes ${queued ? 'to the agent with your review' : 'with your next message'}`, () => openEditor(found.end, 'comment')),
      queued
        ? actionButton('Ask', 'Ask a question about the selected text; it goes to the agent with your other notes', () => openEditor(found.end, 'queue'))
        : actionButton('Ask', 'Ask a quick question about the selected text; the answer is not added to the chat', () => openEditor(found.end, 'ask')),
    );
    mode = 'buttons';
    place(found.end);
  }

  /**
   * Wires a box and its button: the button sends once something is written, Enter sends and
   * Shift+Enter starts a new line, as in the composer.
   * @param {HTMLTextAreaElement} box @param {HTMLButtonElement} submitBtn @param {() => void} submit
   */
  function wireBox(box, submitBtn, submit) {
    submitBtn.disabled = true;
    box.addEventListener('input', () => {
      submitBtn.disabled = !box.value.trim();
      autosize(box, { max: INPUT_MAX_PX });
    });
    box.addEventListener('keydown', (e) => {
      if (e.isComposing || e.defaultPrevented) return; // an open @ list took it
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    });
    submitBtn.addEventListener('click', submit);
  }

  /** @param {DOMRect} anchor @param {keyof typeof ACTIONS} action */
  function openEditor(anchor, action) {
    const words = ACTIONS[action];
    mode = 'editing';
    const preview = el('blockquote', 'omp-quote-preview', quote);
    const box = el('textarea', 'omp-quote-input');
    box.rows = 2;
    box.placeholder = words.placeholder;
    box.setAttribute('aria-label', words.label);
    const submitBtn = button('btn btn-accent', words.submit);
    const cancel = button('btn', 'Cancel', close);
    const actions = el('div', 'omp-row');
    actions.append(submitBtn, cancel);
    pop.replaceChildren(preview, withMentions(box, listDir), actions);
    place(anchor);
    box.focus();
    wireBox(box, submitBtn, () => {
      const text = box.value.trim();
      if (!text) return;
      document.getSelection()?.removeAllRanges();
      if (action === 'comment') {
        onComment(quote, text, quoteCite);
        close();
      } else if (action === 'queue') {
        queued?.queue(quote, text, quoteCite);
        close();
      } else {
        openThread(anchor);
        askInThread(text);
      }
    });
  }

  /**
   * Shows the side questions about the quote, each with its answer as it streams in, and a box
   * for a follow-up that is available whenever no answer is on its way.
   * @param {DOMRect} anchor
   */
  function openThread(anchor) {
    mode = 'thread';
    pop.classList.add('is-answer');
    const thread = el('div', 'omp-ask-thread');
    thread.setAttribute('aria-live', 'polite');
    const box = el('textarea', 'omp-quote-input');
    box.rows = 1;
    box.placeholder = 'Ask a follow-up…';
    box.setAttribute('aria-label', 'Ask a follow-up');
    const askBtn = button('btn btn-accent', 'Ask');
    const closeBtn = button('btn', 'Close', close);
    const actions = el('div', 'omp-row');
    actions.append(askBtn, closeBtn);
    pop.replaceChildren(el('blockquote', 'omp-quote-preview', quote), thread, withMentions(box, listDir), actions);
    closeBtn.focus(); // Esc closes from here while the box is unavailable
    wireBox(box, askBtn, () => {
      const text = box.value.trim();
      if (!text) return;
      box.value = '';
      askBtn.disabled = true;
      autosize(box, { max: INPUT_MAX_PX });
      closeBtn.focus();
      askInThread(text);
    });

    /** Each question's answer as drawn, by its place in `asked`. @type {{ body: HTMLElement, key: string }[]} */
    const drawn = [];
    let wasRunning = false;
    drawThread = () => {
      const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 4;
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
      // omp answers one side question at a time: the box waits while one is on its way.
      const busy = running();
      box.disabled = busy;
      // Once the answer is in, the box takes over from Close, unless the reader moved on.
      if (wasRunning && !busy && document.activeElement === closeBtn) box.focus();
      wasRunning = busy;
      if (!changed) return;
      place(anchor);
      if (atBottom) thread.scrollTop = thread.scrollHeight;
    };
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
    const entry = { question, turn: null, error: null };
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
        topic = result.id;
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
    if (sel && sel.rangeCount && transcript.contains(sel.getRangeAt(0).commonAncestorContainer)) snapToWords(sel);
    offerButtons();
  };
  const onPointerCancel = () => {
    pressed = false;
  };
  const onSelectionChange = () => {
    if (!pressed) offerButtons();
    else if (mode === 'buttons' && !selection()) close();
  };
  const onScroll = () => {
    if (mode === 'buttons') close();
  };
  /** @param {KeyboardEvent} e */
  const onKeyDown = (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation(); // not the pane's Esc-to-stop
    close();
  };
  /** @param {PointerEvent} e */
  const onOutside = (e) => {
    if (pop.contains(/** @type {Node} */ (e.target))) return;
    // A half-written box and an answer still coming are not thrown away by a stray click.
    if (drafted()) return;
    if ((mode === 'editing' || mode === 'thread') && !running()) close();
  };
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointerup', onPointerUp, true);
  document.addEventListener('pointercancel', onPointerCancel, true);
  transcript.addEventListener('scroll', onScroll);
  pop.addEventListener('keydown', onKeyDown);
  document.addEventListener('selectionchange', onSelectionChange);
  document.addEventListener('pointerdown', onOutside, true);

  return {
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
      document.removeEventListener('pointerdown', onOutside, true);
      pop.remove();
    },
  };
}
