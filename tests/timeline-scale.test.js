import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { KNEE_MS, MIN_SPAN_MS, duration, futureSpan, pack, position, ticks } from '../src/timeline/scale.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('the future side’s scale', () => {
  test('runs from now to its span, and the near future gets more room than the far', () => {
    const span = 30 * DAY;
    assert.equal(position(0, span), 0);
    assert.equal(position(span, span), 1);
    assert.equal(position(2 * span, span), 1, 'never past the end');
    const nextHour = position(HOUR, span);
    const hourInAWeek = position(7 * DAY + HOUR, span) - position(7 * DAY, span);
    assert.ok(nextHour > 20 * hourInAWeek, `${nextHour} vs ${hourInAWeek}`);
    assert.ok(position(KNEE_MS, span) < position(2 * KNEE_MS, span));
  });

  test('spans a day at least, and reaches past the furthest prompt', () => {
    assert.equal(futureSpan(0), MIN_SPAN_MS);
    assert.equal(futureSpan(HOUR), MIN_SPAN_MS);
    assert.equal(futureSpan(HOUR, 0.1), MIN_SPAN_MS, 'a near label has room in a day');
    const furthest = 10 * DAY;
    assert.ok(futureSpan(furthest) > furthest);
    assert.ok(position(furthest, futureSpan(furthest)) < 1, 'the furthest label is not at the very edge');
  });

  test('a prompt days ahead leaves its label room before the end, however far it is', () => {
    for (const furthest of [30 * HOUR, 3 * DAY, 20 * DAY, 200 * DAY]) {
      for (const room of [0.05, 0.2]) {
        const span = futureSpan(furthest, room);
        assert.ok(span > MIN_SPAN_MS, `${furthest}: past a day`);
        assert.ok(position(furthest, span) <= 1 - room + 1e-9, `${furthest}, ${room}: ${position(furthest, span)}`);
      }
    }
    assert.ok(futureSpan(3 * DAY, 0.2) > futureSpan(3 * DAY, 0.05), 'a wider label, a longer span');
  });

  test('marks times in order, inside the span, never crowded', () => {
    const span = 60 * DAY;
    for (const width of [120, 400, 1200]) {
      const marks = ticks(span, width, 44);
      assert.ok(marks.every((m) => m.ms < span && m.x >= 44 && width - m.x >= 22), String(width));
      for (let i = 1; i < marks.length; i++) assert.ok(marks[i].x - marks[i - 1].x >= 44, `${width}: ${marks[i - 1].label}→${marks[i].label}`);
    }
    assert.ok(ticks(span, 1200).length > ticks(span, 400).length, 'a wider side marks more');
  });
});

describe('packing labels', () => {
  test('no two labels in one lane overlap, and a label takes the lowest lane free, at its time', () => {
    const labels = [
      { x: 100, width: 80 },
      { x: 0, width: 80 },
      { x: 50, width: 80 },
      { x: 170, width: 40 },
      { x: 300, width: 20 },
    ];
    const placed = pack(labels, 6);
    for (let a = 0; a < labels.length; a++) {
      for (let b = a + 1; b < labels.length; b++) {
        if (placed[a].lane !== placed[b].lane) continue;
        const [l, r] = labels[a].x < labels[b].x ? [labels[a], labels[b]] : [labels[b], labels[a]];
        assert.ok(l.x + l.width + 6 <= r.x, `${a} and ${b} overlap in lane ${placed[a].lane}`);
      }
    }
    assert.deepEqual(
      placed.map((p) => p.lane),
      [0, 0, 1, 1, 0],
    );
    assert.deepEqual(
      placed.map((p) => p.x),
      labels.map((l) => l.x),
    );
  });

  test('with no room for another lane, a label goes just past the one in the lane free soonest, up to the end', () => {
    const labels = [
      { x: 0, width: 100 },
      { x: 10, width: 40 },
      { x: 20, width: 80 },
      { x: 400, width: 80 },
    ];
    const at = (/** @type {Array<{ lane: number, x: number }>} */ placed) => placed.map((p) => [p.lane, p.x]);
    assert.deepEqual(at(pack(labels, 6)), [
      [0, 0],
      [1, 10],
      [2, 20],
      [0, 400],
    ]);
    assert.deepEqual(
      at(pack(labels, 6, 2)),
      [
        [0, 0],
        [1, 10],
        [1, 56],
        [0, 400],
      ],
      'past the shorter one, whose lane frees first',
    );
    assert.deepEqual(at(pack(labels, 6, 1)), [
      [0, 0],
      [0, 106],
      [0, 152],
      [0, 400],
    ]);
    assert.deepEqual(at(pack(labels, 6, 2, 120))[2], [1, 40], 'no further than the end lets it, over the one before');
  });
});

describe('durations', () => {
  test('say the two largest units', () => {
    assert.equal(duration(40_000), '40 s');
    assert.equal(duration(90 * 60_000), '1 h 30 min');
    assert.equal(duration(DAY + 3 * HOUR + 59_000), '1 d 3 h');
    assert.equal(duration(2 * DAY + 5 * 60_000), '2 d');
  });
});
