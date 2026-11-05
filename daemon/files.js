/**
 * Folder listings for path suggestions (the agent pane's `@` file mentions, its Directory field):
 * each entry's name and whether it is a folder (a link to one counts), capped so a huge folder
 * cannot flood the page; how a typed path is read; and the text files the file window shows
 * (src/files/file-refs.js), capped too, and saves when edited.
 *
 * A text file's version (`rev`) is a hash of its text, as a scratchpad's is (scratchpad.js): a
 * save names the version it was edited from, and is refused when the file has moved on since (an
 * agent, an editor), so an edit never silently undoes someone else's.
 */
import { createHash } from 'node:crypto';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isTextPath } from '../src/files/file-refs.js';
/** @import { DirListing, TextFile } from './wire.js' */

/** Past this many bytes a text file is shown cut short, and says so. */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

/** Past this many entries a listing is cut short (by name), and says so. */
const MAX_ENTRIES = 5000;

/**
 * The absolute path `input` names, read as omp reads one: from home with `~/`, as given when
 * absolute, else relative to `base`.
 * @param {string} input @param {string} base
 */
export const resolvePath = (input, base) =>
  resolve(base, input === '~' || input.startsWith('~/') ? homedir() + input.slice(1) : input);

/**
 * The entries of folder `dir`; throws when it is not a folder that can be read.
 * @param {string} dir @param {number} [max] @returns {Promise<Omit<DirListing, 'dir'>>}
 */
export async function listDirectory(dir, max = MAX_ENTRIES) {
  const all = await readdir(dir, { withFileTypes: true });
  all.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const entries = await Promise.all(
    all.slice(0, max).map(async (d) => ({
      name: d.name,
      isDir: d.isDirectory() || (d.isSymbolicLink() && Boolean((await stat(join(dir, d.name)).catch(() => null))?.isDirectory())),
    })),
  );
  return { entries, truncated: all.length > max };
}

/** Why a text file is not shown or saved: not one (by extension, or it holds binary) or not there (404), or one the window cannot save (422). */
export class TextFileRefused extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status = 404) {
    super(message);
    this.status = status;
  }
}

/** @param {string} text */
const revOf = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/**
 * Text file `path` (absolute), as the file window shows it: its first `max` bytes as UTF-8.
 * Throws TextFileRefused for a path that is not a text file the window shows, or no file.
 * @param {string} path @param {number} [max] @returns {Promise<TextFile>}
 */
export async function readTextFile(path, max = MAX_TEXT_BYTES) {
  if (!isTextPath(path)) throw new TextFileRefused('not a text file the file window shows');
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new TextFileRefused('no such file');
  const text = await Bun.file(path).slice(0, max).text();
  if (text.includes('\u0000')) throw new TextFileRefused('not a text file: it holds binary data');
  // Saved, the text is written back as UTF-8: only a file that is exactly that, read whole, comes back
  // byte for byte where it was not edited (not one shown cut short, nor another encoding, nor a BOM).
  const editable = info.size <= max && Buffer.byteLength(text) === info.size;
  return { path, text, size: info.size, truncated: info.size > max, editable, modifiedAt: info.mtimeMs, rev: revOf(text) };
}

/** Saves run one at a time, so two cannot both pass the version check before either lands. @type {Promise<unknown>} */
let saving = Promise.resolve();

/**
 * Saves `text` over text file `path` (absolute), if it is still at version `base`: only a file the
 * window shows, already there, and `editable`. Written in place, so the file keeps its
 * permissions and links.
 * @param {string} path @param {string} text @param {string} base @param {number} [max]
 * @returns {Promise<{ ok: true, file: TextFile } | { ok: false, current: TextFile }>}
 */
export function writeTextFile(path, text, base, max = MAX_TEXT_BYTES) {
  const result = saving.then(async () => {
    if (text.includes('\u0000')) throw new TextFileRefused('not text: it holds a NUL character', 422);
    const current = await readTextFile(path, max);
    if (!current.editable) throw new TextFileRefused('cannot be saved: it is too large, or not UTF-8 text', 422);
    if (current.rev !== base) return { ok: /** @type {const} */ (false), current };
    if (text !== current.text) await writeFile(path, text);
    return { ok: /** @type {const} */ (true), file: await readTextFile(path, max) };
  });
  saving = result.catch(() => {});
  return result;
}
