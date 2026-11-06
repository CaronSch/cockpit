import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { responseTarget } from '../src/omp/response-nav.js';

// Responses starting at 100, 600 and 1100 in a transcript that scrolls to 1500 at most.
const tops = [100, 600, 1100];
const MAX = 1500;

describe('previous response', () => {
  test('from the bottom goes to the last response, then one further back each press', () => {
    assert.equal(responseTarget(tops, MAX, MAX, 'previous'), 1100);
    assert.equal(responseTarget(tops, 1100, MAX, 'previous'), 600);
    assert.equal(responseTarget(tops, 600, MAX, 'previous'), 100);
  });

  test('a response within the slack of the top counts as there, so the press steps past it', () => {
    assert.equal(responseTarget(tops, 1103, MAX, 'previous', 4), 600);
    assert.equal(responseTarget(tops, 1105, MAX, 'previous', 4), 1100);
  });

  test('none above goes to the very top', () => {
    assert.equal(responseTarget(tops, 100, MAX, 'previous'), 0);
    assert.equal(responseTarget([], 700, MAX, 'previous'), 0);
  });
});

describe('next response', () => {
  test('goes to the first response starting below the top, one each press', () => {
    assert.equal(responseTarget(tops, 0, MAX, 'next'), 100);
    assert.equal(responseTarget(tops, 100, MAX, 'next'), 600);
    assert.equal(responseTarget(tops, 597, MAX, 'next', 4), 1100);
  });

  test('none below goes to the bottom', () => {
    assert.equal(responseTarget(tops, 1100, MAX, 'next'), MAX);
    assert.equal(responseTarget([], 0, MAX, 'next'), MAX);
  });

  test('a response too near the end to reach the top lands at the bottom, and stays there', () => {
    assert.equal(responseTarget([100, 1800], 100, MAX, 'next'), MAX);
    assert.equal(responseTarget([100, 1800], MAX, MAX, 'next'), MAX);
    assert.equal(responseTarget([100, 1800], MAX, MAX, 'previous'), 100);
  });
});

test('a transcript too short to scroll stays at 0 either way', () => {
  assert.equal(responseTarget([0, 40], 0, 0, 'next'), 0);
  assert.equal(responseTarget([0, 40], 0, -5, 'previous'), 0);
});
