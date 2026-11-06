import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { createPromptHistory, sentPrompts } from '../src/omp/prompt-history.js';
/** @import { Item } from '../src/omp/transcript.js' */

let key = 0;
/** @param {string} text @param {boolean} [byAgent] @returns {Item} */
const user = (text, byAgent = false) => ({ key: `k${++key}`, rev: 1, kind: 'user', text, images: 0, byAgent, continues: false, at: null });
/** @param {string} command @param {'bash' | 'python'} [language] @returns {Item} */
const shell = (command, language = 'bash') => ({
  key: `k${++key}`,
  rev: 1,
  kind: 'bash',
  language,
  command,
  requestId: null,
  status: 'ok',
  output: '',
  exitCode: 0,
  truncated: false,
  error: null,
  fromMessage: true,
});

/** Presses keys against a box the way the pane does, and returns what the box shows after each. */
function box(/** @type {string[]} */ entries) {
  const history = createPromptHistory(() => entries);
  let text = '';
  let caret = 0;
  /** @param {'older' | 'newer'} direction */
  const press = (direction) => {
    const next = history.step(direction, text, caret);
    if (next !== null) {
      text = next;
      caret = direction === 'older' ? 0 : next.length;
    }
    return text;
  };
  return {
    up: () => press('older'),
    down: () => press('newer'),
    /** @param {string} value @param {number} [at] */
    type(value, at = value.length) {
      text = value;
      caret = at;
    },
    /** @param {number} at */
    caretAt(at) {
      caret = at;
    },
  };
}

describe('prompt history in the omp message box', () => {
  test('lists the user’s prompts and ! commands, newest first, without omp’s own messages or repeats in a row', () => {
    const items = [user('fix it'), user('[reminder]', true), shell('ls'), shell('print(1)', 'python'), user('again'), user('again'), user('   ')];
    assert.deepEqual(sentPrompts(items), ['again', '!ls', 'fix it']);
  });

  test('Up from an empty box steps back through them, Down forward and finally back to an empty box', () => {
    const b = box(['third', 'second', 'first']);
    assert.equal(b.up(), 'third');
    assert.equal(b.up(), 'second');
    assert.equal(b.up(), 'first');
    assert.equal(b.up(), 'first', 'the oldest stays');
    assert.equal(b.down(), 'second');
    assert.equal(b.down(), 'third');
    assert.equal(b.down(), '');
    assert.equal(b.down(), '', 'Down does nothing when not browsing');
    assert.equal(b.up(), 'third', 'and Up starts over from the newest');
  });

  test('Up never replaces a draft the user wrote, and an edit ends browsing with the edited text kept', () => {
    const b = box(['second', 'first']);
    b.type('my draft');
    assert.equal(b.up(), 'my draft');
    b.type('');
    assert.equal(b.up(), 'second');
    b.type('second, edited');
    assert.equal(b.up(), 'second, edited');
    assert.equal(b.down(), 'second, edited');
  });

  test('a multi-line entry is stepped past only from its first line going back, its last going forward', () => {
    const b = box(['one\ntwo', 'older']);
    assert.equal(b.up(), 'one\ntwo'); // the caret lands on the first line
    b.caretAt('one\nt'.length);
    assert.equal(b.up(), 'one\ntwo', 'Up on the second line moves the caret instead');
    b.caretAt(1);
    assert.equal(b.up(), 'older');
    assert.equal(b.down(), 'one\ntwo'); // the caret lands at the end
    b.caretAt(1);
    assert.equal(b.down(), 'one\ntwo', 'Down on the first line moves the caret instead');
    b.caretAt('one\ntwo'.length);
    assert.equal(b.down(), '');
  });
});
