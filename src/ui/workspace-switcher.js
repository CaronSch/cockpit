/**
 * The workspace switcher in the top bar: the workspace this window shows, and a menu, open
 * while the pointer rests on it (hover-menu.js), of every workspace with what it holds; a click
 * on one shows it in this window instead. New workspace adds one and shows it. As a Sessions
 * row does, a row shows its actions (Rename, and Delete while there is another workspace) over
 * its right end while pointed at or focused, and a right-click (or Shift+F10) offers them too.
 * ⌃⌥1–9 show the first nine, ⌃⌥← and ⌃⌥→ the one before or after (src/app.js), as swiping
 * between macOS desktops does.
 *
 * While a window is dragged, its rows are where it can be dropped to move it to that workspace
 * (`dropAt`, which src/app.js asks as the drag goes; interaction/drag-controller.js).
 *
 * Deleting a workspace closes its windows, after asking if it has any; as closing a window
 * never does, it ends no agent (they run on, listed in the Sessions window), though a terminal's
 * shell ends with its window.
 */
import { button, el } from './dom.js';
import { errorMessage } from './format.js';
import { binIcon, chevronIcon, pencilIcon, workspacesIcon } from './icons.js';
import { openOnHover } from './hover-menu.js';
import { openContextMenu, opensContextMenu } from './context-menu.js';
import { workspaceName } from '../workspace/model.js';
/** @import { OpenedWorkspace } from '../workspace/shown.js' */
/** @import { Workspace } from '../../daemon/wire.js' */
/** @import { Tree } from '../layout/grid-model.js' */

/** How many workspaces ⌃⌥ and a digit reach. */
export const NUMBERED = 9;

/**
 * @param {{ opened: OpenedWorkspace, describe: (tree: Tree) => string }} options
 */
export function createWorkspaceSwitcher({ opened, describe }) {
  const root = el('div', 'ws-switcher');
  const toggle = button('topbar-btn ws-switch');
  toggle.setAttribute('aria-haspopup', 'true');
  const label = el('span', 'ws-label');
  const caret = chevronIcon();
  caret.classList.add('ws-caret');
  toggle.append(workspacesIcon(), label, caret);
  const menu = el('div', 'ws-menu');
  menu.popover = 'auto';
  menu.setAttribute('aria-label', 'Workspaces');
  toggle.popoverTargetElement = menu;
  root.append(toggle, menu);
  openOnHover({ toggle, menu, areas: [root] });

  if (!opened.ok) {
    label.textContent = 'Not saved';
    toggle.setAttribute('aria-label', 'Workspaces: not saved');
    menu.append(el('p', 'ws-note', opened.problem));
    return { root, dropAt: (/** @type {number} */ _x, /** @type {number} */ _y) => /** @type {Workspace | null} */ (null), close() {}, report(/** @type {string} */ _text) {} };
  }

  const { shown } = opened;
  /** Why the last change asked for here failed. */
  let note = '';
  /** What the menu shows instead of the list: a rename or a deletion under way. @type {{ kind: 'rename' | 'delete', id: string } | null} */
  let editing = null;
  /** The row a dragged window would be dropped on. @type {string | null} */
  let dropping = null;

  function draw() {
    const current = shown.list().find((w) => w.id === shown.id());
    const saveError = shown.saveError();
    label.textContent = (current?.name ?? '') + (saveError ? ' · not saved' : '');
    toggle.setAttribute('aria-label', `Workspace: ${current?.name ?? ''}${saveError ? ', not saved' : ''}`);
    toggle.classList.toggle('is-unsaved', Boolean(saveError));
    if (menu.matches(':popover-open')) fillMenu();
  }

  /** @param {Promise<unknown>} done @param {string} what */
  function attempt(done, what) {
    done.then(
      () => (note = ''),
      (err) => (note = `Could not ${what}: ${errorMessage(err)}`),
    ).finally(() => {
      editing = null;
      draw();
    });
  }

  /** @param {Workspace} w @param {number} i */
  function row(w, i) {
    if (editing?.id === w.id && editing.kind === 'rename') return renameRow(w);
    const item = el('div', 'ws-row');
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.setAttribute('aria-label', `Show ${w.name}`);
    item.dataset.workspace = w.id;
    const text = el('span', 'ws-row-text');
    text.append(el('span', 'ws-row-name', w.name), el('span', 'ws-row-detail', describe(w.tree)));
    item.append(text);
    if (i < NUMBERED) {
      const keys = el('kbd', 'ws-row-keys', `⌃⌥${i + 1}`);
      keys.setAttribute('aria-hidden', 'true');
      item.append(keys);
    }
    if (w.id === shown.id()) item.setAttribute('aria-current', 'true');
    item.classList.toggle('is-drop', w.id === dropping);
    const rename = () => {
      editing = { kind: 'rename', id: w.id };
      fillMenu();
    };
    const deletable = shown.list().length > 1;
    // Over the row's right end, where its shortcut is, while it is pointed at or focused.
    const tools = el('div', 'ws-row-tools');
    tools.append(action(pencilIcon(), `Rename ${w.name}`, rename), ...(deletable ? [action(binIcon(), `Delete ${w.name}`, () => remove(w))] : []));
    item.append(tools);
    const show = () => {
      menu.hidePopover();
      attempt(shown.switchTo(w.id), `show ${w.name}`);
    };
    item.addEventListener('click', (e) => {
      if (!/** @type {Element} */ (e.target).closest('.ws-row-action')) show();
    });
    const actions = () => [{ label: 'Rename', run: rename }, ...(deletable ? [{ label: 'Delete', run: () => remove(w) }] : [])];
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openContextMenu(item, actions(), { x: e.clientX, y: e.clientY });
    });
    item.addEventListener('keydown', (e) => {
      if (e.target !== item) return;
      if (opensContextMenu(e)) {
        e.preventDefault();
        openContextMenu(item, actions());
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        show();
      }
    });
    return item;
  }

  /** A row's action, drawn as an icon. @param {SVGElement} icon @param {string} label @param {() => void} run */
  function action(icon, label, run) {
    const b = button('ws-row-action', '', run);
    b.append(icon);
    b.setAttribute('aria-label', label);
    return b;
  }

  /** @param {Workspace} w */
  function renameRow(w) {
    const form = el('form', 'ws-rename');
    const input = /** @type {HTMLInputElement} */ (el('input', 'ws-rename-input'));
    input.value = w.name;
    input.maxLength = 40;
    input.setAttribute('aria-label', `Rename ${w.name}`);
    let done = false;
    const finish = (/** @type {boolean} */ save) => {
      if (done) return;
      done = true;
      const name = workspaceName(input.value);
      if (!save || name === null || name === w.name) {
        editing = null;
        fillMenu();
        return;
      }
      attempt(shown.rename(w.id, name), `rename ${w.name}`);
    };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      finish(true);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation(); // the menu stays open
      finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    form.append(input);
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
    return form;
  }

  /** @param {Workspace} w */
  function remove(w) {
    if (!w.tree) return attempt(shown.remove(w.id), `delete ${w.name}`);
    editing = { kind: 'delete', id: w.id };
    fillMenu();
  }

  /** @param {Workspace} w */
  function confirmDelete(w) {
    const yes = button('btn btn-danger', 'Delete', () => {
      yes.disabled = true;
      attempt(shown.remove(w.id), `delete ${w.name}`);
    });
    const no = button('btn', 'Cancel', () => {
      editing = null;
      fillMenu();
    });
    const actions = el('div', 'ws-actions');
    actions.append(yes, no);
    menu.replaceChildren(
      el('p', 'ws-note', `Delete ${w.name} and close its windows (${describe(w.tree)})? Agents shown in them keep running; its terminals end.`),
      actions,
    );
    requestAnimationFrame(() => yes.focus());
  }

  function fillMenu() {
    const all = shown.list();
    const deleting = editing?.kind === 'delete' ? all.find((w) => w.id === editing?.id) : null;
    if (deleting) return confirmDelete(deleting);
    menu.replaceChildren(...all.map(row));
    const add = button('btn', 'New workspace', () => {
      add.disabled = true;
      menu.hidePopover();
      attempt(shown.create(), 'add a workspace');
    });
    const foot = el('div', 'ws-new');
    foot.append(add);
    menu.append(foot);
    if (note) menu.append(el('p', 'ws-note', note));
  }

  menu.addEventListener('toggle', (event) => {
    if (/** @type {ToggleEvent} */ (event).newState !== 'open') {
      editing = null;
      return;
    }
    fillMenu();
  });
  shown.onChange(draw);
  draw();

  return {
    root,
    /**
     * The workspace whose row is at `x`, `y` (a window dragged there moves to it), marked as
     * where it would go; null, and no row marked, when there is none or it is this one.
     * @param {number} x @param {number} y @returns {Workspace | null}
     */
    dropAt(x, y) {
      const hit = menu.matches(':popover-open') ? /** @type {HTMLElement | null} */ (document.elementFromPoint(x, y)?.closest('.ws-row')) : null;
      const target = hit && hit.dataset.workspace !== shown.id() ? (shown.list().find((w) => w.id === hit.dataset.workspace) ?? null) : null;
      const id = target?.id ?? null;
      if (id !== dropping) {
        dropping = id;
        for (const r of menu.querySelectorAll('.ws-row')) r.classList.toggle('is-drop', /** @type {HTMLElement} */ (r).dataset.workspace === id);
      }
      return target;
    },
    close() {
      dropping = null;
      if (menu.matches(':popover-open')) menu.hidePopover();
    },
    /** Says what went wrong, in the menu, opened to show it. @param {string} text */
    report(text) {
      note = text;
      if (!menu.matches(':popover-open')) menu.showPopover({ source: toggle });
      fillMenu();
    },
  };
}
