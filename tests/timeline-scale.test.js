import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { KNEE_MS, MIN_SPAN_MS, duration, futureSpan, lanes, position, ticks } from '../src/timeline/scale.js';

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
    const furthest = 10 * DAY;
    assert.ok(futureSpan(furthest) > furthest);
    assert.ok(position(furthest, futureSpan(furthest)) < 1, 'the furthest label is not at the very edge');
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

describe('lanes', () => {
  test('no two labels in one lane overlap, and a label takes the lowest lane free', () => {
    const labels = [
      { x: 100, width: 80 },
      { x: 0, width: 80 },
      { x: 50, width: 80 },
      { x: 170, width: 40 },
      { x: 300, width: 20 },
    ];
    const lane = lanes(labels, 6);
    for (let a = 0; a < labels.length; a++) {
      for (let b = a + 1; b < labels.length; b++) {
        if (lane[a] !== lane[b]) continue;
        const [l, r] = labels[a].x < labels[b].x ? [labels[a], labels[b]] : [labels[b], labels[a]];
        assert.ok(l.x + l.width + 6 <= r.x, `${a} and ${b} overlap in lane ${lane[a]}`);
      }
    }
    assert.deepEqual(lane, [0, 0, 1, 1, 0]);
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
