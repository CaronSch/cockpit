/**
 * App-wide settings, picked in the top bar's Config menu and kept per browser. The menu
 * opens while the pointer rests on Config (and closes a moment after it leaves), or on a
 * click, which keeps it open until a click elsewhere or Esc.
 *
 * Each setting is a switch with its default; only the ones set away from it are stored.
 * Below them the menu lists the daemon's settings (daemon/settings.js), the same for every
 * browser, while the daemon can be reached: its switches, and which browser agents drive. The
 * Setup window (widgets/setup.js) offers the same ones.
 */
import { button, el } from './dom.js';
import { createAtom } from '../state/atom.js';
/** @import { DaemonClient } from '../daemon/client.js' */
/** @import { BrowserChoice } from '../../daemon/browser.js' */

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

/** The daemon's settings that are switches. @typedef {'idleCompaction' | 'decisionReview' | 'adhd'} DaemonSwitch */
/** @typedef {{ key: DaemonSwitch, label: string, detail: string }} DaemonSetting */

/** The daemon's switches, in the order the menu lists them. @type {readonly DaemonSetting[]} */
export const DAEMON_SETTINGS = [
  {
    key: 'idleCompaction',
    label: 'Compact idle conversations',
    detail: 'Compact a conversation of 200K tokens or more left idle, just before its one-hour prompt cache expires, as Claude Code does; for every browser',
  },
  {
    key: 'decisionReview',
    label: 'Review decisions',
    detail: 'After every turn, a small model lists up to five decisions the agent took without you, under its reply (a cheap model call per turn); for every browser',
  },
  {
    key: 'adhd',
    label: 'I have ADHD',
    detail: 'Agents answer for a reader with ADHD (github.com/ayghri/i-have-adhd): the next action first, numbered steps, short lists, no preamble or closers. A running conversation takes it up from its next message; for every browser',
  },
];

/** @typedef {{ value: BrowserChoice, label: string, detail: string }} BrowserOption */

/** Which browser agents drive (daemon/browser.js), as Setup and the menu offer it. @type {readonly BrowserOption[]} */
export const BROWSER_OPTIONS = [
  {
    value: 'isolated',
    label: 'A separate browser',
    detail: 'omp’s own Chrome for Testing, with a profile of its own: never your tabs or logins',
  },
  {
    value: 'relay',
    label: 'Your Chrome',
    detail: 'Signed in as you, through omp’s browser relay (omp browser-relay install, then load its extension); agents use the tab you are looking at',
  },
  {
    value: 'omp',
    label: 'As omp is set up',
    detail: 'Whatever ~/.omp/agent/config.yml says (browser.relay, cmux, Tern)',
  },
];

/** The heading of the browser choice, and what it is about. */
export const BROWSER_SETTING = Object.freeze({
  label: 'Agents’ browser',
  detail: 'Where agents open web pages; a running conversation takes it up from its next message; for every browser',
});

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
export function switchRow(label, detail, checked, onChange) {
  const row = el('label', 'config-setting');
  const box = el('input');
  box.type = 'checkbox';
  box.checked = checked;
  box.addEventListener('change', () => onChange(box.checked, box));
  row.append(box, el('span', '', label), el('span', 'config-detail', detail));
  return { row, box };
}

/**
 * The browser choice (the daemon's `browser`): one radio per option with what it means, each
 * changing the daemon's setting; `show` follows a change made elsewhere.
 * @param {DaemonClient} daemon @param {BrowserChoice} choice
 */
export function browserChoice(daemon, choice) {
  const root = el('fieldset', 'config-group');
  root.append(el('legend', 'config-legend', BROWSER_SETTING.label), el('p', 'config-detail', BROWSER_SETTING.detail));
  const name = `browser-${crypto.randomUUID().slice(0, 8)}`;
  let current = choice;
  const radios = BROWSER_OPTIONS.map((option) => {
    const row = el('label', 'config-setting');
    const radio = el('input');
    radio.type = 'radio';
    radio.name = name;
    radio.value = option.value;
    radio.checked = option.value === choice;
    // The daemon tells every page, this one too; until then the radio shows the choice.
    radio.addEventListener('change', () => radio.checked && daemon.changeSettings({ browser: option.value }).catch(() => show(current)));
    row.append(radio, el('span', '', option.label), el('span', 'config-detail', option.detail));
    root.append(row);
    return radio;
  });
  /** @param {BrowserChoice} next */
  function show(next) {
    current = next;
    for (const radio of radios) radio.checked = radio.value === next;
  }
  return { root, show };
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
  /** The daemon's settings' switches, while the menu is open. @type {Map<DaemonSwitch, HTMLInputElement>} */
  const daemonBoxes = new Map();
  /** The browser choice, while the menu is open with the daemon's settings. @type {ReturnType<typeof browserChoice> | null} */
  let browser = null;
  function render() {
    const now = settings.get();
    const atDaemon = daemon.settings();
    daemonBoxes.clear();
    browser = atDaemon ? browserChoice(daemon, atDaemon.browser) : null;
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
      ...(browser ? [browser.root] : []),
    );
  }
  // Another page may change them while the menu is open here.
  daemon.onSettings(() => {
    const atDaemon = daemon.settings();
    if (!atDaemon || !menu.matches(':popover-open')) return;
    if (!browser) return render();
    for (const [key, box] of daemonBoxes) box.checked = atDaemon[key];
    browser.show(atDaemon.browser);
  });
  return { root };
}
