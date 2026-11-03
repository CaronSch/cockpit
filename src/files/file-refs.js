/**
 * Text files named in text the workbench shows (an agent's reply): which files the file window
 * (widgets/file.js) shows, by extension (Markdown, JSON, plain text and common code), and the
 * paths of such files in a run of text or a code span, with the line a `:42` after one names,
 * kept free of the DOM so they can be tested. The daemon reads only such files for the window
 * (daemon/server.js, `/api/text`).
 */

/** The extensions of the files shown, lower case, without the dot. */
const TEXT_EXTENSIONS = new Set(
  (
    'md markdown mdx txt text log rst adoc json jsonl ndjson json5 yaml yml toml ini cfg conf csv tsv xml ' +
    'html htm css scss sass less js mjs cjs jsx ts mts cts tsx vue svelte py pyi go rs rb java kt kts scala ' +
    'swift c h cc cpp cxx hpp hh m mm cs fs sh bash zsh fish ps1 sql proto graphql gql tf hcl lua php pl r ' +
    'dart ex exs erl hs clj zig nim jl sol move cairo vy diff patch'
  ).split(' '),
);

/** Whether `path` names a file the file window shows (by its extension). @param {string} path */
export function isTextPath(path) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 && TEXT_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/**
 * A path: absolute, from home (`~/`), relative (`./`, `../`, `src/…`) or a bare file name, of
 * path characters, ending in an extension; then `:line` (and `:column`), if any. It starts after
 * the start, whitespace or an opening bracket or quote, and ends before whitespace, a closing
 * bracket or quote, or punctuation that ends a sentence.
 */
const FILE_REF = /(^|[\s([{"'`])((?:~|\.{1,2})?\/?(?:[\w@+.-]+\/)*[\w@+-][\w@+.-]*\.[A-Za-z0-9]+)(?::(\d+)(?::\d+)?)?(?=$|[\s)\]}"'`,;!?]|[.:](?:\s|$))/g;
/** Bare names that are product names, not files ("Node.js", "Vue.js"). */
const PRODUCT_NAME = /^[A-Z][a-z]+\.js$/;

/** @param {string} path */
const isRef = (path) => isTextPath(path) && (path.includes('/') || !PRODUCT_NAME.test(path));

/**
 * A run of text: plain, or the `path` of a text file (as written: relative ones are the
 * reader's to resolve) with the `line` it names, if any.
 * @typedef {{ text: string } | { text: string, path: string, line: number | null }} FileRun
 */

/**
 * `text` cut into its plain runs and its file paths, in order; text with none is one run.
 * @param {string} text @returns {FileRun[]}
 */
export function splitFileRefs(text) {
  /** @type {FileRun[]} */
  const parts = [];
  let at = 0;
  for (const match of text.matchAll(FILE_REF)) {
    const path = match[2];
    if (!isRef(path)) continue;
    const start = match.index + match[1].length;
    const ref = match[0].slice(match[1].length);
    if (start > at) parts.push({ text: text.slice(at, start) });
    parts.push({ text: ref, path, line: match[3] ? Number(match[3]) : null });
    at = start + ref.length;
  }
  if (at < text.length || !parts.length) parts.push({ text: text.slice(at) });
  return parts;
}

/**
 * The file a code span names, when it is a path and nothing else (`src/app.js:12`).
 * @param {string} code @returns {{ path: string, line: number | null } | null}
 */
export function fileRefOf(code) {
  const parts = splitFileRefs(code.trim());
  return parts.length === 1 && 'path' in parts[0] ? { path: parts[0].path, line: parts[0].line } : null;
}
