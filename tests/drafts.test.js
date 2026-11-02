import { test, describe, beforeEach } from 'bun:test';
import assert from 'node:assert/strict';
import { readDraft, writeDraft } from '../src/omp/drafts.js';

/** @type {Map<string, string>} */
const stored = new Map();
// localStorage, as a page has it.
Object.assign(globalThis, {
  localStorage: {
    getItem: (/** @type {string} */ k) => stored.get(k) ?? null,
    setItem: (/** @type {string} */ k, /** @type {string} */ v) => void stored.set(k, v),
    removeItem: (/** @type {string} */ k) => void stored.delete(k),
  },
});

describe('unsent messages', () => {
  beforeEach(() => stored.clear());

  test('are kept per conversation, text and cards', () => {
    const kept = {
      text: 'half a thought',
      cards: [
        { kind: /** @type {const} */ ('comment'), quote: 'hello', comment: 'why?' },
        { kind: /** @type {const} */ ('file'), name: 'notes.txt', size: 5, path: '/a/notes.txt' },
      ],
    };
    writeDraft('/j/a.jsonl', kept);
    assert.deepEqual(readDraft('/j/a.jsonl'), kept);
    assert.deepEqual(readDraft('/j/b.jsonl'), { text: '', cards: [] });
  });

  test('an empty box keeps nothing; a card alone is kept', () => {
    writeDraft('k', { text: 'x', cards: [] });
    writeDraft('k', { text: '  \n', cards: [] });
    assert.equal(stored.size, 0);
    writeDraft('k', { text: '', cards: [{ kind: 'comment', quote: 'q', comment: 'c' }] });
    assert.equal(readDraft('k').cards.length, 1);
  });

  test('an older draft kept as bare text reads as that text; a malformed card is dropped', () => {
    stored.set('cockpit.draft:k', 'just text');
    assert.deepEqual(readDraft('k'), { text: 'just text', cards: [] });
    stored.set('cockpit.draft:k', JSON.stringify({ text: 't', cards: [{ kind: 'file', name: 'x' }, { kind: 'comment', quote: 'q', comment: 'c' }] }));
    assert.deepEqual(readDraft('k'), { text: 't', cards: [{ kind: 'comment', quote: 'q', comment: 'c' }] });
  });
});
