/**
 * Folder listings for path suggestions (the agent pane's `@` file mentions, its Directory field):
 * each entry's name and whether it is a folder (a link to one counts), capped so a huge folder
 * cannot flood the page; how a typed path is read; and the text files the file window shows
 * (src/files/file-refs.js), capped too.
 */
import { readdir, stat } from 'node:fs/promises';
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

/** Why a text file is not shown: not one (by extension, or it holds binary), or not there. */
export class TextFileRefused extends Error {}

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
  return { path, text, size: info.size, truncated: info.size > max, modifiedAt: info.mtimeMs };
}
