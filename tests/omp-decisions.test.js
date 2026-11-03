import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { parseDecisions, placeReviews, turnToReview } from '../src/omp/decisions.js';
/** @import { Item } from '../src/omp/transcript.js' */

/** @param {string} key @param {string} text @param {number | null} at @param {boolean} [byAgent] @returns {Item} */
const prompt = (key, text, at, byAgent = false) => ({ key, rev: 0, kind: 'user', text, images: 0, byAgent, at });
/** @param {string} key @param {string} text @returns {Item} */
const reply = (key, text) => ({ key, rev: 0, kind: 'assistant', blocks: [{ kind: 'text', text }], stopReason: 'stop', errorMessage: null, model: null, ended: true, at: null });
const noTools = new Map();

describe('the turn the reviewer reads', () => {
  const items = [prompt('p1', 'first ask', 100), reply('r1', 'first answer'), prompt('p2', 'second ask', 200), reply('r2', 'second answer')];

  test('starts at the first prompt after where the last review stopped, and is named by its last prompt', () => {
    const steered = [...items, prompt('p3', 'and also this', 300), reply('r3', 'done both')];
    const turn = turnToReview(steered, noTools, 'r1');
    assert.equal(turn?.promptAt, 300);
    assert.ok(turn?.text.includes('second ask') && turn.text.includes('and also this') && turn.text.includes('done both'));
    assert.ok(!turn?.text.includes('first'), 'nothing of the turn before');
  });

  test('without a known end (resumed, rewound, first turn here) is the last prompt and what followed', () => {
    for (const since of [null, 'gone']) {
      const turn = turnToReview(items, noTools, since);
      assert.equal(turn?.promptAt, 200);
      assert.ok(!turn?.text.includes('first'), String(since));
    }
  });

  test('is none when the agent went on without a prompt of the user’s, or the prompt has no time', () => {
    const goneOn = [...items, prompt('n', 'a job finished', 300, true), reply('r3', 'noted')];
    assert.equal(turnToReview(goneOn, noTools, 'r2'), null);
    assert.equal(turnToReview([prompt('p', 'untimed', null), reply('r', 'ok')], noTools, null), null);
  });

  test('carries tool calls by their arguments, and no `@` omp would read a file for', () => {
    /** @type {Item} */
    const call = { key: 'c', rev: 0, kind: 'assistant', blocks: [{ kind: 'toolCall', id: 't1', name: 'bash', args: { command: 'ls' }, argsText: '', intent: null }], stopReason: 'toolUse', errorMessage: null, model: null, ended: true, at: null };
    const turn = turnToReview([prompt('p', 'look at @"/etc/passwd"', 1), call], noTools, null);
    assert.ok(turn?.text.includes('[agent tool bash] {"command":"ls"}'));
    assert.ok(!turn?.text.includes('@'));
  });

  test('a turn too long keeps its start, where the prompt is, and its end, where the answer is', () => {
    const work = Array.from({ length: 40 }, (_, i) => reply(`w${i}`, `${i} `.repeat(3000).slice(0, 5_900)));
    const turn = turnToReview([prompt('p', 'THE PROMPT', 1), ...work, reply('end', 'THE ANSWER')], noTools, null);
    assert.ok(turn && turn.text.length < 130_000);
    assert.ok(turn?.text.includes('THE PROMPT') && turn.text.includes('THE ANSWER') && turn.text.includes('left out'));
  });
});

describe("the reviewer's answer", () => {
  test('one decision a line, list marks off, at most five', () => {
    assert.deepEqual(parseDecisions('- Chose A.\n2. Chose B.\n\n* Chose C.\n• Chose D.\n1) Chose E.\nChose F.\n'), ['Chose A.', 'Chose B.', 'Chose C.', 'Chose D.', 'Chose E.']);
  });

  test('NONE is no decisions', () => {
    assert.deepEqual(parseDecisions('NONE\n'), []);
    assert.deepEqual(parseDecisions('none.'), []);
  });
});

describe('where a review shows', () => {
  const done = { status: /** @type {const} */ ('done'), decisions: ['Chose A.'] };

  test('where its turn ends: before the user’s next prompt (an injected message is not one), else at the end', () => {
    const items = [prompt('p1', 'a', 100), reply('r1', 'x'), prompt('i', 'injected', 150, true), reply('r1b', 'y'), prompt('p2', 'b', 200), reply('r2', 'z')];
    assert.deepEqual(placeReviews(items, { 100: done, 200: done }), [
      { index: 4, at: 100, review: done },
      { index: 6, at: 200, review: done },
    ]);
  });

  test('a review of a prompt no longer shown (rewound) shows nowhere', () => {
    assert.deepEqual(placeReviews([prompt('p', 'a', 100), reply('r', 'x')], { 999: done }), []);
  });
});
