/**
 * The small line icons buttons show in place of words: drawn as SVG strokes in the text's colour
 * (styles/app.css `.stroke-icon`), so they sit centred and crisp where a font's glyph would not.
 * Each is hidden from screen readers: its button says what it does (`aria-label`).
 */
import { svg } from './dom.js';

/** An icon drawn by `d` on a `size`-unit square. @param {string} d @param {number} size */
function icon(d, size) {
  const node = svg('svg', { class: 'stroke-icon', viewBox: `0 0 ${size} ${size}`, 'aria-hidden': 'true' });
  node.append(svg('path', { d }));
  return node;
}

/** ×: close. */
export const crossIcon = () => icon('M2 2l6 6M8 2l-6 6', 10);

/** +: a new one. */
export const plusIcon = () => icon('M5 1.5v7M1.5 5h7', 10);

/** Six dots, two by three: a handle to drag by (each a stroke of no length, its round caps a dot). */
export const gripIcon = () => icon('M3.75 2.5h0M6.25 2.5h0M3.75 5h0M6.25 5h0M3.75 7.5h0M6.25 7.5h0', 10);

/** A box with an arrow into it: archive. */
export const archiveIcon = () => icon('M2.5 3h11v3h-11zM3.5 6v7h9V6M8 7.5v3.5M6.25 9.5L8 11.25 9.75 9.5', 16);

/** A box with an arrow out of it: restore from the archive. */
export const unarchiveIcon = () => icon('M2.5 3h11v3h-11zM3.5 6v7h9V6M8 11.25V7.75M6.25 9.25L8 7.5l1.75 1.75', 16);

/** A closed envelope: mark as unread, as a mail client does. */
export const mailIcon = () => icon('M2.5 4h11v8h-11zM2.75 4.5L8 8.5l5.25-4', 16);

/** An open envelope: mark as read. */
export const mailOpenIcon = () => icon('M2.5 7L8 3l5.5 4v6h-11zM2.75 7.25L8 10.75l5.25-3.5', 16);

/** Two panes, one behind the other: the workspace switcher. */
export const workspacesIcon = () => icon('M5 3.5h8.5v6.5H5zM2.5 6v6.5H11', 16);

/** A pencil: rename. */
export const pencilIcon = () => icon('M10.5 2.5l3 3-7.5 7.5H3v-3zM9 4l3 3', 16);

/** A bin: delete. */
export const binIcon = () => icon('M2.5 4.5h11M6 4.5V2.75h4V4.5M4 4.5l.75 9h6.5l.75-9M6.75 7v4M9.25 7v4', 16);

/** A small chevron pointing down: a control that opens a menu. */
export const chevronIcon = () => icon('M2.5 4l2.5 2.5L7.5 4', 10);

/** A folder: a folder entry in a list of paths. */
export const folderIcon = () => icon('M2 4.5v8h12V6H7.5L6 4.5z', 16);

/** A page with its corner folded: a file entry in a list of paths. */
export const fileIcon = () => icon('M4 2h5.5L12.5 5v9H4zM9.5 2v3h3', 16);
