/**
 * Inline dialogs for omp's extension UI requests (select, confirm, input, editor, ask);
 * each one answers through a single `respond(payload)` call. Their text fields suggest
 * paths after `@` as the message box does.
 *
 * A dialog is a card set like the message box under it, saying what the agent waits for
 * ("Needs your answer", "Needs your approval") over its question. A choice's options are quiet
 * rows, numbered: in the dialog, 1–9 pick one, ↑ and ↓ move between them, and Esc dismisses
 * the dialog (as Dismiss at its foot does).
 */
import { button, el } from '../ui/dom.js';
import { withMentions } from './file-suggest.js';
import { askAnswers } from './transcript.js';
/** @import { Dialog } from './transcript.js' */
/** @import { ListDir } from './file-suggest.js' */

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
  const kicker = dialog.method === 'confirm' ? 'Needs your approval' : 'Needs your answer';
  const title = typeof dialog.title === 'string' && dialog.title ? dialog.title : null;
  node.setAttribute('aria-label', title ?? kicker);
  const actions = el('div', 'omp-dialog-actions');
  const dismiss = () => respond({ cancelled: true });
  // In its top-right corner, so a choice (its options its answers) needs no foot.
  const cancel = button('omp-dialog-dismiss', 'Dismiss', dismiss);
  const esc = el('kbd', 'omp-dialog-key', 'Esc');
  esc.setAttribute('aria-hidden', 'true');
  cancel.append(esc);
  const said = el('div', 'omp-dialog-said');
  said.append(el('span', 'omp-dialog-kicker', kicker));
  if (title) said.append(el('div', 'omp-dialog-title', title));
  const head = el('div', 'omp-dialog-head');
  head.append(said, cancel);
  node.append(head);
  node.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return; // a suggestion list closed by it
    e.preventDefault();
    e.stopPropagation();
    dismiss();
  });

  switch (dialog.method) {
    case 'select': {
      const options = Array.isArray(dialog.options) ? dialog.options : [];
      const details = Array.isArray(dialog.optionDetails) ? dialog.optionDetails : [];
      const list = el('div', 'omp-options');
      /** @type {HTMLButtonElement[]} */
      const rows = options.map((label, i) => {
        const option = button('omp-option', undefined, () => respond({ value: String(label) }));
        const text = el('span', 'omp-option-text');
        text.append(el('span', 'omp-option-label', String(label)));
        const description = details[i]?.description;
        if (typeof description === 'string' && description) text.append(el('span', 'omp-option-desc', description));
        option.append(...(i < 9 ? [numberKey(i)] : []), text);
        return option;
      });
      list.append(...rows);
      list.addEventListener('keydown', (e) => {
        if (e.altKey || e.ctrlKey || e.metaKey) return;
        const at = rows.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
        const pick = /^[1-9]$/.test(e.key) ? rows[Number(e.key) - 1] : null;
        const move = e.key === 'ArrowDown' ? rows[at + 1] : e.key === 'ArrowUp' ? rows[at - 1] : null;
        if (!pick && !move) return;
        e.preventDefault();
        if (pick) pick.click();
        else move?.focus();
      });
      node.append(list);
      break;
    }
    case 'confirm': {
      if (dialog.message) node.append(el('p', 'omp-dialog-message', String(dialog.message)));
      actions.append(button('btn btn-accent', 'Yes', () => respond({ confirmed: true })), button('btn', 'No', () => respond({ confirmed: false })));
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
      actions.append(button('btn btn-accent', 'Submit', submit));
      break;
    }
    case 'editor': {
      const area = el('textarea', 'omp-field');
      area.rows = 6;
      area.value = typeof dialog.prefill === 'string' ? dialog.prefill : '';
      node.append(withMentions(area, listDir));
      actions.append(button('btn btn-accent', 'Submit', () => respond({ value: area.value })));
      break;
    }
    case 'ask': {
      const questions = Array.isArray(dialog.questions) ? dialog.questions : [];
      /** @type {Record<string, { selected: string[], custom: string }>} */
      const picks = {};
      for (const q of questions) node.append(askQuestion(q, (picks[q.id] = { selected: [], custom: '' }), listDir));
      actions.append(button('btn btn-accent', 'Submit', () => respond({ answers: askAnswers(questions, picks) })));
      break;
    }
  }
  const foot = el('div', 'omp-dialog-foot');
  if (typeof dialog.timeout === 'number') foot.append(el('span', 'omp-dialog-timeout', `Times out after ${Math.round(dialog.timeout / 1000)} s`));
  if (actions.childElementCount) foot.append(actions);
  if (foot.childElementCount) node.append(foot);
  return node;
}

/** The number that picks option `i` (1 for the first), as a key in its row. @param {number} i */
function numberKey(i) {
  const key = el('kbd', 'omp-option-key', String(i + 1));
  key.setAttribute('aria-hidden', 'true');
  return key;
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
    const head = el('span', 'omp-choice-head');
    head.append(el('span', 'omp-option-label', option.label));
    if (i === q.recommended) head.append(el('span', 'omp-recommended', 'recommended'));
    text.append(head);
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
