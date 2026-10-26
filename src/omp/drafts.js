/**
 * Unsent messages, one per conversation: what is typed in an agent window's message box waits
 * while the window shows another conversation, or the page reloads, and is back when the
 * conversation is shown again (in any window of this browser). Kept per browser
 * (ui/prefs.js), under the conversation's key (sessions/running.js `conversationKey`); an
 * empty box keeps nothing.
 */
import { readPref, writePref } from '../ui/prefs.js';

const PREFIX = 'cockpit.draft:';

/** The message left unsent in conversation `key`, or ''. @param {string} key */
export const readDraft = (key) => readPref(PREFIX + key) ?? '';

/** Keeps `text` as conversation `key`'s unsent message. @param {string} key @param {string} text */
export const writeDraft = (key, text) => writePref(PREFIX + key, text.trim() ? text : null);
