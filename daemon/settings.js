/**
 * The daemon's settings: switches for what the daemon does, so every page sees and changes
 * the same ones (a page's own look is kept per browser: src/ui/settings.js). They are picked
 * in the Config menu and kept in one small file in the state directory.
 *
 * `<file>`: `{ version: 1, settings: { [key]: value } }`, written whole after every change
 * (write-then-rename, one write at a time); a key it lacks has its default. A file that cannot
 * be read as one stops the daemon from starting, naming the file, rather than being replaced.
 */
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const VERSION = 1;

/** `idleCompaction`: compact long conversations left idle (idle-compaction.js). @typedef {{ idleCompaction: boolean }} DaemonSettings */

/** @type {Readonly<DaemonSettings>} */
const DEFAULT_SETTINGS = Object.freeze({ idleCompaction: true });

/**
 * Whether `value` sets some of the settings: known keys only, each with a value of its type.
 * @param {any} value parsed untrusted JSON @returns {value is Partial<DaemonSettings>}
 */
export function isSettingsPatch(value) {
  const known = /** @type {Record<string, unknown>} */ (DEFAULT_SETTINGS);
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.entries(value).every(([key, set]) => Object.hasOwn(known, key) && typeof set === typeof known[key])
  );
}

/**
 * Loads the settings kept in `file` (the defaults if it does not exist yet).
 * @param {{ file: string }} options
 */
export async function loadSettings({ file }) {
  /** @type {DaemonSettings} */
  let settings = { ...DEFAULT_SETTINGS };
  const stored = Bun.file(file);
  if (await stored.exists()) {
    /** @type {any} */
    let data;
    try {
      data = JSON.parse(await stored.text());
    } catch {}
    if (data?.version !== VERSION || !isSettingsPatch(data.settings)) {
      throw new Error(`${file} is not a settings file this daemon can read; fix it or move it away`);
    }
    settings = { ...settings, ...data.settings };
  }
  /** @type {Set<(settings: DaemonSettings) => void>} */
  const listeners = new Set();
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();
  let tmpSeq = 0;

  async function store() {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    // Write-then-rename: a crash mid-write leaves the old settings, never half of the new ones.
    const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ version: VERSION, settings }, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
  }

  return {
    /** @returns {DaemonSettings} */
    all: () => settings,
    /** Changes the settings `patch` names. @param {Partial<DaemonSettings>} patch */
    async set(patch) {
      settings = { ...settings, ...patch };
      for (const fn of listeners) fn(settings);
      // Each write stores the settings as they are when it runs, so the last one leaves the newest.
      queue = queue.then(store).catch((err) => console.error(`[daemon] could not save ${file}:`, err));
      await queue;
    },
    /** Hears every change, with all the settings. @param {(settings: DaemonSettings) => void} fn */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** @typedef {Awaited<ReturnType<typeof loadSettings>>} SettingsStore */
