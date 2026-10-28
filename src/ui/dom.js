/** Element construction helpers: elements, buttons that never submit a form, text that keeps a selection, and file-drag checks. */
/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag @param {string} [className] @param {string} [text]
 * @returns {HTMLElementTagNameMap[K]}
 */
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * A `<button type="button">`, so it never submits an enclosing form.
 * @param {string} className @param {string} [text] @param {(event: MouseEvent) => void} [onClick]
 */
export function button(className, text, onClick) {
  const node = el('button', className, text);
  node.type = 'button';
  if (onClick) node.addEventListener('click', onClick);
  return node;
}

/** Whether a drag carries files (as opposed to text or elements). @param {DragEvent} event */
export const carriesFiles = (event) => event.dataTransfer?.types.includes('Files') ?? false;

/**
 * Sets `node`'s text only if it changed: rewriting even the same text replaces its text node,
 * which drops any selection the user made in it.
 * @param {Node} node @param {string} text
 */
export function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}
