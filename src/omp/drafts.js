/**
 * Unsent messages, one per conversation: what is in an agent window's message box (its text,
 * and its comment and file cards) waits while the window shows another conversation, or the
 * page reloads, and is back when the conversation is shown again (in any window of this
 * browser). Kept per browser (ui/prefs.js), under the conversation's key
 * (sessions/running.js `conversationKey`); an empty box keeps nothing.
 */
import { readPref, writePref } from '../ui/prefs.js';
/** @import { Kept, KeptCard } from './composer.js' */

const PREFIX = 'cockpit.draft:';

/** @param {any} c @returns {c is KeptCard} */
const isCard = (c) =>
  (c?.kind === 'comment' && typeof c.quote === 'string' && typeof c.comment === 'string') ||
  (c?.kind === 'file' && typeof c.name === 'string' && typeof c.size === 'number' && typeof c.path === 'string');

/**
 * The message left unsent in conversation `key`; an empty one if none (or unreadable). An
 * older draft kept as bare text is read as that text.
 * @param {string} key @returns {Kept}
 */
export function readDraft(key) {
  const raw = readPref(PREFIX + key);
  if (raw === null) return { text: '', cards: [] };
  try {
    const kept = JSON.parse(raw);
    if (typeof kept?.text === 'string' && Array.isArray(kept.cards)) return { text: kept.text, cards: kept.cards.filter(isCard) };
  } catch {
    // Bare text: see above.
  }
  return { text: raw, cards: [] };
}

/** Keeps `kept` as conversation `key`'s unsent message. @param {string} key @param {Kept} kept */
export const writeDraft = (key, kept) => writePref(PREFIX + key, kept.text.trim() || kept.cards.length ? JSON.stringify(kept) : null);
