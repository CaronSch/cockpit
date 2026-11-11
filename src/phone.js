/**
 * The phone page (`/phone`, phone.html): the Sessions list, then one conversation full screen,
 * then Back, for a phone reaching the daemon over its owner's tailnet (daemon/remote.js).
 *
 * It mounts the workbench's own Sessions and Agent widgets, one at a time, with a context of its
 * own instead of the grid's: no grid, workspace, screens or Web Locks, since over plain HTTP the
 * page is no secure context. Opening a conversation pushes a history entry holding its params,
 * so the back gesture returns to the list and a reload reopens the conversation. The page's
 * daemon client is scoped: it streams the events of the conversations opened here only. Read and
 * reply only: no agent is started from the phone.
 */
import { getDaemon, useScopedDaemon } from './daemon/client.js';
import { setSetting, settings, storedSetting } from './ui/settings.js';
import { el } from './ui/dom.js';
import { WIDGETS } from './widgets/registry.js';
/** @import { LeafParams } from './layout/grid-model.js' */
/** @import { ScreenWindows, WidgetContext } from './widgets/registry.js' */
/** @import { ConnectionStatus } from './daemon/client.js' */

useScopedDaemon();
const daemon = getDaemon();
// Prompts and responses only, until this browser chooses otherwise: a phone is for reading.
if (storedSetting('onlyResponses') === null) setSetting('onlyResponses', true);

/** @template {HTMLElement} T @param {string} selector @returns {T} */
function query(selector) {
  const node = /** @type {T | null} */ (document.querySelector(selector));
  if (!node) throw new Error(`[phone] missing required element ${selector}`);
  return node;
}
const backBtn = query('.phone-back');
const titleEl = query('.phone-title');
const workBtn = query('.phone-work');
const actionsEl = query('.phone-actions');
const statusEl = query('.phone-status');
const viewEl = query('.phone-view');

/** A screen with no windows: the phone shows one widget, never beside another. @type {ScreenWindows} */
const EMPTY = Object.freeze({ windows: [], used: {}, pointed: null });
const SCREEN = { get: () => EMPTY, subscribe: () => () => {} };
const noop = () => {};

/** What the top bar says while the page cannot use the daemon. @type {Partial<Record<ConnectionStatus, string>>} */
const STATUS_TEXT = {
  down: 'Can’t reach the Mac',
  unauthorized: 'Scan the QR code in Config → Phone access on the Mac',
};

/** The list's own settings (search, sort, directory), kept for as long as the page is open. @type {LeafParams} */
let listParams = {};

/** @typedef {{ type: string, params: LeafParams, instance: { destroy(): void, paramsChanged?(): void } }} View */
/** The widget shown. @type {View | null} */
let shown = null;

/** The conversation the page's history entry shows, if any. @returns {LeafParams | null} */
const conversationParams = () => /** @type {{ params?: LeafParams } | null} */ (history.state)?.params ?? null;

/**
 * Mounts `type` with `params` in place of what was shown, which is destroyed (that never ends
 * a session: it is the daemon's).
 * @param {'sessions' | 'omp'} type @param {LeafParams} params
 */
function mount(type, params) {
  shown?.instance.destroy();
  actionsEl.replaceChildren();
  const def = WIDGETS[type];
  const body = el('div', 'widget-body');
  const label = el('span', 'phone-label');
  titleEl.replaceChildren(def.title, label);
  /** @type {View} */
  const view = { type, params, instance: { destroy: noop } };
  /** @type {WidgetContext} */
  const ctx = {
    get params() {
      return view.params;
    },
    setParams(patch) {
      view.params = { ...view.params, ...patch };
      if (shown !== view) return; // gone already: its history entry is another's now
      if (type === 'sessions') listParams = view.params;
      else if (view.params.session || view.params.sessionFile) history.replaceState({ params: view.params }, '');
      // The conversation is gone (nothing was ever said in it): the phone starts no new one.
      else return history.back();
      view.instance.paramsChanged?.();
    },
    addWidget: noop,
    showWidget(widget, p) {
      if (widget !== 'omp') return;
      history.pushState({ params: p }, '');
      render();
    },
    openTab: noop,
    dragWidget: noop,
    setUnread: noop,
    setLabel(text) {
      label.textContent = text ?? '';
    },
    headActions: actionsEl,
    screen: SCREEN,
    outline: noop,
    setFamily: noop,
  };
  body.dataset.widget = type;
  viewEl.replaceChildren(body);
  shown = view;
  view.instance = def.mount(body, ctx);
  backBtn.hidden = type !== 'omp';
  workBtn.hidden = type !== 'omp';
}

/** Shows what the page's history entry names: a conversation, else the list. */
function render() {
  const params = conversationParams();
  if (params) mount('omp', params);
  else mount('sessions', listParams);
}

function drawWork() {
  workBtn.setAttribute('aria-pressed', String(!settings.get().onlyResponses));
}

function drawStatus() {
  const text = STATUS_TEXT[daemon.status()];
  statusEl.textContent = text ?? '';
  statusEl.hidden = !text;
}

backBtn.addEventListener('click', () => history.back());
workBtn.addEventListener('click', () => setSetting('onlyResponses', !settings.get().onlyResponses));
window.addEventListener('popstate', render);
settings.subscribe(drawWork);
daemon.onStatus(drawStatus);
drawWork();
drawStatus();
render();
