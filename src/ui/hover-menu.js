/**
 * Top bar menus that open while the pointer rests on their button (Config, + Widget): the menu
 * follows the pointer, closing a moment after it leaves, and a click on the button or in the
 * menu pins it open (a login under way, a widget dragged out of it, never closes under the user).
 * A touch screen, with no pointer resting anywhere, opens it by a tap as before.
 */

/** How long the menu stays open after the pointer leaves it, so crossing the gap to it does not close it. */
const CLOSE_DELAY_MS = 250;

/**
 * Makes `menu` (a popover `toggle` opens) open on hover. `areas` are where the pointer counts as
 * on the menu: its button and the menu, or an element holding both.
 * @param {{ toggle: HTMLElement, menu: HTMLElement, areas?: HTMLElement[] }} options
 * @returns {{ hovered(): boolean }} whether the pointer opened it (and nothing has pinned it since)
 */
export function openOnHover({ toggle, menu, areas = [toggle, menu] }) {
  let hovering = false;
  let closing = 0;
  const open = () => menu.matches(':popover-open');
  for (const area of areas) {
    area.addEventListener('pointerenter', (e) => {
      if (e.pointerType !== 'mouse') return;
      clearTimeout(closing);
      if (open()) return;
      hovering = true;
      menu.showPopover({ source: toggle }); // under its button, as a click would open it
    });
    area.addEventListener('pointerleave', (e) => {
      if (e.pointerType !== 'mouse' || !hovering) return;
      clearTimeout(closing);
      closing = window.setTimeout(() => open() && hovering && menu.hidePopover(), CLOSE_DELAY_MS);
    });
  }
  toggle.addEventListener('click', (e) => {
    // Opened by hovering: the click pins it rather than closing it.
    if (hovering && open()) e.preventDefault();
    hovering = false;
  });
  menu.addEventListener('pointerdown', () => {
    hovering = false;
    clearTimeout(closing);
  });
  menu.addEventListener('toggle', (event) => {
    if (/** @type {ToggleEvent} */ (event).newState !== 'open') hovering = false;
  });
  return { hovered: () => hovering };
}
