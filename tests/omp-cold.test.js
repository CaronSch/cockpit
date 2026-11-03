import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { coldAt } from '../src/omp/cold.js';
/** @import { Item } from '../src/omp/transcript.js' */

/** @param {number | null} at @param {boolean} [byAgent] @returns {Item} */
const prompt = (at, byAgent = false) => ({ key: `u${at}`, rev: 0, kind: 'user', text: '', images: 0, byAgent, at });
/** @param {number | null} at @returns {Item} */
const reply = (at) => ({ key: `a${at}`, rev: 0, kind: 'assistant', blocks: [], stopReason: 'stop', errorMessage: null, model: null, ended: true, at });
/** @param {Item[]} items @param {{ streaming?: boolean, dialogs?: any[] }} [rest] */
const state = (items, { streaming = false, dialogs = [] } = {}) => ({ items, streaming, dialogs });

test('quiet from the last request, or the user’s last prompt if newer; an injected message is neither', () => {
  assert.equal(coldAt(state([prompt(100), reply(200), reply(300)]), 50), 350);
  assert.equal(coldAt(state([reply(300), prompt(400)]), 50), 450, 'a prompt just sent, its request not made yet');
  assert.equal(coldAt(state([reply(300), prompt(400, true)]), 50), 350);
});

test('never while the agent works or asks, or before anything was said', () => {
  assert.equal(coldAt(state([reply(300)], { streaming: true }), 50), null);
  assert.equal(coldAt(state([reply(300)], { dialogs: [{ id: 'd', method: 'ask' }] }), 50), null);
  assert.equal(coldAt(state([]), 50), null);
  assert.equal(coldAt(state([prompt(null)]), 50), null);
});
