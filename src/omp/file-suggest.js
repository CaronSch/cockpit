/**
 * Path suggestions in the agent pane's text boxes (`@` file mentions in its draft, its dialogs'
 * answers and its comments and questions on reply text; its Directory field): while the caret ends a path, the suggestion list shows the matching entries of the
 * folder it names, and Tab, Enter or a click completes the path (see `file-mention.js`).
 *
 * Folders are listed by the daemon (relative to the session's directory, or to home before
 * there is a session); one listing serves every keystroke in that folder until the path is
 * finished or abandoned.
 */
import { el } from '../ui/dom.js';
import { fileIcon, folderIcon } from '../ui/icons.js';
import { MENTIONS, commonPrefix, matchEntries } from './file-mention.js';
import { createSuggestions } from './suggestions.js';
/** @import { DirEntry, MentionQuery, PathSyntax } from './file-mention.js' */
/** @import { DirListing } from '../../daemon/wire.js' */
/** @import { Suggestions } from './suggestions.js' */

/** Lists a folder as typed in a path. @typedef {(dir: string) => Promise<DirListing>} ListDir */

/** Rows shown at most; typing more of the name narrows the rest down. */
const MAX_ROWS = 50;

/**
 * @param {{
 *   draft: HTMLTextAreaElement | HTMLInputElement,
 *   syntax: PathSyntax,
 *   foldersOnly?: boolean,
 *   enter?: true | 'moved',
 *   list: Suggestions,
 *   listDir: (dir: string) => Promise<DirListing>,
 *   replace: (start: number, end: number, text: string) => void,
 * }} options `syntax` says how paths are written in `draft`; `foldersOnly` leaves files out;
 * `enter` is when Enter takes the selected row (`SuggestOptions`), always unless told;
 * `listDir` lists a folder as typed in a path; `replace` puts `text` in the draft in place of
 * `start`…`end`, leaving the caret after it.
 */
export function createFileSuggest({ draft, syntax, foldersOnly = false, enter = true, list, listDir, replace }) {
  /** @type {Map<string, Promise<DirListing>>} */
  const listings = new Map();
  /** The path the list is for (where it starts, its folder and segment), while one is being typed. */
  let showing = '';

  /** The path the caret ends now, if the caret is not a selection. */
  function current() {
    const caret = draft.selectionStart;
    return caret !== null && caret === draft.selectionEnd ? syntax.at(draft.value, caret) : null;
  }
  /** @param {MentionQuery} q */
  const key = (q) => `${q.start}:${q.quote}${q.dir}`;

  /** @param {string} dir */
  function listing(dir) {
    let pending = listings.get(dir);
    if (!pending) {
      pending = listDir(dir);
      listings.set(dir, pending);
      pending.catch(() => listings.delete(dir));
    }
    return pending;
  }

  /**
   * Replaces the path, if the caret still ends the one the rows were made for, then
   * follows the draft (a folder's own entries next, or nothing once a file is in).
   * @param {MentionQuery} shown @param {(q: MentionQuery) => string} text
   */
  function complete(shown, text) {
    const q = current();
    if (q && key(q) === key(shown)) replace(q.start, q.end, text(q));
    update();
  }

  /** @param {MentionQuery} q @param {DirListing} found */
  function draw(q, found) {
    if (syntax.ended?.(q, found.entries)) return list.hide();
    const matches = matchEntries(foldersOnly ? found.entries.filter((e) => e.isDir) : found.entries, q.segment);
    const shown = matches.slice(0, MAX_ROWS);
    const more = matches.length - shown.length;
    const note = found.truncated
      ? `Only the first ${found.entries.length} entries of this folder are listed`
      : more > 0
        ? `${more} more: type to narrow`
        : undefined;
    /** @param {DirEntry} entry */
    const pick = (entry) => () => complete(q, (now) => syntax.complete(now, entry));
    list.show(
      shown.map((entry) => ({
        cells: [
          entry.isDir ? folderIcon() : fileIcon(),
          entry.isDir ? el('span', 'omp-suggestion-path is-dir', `${entry.name}/`) : el('span', 'omp-suggestion-path', entry.name),
        ],
        pick: pick(entry),
      })),
      {
        enter,
        note,
        tab(moved, selected) {
          const prefix = moved ? null : commonPrefix(matches, q.segment);
          if (prefix) complete(q, (now) => syntax.extend(now, prefix));
          else selected.pick();
        },
      },
    );
  }

  /** Stops following a path: the list closes and its listings are forgotten. */
  function close() {
    showing = '';
    listings.clear();
    list.hide();
  }

  /**
   * Follows the draft as it now stands: lists the folder of the path the caret ends, if
   * any. Returns false when it ends none, having closed the list if it showed one.
   */
  function update() {
    const q = current();
    if (!q) {
      if (showing) close();
      return false;
    }
    const at = `${key(q)}/${q.segment}`;
    showing = at;
    listing(q.dir).then(
      (found) => {
        if (showing === at) draw(q, found);
      },
      () => {
        if (showing === at) list.hide();
      },
    );
    return true;
  }

  return { update, close };
}

/**
 * `field`, with a list under it suggesting the entries of the folder an `@` path names as it is
 * typed; the list takes the arrows, Tab, Enter and Esc while open (a key it takes is
 * `defaultPrevented`, and its Esc goes no further, so the box's owner does not act on it too).
 * @param {HTMLInputElement | HTMLTextAreaElement} field @param {ListDir | undefined} listDir
 * @returns {HTMLElement}
 */
export function withMentions(field, listDir) {
  if (!listDir) return field;
  const list = createSuggestions();
  const files = createFileSuggest({
    draft: field,
    syntax: MENTIONS,
    list,
    listDir,
    replace(start, end, text) {
      field.setRangeText(text, start, end, 'end');
      field.dispatchEvent(new Event('input')); // whatever follows the field's text sees it
    },
  });
  field.spellcheck = false;
  field.addEventListener('input', () => files.update());
  field.addEventListener('blur', () => files.close());
  /** @type {HTMLElement} */ (field).addEventListener('keydown', (e) => { // typed as one element, so `e` is a KeyboardEvent
    if (e.isComposing || list.key(e)) return;
    if (e.key === 'Escape' && list.open) {
      e.preventDefault();
      e.stopPropagation();
      files.close();
    }
  });
  const wrap = el('div', 'omp-mention-field');
  wrap.append(field, list.root);
  return wrap;
}
