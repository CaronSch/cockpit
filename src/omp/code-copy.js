/**
 * A fenced code block as rendered Markdown shows it, with a Copy button in its top-right
 * corner that copies the code itself (the fence's contents, not its language label). A
 * ```diff (or ```patch) block shows its added lines green and its removed ones red, as the
 * pull request window does, its text as written.
 */
import { button, el } from '../ui/dom.js';
import { errorMessage } from '../ui/format.js';
import { copyReport } from './table-copy.js';

/** Fenced languages shown as a diff. */
const DIFF_LANGS = new Set(['diff', 'patch']);

/** What a line of a diff is. @typedef {'add' | 'del' | 'hunk' | 'meta' | 'context'} DiffLine */

/**
 * What each line of `lines` is, by its first characters. A `--- `/`+++ ` pair names the files
 * compared; either alone is a removed or added line (a removed SQL comment, `--- note`, is one).
 * Agents write diffs loosely (no hunk headers, `...` for what was left out), so nothing more is
 * required of them.
 * @param {readonly string[]} lines @returns {DiffLine[]}
 */
export function diffLines(lines) {
  /** @type {DiffLine[]} */
  const kinds = [];
  lines.forEach((line, i) => {
    if (kinds[i]) return; // the `+++ ` of a pair, already named
    if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      kinds[i] = kinds[i + 1] = 'meta';
    } else if (line.startsWith('@@')) kinds[i] = 'hunk';
    else if (line.startsWith('diff --git ') || line.startsWith('\\ No newline') || (line.startsWith('index ') && kinds[i - 1] === 'meta')) kinds[i] = 'meta';
    else if (line.startsWith('+')) kinds[i] = 'add';
    else if (line.startsWith('-')) kinds[i] = 'del';
    else kinds[i] = 'context';
  });
  return kinds;
}

/**
 * The code block for `text`, labelled with `lang` if it has one. Long lines scroll the `pre`
 * sideways; the Copy button sits outside it, so it stays in the block's corner meanwhile.
 * @param {string} text @param {string} lang @returns {HTMLElement}
 */
export function renderCode(text, lang) {
  const pre = el('pre', 'md-code');
  if (lang) pre.dataset.lang = lang;
  const code = el('code');
  if (DIFF_LANGS.has(lang.toLowerCase())) {
    pre.classList.add('is-diff');
    const lines = text.split('\n');
    const kinds = diffLines(lines);
    // A row per line, so each one's tint runs the block's whole width, however far it scrolls.
    code.append(...lines.map((line, i) => el('span', `md-diff-line is-${kinds[i]}`, line)));
  } else {
    code.textContent = text;
  }
  pre.append(code);
  const copy = button('md-code-copy', 'Copy', () => {
    navigator.clipboard.writeText(text).then(
      () => report('Copied'),
      (err) => report('Copy failed', errorMessage(err)),
    );
  });
  const report = copyReport(copy);
  const block = el('div', 'md-code-block');
  block.append(copy, pre);
  return block;
}
