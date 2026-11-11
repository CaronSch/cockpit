import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { ANSWER_BRIEFLY, asQuote, composeAsk, composeFollowUp, composeMessage, isCommand, splitAttachments } from '../src/omp/message.js';

describe('the message the agent pane sends', () => {
  test('each comment quotes its text, then says its piece, before the prompt', () => {
    const message = composeMessage('  and then deploy?  ', [
      { quote: 'Run the migration first.', comment: 'Which one?' },
      { quote: 'line one\n\nline three', comment: ' both? ' },
    ]);
    assert.equal(message, '> Run the migration first.\n\nWhich one?\n\n> line one\n>\n> line three\n\nboth?\n\nand then deploy?');
  });

  test('comments alone are a message; nothing at all is not', () => {
    assert.equal(composeMessage('', [{ quote: 'x', comment: 'why?' }]), '> x\n\nwhy?');
    assert.equal(composeMessage('   ', []), '');
  });

  test('a quote keeps its blank lines inside the quote', () => {
    assert.equal(asQuote('\na\n\nb\n'), '> a\n>\n> b');
  });

  test('slash commands and shell lines are commands, prose is not', () => {
    assert.equal(isCommand('/model'), true);
    assert.equal(isCommand('  !ls'), true);
    assert.equal(isCommand('use /tmp for it'), false);
  });

  test('a side question quotes the text it is about, asks, and asks for a short answer; so does each follow-up', () => {
    const asked = composeAsk('line one\n\nline three', '  why both?  ');
    const quoted = asked.indexOf(asQuote('line one\n\nline three'));
    assert.ok(quoted >= 0 && quoted < asked.indexOf('why both?'), 'the quote comes before the question');
    assert.ok(asked.endsWith(`why both?\n\n${ANSWER_BRIEFLY}`));
    assert.equal(composeFollowUp('  and then?  '), `and then?\n\n${ANSWER_BRIEFLY}`);
  });

  test('files follow the prompt as omp mentions', () => {
    const message = composeMessage('why does this fail?', [], ['/state/attachments/2026-01-02/k1-shot.png', '/tmp/odd "name".txt']);
    assert.equal(message, 'why does this fail?\n\n@"/state/attachments/2026-01-02/k1-shot.png"\n\n@\'/tmp/odd "name".txt\'');
    assert.equal(composeMessage('', [], ['/a.png']), '@"/a.png"', 'a file alone is a message');
  });

  test('a sent prompt splits back into its text and the files it ends with; mentions in the text stay', () => {
    const files = ['/state/attachments/2026-01-02/k1-shot.png', '/tmp/odd "name".txt'];
    assert.deepEqual(splitAttachments(composeMessage('why does this fail?', [], files)), { text: 'why does this fail?', files });
    assert.deepEqual(splitAttachments(composeMessage('', [], ['/a.png'])), { text: '', files: ['/a.png'] });
    assert.deepEqual(splitAttachments('compare @"/x.md" with this\n\n@"/y.png"'), { text: 'compare @"/x.md" with this', files: ['/y.png'] });
    assert.deepEqual(splitAttachments('no files here'), { text: 'no files here', files: [] });
  });
});
