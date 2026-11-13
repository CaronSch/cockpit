/**
 * Obsidian vaults, for the wiki links (`[[note]]`) in agents' replies and Markdown files: the
 * vaults Obsidian knows, the vault a folder is in, and the file a link names there, found as
 * Obsidian finds it.
 *
 * A folder is in a vault when it, or a folder above it, holds Obsidian's `.obsidian/` folder, so a
 * note links within its own vault. A link from anywhere else (a conversation in a repository) is
 * read in the vault picked in Config (settings.js `vault`), if one is. Vaults are only read here:
 * the note a link names opens in a file window, as any text file does (files.js).
 */
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';

/** Obsidian's own list of the vaults it has opened. */
const OBSIDIAN_CONFIG =
  process.platform === 'darwin'
    ? join(homedir(), 'Library/Application Support/obsidian/obsidian.json')
    : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'obsidian/obsidian.json');

/** The vaults Obsidian knows, their absolute paths A→Z; none when it is not installed. @returns {Promise<string[]>} */
export async function knownVaults() {
  const data = await Bun.file(OBSIDIAN_CONFIG).json().catch(() => null);
  const vaults = data?.vaults && typeof data.vaults === 'object' ? Object.values(data.vaults) : [];
  return vaults.flatMap((/** @type {any} */ vault) => (typeof vault?.path === 'string' ? [vault.path] : [])).sort();
}

/** The vault folder `dir` (absolute) is in, or null. @param {string} dir @returns {Promise<string | null>} */
async function vaultOf(dir) {
  for (let at = dir; ; at = dirname(at)) {
    if ((await stat(join(at, '.obsidian')).catch(() => null))?.isDirectory()) return at;
    if (dirname(at) === at) return null;
  }
}

/**
 * The file `target` names among a vault's `files` (paths from its top, `/` between folders), from
 * a note in folder `from` (from the top too, '' for the top), as Obsidian finds it: a Markdown note
 * unless the target names a file with its extension, whatever the case; first a path from the
 * note's folder, then from the vault's top, then any file whose path ends in it, the shortest
 * first. Null when no file is.
 * @param {readonly string[]} files @param {string} target @param {string} from @returns {string | null}
 */
export function pickWikiTarget(files, target, from) {
  const wanted = target.replace(/^\/+/, '').toLowerCase();
  const names = [`${wanted}.md`, wanted];
  const lower = files.map((file) => file.toLowerCase());
  for (const path of [...names.map((name) => posix.join(from.toLowerCase(), name)), ...names]) {
    const at = lower.indexOf(path);
    if (at !== -1) return files[at];
  }
  const ends = files.filter((_, i) => names.some((name) => lower[i].endsWith(`/${name}`)));
  return ends.sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))[0] ?? null;
}

/**
 * The file wiki link `target` names, from text in folder `from` (absolute): in the vault `from` is
 * in, else in `picked` (Config's). `vault` is null when there is neither, `path` (absolute) when
 * the vault has the file. Hidden folders (`.obsidian`, `.trash`) are not looked in, as Obsidian
 * does not.
 * @param {string} target @param {string} from @param {string | null} picked
 * @returns {Promise<{ vault: string | null, path: string | null }>}
 */
export async function findWikiTarget(target, from, picked) {
  const vault = (await vaultOf(from)) ?? picked;
  if (!vault) return { vault: null, path: null };
  const files = await Array.fromAsync(new Bun.Glob('**/*').scan({ cwd: vault, onlyFiles: true })).catch(() => []);
  const inside = relative(vault, from);
  const folder = inside.startsWith('..') ? '' : inside.split(sep).join('/');
  const found = pickWikiTarget(files.map((file) => file.split(sep).join('/')), target, folder);
  return { vault, path: found && resolve(vault, found) };
}
