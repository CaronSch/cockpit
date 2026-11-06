/**
 * Reads the daemon's fork registry (daemon/forks.js: each fork's omp id → the conversation it
 * was forked from, and its title) for one conversation: what it was forked from and its own
 * forks, which the agent pane's Forks menu lists, and the family it belongs to, which colours
 * the windows of related conversations alike.
 */
/** @import { Forks } from '../../daemon/forks.js' */

/**
 * The conversation `id` was forked from and its own forks, oldest first.
 * @param {Forks} forks @param {string | null} id
 * @returns {{ parent: string | null, children: string[] }}
 */
export function relatives(forks, id) {
  if (id === null) return { parent: null, children: [] };
  return { parent: Object.hasOwn(forks, id) ? forks[id].parent : null, children: Object.keys(forks).filter((child) => forks[child].parent === id) };
}

/**
 * The family conversation `id` belongs to, named by the conversation its line of forks started
 * from (that one, too, is in it); null for one neither forked nor forked from. A fork whose
 * source was forked from it in turn (which omp cannot make, but a hand-edited registry can)
 * ends the line where it comes round.
 * @param {Forks} forks @param {string | null} id
 */
export function familyOf(forks, id) {
  if (id === null || (!Object.hasOwn(forks, id) && !Object.values(forks).some((link) => link.parent === id))) return null;
  const seen = new Set([id]);
  let root = id;
  while (Object.hasOwn(forks, root) && !seen.has(forks[root].parent)) {
    root = forks[root].parent;
    seen.add(root);
  }
  return root;
}
