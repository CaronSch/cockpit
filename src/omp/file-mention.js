/**
 * Paths typed in the agent pane, as `@` file mentions in its draft or plainly in its Directory
 * field: the path being typed at the caret, the folder entries that match it, and the text that
 * completes it, kept free of the DOM so they can be tested.
 *
 * The path is what follows `@`, read the way omp reads a mention (`utils/file-mentions.ts`):
 * relative to the session's directory, from home with `~/`, or absolute. Its folder part
 * (through the last `/`) names the folder to list; its last segment filters the entries. A
 * path omp would cut short unquoted (a space, an `@`, quotes, punctuation it trims from the
 * ends) is written quoted, `@"…"`, which omp takes verbatim. A plain field holds one path,
 * its whole text, read the same way, and is never quoted.
 */

/** One entry of a folder. @typedef {{ name: string, isDir: boolean }} DirEntry */
/**
 * The mention being typed, from its `@` (`start`) to the caret (`end`). `quote` is the quote
 * it opened with, if any; `dir` its folder part as typed ('' for the session's own folder),
 * `segment` the rest.
 * @typedef {{ start: number, end: number, quote: '' | '"' | "'", dir: string, segment: string }} MentionQuery
 */
/**
 * How paths are written in one kind of text: `at` finds the one the caret ends; `complete` and
 * `extend` give the text that replaces it (`start`…`end`) once an entry is chosen, or once Tab
 * extends its last segment; `ended`, if given, says when the path is done though the caret
 * still ends it (`entries` being its folder's).
 * @typedef {{
 *   at: (text: string, caret: number) => MentionQuery | null,
 *   complete: (query: MentionQuery, entry: DirEntry) => string,
 *   extend: (query: MentionQuery, segment: string) => string,
 *   ended?: (query: MentionQuery, entries: readonly DirEntry[]) => boolean,
 * }} PathSyntax
 */

/** An `@` at the start or after whitespace, then an open quoted path or a bare one, up to the caret. */
const QUERY = /(?:^|\s)@(?:"([^"]*)|'([^']*)|([^\s"'@]*))$/;
/** What ends a bare mention while it is typed (see QUERY). */
const BREAKS_OPEN = /[\s@"']/;
/** What omp would read differently in a finished bare mention: it ends at whitespace or `@`, and trims these ends. */
const BREAKS_FINISHED = /[\s@"'`]|^[([{<]|[)\]}>.,;:!?]$/;

/**
 * The mention the caret ends, or null when it ends none.
 * @param {string} text @param {number} caret @returns {MentionQuery | null}
 */
export function mentionAt(text, caret) {
  const match = QUERY.exec(text.slice(0, caret));
  if (!match) return null;
  const quote = match[1] !== undefined ? '"' : match[2] !== undefined ? "'" : '';
  const path = match[1] ?? match[2] ?? match[3] ?? '';
  const cut = path.lastIndexOf('/') + 1;
  return { start: caret - path.length - quote.length - 1, end: caret, quote, dir: path.slice(0, cut), segment: path.slice(cut) };
}

/**
 * The entries `segment` matches, case-insensitively: names starting with it, then names
 * containing it; folders first within each, then by name. Dotfiles only when it starts with `.`.
 * @param {readonly DirEntry[]} entries @param {string} segment @returns {DirEntry[]}
 */
export function matchEntries(entries, segment) {
  const q = segment.toLowerCase();
  const showHidden = q.startsWith('.');
  /** @param {DirEntry} e */
  const rank = (e) => {
    const name = e.name.toLowerCase();
    return name.startsWith(q) ? 0 : name.includes(q) ? 1 : -1;
  };
  return entries
    .filter((e) => showHidden || !e.name.startsWith('.'))
    .map((entry) => ({ entry, rank: rank(entry) }))
    .filter((m) => m.rank >= 0)
    .sort((a, b) => a.rank - b.rank || Number(b.entry.isDir) - Number(a.entry.isDir) || a.entry.name.localeCompare(b.entry.name))
    .map((m) => m.entry);
}

/**
 * What Tab extends `segment` to when several entries start with it and share a longer
 * start (spelled as the first of them spells it), else null.
 * @param {readonly DirEntry[]} matches @param {string} segment @returns {string | null}
 */
export function commonPrefix(matches, segment) {
  const names = matches.map((e) => e.name).filter((n) => n.toLowerCase().startsWith(segment.toLowerCase()));
  if (names.length < 2) return null;
  let end = segment.length;
  while (end < names[0].length && names.every((n) => n.length > end && n[end].toLowerCase() === names[0][end].toLowerCase())) end++;
  return end > segment.length ? names[0].slice(0, end) : null;
}

/**
 * The quote a mention of `path` needs: the one typed, unless the path holds it; else one only
 * if a bare mention would break, still open (`finished` false) or once done.
 * @param {string} path @param {MentionQuery['quote']} typed @param {boolean} finished @returns {MentionQuery['quote']}
 */
const quoteFor = (path, typed, finished) =>
  path.includes('"') ? "'" : typed || ((finished ? BREAKS_FINISHED : BREAKS_OPEN).test(path) ? '"' : '');

/**
 * The text that replaces the mention (from `query.start` to `query.end`) once `entry` is
 * chosen: a file as a finished mention and a space; a folder open, ending in `/`, so its
 * own entries can be chosen next.
 * @param {MentionQuery} query @param {DirEntry} entry
 */
export function completeEntry(query, entry) {
  const path = `${query.dir}${entry.name}${entry.isDir ? '/' : ''}`;
  const quote = quoteFor(path, query.quote, !entry.isDir);
  return entry.isDir ? `@${quote}${path}` : `@${quote}${path}${quote} `;
}

/** Sentence punctuation typed after a path, at the end of what is being typed. */
const TRAILING_PUNCTUATION = /[.,;:!?)]+$/;

/**
 * Whether a bare mention is done because the sentence goes on after it: what follows the path
 * is punctuation (`@benches/.`, `@src/app.js,`, `@README.md)`), which omp trims from a bare
 * mention's end anyway (see BREAKS_FINISHED). The path before it must be a finished one, a
 * folder (`…/`) or an entry's exact name; as in Claude Code, that ends it even though names
 * hold these characters too: `@src/.e` still lists `.env`, and `@app.js.b` `app.js.bak`. Only
 * `@.` and `@..`, on their way to `./` and `../`, finish nothing.
 * @param {MentionQuery} query @param {readonly DirEntry[]} entries
 */
export function endedByPunctuation(query, entries) {
  if (query.quote) return false;
  const name = query.segment.replace(TRAILING_PUNCTUATION, '');
  if (name === query.segment) return false;
  return name ? entries.some((e) => e.name === name) : query.dir.endsWith('/');
}

/**
 * The text that replaces the mention when Tab extends its last segment to `segment`.
 * @param {MentionQuery} query @param {string} segment
 */
export function extendSegment(query, segment) {
  const path = `${query.dir}${segment}`;
  return `@${quoteFor(path, query.quote, false)}${path}`;
}

/** `@` mentions in the omp draft. @type {PathSyntax} */
export const MENTIONS = { at: mentionAt, complete: completeEntry, extend: extendSegment, ended: endedByPunctuation };

/**
 * A field that holds one path: all of its text, while the caret is at its end, with no `@` and
 * no quotes; a folder chosen stays open, ending in `/`.
 * @type {PathSyntax}
 */
export const PLAIN_PATH = {
  at(text, caret) {
    if (caret !== text.length) return null;
    const cut = text.lastIndexOf('/') + 1;
    return { start: 0, end: caret, quote: '', dir: text.slice(0, cut), segment: text.slice(cut) };
  },
  complete: (query, entry) => `${query.dir}${entry.name}${entry.isDir ? '/' : ''}`,
  extend: (query, segment) => `${query.dir}${segment}`,
};
