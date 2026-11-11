/** Element construction helpers: elements, SVG icons, buttons that never submit a form, text that keeps a selection, and file-drag checks. */
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

/** An SVG element, its attributes set. @param {string} tag @param {Record<string, string>} [attrs] @returns {SVGElement} */
export function svg(tag, attrs = {}) {
  const node = /** @type {SVGElement} */ (document.createElementNS('http://www.w3.org/2000/svg', tag));
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  return node;
}

/** A small ×, drawn so it sits at the centre of whatever holds it (a font's × sits low). */
export function crossIcon() {
  const icon = svg('svg', { class: 'cross-icon', viewBox: '0 0 10 10', 'aria-hidden': 'true' });
  icon.append(svg('path', { d: 'M2 2l6 6M8 2l-6 6' }));
  return icon;
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
