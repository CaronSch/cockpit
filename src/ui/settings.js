/**
 * App-wide settings, picked in the top bar's Config menu and kept per browser. The menu
 * opens while the pointer rests on Config (and closes a moment after it leaves), or on a
 * click, which keeps it open until a click elsewhere or Esc.
 *
 * Each setting is a switch with its default; only the ones set away from it are stored.
 */
import { button, el } from './dom.js';
import { createAtom } from '../state/atom.js';

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

/** The top bar's Config button and its menu. */
export function createConfigMenu() {
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
    const now = settings.get();
    menu.replaceChildren(
      ...SETTINGS.map((setting) => {
        const row = el('label', 'config-setting');
        const box = el('input');
        box.type = 'checkbox';
        box.checked = now[setting.key];
        box.addEventListener('change', () => set(setting.key, box.checked));
        row.append(box, el('span', '', setting.label), el('span', 'config-detail', setting.detail));
        return row;
      }),
    );
  });
  return { root };
}
