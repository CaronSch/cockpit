/**
 * The daemon's settings: switches for what the daemon does, so every page sees and changes
 * the same ones (a page's own look is kept per browser: src/ui/settings.js). They are picked
 * in the Config menu and kept in one small file in the state directory.
 *
 * `<file>` (state-file.js): `{ version: 1, settings: { [key]: value } }`; a key it lacks has
 * its default.
 */
import { loadStateFile } from './state-file.js';

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
  const settings = await loadStateFile({
    file,
    what: 'a settings file',
    initial: /** @type {DaemonSettings} */ ({ ...DEFAULT_SETTINGS }),
    read: (data) => (data?.version === VERSION && isSettingsPatch(data.settings) ? { ...DEFAULT_SETTINGS, ...data.settings } : null),
    write: (all) => ({ version: VERSION, settings: all }),
  });
  return {
    all: settings.get,
    /** Changes the settings `patch` names. @param {Partial<DaemonSettings>} patch */
    set: (patch) => settings.set({ ...settings.get(), ...patch }),
    /** Hears every change, with all the settings. */
    subscribe: settings.subscribe,
  };
}

/** @typedef {Awaited<ReturnType<typeof loadSettings>>} SettingsStore */
