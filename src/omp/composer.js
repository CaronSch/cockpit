/**
 * The agent pane's message box: a draft that starts one line high and grows with its text up
 * to half the pane, cards for what goes with the next message (comments on quoted transcript
 * text, files), and the Send button.
 *
 * Pasted text goes into the draft as typed. Files pasted into it or dropped anywhere on the
 * pane are stored by the daemon as they arrive, and go with the message as omp file mentions. A draft starting with `!` is a shell
 * command: the box switches to shell mode (accent-coloured, marked with the directory it runs
 * in, Run for Send) and shows the cards as waiting, since a command goes without them. Tab
 * indents, as in a code editor (Esc then Tab leaves the box).
 */
import { button, carriesFiles, el } from '../ui/dom.js';
import { errorMessage } from '../ui/format.js';
import { autosize } from '../ui/autosize.js';
import { tabIndent } from '../ui/indent.js';
import { onZoom } from '../ui/zoom.js';
import { composeMessage, shellCommand } from './message.js';
/** @import { QuoteComment } from './message.js' */

/**
 * A file card. `path` stays null until the daemon has stored the file; `stored` settles then
 * (a failed upload removes the card).
 * @typedef {{ kind: 'file', name: string, size: number, preview: string | null, path: string | null, stored: Promise<void> }} FileCard
 */
/** One card above the draft. @typedef {({ kind: 'comment' } & QuoteComment) | FileCard} Card */
/** A card as kept with an unsent message (omp/drafts.js): a comment, or a stored file. @typedef {({ kind: 'comment' } & QuoteComment) | { kind: 'file', name: string, size: number, path: string }} KeptCard */
/** What the box holds worth keeping: its text and its cards. @typedef {{ text: string, cards: KeptCard[] }} Kept */

/** The draft never grows past this share of the pane, nor shrinks its cap below MIN_MAX_PX. */
const MAX_SHARE = 0.5;
const MIN_MAX_PX = 120;
const EXCERPT_CHARS = 80;

/** @param {string} text */
const excerpt = (text) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > EXCERPT_CHARS ? `${line.slice(0, EXCERPT_CHARS - 1)}…` : line;
};

/** @param {number} bytes */
const size = (bytes) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * @param {{
 *   pane: HTMLElement,
 *   upload: (file: Blob, name: string) => Promise<string>,
 *   onError: (message: string) => void,
 *   shellDir: () => { label: string, path: string },
 *   onChange?: () => void,
 * }} options `pane`: caps the draft's height and takes dropped files; `upload` stores a file
 * and answers with its path; `onError` hears about a file that could not be attached;
 * `shellDir` names the directory a shell command runs in, for shell mode's marker; `onChange`
 * hears whenever what the box keeps (`kept`) may have changed.
 */
export function createComposer({ pane, upload, onError, shellDir, onChange = () => {} }) {
  const root = el('div', 'omp-composer');
  const cards = el('div', 'omp-cards');
  cards.hidden = true;
  const heldNote = el('p', 'omp-cards-note', 'These wait for your next prompt: the command runs without them.');
  const editor = el('div', 'omp-card-editor');
  editor.hidden = true;
  const mark = el('div', 'omp-shell-mark');
  mark.id = `omp-shell-${Math.random().toString(36).slice(2)}`;
  mark.hidden = true;
  const markDir = el('span', 'omp-shell-dir');
  mark.append(el('span', 'omp-shell-label', '$ shell'), markDir, el('span', 'omp-shell-hint', 'Enter runs it as a command, not a prompt'));
  const row = el('div', 'omp-compose-row');
  const draft = el('textarea', 'omp-draft');
  draft.rows = 1;
  draft.setAttribute('aria-label', 'Message the agent');
  const sendBtn = button('btn btn-accent', 'Send');
  row.append(draft, sendBtn);
  root.append(cards, editor, mark, row);
  // Tab indents in the draft and the card editor; an open suggestion list takes it first.
  tabIndent(root);

  /** @type {Card[]} */
  let items = [];
  /** Whether the draft is a `!` shell command. */
  let shell = false;
  /** @type {Set<string>} */
  const previews = new Set();

  const maxHeight = () => Math.max(MIN_MAX_PX, pane.clientHeight * MAX_SHARE);
  const fit = () => autosize(draft, { max: maxHeight() });
  /** The draft's text changed: refit it, switch shell mode on or off, and say so. */
  const changed = () => {
    fit();
    drawMode();
    onChange();
  };
  draft.addEventListener('input', changed);
  // The cap follows the pane, and the wrap follows the draft's width.
  const resizes = new ResizeObserver(fit);
  resizes.observe(pane);
  const offZoom = onZoom(fit);

  draft.addEventListener('paste', (e) => {
    const files = e.clipboardData?.files;
    if (!files?.length) return;
    e.preventDefault();
    attachFiles([...files]);
  });

  /** @param {DragEvent} e */
  const onDragOver = (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    pane.classList.add('is-dropping');
  };
  /** @param {DragEvent} e */
  const onDragLeave = (e) => {
    if (!(e.relatedTarget instanceof Node && pane.contains(e.relatedTarget))) pane.classList.remove('is-dropping');
  };
  /** @param {DragEvent} e */
  const onDrop = (e) => {
    pane.classList.remove('is-dropping');
    if (!carriesFiles(e)) return;
    e.preventDefault();
    attachFiles([...(e.dataTransfer?.files ?? [])]);
    draft.focus();
  };
  pane.addEventListener('dragover', onDragOver);
  pane.addEventListener('dragleave', onDragLeave);
  pane.addEventListener('drop', onDrop);

  /** @param {File[]} files */
  function attachFiles(files) {
    for (const file of files) {
      const name = file.name || 'pasted-file';
      const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
      if (preview) previews.add(preview);
      /** @type {FileCard} */
      const card = { kind: 'file', name, size: file.size, preview, path: null, stored: Promise.resolve() };
      card.stored = upload(file, name).then(
        (path) => {
          card.path = path;
          drawCards();
        },
        (err) => {
          remove(card);
          onError(`Could not attach ${name}: ${errorMessage(err)}`);
        },
      );
      items = [...items, card];
    }
    drawCards();
  }

  /** @param {Card} card */
  function remove(card) {
    if (!items.includes(card)) return;
    items = items.filter((c) => c !== card);
    if (card.kind === 'file' && card.preview) {
      URL.revokeObjectURL(card.preview);
      previews.delete(card.preview);
    }
    closeEditor();
    drawCards();
  }

  /** @param {Card} card @param {Card} next */
  function replace(card, next) {
    items = items.map((c) => (c === card ? next : c));
    drawCards();
  }

  /** @param {Card} card */
  function cardView(card) {
    const view = el('div', `omp-card is-${card.kind}`);
    const main = el(card.kind === 'file' ? 'div' : 'button', 'omp-card-main');
    const removeBtn = button('omp-card-remove', '×', () => remove(card));
    if (card.kind === 'comment') {
      main.title = 'Edit this comment';
      main.append(el('span', 'omp-card-quote', `“${excerpt(card.quote)}”`), el('span', 'omp-card-text', excerpt(card.comment)));
      main.addEventListener('click', () =>
        openEditor({
          label: 'Edit comment',
          quote: card.quote,
          value: card.comment,
          onSave: (value) => (value.trim() ? replace(card, { ...card, comment: value.trim() }) : remove(card)),
        }),
      );
      removeBtn.setAttribute('aria-label', 'Remove comment');
    } else {
      view.classList.toggle('is-uploading', card.path === null);
      main.title = card.path ?? 'Uploading…';
      if (card.preview) {
        const thumb = el('img', 'omp-card-thumb');
        thumb.src = card.preview;
        thumb.alt = '';
        view.prepend(thumb);
      }
      main.append(el('span', 'omp-card-text', card.name), el('span', 'omp-card-quote', card.path ? size(card.size) : 'uploading…'));
      removeBtn.setAttribute('aria-label', `Remove ${card.name}`);
    }
    if (main instanceof HTMLButtonElement) main.type = 'button';
    view.append(main, removeBtn);
    return view;
  }

  function drawCards() {
    // A command goes without the cards: say so, rather than let them look attached to it.
    const held = shell && items.length > 0;
    cards.classList.toggle('is-held', held);
    cards.replaceChildren(...(held ? [heldNote] : []), ...items.map(cardView));
    cards.hidden = items.length === 0;
    onChange();
  }

  /** Shell mode while the draft is a `!` command: it looks like one and says where it runs. */
  function drawMode() {
    const next = shellCommand(draft.value) !== null;
    if (next === shell) return;
    shell = next;
    root.classList.toggle('is-shell', shell);
    mark.hidden = !shell;
    sendBtn.textContent = shell ? 'Run' : 'Send';
    if (shell) {
      const dir = shellDir();
      markDir.textContent = `· ${dir.label}`;
      mark.title = dir.path;
      draft.setAttribute('aria-describedby', mark.id);
    } else {
      draft.removeAttribute('aria-describedby');
    }
    drawCards();
  }

  function closeEditor() {
    editor.hidden = true;
    editor.replaceChildren();
  }

  /**
   * Opens the editor above the draft for a comment.
   * @param {{ label: string, quote: string, value: string, onSave: (value: string) => void }} options
   */
  function openEditor({ label, quote, value, onSave }) {
    const box = el('textarea', 'omp-card-input');
    box.value = value;
    box.setAttribute('aria-label', label);
    const save = button('btn btn-accent', 'Save');
    const cancel = button('btn', 'Cancel');
    const actions = el('div', 'omp-row');
    actions.append(save, cancel);
    editor.replaceChildren(el('blockquote', 'omp-quote-preview', quote), box, actions);
    editor.hidden = false;
    const done = () => {
      closeEditor();
      draft.focus();
    };
    save.addEventListener('click', () => {
      onSave(box.value);
      done();
    });
    cancel.addEventListener('click', done);
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        done();
      }
    });
    box.addEventListener('input', () => autosize(box, { max: maxHeight() }));
    autosize(box, { max: maxHeight() });
    box.focus();
  }

  return {
    root,
    draft,
    sendBtn,
    get text() {
      return draft.value;
    },
    /** The text and the cards, as kept with an unsent message: a file once it is stored. @returns {Kept} */
    get kept() {
      return {
        text: draft.value,
        cards: items.flatMap((c) =>
          /** @type {KeptCard[]} */ (
            c.kind === 'comment' ? [{ kind: 'comment', quote: c.quote, comment: c.comment }] : c.path ? [{ kind: 'file', name: c.name, size: c.size, path: c.path }] : []
          ),
        ),
      };
    },
    /** Puts back what was kept: its text and its cards (a file without its thumbnail). @param {Kept} kept */
    load(kept) {
      draft.value = kept.text;
      items = kept.cards.map((c) => (c.kind === 'file' ? { ...c, preview: null, stored: Promise.resolve() } : c));
      changed();
      drawCards();
    },
    /** Replaces the draft (a restored or prefilled message) and fits it. @param {string} text */
    setText(text) {
      draft.value = text;
      changed();
    },
    /** Puts `text` in place of the draft's `start`…`end`, the caret after it. @param {number} start @param {number} end @param {string} text */
    replace(start, end, text) {
      draft.setRangeText(text, start, end, 'end');
      changed();
    },
    /** Adds a comment on `quote` to go with the next message. @param {string} quote @param {string} comment */
    addComment(quote, comment) {
      items = [...items, { kind: 'comment', quote, comment }];
      drawCards();
    },
    /** Settles once every file attached so far is stored (or has failed and been dropped). */
    async settled() {
      await Promise.all(items.map((c) => (c.kind === 'file' ? c.stored : null)));
    },
    /**
     * What Send would send now, without sending it: the draft alone (`withCards` false, for
     * commands) or with every card whose file is stored. `take()` empties the composer of
     * exactly that (the draft only if it is unchanged); `restore()` puts it back if the
     * message was refused, unless something new has been written meanwhile.
     * @param {{ withCards: boolean }} options
     */
    compose({ withCards }) {
      const text = draft.value;
      const taken = withCards ? items.filter((c) => c.kind !== 'file' || c.path !== null) : [];
      /** @type {QuoteComment[]} */
      const comments = [];
      /** @type {string[]} */
      const files = [];
      for (const card of taken) {
        if (card.kind === 'comment') comments.push({ quote: card.quote, comment: card.comment });
        else if (card.path) files.push(card.path);
      }
      return {
        message: withCards ? composeMessage(text, comments, files) : text.trim(),
        take() {
          if (draft.value === text) draft.value = '';
          items = items.filter((c) => !taken.includes(c));
          closeEditor();
          changed();
          drawCards();
          return {
            restore() {
              if (draft.value || (taken.length && items.length)) return;
              draft.value = text;
              items = [...taken, ...items];
              changed();
              drawCards();
            },
          };
        },
      };
    },
    destroy() {
      resizes.disconnect();
      offZoom();
      pane.removeEventListener('dragover', onDragOver);
      pane.removeEventListener('dragleave', onDragLeave);
      pane.removeEventListener('drop', onDrop);
      for (const url of previews) URL.revokeObjectURL(url);
    },
  };
}

/** @typedef {ReturnType<typeof createComposer>} Composer */
