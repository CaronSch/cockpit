/**
 * App-wide settings, picked in the top bar's Config menu and kept per browser. The menu
 * opens while the pointer rests on Config (and closes a moment after it leaves), or on a
 * click, which keeps it open until a click elsewhere or Esc.
 *
 * Each setting is a switch with its default; only the ones set away from it are stored.
 * Below them the menu lists the daemon's settings (daemon/settings.js), the same for every
 * browser, while the daemon can be reached.
 */
import { button, el } from './dom.js';
import { createAtom } from '../state/atom.js';
/** @import { DaemonClient } from '../daemon/client.js' */
/** @import { DaemonSettings } from '../../daemon/settings.js' */

const SETTINGS_KEY = 'cockpit.settings';
/** How long the menu stays open after the pointer leaves it, so crossing the gap to it does not close it. */
const CLOSE_DELAY_MS = 250;

/** @typedef {'onlyResponses' | 'animatedSelection'} SettingKey */
/** @typedef {{ key: SettingKey, label: string, detail: string, initial: boolean }} Setting */

/** The settings, in the order the menu lists them. @type {readonly Setting[]} */
const SETTINGS = [
  {
    key: 'onlyResponses',
    label: 'Only prompts and responses',
    detail: 'Hide thinking, tool calls and the messages in between, in every agent window',
    initial: false,
  },
  {
    key: 'animatedSelection',
    label: 'Animated selection',
    detail: 'Highlight whole words while dragging over a reply, gliding between them',
    initial: true,
  },
];

/** @typedef {{ key: keyof DaemonSettings, label: string, detail: string }} DaemonSetting */

/** The daemon's settings, in the order the menu lists them. @type {readonly DaemonSetting[]} */
const DAEMON_SETTINGS = [
  {
    key: 'idleCompaction',
    label: 'Compact idle conversations',
    detail: 'Compact a conversation of 200K tokens or more left idle, just before its one-hour prompt cache expires, as Claude Code does; for every browser',
  },
];

/** @typedef {Record<SettingKey, boolean>} Settings */

/** Stored settings over the defaults; anything unknown or not a switch is ignored. @param {string | null} value @returns {Settings} */
export function parseSettings(value) {
  /** @type {Record<string, unknown>} */
  let saved = {};
  try {
    const parsed = value ? JSON.parse(value) : null;
    if (parsed && typeof parsed === 'object') saved = parsed;
  } catch {
    // Not settings: the defaults stand.
  }
  return /** @type {Settings} */ (Object.fromEntries(SETTINGS.map((s) => [s.key, typeof saved[s.key] === 'boolean' ? saved[s.key] : s.initial])));
}

/** @returns {Settings} */
function stored() {
  try {
    return parseSettings(localStorage.getItem(SETTINGS_KEY));
  } catch {
    return parseSettings(null);
  }
}

/** @param {Settings} settings */
function store(settings) {
  const changed = Object.fromEntries(SETTINGS.filter((s) => settings[s.key] !== s.initial).map((s) => [s.key, settings[s.key]]));
  try {
    if (Object.keys(changed).length) localStorage.setItem(SETTINGS_KEY, JSON.stringify(changed));
    else localStorage.removeItem(SETTINGS_KEY);
  } catch {
    // Not kept: they stay as chosen until the page reloads.
  }
}

/** The settings as they are now; subscribe to follow them. */
export const settings = createAtom(stored());

/** @param {SettingKey} key @param {boolean} on */
function set(key, on) {
  const next = { ...settings.get(), [key]: on };
  settings.set(next);
  store(next);
}

/** @param {string} label @param {string} detail @param {boolean} checked @param {(on: boolean, box: HTMLInputElement) => void} onChange */
function switchRow(label, detail, checked, onChange) {
  const row = el('label', 'config-setting');
  const box = el('input');
  box.type = 'checkbox';
  box.checked = checked;
  box.addEventListener('change', () => onChange(box.checked, box));
  row.append(box, el('span', '', label), el('span', 'config-detail', detail));
  return { row, box };
}

/** The top bar's Config button and its menu. @param {{ daemon: DaemonClient }} options */
export function createConfigMenu({ daemon }) {
  const root = el('div', 'config');
  const toggle = button('topbar-btn config-toggle', 'Config');
  toggle.setAttribute('aria-haspopup', 'true');
  const menu = el('div', 'config-menu');
  menu.popover = 'auto';
  toggle.popoverTargetElement = menu;
  root.append(toggle, menu);

  // Opened by the pointer resting on it, the menu follows the pointer; a click pins it open.
  let hovering = false;
  let closing = 0;
  const open = () => menu.matches(':popover-open');
  root.addEventListener('pointerenter', (e) => {
    if (e.pointerType !== 'mouse') return;
    clearTimeout(closing);
    if (open()) return;
    hovering = true;
    menu.showPopover({ source: toggle }); // under its button, as a click would open it
  });
  root.addEventListener('pointerleave', (e) => {
    if (e.pointerType !== 'mouse' || !hovering) return;
    closing = window.setTimeout(() => open() && hovering && menu.hidePopover(), CLOSE_DELAY_MS);
  });
  toggle.addEventListener('click', (e) => {
    // Open from hovering: the click pins it rather than closing it.
    if (hovering && open()) e.preventDefault();
    hovering = false;
  });
  menu.addEventListener('toggle', (event) => {
    const opened = /** @type {ToggleEvent} */ (event).newState === 'open';
    toggle.setAttribute('aria-expanded', String(opened));
    if (!opened) {
      hovering = false;
      return;
    }
    render();
  });
  /** The daemon's settings' switches, while the menu is open. @type {Map<keyof DaemonSettings, HTMLInputElement>} */
  const daemonBoxes = new Map();
  function render() {
    const now = settings.get();
    const atDaemon = daemon.settings();
    daemonBoxes.clear();
    menu.replaceChildren(
      ...SETTINGS.map((setting) => switchRow(setting.label, setting.detail, now[setting.key], (on) => set(setting.key, on)).row),
      ...(atDaemon
        ? DAEMON_SETTINGS.map((setting) => {
            const { row, box } = switchRow(setting.label, setting.detail, atDaemon[setting.key], (on, box) => {
              // The daemon tells every page, this one too; until then the switch shows the choice.
              daemon.changeSettings({ [setting.key]: on }).catch(() => (box.checked = !on));
            });
            daemonBoxes.set(setting.key, box);
            return row;
          })
        : []),
    );
  }
  // Another page may change them while the menu is open here.
  daemon.onSettings(() => {
    const atDaemon = daemon.settings();
    if (!atDaemon || !menu.matches(':popover-open')) return;
    if (daemonBoxes.size === 0) return render();
    for (const [key, box] of daemonBoxes) box.checked = atDaemon[key];
  });
  return { root };
}
