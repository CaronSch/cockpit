import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { IDLE_COMPACT_LATE_MS, createIdleCompaction, followIdleCompaction, idleCompactionNow } from '../daemon/idle-compaction.js';

const options = { afterMs: 1000, minTokens: 200_000 };
const oneHour = { input: 10, output: 5, cacheRead: 249_000, cacheWrite: 1000, cttl: { ephemeral1h: 1000 } };

let seq = 0;
/** @param {ReturnType<typeof createIdleCompaction>} state @param {Record<string, any>} frame @param {number} at */
const feed = (state, frame, at) => followIdleCompaction(state, { kind: 'frame', frame, seq: ++seq, at, session: 's' }, options);

/**
 * A reply whose request started at `at` and ended a little later, with `usage`.
 * @param {ReturnType<typeof createIdleCompaction>} state @param {number} at @param {Record<string, any>} usage
 */
function reply(state, at, usage = oneHour) {
  feed(state, { type: 'message_start', message: { role: 'assistant' } }, at);
  feed(state, { type: 'message_end', message: { role: 'assistant', usage } }, at + 300);
}

describe('idle compaction', () => {
  test('is due the given while after the request that wrote a one-hour cache entry', () => {
    const state = createIdleCompaction();
    reply(state, 5000);
    assert.equal(idleCompactionNow(state, 5999), 'waiting');
    assert.equal(idleCompactionNow(state, 6000), 'due');
  });

  test('lapses when checked more than a minute late, as the entry has likely expired', () => {
    const state = createIdleCompaction();
    reply(state, 0);
    assert.equal(idleCompactionNow(state, 1000 + IDLE_COMPACT_LATE_MS), 'due');
    assert.equal(idleCompactionNow(state, 1001 + IDLE_COMPACT_LATE_MS), null);
  });

  test('moves with every newer request', () => {
    const state = createIdleCompaction();
    reply(state, 0);
    reply(state, 800);
    assert.equal(idleCompactionNow(state, 1500), 'waiting');
    assert.equal(idleCompactionNow(state, 1800), 'due');
  });

  test('never for a five-minute entry, an uncached request or a short conversation', () => {
    for (const usage of [
      { ...oneHour, cttl: { ephemeral5m: 1000 } },
      { input: 250_000, output: 5, cacheRead: 0, cacheWrite: 0 },
      { ...oneHour, cacheRead: 100_000 },
    ]) {
      const state = createIdleCompaction();
      reply(state, 0, usage);
      assert.equal(idleCompactionNow(state, 1000), null, JSON.stringify(usage));
    }
  });

  test('is dropped once the cached prefix changes: another model or thinking level, a compaction, a rewind', () => {
    for (const frame of [
      { type: 'model_changed' },
      { type: 'thinking_level_changed' },
      { type: 'auto_compaction_start' },
      { type: 'response', command: 'set_model', success: true },
      { type: 'response', command: 'compact', success: true },
      { type: 'response', command: 'branch', success: true },
    ]) {
      const state = createIdleCompaction();
      reply(state, 0);
      feed(state, frame, 400);
      assert.equal(idleCompactionNow(state, 1000), null, JSON.stringify(frame));
    }
    const state = createIdleCompaction();
    reply(state, 0);
    feed(state, { type: 'response', command: 'branch', success: false }, 400);
    assert.equal(idleCompactionNow(state, 1000), 'due', 'a refused rewind changed nothing');
  });
});
