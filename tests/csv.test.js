import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { delimitedTable, parseDelimited, tableDelimiter } from '../src/files/csv.js';
import { inlineText } from '../src/omp/table-text.js';

test('quoted fields hold the delimiter, line breaks and doubled quotes; CRLF and LF end records; blank lines are no records', () => {
  const text = 'name,note\r\n"a, b","say ""hi"""\r\n\r\n"two\nlines",\nlast,x';
  assert.deepEqual(parseDelimited(text, ','), [
    ['name', 'note'],
    ['a, b', 'say "hi"'],
    ['two\nlines', ''],
    ['last', 'x'],
  ]);
  assert.deepEqual(parseDelimited('a\tb,c\n1\t"2\t3"\n', '\t'), [
    ['a', 'b,c'],
    ['1', '2\t3'],
  ]);
  assert.deepEqual(parseDelimited('"",\n', ','), [['', '']], 'an empty quoted field is still a record');
  assert.deepEqual(parseDelimited('\n\n', ','), []);
});

test('a table has every column of its widest row, numbers aligned right, a line break kept in its cell', () => {
  const table = delimitedTable('name,jobs,share\nastralane,4,1.5%\nsol,,\n"two\nlines",-1e3,0.25,extra\n', ',');
  assert.ok(table);
  const { block, shown, total } = table;
  assert.deepEqual([shown, total], [3, 3]);
  assert.deepEqual(block.head.map(inlineText), ['name', 'jobs', 'share', '']);
  assert.deepEqual(block.rows.map((r) => r.map(inlineText)), [
    ['astralane', '4', '1.5%', ''],
    ['sol', '', '', ''],
    ['two\nlines', '-1e3', '0.25', 'extra'],
  ]);
  assert.deepEqual(block.align, [null, 'right', 'right', null]);
});

test('copied as Markdown, a cell keeps its pipes and line breaks', () => {
  const table = delimitedTable('a,b\n"x|y","1\n2"\n', ',');
  assert.equal(table?.block.source, '| a | b |\n| --- | --- |\n| x\\|y | 1<br>2 |');
});

test('past the cap, only the first rows are in the table, and it says how many there are', () => {
  const table = delimitedTable(`n\n${Array.from({ length: 12 }, (_, i) => i).join('\n')}\n`, ',', 10);
  assert.deepEqual([table?.shown, table?.total, table?.block.rows.length], [10, 12, 10]);
  assert.equal(delimitedTable('', ','), null);
});

test('only .csv and .tsv files are tables', () => {
  assert.deepEqual(['/x/a.CSV', '/x/b.tsv', '/x/c.txt', '/x/csv'].map(tableDelimiter), [',', '\t', null, null]);
});
