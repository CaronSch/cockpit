import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { indexText, rank, stem, words } from '../daemon/search.js';

/** @param {string} title @param {...string} texts */
const doc = (title, ...texts) => ({ title, index: indexText({ title, texts }) });
/** @param {ReturnType<typeof doc>[]} docs @param {string} query */
const titles = (docs, query) => rank(docs, query).map((r) => r.doc.title);

describe('words', () => {
  test('a word and its forms are one word: stems are the start of their words', () => {
    for (const [a, b] of [['dropped', 'drop'], ['switched', 'switches'], ['bundles', 'bundle'], ['keys', 'key']]) assert.equal(stem(a), stem(b), `${a} ${b}`);
    for (const w of ['dropped', 'bundles', 'exclusive', 'running']) assert.ok(w.startsWith(stem(w)), w);
    assert.equal(stem('pass'), 'pass');
    assert.equal(stem('v2'), 'v2');
  });

  test('common English words, and talk of sessions, are not words to search by', () => {
    assert.deepEqual(words('In which session did we find that the Nova key dropped?'), ['nova', 'key', 'drop']);
  });
});

describe('rank', () => {
  const docs = [
    doc('Gate Binance latency on exclusivity', 'Binance latency is gated on exclusivity.', 'Binance Binance Binance'),
    doc('Check Nova key gas recovery', 'Looking at Binance gas recovery.', 'The drop in exclusivity lines up with the switch to the new Nova key at 15:20.'),
    doc('Deploy staging', 'deploy the staging cluster'),
  ];

  test('a question finds the conversation that answers it first, with that passage as its snippet', () => {
    const [first] = rank(docs, 'In which session did we find that Binance exclusivity dropped when we switched to the new Nova key?');
    assert.equal(first.doc.title, 'Check Nova key gas recovery');
    assert.match(first.snippet, /drop in exclusivity lines up with the switch/);
    assert.ok(first.terms.includes('nova') && first.terms.includes('drop'));
  });

  test('a word few conversations use counts for more than one most do; one that shares little is left out', () => {
    assert.deepEqual(titles(docs, 'staging'), ['Deploy staging']);
    assert.deepEqual(titles([...docs, doc('Nova only', 'nova nova')], 'nova binance'), ['Check Nova key gas recovery', 'Nova only', 'Gate Binance latency on exclusivity']);
  });

  test('the last word may still be being typed; one followed by a space is whole', () => {
    assert.deepEqual(titles(docs, 'depl'), ['Deploy staging']);
    assert.deepEqual(titles(docs, 'depl '), []);
  });

  test('a match in the title ranks before one in the text', () => {
    assert.deepEqual(titles([doc('Other', 'about recovery'), doc('Recovery')], 'recovery'), ['Recovery', 'Other']);
  });

  test('nothing to search by finds nothing', () => {
    assert.deepEqual(rank(docs, 'the which of'), []);
    assert.deepEqual(rank([], 'nova'), []);
  });

  test('a long passage is cut around its first match', () => {
    const long = `${'filler words here. '.repeat(30)}The Nova key matters. ${'more filler text. '.repeat(30)}`;
    const [hit] = rank([doc('x', long)], 'nova');
    assert.ok(hit.snippet.length <= 202, String(hit.snippet.length));
    assert.match(hit.snippet, /^….*Nova key matters/);
  });
});
