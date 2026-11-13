/**
 * App-wide settings, picked in the top bar's Config menu and kept per browser. The menu
 * opens while the pointer rests on Config (and closes a moment after it leaves), or on a
 * click, on Config or in the menu, which keeps it open until a click elsewhere or Esc.
 *
 * Each setting is a switch with its default; only the ones this browser chose are stored, so a
 * page can tell a choice from the default (`storedSetting`). After them comes this browser's
 * desktop notifications (sessions/notify.js). Below them the menu lists the daemon's settings
 * (daemon/settings.js), the same for every browser, while the daemon can be reached: its
 * switches, Phone access (with, while it is on, the QR code a phone signs in with), which
 * browser agents drive, the Obsidian vault wiki links are found in, and Accounts, which signs omp
 * in to a model provider (ui/login.js).
 * The Setup window (widgets/setup.js) offers the same ones, Phone access in a step of its own.
 */
import { button, el } from './dom.js';
import { tildeHome } from './format.js';
import { createAtom } from '../state/atom.js';
import { createLogin } from './login.js';
import { openOnHover } from './hover-menu.js';
/** @import { DaemonClient } from '../daemon/client.js' */
/** @import { Notifier } from '../sessions/notify.js' */
/** @import { BrowserChoice } from '../../daemon/browser.js' */
/** @import { RemoteState } from '../../daemon/wire.js' */

const SETTINGS_KEY = 'cockpit.settings';
/** @typedef {'onlyResponses' | 'animatedSelection'} SettingKey */
/** @typedef {{ key: SettingKey, label: string, detail: string, initial: boolean }} Setting */

/** The settings, in the order the menu lists them. @type {readonly Setting[]} */
const SETTINGS = [
  {
    key: 'onlyResponses',
    label: 'Only prompts and responses',
    detail: 'Hide thinking and tool calls in agent windows',
    initial: false,
  },
  {
    key: 'animatedSelection',
    label: 'Animated selection',
    detail: 'Highlight whole words as you drag over a reply',
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
    detail: 'Compact long idle conversations before their prompt cache expires',
  },
  {
    key: 'decisionReview',
    label: 'Review decisions',
    detail: 'List the decisions an agent took without you, under each reply',
  },
  {
    key: 'adhd',
    label: 'I have ADHD',
    detail: 'Replies lead with the next step: numbered, short, no preamble',
  },
];

/** @typedef {{ value: BrowserChoice, label: string, detail: string }} BrowserOption */

/** Which browser agents drive (daemon/browser.js), as Setup and the menu offer it. @type {readonly BrowserOption[]} */
const BROWSER_OPTIONS = [
  {
    value: 'isolated',
    label: 'A separate browser',
    detail: 'omp’s own Chrome: never your tabs or logins',
  },
  {
    value: 'relay',
    label: 'Your Chrome',
    detail: 'Your tabs, through omp’s browser relay extension',
  },
  {
    value: 'omp',
    label: 'As omp is set up',
    detail: 'Whatever omp’s own config says',
  },
];

/** The heading of the browser choice, and what it is about. */
const BROWSER_SETTING = Object.freeze({
  label: 'Agents’ browser',
  detail: 'Where agents open web pages',
});

/** @typedef {Record<SettingKey, boolean>} Settings */

/** The switches stored, as chosen; anything unknown or not a switch is ignored. @param {string | null} value @returns {Partial<Settings>} */
function parseChosen(value) {
  /** @type {Record<string, unknown>} */
  let saved = {};
  try {
    const parsed = value ? JSON.parse(value) : null;
    if (parsed && typeof parsed === 'object') saved = parsed;
  } catch {
    // Not settings: none chosen.
  }
  return /** @type {Partial<Settings>} */ (Object.fromEntries(SETTINGS.flatMap((s) => (typeof saved[s.key] === 'boolean' ? [[s.key, saved[s.key]]] : []))));
}

/** Stored settings over the defaults; anything unknown or not a switch is ignored. @param {string | null} value @returns {Settings} */
function parseSettings(value) {
  const chosen = parseChosen(value);
  return /** @type {Settings} */ (Object.fromEntries(SETTINGS.map((s) => [s.key, chosen[s.key] ?? s.initial])));
}

/** What this browser stored, or null when it has none (or no storage). @returns {string | null} */
function storedText() {
  try {
    return localStorage.getItem(SETTINGS_KEY);
  } catch {
    return null;
  }
}

/** The settings as they are now; subscribe to follow them. */
export const settings = createAtom(parseSettings(storedText()));

/** What this browser chose for `key`, or null if it never chose. @param {SettingKey} key @returns {boolean | null} */
export const storedSetting = (key) => parseChosen(storedText())[key] ?? null;

/** Sets `key` for this browser, from now on and across reloads. @param {SettingKey} key @param {boolean} on */
export function setSetting(key, on) {
  settings.set({ ...settings.get(), [key]: on });
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...parseChosen(storedText()), [key]: on }));
  } catch {
    // Not kept: it stays as chosen until the page reloads.
  }
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

/** Phone access (the daemon's `remote`, daemon/remote.js), as Config offers it. */
const PHONE_SETTING = Object.freeze({
  label: 'Phone access',
  detail: 'Use your agents from your phone, over Tailscale',
});

/** How Phone access is doing: on, coming on, or why it is not. @param {RemoteState | null} remote */
const remoteText = (remote) => (remote?.state === 'on' ? 'On' : remote?.state === 'error' ? (remote.error ?? 'Phone access failed') : 'Starting…');

/**
 * The Phone access switch and, while it is on, how it is doing; once on, the QR code a phone
 * signs in with (an image, never markup), the phone's address and whose devices get in, asked
 * of the daemon each time it comes on (its address may change). `show` follows the daemon. Config
 * and Setup each show one.
 * @param {DaemonClient} daemon
 */
export function phoneAccess(daemon) {
  const root = el('div', 'config-phone');
  const { row, box } = switchRow(PHONE_SETTING.label, PHONE_SETTING.detail, false, (on, box) => {
    // The daemon tells every page, this one too; until then the switch shows the choice.
    daemon.changeSettings({ remote: on }).catch(() => (box.checked = !on));
  });
  const panel = el('div', 'config-phone-panel');
  const stateLine = el('p', 'config-detail config-phone-state');
  const signIn = el('div', 'config-phone-sign-in');
  panel.append(stateLine, signIn);
  root.append(row, panel);
  /** Whether the sign-in was asked for since it last came on. */
  let asked = false;
  /** Which asking is current: an answer to an older one is stale. */
  let asking = 0;
  function show() {
    const on = daemon.settings()?.remote ?? false;
    const remote = daemon.remote();
    box.checked = on;
    panel.hidden = !on;
    stateLine.textContent = remoteText(remote);
    panel.classList.toggle('is-error', remote?.state === 'error');
    if (!on || remote?.state !== 'on') {
      asked = false;
      asking++;
      signIn.replaceChildren();
      return;
    }
    if (asked) return;
    asked = true;
    const mine = ++asking;
    daemon
      .remoteInfo()
      .then((info) => {
        if (mine !== asking || info.state !== 'on' || info.qr === null || info.url === null || info.login === null) return;
        const qr = el('img', 'config-phone-qr');
        qr.src = `data:image/svg+xml,${encodeURIComponent(info.qr)}`;
        qr.alt = 'QR code: scan it with your phone to sign in';
        signIn.replaceChildren(qr, el('p', 'config-phone-url', info.url), el('p', 'config-detail', `Only ${info.login}’s devices`));
      })
      .catch(() => {
        // Asked again on the next change.
        if (mine === asking) asked = false;
      });
  }
  show();
  return { root, show };
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

/**
 * The Obsidian vault wiki links (`[[note]]`) are found in when the text they are in is in no vault
 * (the daemon's `vault`, daemon/vaults.js): None, or one of the vaults Obsidian knows, each a radio
 * changing the daemon's setting; `show` follows a change made elsewhere. Hidden while there is
 * nothing to pick (no Obsidian, and none picked).
 * @param {DaemonClient} daemon @param {string | null} vault
 */
function vaultChoice(daemon, vault) {
  const root = el('fieldset', 'config-group');
  root.hidden = true;
  const name = `vault-${crypto.randomUUID().slice(0, 8)}`;
  let current = vault;
  /** @type {HTMLInputElement[]} */
  let radios = [];
  /** @param {string | null} next */
  function show(next) {
    current = next;
    for (const radio of radios) radio.checked = radio.value === (next ?? '');
  }
  Promise.all([daemon.vaults(), daemon.config()]).then(
    ([{ vaults }, { home }]) => {
      const paths = current && !vaults.includes(current) ? [current, ...vaults] : vaults;
      if (!paths.length) return;
      root.append(el('legend', 'config-legend', 'Obsidian vault'), el('p', 'config-detail', 'Where [[wiki links]] lead from text in no vault'));
      radios = [null, ...paths].map((path) => {
        const row = el('label', 'config-setting');
        const radio = el('input');
        radio.type = 'radio';
        radio.name = name;
        radio.value = path ?? '';
        radio.checked = path === current;
        // The daemon tells every page, this one too; until then the radio shows the choice.
        radio.addEventListener('change', () => radio.checked && daemon.changeSettings({ vault: path }).catch(() => show(current)));
        const label = path ? path.slice(path.lastIndexOf('/') + 1) : 'None';
        row.append(radio, el('span', '', label), el('span', 'config-detail', path ? tildeHome(path, home) : 'Wiki links lead only within a vault'));
        root.append(row);
        return radio;
      });
      root.hidden = false;
    },
    () => {},
  );
  return { root, show };
}

/**
 * Desktop notifications, as Config offers them: this browser's, off until turned on here (which
 * asks the browser's permission), and saying why when the browser will not show them.
 * @param {Notifier} notifier
 */
function notificationsRow(notifier) {
  const blocked = notifier.blocked();
  const detail = blocked ?? 'When an agent finishes or needs you';
  const { row, box } = switchRow('Desktop notifications', detail, notifier.active(), (on) => {
    void notifier.set(on).then((now) => (box.checked = now));
  });
  box.disabled = blocked !== null;
  return row;
}

/** Accounts: sign omp in to a model provider, or with another account; one row, its login below it while one runs. @param {DaemonClient} daemon */
function accountsGroup(daemon) {
  const login = createLogin(daemon);
  login.signIn.classList.remove('btn-accent');
  const root = el('div', 'config-accounts');
  root.append(el('span', 'config-accounts-label', 'Accounts'), el('span', 'config-detail', 'Sign in to a model provider (omp login)'), login.signIn, login.panel);
  return { root, destroy: login.destroy };
}

/** A heading over a group of settings: whose they are. @param {string} text */
const heading = (text) => el('p', 'config-heading', text);

/** The top bar's Config button and its menu. @param {{ daemon: DaemonClient, notifier: Notifier }} options */
export function createConfigMenu({ daemon, notifier }) {
  const root = el('div', 'config');
  const toggle = button('topbar-btn config-toggle', 'Config');
  toggle.setAttribute('aria-haspopup', 'true');
  const menu = el('div', 'config-menu');
  menu.popover = 'auto';
  toggle.popoverTargetElement = menu;
  root.append(toggle, menu);

  // Opened while the pointer rests on it (ui/hover-menu.js); a click pins it open.
  openOnHover({ toggle, menu, areas: [root] });
  menu.addEventListener('toggle', (event) => {
    const opened = /** @type {ToggleEvent} */ (event).newState === 'open';
    toggle.setAttribute('aria-expanded', String(opened));
    if (!opened) {
      accounts?.destroy();
      accounts = null;
      return;
    }
    render();
  });
  /** The daemon's settings' switches, while the menu is open. @type {Map<DaemonSwitch, HTMLInputElement>} */
  const daemonBoxes = new Map();
  /** The browser choice, while the menu is open with the daemon's settings. @type {ReturnType<typeof browserChoice> | null} */
  let browser = null;
  /** The vault choice, while the menu is open with the daemon's settings. @type {ReturnType<typeof vaultChoice> | null} */
  let vault = null;
  /** Phone access, while the menu is open with the daemon's settings. @type {ReturnType<typeof phoneAccess> | null} */
  let phone = null;
  /** Accounts, while the menu is open with the daemon's settings. @type {ReturnType<typeof accountsGroup> | null} */
  let accounts = null;
  function render() {
    const now = settings.get();
    const atDaemon = daemon.settings();
    daemonBoxes.clear();
    browser = atDaemon ? browserChoice(daemon, atDaemon.browser) : null;
    vault = atDaemon ? vaultChoice(daemon, atDaemon.vault) : null;
    phone = atDaemon ? phoneAccess(daemon) : null;
    accounts?.destroy();
    accounts = atDaemon ? accountsGroup(daemon) : null;
    menu.replaceChildren(
      heading('This browser'),
      ...SETTINGS.map((setting) => switchRow(setting.label, setting.detail, now[setting.key], (on) => setSetting(setting.key, on)).row),
      notificationsRow(notifier),
      ...(atDaemon ? [heading('Every browser')] : []),
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
      ...(phone ? [phone.root] : []),
      ...(browser ? [browser.root] : []),
      ...(vault ? [vault.root] : []),
      ...(accounts ? [accounts.root] : []),
    );
  }
  // Another page may change them while the menu is open here.
  daemon.onSettings(() => {
    const atDaemon = daemon.settings();
    if (!atDaemon || !menu.matches(':popover-open')) return;
    if (!browser) return render();
    for (const [key, box] of daemonBoxes) box.checked = atDaemon[key];
    browser.show(atDaemon.browser);
    vault?.show(atDaemon.vault);
    phone?.show();
  });
  daemon.onRemote(() => {
    if (menu.matches(':popover-open')) phone?.show();
  });
  return { root };
}
