import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { SCREEN_ID, claimOrder, copyLayout, describeWindows, newScreenId, workspaceFrom } from '../src/workspace/model.js';
import { branch, leaf } from '../src/layout/grid-model.js';

describe('workspace model', () => {
  test('a copied layout has the same windows and settings under new ids, sharing nothing with the original', () => {
    const one = { ...leaf('w_1', 'omp'), params: { session: 's1' } };
    const tree = branch('row', [one, leaf('w_2', 'pane')], [0.3, 0.7]);
    let n = 0;
    const copy = copyLayout(tree, () => `w_new${++n}`);
    assert.deepEqual(copy, branch('row', [{ ...leaf('w_new1', 'omp'), params: { session: 's1' } }, leaf('w_new2', 'pane')], [0.3, 0.7]));
    assert.notEqual(/** @type {any} */ (copy).children[0].params, one.params);
    assert.equal(copyLayout(null), null);
  });

  test('the page names its workspace in ?workspace=, main when it names none, and nothing that is not a file name', () => {
    assert.equal(workspaceFrom(''), 'main');
    assert.equal(workspaceFrom('?x=1'), 'main');
    assert.equal(workspaceFrom('?workspace=e2e-3f9a'), 'e2e-3f9a');
    for (const bad of ['', '..', '../token', '%2e%2e%2ftoken', 'Main', 'a/b', '-x', 'a b', 'x'.repeat(41)]) {
      assert.equal(workspaceFrom(`?workspace=${bad}`), null, bad);
    }
  });

  test('a window tries the screen its tab had, then every saved one in order', () => {
    assert.deepEqual(claimOrder(null, ['s1', 's2']), ['s1', 's2']);
    assert.deepEqual(claimOrder('s2', ['s1', 's2', 's3']), ['s2', 's1', 's3']);
    assert.deepEqual(claimOrder('s9', ['s1']), ['s9', 's1'], 'a screen not stored yet is still the tab’s');
    assert.deepEqual(claimOrder(null, []), []);
  });

  test('new screen ids are valid and distinct', () => {
    const ids = new Set(Array.from({ length: 50 }, newScreenId));
    assert.equal(ids.size, 50);
    for (const id of ids) assert.match(id, SCREEN_ID);
  });

  test('a screen is described by how many windows of each kind it holds', () => {
    const titles = /** @type {Record<string, string>} */ ({ omp: 'Agent', scratchpad: 'Notes' });
    const titleOf = (/** @type {string} */ w) => titles[w] ?? w;
    const tree = branch('row', [leaf('a', 'omp'), branch('col', [leaf('b', 'scratchpad'), leaf('c', 'omp')])]);
    assert.equal(describeWindows(tree, titleOf), '2 Agent, 1 Notes');
    assert.equal(describeWindows(null, titleOf), 'no windows');
  });
});
