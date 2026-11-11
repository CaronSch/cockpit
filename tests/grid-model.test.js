import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import {
  leaf,
  branch,
  listLeaves,
  findLeaf,
  insertBeside,
  insertAtEdge,
  removeLeaf,
  moveLeaf,
  addTab,
  activateTab,
  moveTab,
  findSlot,
  applyDrop,
  canDropInto,
  setSizes,
  normalize,
  isValidTree,
  setLeafParams,
} from '../src/layout/grid-model.js';

/** @import { Tree, GridNode, Branch, Leaf, Stack } from '../src/layout/grid-model.js' */

/** Narrow to a branch, failing the test otherwise. @param {Tree | undefined} node @returns {Branch} */
const asBranch = (node) => {
  assert.ok(node?.kind === 'branch', 'expected a branch');
  return node;
};
/** Narrow to a leaf, failing the test otherwise. @param {GridNode | undefined} node @returns {Leaf} */
const asLeaf = (node) => {
  assert.ok(node?.kind === 'leaf', 'expected a leaf');
  return node;
};
/** Narrow to a stack, failing the test otherwise. @param {GridNode | null | undefined} node @returns {Stack} */
const asStack = (node) => {
  assert.ok(node?.kind === 'stack', 'expected a stack');
  return node;
};
/** @param {Tree} tree */
const ids = (tree) => listLeaves(tree).map((l) => l.id);
/** @param {number[]} xs */
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

describe('insertBeside', () => {
  test('splits a lone leaf into a row when dropping right', () => {
    const tree = leaf('a', 'log');
    const next = asBranch(insertBeside(tree, 'a', 'right', leaf('b', 'clock')));
    assert.equal(next.kind, 'branch');
    assert.equal(next.axis, 'row');
    assert.deepEqual(ids(next), ['a', 'b']);
    assert.deepEqual(next.sizes, [0.5, 0.5]);
  });

  test('places the new leaf before the target for left/up', () => {
    const next = asBranch(insertBeside(leaf('a', 'log'), 'a', 'up', leaf('b', 'clock')));
    assert.equal(next.axis, 'col');
    assert.deepEqual(ids(next), ['b', 'a']);
  });

  test('splices into an existing same-axis branch, halving only the target', () => {
    const tree = branch('row', [leaf('a', 'x'), leaf('b', 'x')], [0.6, 0.4]);
    const next = asBranch(insertBeside(tree, 'b', 'right', leaf('c', 'x')));
    assert.deepEqual(ids(next), ['a', 'b', 'c']);
    assert.deepEqual(next.sizes, [0.6, 0.2, 0.2]);
  });

  test('nests a cross-axis branch in place of the target', () => {
    const tree = branch('row', [leaf('a', 'x'), leaf('b', 'x')], [0.5, 0.5]);
    const next = asBranch(insertBeside(tree, 'b', 'down', leaf('c', 'x')));
    assert.equal(next.children[1].kind, 'branch');
    assert.equal(asBranch(next.children[1]).axis, 'col');
    assert.deepEqual(ids(next), ['a', 'b', 'c']);
    assert.deepEqual(next.sizes, [0.5, 0.5]);
  });

  test('does not mutate the input tree', () => {
    const tree = branch('row', [leaf('a', 'x'), leaf('b', 'x')], [0.5, 0.5]);
    const snapshot = structuredClone(tree);
    insertBeside(tree, 'a', 'left', leaf('c', 'x'));
    assert.deepEqual(tree, snapshot);
  });

  test('returns a single leaf when the tree is empty', () => {
    assert.deepEqual(insertBeside(null, 'nope', 'left', leaf('a', 'x')), leaf('a', 'x'));
  });
});

describe('insertAtEdge', () => {
  test('wraps a cross-axis root so the new leaf spans the full edge', () => {
    const tree = branch('row', [leaf('a', 'x'), leaf('b', 'x')], [0.5, 0.5]);
    const next = asBranch(insertAtEdge(tree, 'down', leaf('c', 'x')));
    assert.equal(next.axis, 'col');
    assert.equal(asLeaf(next.children[1]).id, 'c');
    assert.ok(Math.abs(sum(next.sizes) - 1) < 1e-9);
  });

  test('appends to a same-axis root and scales siblings proportionally', () => {
    const tree = branch('row', [leaf('a', 'x'), leaf('b', 'x')], [0.5, 0.5]);
    const next = asBranch(insertAtEdge(tree, 'left', leaf('c', 'x')));
    assert.deepEqual(ids(next), ['c', 'a', 'b']);
    assert.ok(Math.abs(sum(next.sizes) - 1) < 1e-9);
    assert.ok(Math.abs(next.sizes[1] - next.sizes[2]) < 1e-9);
  });
});

describe('removeLeaf', () => {
  test('collapses a two-child branch to the survivor', () => {
    const tree = branch('row', [leaf('a', 'x'), leaf('b', 'x')], [0.5, 0.5]);
    assert.deepEqual(removeLeaf(tree, 'a'), leaf('b', 'x'));
  });

  test('gives freed space to the adjacent sibling so others stay put', () => {
    const tree = branch('row', [leaf('a', 'x'), leaf('b', 'x'), leaf('c', 'x')], [0.2, 0.3, 0.5]);
    const next = asBranch(removeLeaf(tree, 'b'));
    assert.deepEqual(ids(next), ['a', 'c']);
    assert.deepEqual(next.sizes, [0.5, 0.5]);
  });

  test('flattens a nested branch that ends up with the parent axis', () => {
    const inner = branch('col', [leaf('b', 'x'), branch('row', [leaf('c', 'x'), leaf('d', 'x')])]);
    const tree = branch('row', [leaf('a', 'x'), inner], [0.5, 0.5]);
    const next = asBranch(removeLeaf(tree, 'b'));
    assert.equal(next.axis, 'row');
    assert.deepEqual(ids(next), ['a', 'c', 'd']);
    assert.deepEqual(next.sizes, [0.5, 0.25, 0.25]);
  });

  test('returns null when the last leaf is removed', () => {
    assert.equal(removeLeaf(leaf('a', 'x'), 'a'), null);
  });
});

describe('moveLeaf', () => {
  test('moves a leaf beside another target', () => {
    const tree = branch('row', [leaf('a', 'x'), leaf('b', 'x'), leaf('c', 'x')]);
    const next = moveLeaf(tree, 'a', 'c', 'right');
    assert.deepEqual(ids(next), ['b', 'c', 'a']);
  });

  test('is a no-op when dropping a leaf onto itself', () => {
    const tree = branch('row', [leaf('a', 'x'), leaf('b', 'x')]);
    assert.equal(moveLeaf(tree, 'a', 'a', 'left'), tree);
  });

  test('center drop stacks the window onto the target as its shown tab', () => {
    const tree = branch('row', [leaf('a', 'log'), leaf('b', 'clock'), leaf('c', 'x')], [0.2, 0.5, 0.3]);
    const next = asBranch(moveLeaf(tree, 'a', 'b', 'center'));
    assert.deepEqual(next.sizes, [0.7, 0.3]);
    assert.deepEqual(asStack(next.children[0]), { kind: 'stack', tabs: [leaf('b', 'clock'), leaf('a', 'log')], active: 'a' });
  });
});

describe('stacks', () => {
  const stacked = () => branch('row', [leaf('a', 'x'), { kind: 'stack', tabs: [leaf('b', 'x'), leaf('c', 'x'), leaf('d', 'x')], active: 'c' }]);

  test('every tab is a window of the tree', () => {
    assert.deepEqual(ids(stacked()), ['a', 'b', 'c', 'd']);
    assert.equal(findSlot(stacked(), 'd')?.kind, 'stack');
    assert.equal(isValidTree(stacked()), true);
  });

  test('closing the shown tab shows the next one, else the one before; one left is a plain window', () => {
    assert.equal(asStack(asBranch(removeLeaf(stacked(), 'c')).children[1]).active, 'd');
    const lastShown = activateTab(stacked(), 'd');
    assert.equal(asStack(asBranch(removeLeaf(lastShown, 'd')).children[1]).active, 'c');
    const one = asBranch(removeLeaf(removeLeaf(stacked(), 'b'), 'c'));
    assert.deepEqual(one.children[1], leaf('d', 'x'));
    assert.deepEqual(one.sizes, [0.5, 0.5], 'the slot keeps its size');
  });

  test('moveTab puts a tab at an index among the others, and is a no-op in place', () => {
    const tree = stacked();
    assert.deepEqual(ids(moveTab(tree, 'b', 2)), ['a', 'c', 'd', 'b']);
    assert.deepEqual(ids(moveTab(tree, 'd', 0)), ['a', 'd', 'b', 'c']);
    assert.equal(moveTab(tree, 'c', 1), tree);
  });

  test('splitting beside a tab splits beside its whole stack', () => {
    const next = asBranch(insertBeside(stacked(), 'b', 'down', leaf('n', 'x')));
    const col = asBranch(next.children[1]);
    assert.equal(col.axis, 'col');
    assert.equal(asStack(col.children[0]).tabs.length, 3);
    assert.deepEqual(col.children[1], leaf('n', 'x'));
  });

  test('a tab moved to an edge of its own stack leaves it for a slot beside it', () => {
    const next = asBranch(moveLeaf(stacked(), 'c', 'c', 'right'));
    assert.deepEqual(ids(next), ['a', 'b', 'd', 'c']);
    assert.equal(asStack(next.children[1]).active, 'd');
    const tree = stacked();
    assert.equal(moveLeaf(tree, 'c', 'b', 'center'), tree, 'into its own stack: nothing moves');
  });

  test('applyDrop into tabs: reorders within a stack, joins another at the index', () => {
    const tree = stacked();
    const reordered = applyDrop(tree, { source: { kind: 'move', id: 'b' }, target: { kind: 'tab', id: 'c', index: 1 }, dir: 'center' });
    assert.deepEqual(ids(reordered), ['a', 'c', 'b', 'd']);
    const joined = asStack(applyDrop(tree, { source: { kind: 'move', id: 'a' }, target: { kind: 'tab', id: 'c', index: 0 }, dir: 'center' }));
    assert.deepEqual(joined.tabs.map((t) => t.id), ['a', 'b', 'c', 'd']);
    assert.equal(joined.active, 'a');
    const fresh = asStack(applyDrop(leaf('a', 'x'), { source: { kind: 'new', leaf: leaf('n', 'y') }, target: { kind: 'leaf', id: 'a' }, dir: 'center' }));
    assert.deepEqual(fresh.tabs.map((t) => t.id), ['a', 'n']);
    assert.deepEqual(addTab(leaf('a', 'x'), 'a', leaf('n', 'y'), 0), { kind: 'stack', tabs: [leaf('n', 'y'), leaf('a', 'x')], active: 'n' });
  });

  test('isValidTree rejects malformed stacks', () => {
    const stack = (/** @type {unknown} */ tabs, active = 'a') => ({ kind: 'stack', tabs, active });
    assert.equal(isValidTree(stack([leaf('a', 'x')])), false, 'one tab');
    assert.equal(isValidTree(stack([leaf('a', 'x'), leaf('b', 'x')], 'z')), false, 'shows none of its tabs');
    assert.equal(isValidTree(stack([leaf('a', 'x'), branch('row', [leaf('b', 'x'), leaf('c', 'x')])])), false, 'a branch as a tab');
    const children = [leaf('a', 'x'), stack([leaf('a', 'x'), leaf('b', 'x')])];
    assert.equal(isValidTree({ kind: 'branch', axis: 'row', children, sizes: [0.5, 0.5] }), false, 'duplicate ids');
  });
});

describe('applyDrop', () => {
  const tree = branch('row', [leaf('a', 'x'), leaf('b', 'x')]);

  test('handles new widgets dropped on a leaf', () => {
    const next = applyDrop(tree, {
      source: { kind: 'new', leaf: leaf('n', 'clock') },
      target: { kind: 'leaf', id: 'a' },
      dir: 'down',
    });
    assert.ok(findLeaf(next, 'n'));
  });

  test('handles moves to the grid edge', () => {
    const next = asBranch(applyDrop(tree, {
      source: { kind: 'move', id: 'a' },
      target: { kind: 'edge' },
      dir: 'down',
    }));
    assert.equal(next.axis, 'col');
    assert.equal(asLeaf(next.children[1]).id, 'a');
  });

  test('a new window marked `into` dropped on the middle of one of its type gives that one its params', () => {
    const shown = { ...leaf('n', 'x'), params: { session: 's2' } };
    const into = applyDrop({ ...tree, children: [{ ...leaf('a', 'x'), params: { session: 's1', mine: true } }, leaf('b', 'x')] }, {
      source: { kind: 'new', leaf: shown, into: true },
      target: { kind: 'leaf', id: 'a' },
      dir: 'center',
    });
    assert.deepEqual(ids(into), ['a', 'b'], 'no window added');
    assert.deepEqual(findLeaf(into, 'a')?.params, { session: 's2', mine: true });
    assert.equal(canDropInto(tree, { kind: 'new', leaf: shown, into: true }, 'a'), true);
    assert.equal(canDropInto(tree, { kind: 'new', leaf: shown }, 'a'), false, 'only when asked for');
    assert.equal(canDropInto(tree, { kind: 'new', leaf: leaf('n', 'other'), into: true }, 'a'), false, 'only onto its own type');
    const stacked = applyDrop(tree, { source: { kind: 'new', leaf: shown }, target: { kind: 'leaf', id: 'a' }, dir: 'center' });
    assert.deepEqual(ids(stacked), ['a', 'n', 'b'], 'otherwise it stacks');
  });

  test('handles a drop into an empty grid', () => {
    const next = applyDrop(null, {
      source: { kind: 'new', leaf: leaf('n', 'clock') },
      target: { kind: 'empty' },
      dir: 'center',
    });
    assert.deepEqual(next, leaf('n', 'clock'));
  });
});

describe('setSizes / normalize / isValidTree', () => {
  test('setSizes replaces sizes at a path immutably', () => {
    const inner = branch('col', [leaf('b', 'x'), leaf('c', 'x')]);
    const tree = branch('row', [leaf('a', 'x'), inner]);
    const next = asBranch(setSizes(tree, [1], [0.25, 0.75]));
    assert.deepEqual(asBranch(next.children[1]).sizes, [0.25, 0.75]);
    assert.deepEqual(inner.sizes, [0.5, 0.5]);
  });

  test('normalize repairs sizes that do not sum to 1', () => {
    const next = asBranch(normalize(branch('row', [leaf('a', 'x'), leaf('b', 'x')], [2, 2])));
    assert.deepEqual(next.sizes, [0.5, 0.5]);
  });

  test('isValidTree accepts real trees and rejects junk', () => {
    assert.equal(isValidTree(branch('row', [leaf('a', 'x'), leaf('b', 'x')])), true);
    assert.equal(isValidTree(null), true);
    assert.equal(isValidTree({ kind: 'branch', axis: 'diag', children: [], sizes: [] }), false);
    assert.equal(isValidTree({ kind: 'leaf', id: 42 }), false);
    assert.equal(isValidTree(branch('row', [leaf('a', 'x'), leaf('a', 'x')])), false, 'duplicate ids');
  });
});

describe('leaf params', () => {
  test('setLeafParams merges into one leaf and leaves the others alone', () => {
    const tree = branch('row', [{ ...leaf('a', 'x'), params: { session: 's1', cwd: '/p' } }, leaf('b', 'x')]);
    const next = setLeafParams(tree, 'a', { session: 's2' });
    assert.deepEqual(findLeaf(next, 'a')?.params, { session: 's2', cwd: '/p' });
    assert.equal(findLeaf(next, 'b')?.params, undefined);
    assert.equal(setLeafParams(tree, 'missing', { session: 's3' }), tree);
  });

  test('params travel with their window through moves and stacking', () => {
    const bound = { ...leaf('a', 'omp'), params: { session: 's1' } };
    const tree = branch('row', [bound, leaf('b', 'x'), leaf('c', 'x')]);
    assert.deepEqual(findLeaf(moveLeaf(tree, 'a', 'c', 'down'), 'a')?.params, { session: 's1' });
    assert.deepEqual(findLeaf(moveLeaf(tree, 'a', 'b', 'center'), 'a')?.params, { session: 's1' });
  });

  test('isValidTree accepts flat JSON params and rejects anything else', () => {
    const withParams = (/** @type {unknown} */ params) => ({ kind: 'leaf', id: 'a', widget: 'x', params });
    assert.equal(isValidTree(withParams({ session: 's', n: 1, on: true, none: null })), true);
    assert.equal(isValidTree(withParams({ nested: { a: 1 } })), false);
    assert.equal(isValidTree(withParams(['s'])), false);
    assert.equal(isValidTree(withParams(null)), false);
    assert.equal(isValidTree(withParams({ n: Number.NaN })), false);
  });
});
