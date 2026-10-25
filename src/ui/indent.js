/**
 * Tab and Shift+Tab indent and outdent text in a textarea, as in a code editor, and Backspace
 * in a line's leading spaces takes a whole indent back; Esc then Tab leaves the field instead,
 * so keyboard users are never trapped in it.
 *
 * The edit itself (`indent`, `outdent`, `unindent`) is plain text in, text out, so it can be tested
 * without a DOM. `tabIndent` applies it through `document.execCommand('insertText')`: that
 * command is deprecated, but it is the only way a script's edit lands on the textarea's own
 * undo stack (Cmd/Ctrl+Z undoes it) and fires `input` as typing does; `setRangeText` and
 * setting `value` do neither.
 */

/** One indent level: two spaces, which Markdown reads as nesting and omp's prompts keep as typed. */
const INDENT = '  ';

/**
 * Replace `from`…`to` of the text with `text`, then select `start`…`end` of the result.
 * @typedef {{ from: number, to: number, text: string, start: number, end: number }} IndentEdit
 */

/** @param {string} text */
const leadingSpaces = (text) => text.length - text.replace(/^ +/, '').length;

/**
 * The lines a selection touches, by where each starts: one that the selection only reaches
 * the start of (a selection of whole lines ends there) is not one of them.
 * @param {string} text @param {number} start @param {number} end
 */
function touchedLines(text, start, end) {
  const last = end > start && text[end - 1] === '\n' ? end - 1 : end;
  const starts = [start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1];
  for (let at = text.indexOf('\n', starts[0]); at !== -1 && at < last; at = text.indexOf('\n', at + 1)) starts.push(at + 1);
  const close = text.indexOf('\n', last);
  return { starts, to: close === -1 ? text.length : close };
}

/**
 * Rewrites the lines a selection touches, each by `change`, and keeps the selection on the
 * same text: a position inside what a line loses moves to where the line now starts.
 * @param {string} text @param {number} start @param {number} end
 * @param {(line: string) => { add: string, remove: number }} change what goes in front of a
 *   line, and how many of its first characters go
 * @returns {IndentEdit | null} null when no line changes
 */
function editLines(text, start, end, change) {
  const { starts, to } = touchedLines(text, start, end);
  const lines = starts.map((at, i) => {
    const line = text.slice(at, i + 1 < starts.length ? starts[i + 1] - 1 : to);
    return { at, line, ...change(line) };
  });
  const out = lines.map(({ line, add, remove }) => add + line.slice(remove)).join('\n');
  if (out === text.slice(starts[0], to)) return null;
  // A position at a line's start stays there; one past it moves with the line's text.
  /** @param {number} p */
  const moved = (p) => lines.reduce((q, { at, add, remove }) => (p > at ? q + add.length - Math.min(p - at, remove) : q), p);
  return { from: starts[0], to, text: out, start: moved(start), end: moved(end) };
}

/**
 * Tab: with nothing selected, an indent at the caret; with a selection, one more indent at the
 * start of every line it touches (blank lines stay blank).
 * @param {string} text @param {number} start @param {number} end
 * @returns {IndentEdit | null}
 */
export function indent(text, start, end) {
  if (start === end) return { from: start, to: end, text: INDENT, start: start + INDENT.length, end: start + INDENT.length };
  return editLines(text, start, end, (line) => ({ add: line === '' ? '' : INDENT, remove: 0 }));
}

/**
 * Shift+Tab: one indent less on every line the caret or selection touches; a line loses at most
 * one indent's worth of leading spaces (or one tab), and never more than it has.
 * @param {string} text @param {number} start @param {number} end
 * @returns {IndentEdit | null} null when no line starts indented
 */
export function outdent(text, start, end) {
  return editLines(text, start, end, (line) => ({ add: '', remove: line.startsWith('\t') ? 1 : leadingSpaces(line.slice(0, INDENT.length)) }));
}

/**
 * Backspace: with the caret in a line's leading spaces, back to the indent level before it
 * (so an indent goes in one press, as it came in with one Tab).
 * @param {string} text @param {number} start @param {number} end
 * @returns {IndentEdit | null} null when Backspace should delete as usual
 */
export function unindent(text, start, end) {
  if (start !== end) return null;
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const before = text.slice(lineStart, start);
  if (before === '' || /[^ ]/.test(before)) return null;
  const from = lineStart + (Math.ceil(before.length / INDENT.length) - 1) * INDENT.length;
  return { from, to: start, text: '', start: from, end: from };
}

/** Keys pressed on their own on the way to a shortcut (Shift for Shift+Tab). */
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

/**
 * Makes Tab and Shift+Tab indent in every textarea inside `container`, and Backspace unindent. It listens on the
 * container, so a textarea's own keydown handlers run first: one that takes Tab (a suggestion
 * list completing) cancels the event, and the Tab is left to it. Esc arms the next Tab (or
 * Shift+Tab) to move focus as usual; any other key, or leaving the field, disarms it. Esc keeps
 * whatever else it does in the field.
 * @param {HTMLElement} container
 */
export function tabIndent(container) {
  /** The textarea whose next Tab leaves it. @type {EventTarget | null} */
  let leaving = null;
  container.addEventListener('focusout', () => (leaving = null));
  container.addEventListener('keydown', (e) => {
    const area = e.target;
    if (!(area instanceof HTMLTextAreaElement) || MODIFIERS.has(e.key)) return;
    const leave = leaving === area;
    leaving = e.key === 'Escape' ? area : null;
    if (e.defaultPrevented || e.isComposing || e.altKey || e.ctrlKey || e.metaKey || area.readOnly) return;
    if (e.key === 'Backspace' && !e.shiftKey) {
      const edit = unindent(area.value, area.selectionStart, area.selectionEnd);
      if (!edit) return;
      e.preventDefault();
      area.setSelectionRange(edit.from, edit.to);
      document.execCommand('delete');
      return;
    }
    if (e.key !== 'Tab' || leave) return;
    e.preventDefault();
    const edit = (e.shiftKey ? outdent : indent)(area.value, area.selectionStart, area.selectionEnd);
    if (!edit) return;
    const direction = area.selectionDirection;
    area.setSelectionRange(edit.from, edit.to);
    document.execCommand('insertText', false, edit.text);
    area.setSelectionRange(edit.start, edit.end, direction);
  });
}
