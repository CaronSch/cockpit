import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { fileRefOf, isTextPath, splitFileRefs } from '../src/files/file-refs.js';

/** The paths (with lines) `text` names. @param {string} text */
const refs = (text) => splitFileRefs(text).flatMap((run) => ('path' in run ? [[run.path, run.line]] : []));

test('paths to text files, absolute, from home, relative or bare, with the line after one', () => {
  assert.deepEqual(refs('/tmp/sol_oct/astralane.json has 4 Jobs in sol-mainnet.'), [['/tmp/sol_oct/astralane.json', null]]);
  assert.deepEqual(refs('See src/app.js:42, ~/notes/plan.md:3:7 and ../x/y.ts.'), [['src/app.js', 42], ['~/notes/plan.md', 3], ['../x/y.ts', null]]);
  assert.deepEqual(refs('Edit "daemon/main.js" (or README.md)!'), [['daemon/main.js', null], ['README.md', null]]);
});

test('the run keeps the text as written, line included, and the rest around it', () => {
  assert.deepEqual(splitFileRefs('at src/a.ts:9 now'), [{ text: 'at ' }, { text: 'src/a.ts:9', path: 'src/a.ts', line: 9 }, { text: ' now' }]);
  assert.deepEqual(splitFileRefs('nothing here'), [{ text: 'nothing here' }]);
});

test('not files: URLs, product names, versions, words with a dot, other extensions', () => {
  assert.deepEqual(refs('Open https://x.com/a.json, built on Node.js and Vue.js 1.2.3, e.g. foo.bar, logo.png or .env'), []);
});

test('a code span names a file only when it holds a path and nothing else', () => {
  assert.deepEqual(fileRefOf('src/omp/decisions.js:12'), { path: 'src/omp/decisions.js', line: 12 });
  assert.equal(fileRefOf('cat src/app.js'), null);
  assert.equal(isTextPath('/a/b/Notes.MD'), true);
  assert.equal(isTextPath('/a/b/.json'), false);
});
