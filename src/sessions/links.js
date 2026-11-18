/**
 * Which agent windows show which conversations: on this screen, so the Sessions window can mark
 * its rows and point at their windows; and in a workspace, so it can list only the
 * conversations a workspace shows. A window shows the conversation its settings name
 * (`conversationKey`: its journal, else a new one's session); one still starting a fork has
 * none yet, and shows nothing here.
 *
 * "Current" is the conversation in the agent window this screen used last: the one a click in
 * Sessions shows conversations in. That is not always the focused window (focus may be in
 * Sessions itself, or nowhere), and it is where a click lands, so it is the one marked.
 */
import { listLeaves } from '../layout/grid-model.js';
import { conversationKey } from './running.js';
/** @import { Leaf, Tree } from '../layout/grid-model.js' */
/** @import { ScreenWindows } from '../widgets/registry.js' */

/**
 * @typedef {{
 *   windows: Map<string, string[]>,
 *   current: string | null,
 *   pointed: string | null,
 * }} SessionLinks `windows`: the ids of the agent windows showing each conversation, in screen
 * order; `current`: the conversation in the agent window used last; `pointed`: the one in the
 * agent window under the pointer, or focused
 */

/** @param {unknown} v */
const str = (v) => (typeof v === 'string' && v ? v : null);

/** The conversation an agent window shows, if it is one. @param {Leaf | undefined} leaf */
const shownBy = (leaf) => (leaf?.widget === 'omp' ? conversationKey({ sessionFile: str(leaf.params?.sessionFile), session: str(leaf.params?.session) }) : null);

/** @param {ScreenWindows} screen @returns {SessionLinks} */
export function sessionLinks(screen) {
  /** @type {Map<string, string[]>} */
  const windows = new Map();
  for (const leaf of screen.windows) {
    const key = shownBy(leaf);
    if (key) windows.set(key, [...(windows.get(key) ?? []), leaf.id]);
  }
  /** @param {string | null | undefined} id */
  const shownIn = (id) => shownBy(screen.windows.find((leaf) => leaf.id === id));
  return { windows, current: shownIn(screen.used.omp), pointed: shownIn(screen.pointed) };
}

/** The conversations the agent windows of layout `tree` show, tabs behind others too. @param {Tree} tree @returns {Set<string>} */
export const conversationsIn = (tree) => new Set(listLeaves(tree).flatMap((leaf) => shownBy(leaf) ?? []));
