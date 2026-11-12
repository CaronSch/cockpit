/**
 * The passage a search matched, as a line of DOM, shared by the Sessions window and Spotlight;
 * and whether a conversation's name holds a word the search matched.
 */
import { el } from '../ui/dom.js';

/** Words and what lies between them, split so words are at odd positions. */
const WORDS = /([\p{L}\p{N}_]+)/u;

/**
 * Whether `word` is one the search matched: each matched word is stemmed (daemon/search.js), so
 * it is the start of the words it stands for.
 * @param {string} word @param {readonly string[]} terms
 */
const matched = (word, terms) => {
  const lower = word.toLowerCase();
  return terms.some((t) => lower.startsWith(t));
};

/** Whether `text` (a conversation's name) holds a word the search matched. @param {string} text @param {readonly string[]} terms */
export const mentions = (text, terms) => text.split(WORDS).some((part, i) => i % 2 === 1 && matched(part, terms));

/**
 * The passage with the words the search matched marked.
 * @param {{ snippet: string, terms: string[] }} match @param {string} className
 */
export function snippetLine({ snippet, terms }, className) {
  const line = el('div', className);
  for (const part of snippet.split(WORDS)) line.append(matched(part, terms) ? el('mark', '', part) : part);
  return line;
}
