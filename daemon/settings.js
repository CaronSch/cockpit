/**
 * The daemon's settings: what the daemon does, so every page sees and changes the same ones (a
 * page's own look is kept per browser: src/ui/settings.js). They are picked in Setup and the
 * Config menu and kept in one small file in the state directory.
 *
 * `<file>` (state-file.js): `{ version: 1, settings: { [key]: value } }`; a key it lacks has
 * its default.
 */
import { isAbsolute } from 'node:path';
import { BROWSER_CHOICES } from './browser.js';
import { loadStateFile } from './state-file.js';
/** @import { BrowserChoice } from './browser.js' */

const VERSION = 1;

/**
 * `idleCompaction`: compact long conversations left idle (idle-compaction.js); `decisionReview`:
 * after every turn, list the decisions the agent took without its user (decisions.js); `adhd`:
 * agents shape their replies for a reader with ADHD (adhd.js); `browser`: which browser agents
 * drive (browser.js); `setupDone`: the user has been through Setup, so an empty screen no longer
 * opens it; `remote`: Phone access, the daemon also serving the owner's tailnet devices (remote.js);
 * `vault`: the Obsidian vault (an absolute path) wiki links are found in when the text they are in
 * is in no vault (vaults.js), or none.
 * @typedef {{ idleCompaction: boolean, decisionReview: boolean, adhd: boolean, browser: BrowserChoice, setupDone: boolean, remote: boolean, vault: string | null }} DaemonSettings
 */

/** @type {Readonly<DaemonSettings>} */
const DEFAULT_SETTINGS = Object.freeze({ idleCompaction: true, decisionReview: false, adhd: false, browser: 'isolated', setupDone: false, remote: false, vault: null });

/** Whether each setting may take a value. @type {Readonly<Record<keyof DaemonSettings, (value: unknown) => boolean>>} */
const VALID = Object.freeze({
  idleCompaction: (value) => typeof value === 'boolean',
  decisionReview: (value) => typeof value === 'boolean',
  adhd: (value) => typeof value === 'boolean',
  browser: (value) => BROWSER_CHOICES.includes(/** @type {BrowserChoice} */ (value)),
  setupDone: (value) => typeof value === 'boolean',
  remote: (value) => typeof value === 'boolean',
  vault: (value) => value === null || (typeof value === 'string' && isAbsolute(value)),
});

/**
 * Whether `value` sets some of the settings: known keys only, each with a value it may take.
 * @param {any} value parsed untrusted JSON @returns {value is Partial<DaemonSettings>}
 */
export function isSettingsPatch(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.entries(value).every(([key, set]) => Object.hasOwn(VALID, key) && VALID[/** @type {keyof DaemonSettings} */ (key)](set))
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
