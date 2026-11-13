import { describe, expect, test } from 'bun:test';
import { findQuote } from '../src/omp/annotation-marks.js';

describe('findQuote', () => {
  test('finds the nth occurrence across text nodes, whatever whitespace separates them', () => {
    // A selection's text puts a line break between blocks; the DOM has nothing there.
    const texts = ['You said: the build', 'and the ', 'build steps'];
    expect(findQuote(texts, 'build', 0)).toEqual({ start: [0, 14], end: [0, 19] });
    expect(findQuote(texts, 'build', 1)).toEqual({ start: [2, 0], end: [2, 5] });
    expect(findQuote(texts, 'the build\nand  the', 0)).toEqual({ start: [0, 10], end: [1, 7] });
    expect(findQuote(texts, 'build', 2)).toBeNull();
    expect(findQuote(texts, 'nothing like it', 0)).toBeNull();
  });
});
