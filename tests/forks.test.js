import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { settledJournal } from '../daemon/forks.js';
import { fallbackForkTitle, parseForkTitle } from '../daemon/fork-title.js';
import { familyOf, relatives } from '../src/omp/fork-family.js';

/** @param {Record<string, any>[]} entries */
const journal = (entries) => `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`;
const head = [{ type: 'title', v: 1, title: 'Work' }, { type: 'session', version: 3, id: 'conv', timestamp: '2026-10-01T10:00:00.000Z', cwd: '/p' }];
/** @param {string} id @param {string | null} parentId @param {'user' | 'assistant' | 'toolResult'} role @param {string} [stopReason] */
const msg = (id, parentId, role, stopReason) => ({ type: 'message', id, parentId, message: { role, content: [{ type: 'text', text: id }], ...(stopReason ? { stopReason } : {}) } });

describe('settledJournal: a journal forked mid-turn, as of its last completed response', () => {
  test('the turn under way (its prompt, a reply asking for a tool, the tool’s result) is left out', () => {
    const kept = [...head, msg('u1', null, 'user'), msg('a1', 'u1', 'assistant', 'stop')];
    const text = journal([...kept, msg('u2', 'a1', 'user'), msg('a2', 'u2', 'assistant', 'toolUse'), msg('t2', 'a2', 'toolResult')]);
    assert.equal(settledJournal(text), journal(kept));
  });

  test('a response on a path set aside by a rewind is not the one kept', () => {
    // u1 → a1, then a rewind went back to before u2's answer: a2x was set aside, u3 is under way.
    const text = journal([
      ...head,
      msg('u1', null, 'user'),
      msg('a1', 'u1', 'assistant', 'stop'),
      msg('u2', 'a1', 'user'),
      msg('a2x', 'u2', 'assistant', 'stop'),
      msg('u3', 'a1', 'user'),
      msg('a3', 'u3', 'assistant', 'toolUse'),
    ]);
    const kept = settledJournal(text);
    assert.ok(kept);
    assert.deepEqual(
      kept.trim().split('\n').map((l) => (JSON.parse(l).type === 'message' ? JSON.parse(l).id : JSON.parse(l).type)),
      ['title', 'session', 'u1', 'a1'],
      'cut after a1, the last answer on the path the conversation is on',
    );
  });

  test('nothing to leave out, or nothing answered yet: null (the journal is forked as it is)', () => {
    assert.equal(settledJournal(journal([...head, msg('u1', null, 'user'), msg('a1', 'u1', 'assistant', 'stop')])), null);
    assert.equal(settledJournal(journal([...head, msg('u1', null, 'user'), msg('a1', 'u1', 'assistant', 'toolUse')])), null);
  });

  test('an aborted reply is not a completed one', () => {
    const kept = [...head, msg('u1', null, 'user'), msg('a1', 'u1', 'assistant', 'stop')];
    const text = journal([...kept, msg('u2', 'a1', 'user'), msg('a2', 'u2', 'assistant', 'aborted'), msg('u3', 'a2', 'user')]);
    assert.equal(settledJournal(text), journal(kept));
  });
});

describe('fork titles', () => {
  test('the model’s title comes without the wrapping models add, in any order', () => {
    assert.equal(parseForkTitle('"Try the queue approach".'), 'Try the queue approach');
    assert.equal(parseForkTitle('Title: **Benchmark the cache**\n\nThis fork benchmarks…'), 'Benchmark the cache');
    assert.equal(parseForkTitle('\n\n  # Port to Postgres!  \n'), 'Port to Postgres');
    assert.equal(parseForkTitle('  \n"".'), null);
  });

  test('a title too long for a top bar is cut; without one, the prompt’s first line stands in', () => {
    const long = parseForkTitle('word '.repeat(40));
    assert.ok(long && long.length <= 60 && long.endsWith('…'));
    assert.equal(fallbackForkTitle('  rewrite the parser\nwith a table'), 'rewrite the parser');
    assert.equal(fallbackForkTitle('   '), 'Fork');
  });
});

describe('fork families', () => {
  /** @param {string} parent */
  const link = (parent) => ({ parent, title: null });
  // root ← a ← a1, root ← b; lone stands apart.
  const forks = { a: link('root'), a1: link('a'), b: link('root') };

  test('a conversation, its forks and theirs are one family, named by where the line started', () => {
    assert.deepEqual(['root', 'a', 'a1', 'b'].map((id) => familyOf(forks, id)), ['root', 'root', 'root', 'root']);
    assert.equal(familyOf(forks, 'lone'), null, 'neither forked nor forked from');
    assert.equal(familyOf({ x: link('y'), y: link('x') }, 'x'), 'y', 'a line that comes round ends');
  });

  test('relatives are the parent and the direct forks only', () => {
    assert.deepEqual(relatives(forks, 'a'), { parent: 'root', children: ['a1'] });
    assert.deepEqual(relatives(forks, 'root'), { parent: null, children: ['a', 'b'] });
  });
});
