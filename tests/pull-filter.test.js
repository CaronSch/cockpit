import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { authorsOf, filterPulls, pullStatus, statusFilter } from '../src/github/pull-filter.js';
/** @import { PullSummary } from '../daemon/wire.js' */

/** @param {number} number @param {string} state @param {boolean} isDraft @param {string} author @returns {PullSummary} */
const pull = (number, state, isDraft, author) => ({ number, title: '', state, isDraft, author, headRefName: '', url: '', updatedAt: '' });
const pulls = [pull(4, 'OPEN', false, 'octo'), pull(3, 'OPEN', true, 'hubot'), pull(2, 'MERGED', false, 'octo'), pull(1, 'CLOSED', false, 'Ann')];
/** @param {PullSummary[]} list */
const numbers = (list) => list.map((p) => p.number);

test('an open draft is a draft, not open; GitHub’s state otherwise', () => {
  assert.deepEqual(pulls.map(pullStatus), ['open', 'draft', 'merged', 'closed']);
});

test('narrowed by status (open or draft together), by author, or both, in the listed order', () => {
  assert.deepEqual(numbers(filterPulls(pulls, { status: 'all', author: null })), [4, 3, 2, 1]);
  assert.deepEqual(numbers(filterPulls(pulls, { status: 'active', author: null })), [4, 3]);
  assert.deepEqual(numbers(filterPulls(pulls, { status: 'open', author: null })), [4]);
  assert.deepEqual(numbers(filterPulls(pulls, { status: 'all', author: 'octo' })), [4, 2]);
  assert.deepEqual(numbers(filterPulls(pulls, { status: 'active', author: 'octo' })), [4]);
});

test('authors are offered once each, A→Z; a saved status that is not one is any status', () => {
  assert.deepEqual(authorsOf(pulls), ['Ann', 'hubot', 'octo']);
  assert.equal(statusFilter('merged'), 'merged');
  assert.equal(statusFilter('bogus'), 'all');
  assert.equal(statusFilter(undefined), 'all');
});
