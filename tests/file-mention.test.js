import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { PLAIN_PATH, commonPrefix, completeEntry, endedByPunctuation, extendSegment, matchEntries, mentionAt } from '../src/omp/file-mention.js';
/** @import { DirEntry } from '../src/omp/file-mention.js' */

/** @param {string} text */
const at = (text) => mentionAt(text, text.length);

/** @param {string} name */
const file = (name) => ({ name, isDir: false });
/** @param {string} name */
const dir = (name) => ({ name, isDir: true });

describe('the mention being typed', () => {
  test('is the path after an @ at the start or after whitespace, split at its last slash', () => {
    assert.deepEqual(at('@'), { start: 0, end: 1, quote: '', dir: '', segment: '' });
    assert.deepEqual(at('look at @src/ap'), { start: 8, end: 15, quote: '', dir: 'src/', segment: 'ap' });
    assert.deepEqual(at('x\n@../../'), { start: 2, end: 9, quote: '', dir: '../../', segment: '' });
    assert.deepEqual(at('@~/co'), { start: 0, end: 5, quote: '', dir: '~/', segment: 'co' });
    assert.deepEqual(at('@/etc/ho'), { start: 0, end: 8, quote: '', dir: '/etc/', segment: 'ho' });
  });

  test('an open quote keeps spaces in the path', () => {
    assert.deepEqual(at('see @"my dir/no'), { start: 4, end: 15, quote: '"', dir: 'my dir/', segment: 'no' });
    assert.deepEqual(at("@'a \"b/c"), { start: 0, end: 8, quote: "'", dir: 'a "b/', segment: 'c' });
  });

  test('is none inside a word, past a finished mention, or once the path has ended', () => {
    for (const text of ['ben@example', '@src/app.js ', '@"a b.txt"', '@"a b.txt" ', 'plain text', '@a@b']) {
      assert.equal(at(text), null, text);
    }
  });

  test('is read up to the caret, not the end of the text', () => {
    assert.deepEqual(mentionAt('@src/app.js and more', 6), { start: 0, end: 6, quote: '', dir: 'src/', segment: 'a' });
  });
});

describe('the entries a segment matches', () => {
  /** @type {DirEntry[]} */
  const entries = [file('readme.md'), dir('src'), file('Spec.md'), file('.env'), dir('.git'), file('assets.json'), dir('scripts')];

  test('every visible entry for an empty segment, folders first, then by name', () => {
    assert.deepEqual(
      matchEntries(entries, '').map((e) => e.name),
      ['scripts', 'src', 'assets.json', 'readme.md', 'Spec.md'],
    );
  });

  test('names starting with it before names containing it, ignoring case', () => {
    assert.deepEqual(
      matchEntries(entries, 'S').map((e) => e.name),
      ['scripts', 'src', 'Spec.md', 'assets.json'],
    );
  });

  test('dotfiles only once the segment starts with a dot', () => {
    assert.deepEqual(
      matchEntries(entries, '.').map((e) => e.name),
      ['.git', '.env', 'assets.json', 'readme.md', 'Spec.md'],
    );
    assert.deepEqual(matchEntries(entries, 'env'), []);
  });
});

describe('Tab and choosing an entry', () => {
  test('Tab extends to what several entries starting with the segment share, spelled as the first', () => {
    assert.equal(commonPrefix([file('App.js'), file('apple.txt'), file('map.js')], 'a'), 'App');
    assert.equal(commonPrefix([file('api.js'), file('app.js')], 'ap'), null, 'nothing more in common');
    assert.equal(commonPrefix([file('app.js'), file('map.js')], 'ap'), null, 'one starts with it: Tab picks it instead');
    assert.equal(commonPrefix([file('ab'), file('abc')], ''), 'ab');
  });

  test('a file becomes a finished mention and a space; a folder stays open on its contents', () => {
    const query = { start: 0, end: 7, quote: /** @type {''} */ (''), dir: 'src/', segment: 'ap' };
    assert.equal(completeEntry(query, file('app.js')), '@src/app.js ');
    assert.equal(completeEntry(query, dir('api')), '@src/api/');
    assert.equal(extendSegment(query, 'app'), '@src/app');
  });

  test('a path a bare mention would cut short is quoted, and a typed quote is kept', () => {
    const bare = { start: 0, end: 1, quote: /** @type {''} */ (''), dir: '', segment: '' };
    assert.equal(completeEntry(bare, file('my notes.md')), '@"my notes.md" ');
    assert.equal(completeEntry(bare, dir('my dir')), '@"my dir/');
    assert.equal(completeEntry(bare, file('v1.')), '@"v1." ', 'omp trims a trailing dot');
    assert.equal(completeEntry(bare, file('(draft)')), '@"(draft)" ');
    assert.equal(completeEntry(bare, file('say "hi"')), `@'say "hi"' `);
    assert.equal(extendSegment(bare, 'my n'), '@"my n');
    const open = { start: 0, end: 9, quote: /** @type {'"'} */ ('"'), dir: 'my dir/', segment: '' };
    assert.equal(completeEntry(open, file('a.txt')), '@"my dir/a.txt" ');
  });
});

describe('a field that holds one path', () => {
  /** @param {string} text */
  const pathAt = (text) => PLAIN_PATH.at(text, text.length);

  test('is all of its text, with no @, split at its last slash', () => {
    assert.deepEqual(pathAt(''), { start: 0, end: 0, quote: '', dir: '', segment: '' });
    assert.deepEqual(pathAt('~/'), { start: 0, end: 2, quote: '', dir: '~/', segment: '' });
    assert.deepEqual(pathAt('code/my app'), { start: 0, end: 11, quote: '', dir: 'code/', segment: 'my app' });
    assert.deepEqual(pathAt('../x'), { start: 0, end: 4, quote: '', dir: '../', segment: 'x' });
    assert.deepEqual(pathAt('/Users/b'), { start: 0, end: 8, quote: '', dir: '/Users/', segment: 'b' });
  });

  test('is none while the caret is not at its end', () => {
    assert.equal(PLAIN_PATH.at('/Users/ben', 0), null);
    assert.equal(PLAIN_PATH.at('/Users/ben', 6), null);
  });

  test('completes without quotes, a folder open on its own folders', () => {
    const query = /** @type {import('../src/omp/file-mention.js').MentionQuery} */ (pathAt('~/my co'));
    assert.equal(PLAIN_PATH.complete(query, dir('my code')), '~/my code/');
    assert.equal(PLAIN_PATH.extend(query, 'my cod'), '~/my cod');
  });
});

describe('a mention the sentence goes on after', () => {
  /** @type {DirEntry[]} */
  const entries = [dir('benches'), file('app.js'), file('app.js.bak'), file('README.md'), file('.env')];
  /** @param {string} text @param {readonly DirEntry[]} [folder] */
  const ended = (text, folder = entries) => endedByPunctuation(/** @type {import('../src/omp/file-mention.js').MentionQuery} */ (at(text)), folder);

  test('ends at punctuation after a folder or an entry’s exact name', () => {
    assert.equal(ended('see @benches/.', []), true);
    assert.equal(ended('see @benches/,', [file('bench.rs')]), true);
    assert.equal(ended('in @README.md)'), true);
    assert.equal(ended('and @README.md!?'), true);
  });

  test('ends even where a longer name starts with what is typed, which takes one more letter', () => {
    assert.equal(ended('@src/.', [file('.env')]), true, 'a dotfile');
    assert.equal(ended('@src/.e', [file('.env')]), false);
    assert.equal(ended('@app.js.'), true, 'app.js.bak');
    assert.equal(ended('@app.js.b'), false);
  });

  test('goes on for `.` and `..`, on their way to ./ and ../', () => {
    assert.equal(ended('@.'), false, './ or a dotfile');
    assert.equal(ended('@..'), false, '../');
  });

  test('goes on for a name not finished, without punctuation, or quoted', () => {
    assert.equal(ended('@READ.'), false, 'no entry is called READ');
    assert.equal(ended('@README.md'), false);
    assert.equal(ended('@benches/'), false);
    assert.equal(ended('@"benches/.', []), false, 'a quoted path takes punctuation as typed');
  });
});
