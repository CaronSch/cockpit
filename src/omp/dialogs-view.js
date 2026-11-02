/**
 * Inline dialogs for omp's extension UI requests (select, confirm, input, editor, ask);
 * each one answers through a single `respond(payload)` call. Their text fields suggest
 * paths after `@` as the message box does.
 */
import { button, el } from '../ui/dom.js';
import { createFileSuggest } from './file-suggest.js';
import { MENTIONS } from './file-mention.js';
import { createSuggestions } from './suggestions.js';
import { askAnswers } from './transcript.js';
/** @import { Dialog } from './transcript.js' */
/** @import { DirListing } from '../../daemon/wire.js' */

/** Lists a folder as typed in a path. @typedef {(dir: string) => Promise<DirListing>} ListDir */

/** The fields of an `extension_ui_response` after `type` and `id`. @typedef {Record<string, unknown>} UiPayload */

let uid = 0;

/**
 * @param {Dialog} dialog @param {(payload: UiPayload) => void} respond
 * @param {ListDir} [listDir] lists the folders `@` paths name; without it none are suggested
 * @returns {HTMLElement}
 */
export function renderDialog(dialog, respond, listDir) {
  const node = el('section', `omp-dialog is-${dialog.method}`);
  node.setAttribute('role', 'group');
  const title = typeof dialog.title === 'string' && dialog.title ? dialog.title : dialog.method === 'ask' ? 'Questions' : 'The agent asks';
  node.setAttribute('aria-label', title);
  node.append(el('div', 'omp-dialog-title', title));

  const actions = el('div', 'omp-dialog-actions');
  const cancel = button('btn', 'Cancel', () => respond({ cancelled: true }));

  switch (dialog.method) {
    case 'select': {
      const options = Array.isArray(dialog.options) ? dialog.options : [];
      const details = Array.isArray(dialog.optionDetails) ? dialog.optionDetails : [];
      const list = el('div', 'omp-options');
      options.forEach((label, i) => {
        const option = button('btn omp-option', undefined, () => respond({ value: String(label) }));
        option.append(el('span', 'omp-option-label', String(label)));
        const description = details[i]?.description;
        if (typeof description === 'string' && description) option.append(el('span', 'omp-option-desc', description));
        list.append(option);
      });
      node.append(list);
      actions.append(cancel);
      break;
    }
    case 'confirm': {
      if (dialog.message) node.append(el('p', 'omp-dialog-message', String(dialog.message)));
      actions.append(
        button('btn btn-accent', 'Yes', () => respond({ confirmed: true })),
        button('btn', 'No', () => respond({ confirmed: false })),
        cancel,
      );
      break;
    }
    case 'input': {
      const input = el('input', 'omp-field');
      input.type = 'text';
      input.placeholder = typeof dialog.placeholder === 'string' ? dialog.placeholder : '';
      const submit = () => respond({ value: input.value });
      const field = withMentions(input, listDir);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing && !e.defaultPrevented) submit(); // not when it took a suggestion
      });
      node.append(field);
      actions.append(button('btn btn-accent', 'Submit', submit), cancel);
      break;
    }
    case 'editor': {
      const area = el('textarea', 'omp-field');
      area.rows = 6;
      area.value = typeof dialog.prefill === 'string' ? dialog.prefill : '';
      node.append(withMentions(area, listDir));
      actions.append(button('btn btn-accent', 'Submit', () => respond({ value: area.value })), cancel);
      break;
    }
    case 'ask': {
      const questions = Array.isArray(dialog.questions) ? dialog.questions : [];
      /** @type {Record<string, { selected: string[], custom: string }>} */
      const picks = {};
      for (const q of questions) node.append(askQuestion(q, (picks[q.id] = { selected: [], custom: '' }), listDir));
      actions.append(button('btn btn-accent', 'Submit', () => respond({ answers: askAnswers(questions, picks) })), cancel);
      break;
    }
  }
  if (typeof dialog.timeout === 'number') node.append(el('p', 'omp-muted', `times out after ${Math.round(dialog.timeout / 1000)}s`));
  node.append(actions);
  return node;
}

/**
 * @param {{ id: string, question: string, header?: string, multi?: boolean, recommended?: number,
 *   options: Array<{ label: string, description?: string, preview?: string }> }} q
 * @param {{ selected: string[], custom: string }} pick
 * @param {ListDir} [listDir]
 */
function askQuestion(q, pick, listDir) {
  const box = el('fieldset', 'omp-question');
  const legend = el('legend');
  if (q.header) legend.append(el('span', 'omp-question-header', q.header));
  legend.append(String(q.question ?? ''));
  box.append(legend);
  const group = `omp-ask-${++uid}`;
  /** @type {HTMLInputElement[]} */
  const inputs = [];
  const custom = el('input', 'omp-field');
  (q.options ?? []).forEach((option, i) => {
    const row = el('label', 'omp-choice');
    const input = el('input');
    input.type = q.multi ? 'checkbox' : 'radio';
    input.name = group;
    input.value = option.label;
    input.addEventListener('change', () => {
      pick.selected = inputs.filter((x) => x.checked).map((x) => x.value);
      if (!q.multi && input.checked) {
        // A single answer is either an option or free text, never both.
        custom.value = '';
        pick.custom = '';
      }
    });
    inputs.push(input);
    const text = el('span', 'omp-choice-text');
    text.append(el('span', 'omp-option-label', option.label));
    if (i === q.recommended) text.append(el('span', 'omp-recommended', 'recommended'));
    if (option.description) text.append(el('span', 'omp-option-desc', option.description));
    if (option.preview) text.append(el('pre', 'omp-pre omp-preview', option.preview));
    row.append(input, text);
    box.append(row);
  });
  custom.type = 'text';
  custom.placeholder = q.multi ? 'Something else (optional)' : 'Or type your own answer';
  custom.addEventListener('input', () => {
    pick.custom = custom.value;
    if (!q.multi && custom.value.trim()) {
      for (const x of inputs) x.checked = false;
      pick.selected = [];
    }
  });
  box.append(withMentions(custom, listDir));
  return box;
}

/**
 * `field`, with a list under it suggesting the entries of the folder an `@` path names as it is
 * typed; the list takes the arrows, Tab, Enter and Esc while open.
 * @param {HTMLInputElement | HTMLTextAreaElement} field @param {ListDir | undefined} listDir
 * @returns {HTMLElement}
 */
function withMentions(field, listDir) {
  if (!listDir) return field;
  const list = createSuggestions();
  const files = createFileSuggest({
    draft: field,
    syntax: MENTIONS,
    list,
    listDir,
    replace(start, end, text) {
      field.setRangeText(text, start, end, 'end');
      field.dispatchEvent(new Event('input')); // the answer follows the field
    },
  });
  field.spellcheck = false;
  field.addEventListener('input', () => files.update());
  field.addEventListener('blur', () => files.close());
  /** @type {HTMLElement} */ (field).addEventListener('keydown', (e) => { // typed as one element, so `e` is a KeyboardEvent
    if (e.isComposing || list.key(e)) return;
    if (e.key === 'Escape' && list.open) {
      e.preventDefault();
      files.close();
    }
  });
  const wrap = el('div', 'omp-dialog-field');
  wrap.append(field, list.root);
  return wrap;
}
