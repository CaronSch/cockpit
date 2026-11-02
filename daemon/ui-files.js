/**
 * The files that make up the browser UI: which ones the daemon serves, and a version that
 * changes whenever any of them does, so an open page can tell it is running older code.
 *
 * The daemon reads these files from disk on every request, so they change under a running
 * daemon (a `git pull`) as well as across restarts; the version is computed when asked.
 */
import { extname, join } from 'node:path';

/** Directories served under their own name, besides `index.html`. */
export const STATIC_DIRS = ['src', 'styles'];
export const INDEX_FILE = 'index.html';
/**
 * Files from dependencies, each served at a stable path of its own (index.html's import map
 * names them), so the page loads what it needs and nothing else of `node_modules`.
 */
export const VENDOR_FILES = /** @type {Record<string, string>} */ ({
  'vendor/temml.mjs': 'node_modules/temml/dist/temml.mjs',
  // Loaded only when a reply holds a diagram or chart (src/omp/visuals.js): classic scripts.
  'vendor/mermaid.min.js': 'node_modules/mermaid/dist/mermaid.min.js',
  'vendor/vega.min.js': 'node_modules/vega/build/vega.min.js',
  'vendor/vega-lite.min.js': 'node_modules/vega-lite/build/vega-lite.min.js',
});
/** The file types served, and so the only ones a version counts. */
export const CONTENT_TYPES = /** @type {Record<string, string>} */ ({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
});

const ALL_FILES = new Bun.Glob('**');

/** @param {string} root @returns {Promise<string[]>} every served file, relative to `root` */
async function servedFiles(root) {
  const files = [INDEX_FILE, ...Object.values(VENDOR_FILES)];
  for (const dir of STATIC_DIRS) {
    try {
      for await (const path of ALL_FILES.scan({ cwd: join(root, dir), dot: true })) {
        if (CONTENT_TYPES[extname(path)]) files.push(join(dir, path));
      }
    } catch {} // a missing directory serves nothing
  }
  return files.sort();
}

/**
 * The UI version for the files under `root`: a hash of every served file's path and bytes.
 * Contents are re-read only when a file's size or modification time has changed.
 * @param {string} root
 */
export function createUiVersion(root) {
  let signature = '';
  let version = '';
  return {
    async current() {
      const files = await servedFiles(root);
      const stats = await Promise.all(files.map((file) => Bun.file(join(root, file)).stat().catch(() => null)));
      const next = files.map((file, i) => `${file}\0${stats[i]?.size}\0${stats[i]?.mtimeMs}`).join('\n');
      if (next === signature) return version;
      const hash = new Bun.CryptoHasher('sha256');
      for (const file of files) {
        const bytes = await Bun.file(join(root, file)).bytes().catch(() => null);
        if (bytes) hash.update(`${file}\0${bytes.length}\0`).update(bytes);
      }
      signature = next;
      version = hash.digest('hex').slice(0, 16);
      return version;
    },
  };
}
