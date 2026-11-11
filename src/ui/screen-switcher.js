/**
 * The screen switcher in the top bar: which screen of its workspace this window shows, and a
 * menu of every screen, with what it holds and where it is open, to open one here or delete it,
 * or to open a copy of this one in a new tab.
 *
 * Screens are numbered in the order they were created. Deleting a screen closes its windows,
 * after asking; as closing a window never does, it ends no agent (they run on, listed in the
 * Sessions window).
 */
import { button, el } from './dom.js';
import { errorMessage } from './format.js';
/** @import { OpenedScreen, ScreenEntry } from '../workspace/screen.js' */
/** @import { Tree } from '../layout/grid-model.js' */

/**
 * @param {{ opened: OpenedScreen, describe: (tree: Tree) => string }} options
 */
export function createScreenSwitcher({ opened, describe }) {
  const root = el('div', 'screen-switcher');
  const toggle = button('topbar-btn screen-switch');
  toggle.setAttribute('aria-haspopup', 'true');
  const label = el('span', 'screen-label');
  const caret = el('span', 'screen-caret', '▾');
  caret.setAttribute('aria-hidden', 'true');
  toggle.append(label, caret);
  const menu = el('div', 'screen-menu');
  menu.popover = 'auto';
  menu.setAttribute('aria-label', 'Screens');
  toggle.popoverTargetElement = menu;
  root.append(toggle, menu);

  if (!opened.ok) {
    label.textContent = 'Not saved';
    toggle.title = opened.problem;
    menu.append(el('p', 'screen-note', opened.problem));
    return { root };
  }

  const { screen } = opened;
  /** @type {ScreenEntry[]} */
  let entries = [];
  /** Why the last listing or deletion failed. */
  let note = '';
  let confirming = false;

  async function refresh() {
    try {
      entries = await screen.list();
    } catch (err) {
      note = `Could not list the screens: ${errorMessage(err)}`;
    }
    draw();
  }

  function draw() {
    const at = entries.findIndex((e) => e.open === 'here');
    const saveError = screen.saveError();
    label.textContent = (at < 0 ? 'Screen' : `Screen ${at + 1} of ${entries.length}`) + (saveError ? ' · not saved' : '');
    toggle.classList.toggle('is-unsaved', Boolean(saveError));
    toggle.title = saveError ? `Not saved: ${saveError}` : `Workspace “${screen.workspace}”: switch screens`;
    if (menu.matches(':popover-open') && !confirming) fillMenu();
  }

  function fillMenu() {
    menu.replaceChildren(el('p', 'screen-menu-head', `Workspace “${screen.workspace}”`));
    entries.forEach((entry, i) => {
      const row = el('div', 'screen-row');
      const text = el('div', 'screen-row-text');
      text.append(el('span', 'screen-row-name', `Screen ${i + 1}`), el('span', 'screen-row-detail', describe(entry.tree)));
      row.append(text);
      if (entry.open === 'here') {
        row.setAttribute('aria-current', 'true');
        row.append(el('span', 'screen-row-where', 'this window'));
      } else if (entry.open === 'elsewhere') {
        row.append(el('span', 'screen-row-where', 'open in another window'));
      } else {
        const openHere = button('btn', 'Open here', () => screen.openHere(entry.id));
        openHere.setAttribute('aria-label', `Open Screen ${i + 1} here`);
        const remove = button('btn btn-danger', 'Delete', () => confirmDelete(entry, i + 1));
        remove.setAttribute('aria-label', `Delete Screen ${i + 1}`);
        row.append(openHere, remove);
      }
      menu.append(row);
    });
    const copy = button('btn', 'New screen', () => {
      copy.disabled = true;
      screen
        .openCopy()
        .then(() => menu.hidePopover())
        .catch((err) => {
          note = `Could not open a new screen: ${errorMessage(err)}`;
        })
        .finally(() => void refresh());
    });
    copy.title = 'Open a copy of this screen in a new tab';
    const actions = el('div', 'screen-actions screen-new');
    actions.append(copy);
    menu.append(actions);
    if (note) menu.append(el('p', 'screen-note', note));
  }

  /** @param {ScreenEntry} entry @param {number} number */
  function confirmDelete(entry, number) {
    confirming = true;
    const yes = button('btn btn-danger', 'Delete');
    const no = button('btn', 'Cancel', () => {
      confirming = false;
      fillMenu();
    });
    const actions = el('div', 'screen-actions');
    actions.append(yes, no);
    menu.replaceChildren(
      el('p', 'screen-note', `Delete Screen ${number} and close its windows (${describe(entry.tree)})? Agents shown in them keep running.`),
      actions,
    );
    yes.addEventListener('click', () => {
      yes.disabled = true;
      screen
        .remove(entry)
        .then((removed) => {
          note = removed ? '' : `Screen ${number} was opened or changed in another window, so it was not deleted.`;
        })
        .catch((err) => {
          note = `Could not delete Screen ${number}: ${errorMessage(err)}`;
        })
        .finally(() => {
          confirming = false;
          void refresh();
        });
    });
    yes.focus();
  }

  menu.addEventListener('toggle', (event) => {
    if (/** @type {ToggleEvent} */ (event).newState !== 'open') {
      confirming = false;
      return;
    }
    note = '';
    fillMenu();
    void refresh();
  });
  // Other windows add and close screens: look again whenever the user comes back.
  addEventListener('focus', () => void refresh());
  screen.onChange(() => void refresh());
  void refresh();

  return { root };
}
