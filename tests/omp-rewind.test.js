import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { branchEntry, rewindPoint } from '../src/omp/rewind.js';
/** @import { Item } from '../src/omp/transcript.js' */

/** @param {string} key @param {string} text @param {boolean} [byAgent] @returns {Item} */
const user = (key, text, byAgent = false) => ({ key, rev: 0, kind: 'user', text, images: 0, byAgent, continues: false, at: null });
/** @param {string} key @returns {Item} */
const reply = (key) => ({ key, rev: 0, kind: 'assistant', blocks: [], stopReason: 'stop', errorMessage: null, model: null, ended: true, at: null });

const items = [user('a', 'first'), reply('r1'), user('b', 'second'), reply('r2'), user('c', 'steer', true), user('d', 'third'), reply('r3')];

describe('rewind', () => {
  test('a prompt’s place counts every user message from the end; what it sets aside counts the user’s own', () => {
    assert.deepEqual(rewindPoint(items, 'b'), { text: 'second', fromEnd: 2, setAside: 2 });
    assert.deepEqual(rewindPoint(items, 'd'), { text: 'third', fromEnd: 0, setAside: 1 });
    assert.equal(rewindPoint(items, 'c'), null, 'another agent’s prompt');
    assert.equal(rewindPoint(items, 'r1'), null, 'not a prompt');
  });

  test('omp’s entry is the one at the same place from the end, only if its text agrees', () => {
    // omp's journal can hold more than the window loaded, never other recent prompts.
    const listed = [{ entryId: 'e0', text: 'before' }, { entryId: 'e1', text: 'first' }, { entryId: 'e2', text: 'second' }, { entryId: 'e3', text: 'steer' }, { entryId: 'e4', text: 'third\n' }];
    assert.equal(branchEntry(listed, /** @type {any} */ (rewindPoint(items, 'b'))), 'e2');
    assert.equal(branchEntry(listed, /** @type {any} */ (rewindPoint(items, 'd'))), 'e4');
    assert.equal(branchEntry(listed.slice(0, 4), /** @type {any} */ (rewindPoint(items, 'b'))), null, 'another window sent since');
    assert.equal(branchEntry([], /** @type {any} */ (rewindPoint(items, 'a'))), null);
  });
});
