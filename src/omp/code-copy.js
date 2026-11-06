/**
 * A fenced code block as rendered Markdown shows it, with a Copy button in its top-right
 * corner that copies the code itself (the fence's contents, not its language label).
 */
import { button, el } from '../ui/dom.js';
import { errorMessage } from '../ui/format.js';
import { copyReport } from './table-copy.js';

/**
 * The code block for `text`, labelled with `lang` if it has one. Long lines scroll the `pre`
 * sideways; the Copy button sits outside it, so it stays in the block's corner meanwhile.
 * @param {string} text @param {string} lang @returns {HTMLElement}
 */
export function renderCode(text, lang) {
  const pre = el('pre', 'md-code');
  if (lang) pre.dataset.lang = lang;
  pre.append(el('code', undefined, text));
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
