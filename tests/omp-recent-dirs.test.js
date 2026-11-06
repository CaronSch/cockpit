import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { RECENT_DIRS, recentDirs } from '../src/omp/recent-dirs.js';

/** @param {string | null} cwd @param {number} modifiedAt */
const at = (cwd, modifiedAt) => ({ cwd, modifiedAt });

describe('recent directories', () => {
  test('come the one active last first, each once', () => {
    const conversations = [at('/a', 1), at('/b', 5), at('/a', 9), at('/c', 3), at('/b', 2)];
    assert.deepEqual(recentDirs(conversations), ['/a', '/b', '/c']);
  });

  test('a directory written with and without its trailing slash is one', () => {
    assert.deepEqual(recentDirs([at('/a/b/', 4), at('/a/b', 2), at('/', 1)]), ['/a/b', '/']);
  });

  test('are at most five', () => {
    const conversations = Array.from({ length: 8 }, (_, i) => at(`/d${i}`, i));
    assert.equal(RECENT_DIRS, 5);
    assert.deepEqual(recentDirs(conversations), ['/d7', '/d6', '/d5', '/d4', '/d3']);
  });

  test('leave out conversations with no directory, and are none without conversations', () => {
    assert.deepEqual(recentDirs([at(null, 9), at('', 8), at('/a', 1)]), ['/a']);
    assert.deepEqual(recentDirs([]), []);
  });
});
