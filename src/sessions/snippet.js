/** The passage a search matched, as a line of DOM, shared by the Sessions window and Spotlight. */
import { el } from '../ui/dom.js';

/**
 * The passage with the words the search matched marked: each matched word is stemmed
 * (daemon/search.js), so it is the start of the words it stands for.
 * @param {{ snippet: string, terms: string[] }} match @param {string} className
 */
export function snippetLine({ snippet, terms }, className) {
  const line = el('div', className);
  for (const part of snippet.split(/([\p{L}\p{N}_]+)/u)) {
    const lower = part.toLowerCase();
    line.append(terms.some((t) => lower.startsWith(t)) ? el('mark', '', part) : part);
  }
  return line;
}
