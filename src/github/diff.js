/**
 * A pull request's changes as the pull request window shows them: `gh pr diff`'s unified diff
 * parsed into files, their hunks and each line with its numbers in the old and the new file,
 * kept free of the DOM so it can be tested.
 *
 * A review comment on GitHub sits on a line of one side (`RIGHT`: the new file, `LEFT`: the
 * old one), which is how `lineKey` names lines here, so comments land under the line they are
 * about.
 */

/** One line of a hunk: `old`/`new` are its numbers in each file, null on the side it is not in. @typedef {{ kind: 'context' | 'add' | 'del', text: string, old: number | null, new: number | null }} DiffLine */
/** @typedef {{ header: string, lines: DiffLine[] }} DiffHunk */
/**
 * One file's changes: `path` is its name after the change (before, for a deleted file), `from`
 * its name before a rename; `binary` when git shows no lines for it.
 * @typedef {{ path: string, from: string | null, status: 'added' | 'deleted' | 'renamed' | 'modified', binary: boolean, hunks: DiffHunk[], additions: number, deletions: number }} DiffFile
 */

const FILE_START = /^diff --git a\/(.*) b\/(.*)$/;
const HUNK_START = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** A path as git writes it after `--- ` or `+++ `, without its `a/`/`b/`; null for /dev/null. @param {string} line */
const sidePath = (line) => {
  const path = line.slice(4).replace(/\t.*$/, '');
  return path === '/dev/null' ? null : path.replace(/^[ab]\//, '');
};

/**
 * The files `diff` changes, in its order.
 * @param {string} diff @returns {DiffFile[]}
 */
export function parseDiff(diff) {
  /** @type {DiffFile[]} */
  const files = [];
  /** @type {DiffFile | null} */
  let file = null;
  /** @type {DiffHunk | null} */
  let hunk = null;
  let oldAt = 0;
  let newAt = 0;
  for (const line of diff.split('\n')) {
    const start = FILE_START.exec(line);
    if (start) {
      file = { path: start[2], from: null, status: 'modified', binary: false, hunks: [], additions: 0, deletions: 0 };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    const head = HUNK_START.exec(line);
    if (head) {
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      oldAt = Number(head[1]);
      newAt = Number(head[2]);
      continue;
    }
    if (!hunk) {
      // The file's header: how it changed, before its first hunk.
      if (line.startsWith('new file mode')) file.status = 'added';
      else if (line.startsWith('deleted file mode')) file.status = 'deleted';
      else if (line.startsWith('rename from ')) {
        file.status = 'renamed';
        file.from = line.slice('rename from '.length);
      } else if (line.startsWith('Binary files ')) file.binary = true;
      else if (line.startsWith('--- ') && file.status === 'deleted') file.path = sidePath(line) ?? file.path;
      continue;
    }
    if (line.startsWith('+')) {
      hunk.lines.push({ kind: 'add', text: line.slice(1), old: null, new: newAt++ });
      file.additions++;
    } else if (line.startsWith('-')) {
      hunk.lines.push({ kind: 'del', text: line.slice(1), old: oldAt++, new: null });
      file.deletions++;
    } else if (line.startsWith(' ')) {
      hunk.lines.push({ kind: 'context', text: line.slice(1), old: oldAt++, new: newAt++ });
    }
    // "\ No newline at end of file", and the empty string after the last newline: not lines.
  }
  return files;
}

/**
 * The key of the line a review comment on `side` at `line` is about, as `lineKeys` gives it.
 * @param {'LEFT' | 'RIGHT'} side @param {number} line
 */
export const lineKey = (side, line) => `${side}:${line}`;

/**
 * The keys a diff line answers to: a removed line is on the old side, an added one on the new
 * side, and an unchanged one on both (GitHub puts comments on it on either).
 * @param {DiffLine} line @returns {string[]}
 */
export function lineKeys(line) {
  /** @type {string[]} */
  const keys = [];
  if (line.new !== null) keys.push(lineKey('RIGHT', line.new));
  if (line.old !== null) keys.push(lineKey('LEFT', line.old));
  return keys;
}

/**
 * Where a range of diff lines is, for a reader: `path` with the new file's lines, e.g.
 * `src/a.js:10-12`, or the old file's for a range of removed lines only, said so.
 * @param {string} path @param {readonly Pick<DiffLine, 'old' | 'new'>[]} lines
 */
export function citeLines(path, lines) {
  const news = lines.flatMap((l) => (l.new === null ? [] : [l.new]));
  const numbers = news.length ? news : lines.flatMap((l) => (l.old === null ? [] : [l.old]));
  if (!numbers.length) return path;
  const first = Math.min(...numbers);
  const last = Math.max(...numbers);
  const range = first === last ? `${first}` : `${first}-${last}`;
  return `${path}:${range}${news.length ? '' : ' (before the change)'}`;
}
