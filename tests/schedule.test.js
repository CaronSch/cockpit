import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeliveryRefused } from '../daemon/deliver.js';
import { MISSED_AFTER_MS, MISSED_DELAY_MS, loadSchedule, parseAt, parseDelay, scheduledMessage } from '../daemon/schedule.js';
/** @import { ConversationTarget, ScheduledTask, SessionMeta } from '../daemon/wire.js' */

const TARGET = Object.freeze({ sessionFile: '/sessions/p/a.jsonl', session: 's_1', cwd: '/work' });
/** @type {SessionMeta} */
const META = { id: 's_1', cwd: '/work', resume: null, fork: null, sessionFile: '/sessions/p/a.jsonl', status: 'ready', pid: 1, exitCode: null, error: null, startedAt: 0, ompId: 'a' };

/** @param {Partial<ScheduledTask>} task @returns {ScheduledTask} */
const task = (task) => ({ id: 't1', target: TARGET, prompt: 'check CI', dueAt: 0, createdAt: 0, missedAt: null, error: null, ...task });

/** A turn of the event loop or a few: long enough for the scheduler's short timers to fire. */
const settle = () => Bun.sleep(40);

/**
 * A schedule on a clock the test moves, its file holding `tasks` to start with; `deliver` records
 * what was sent, or fails as `failWith` says.
 * @param {{ tasks?: ScheduledTask[], at?: number, archived?: () => boolean, failWith?: () => Error | null }} [options]
 */
async function schedule({ tasks = [], at = 1_000_000, archived = () => false, failWith = () => null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ac-schedule-'));
  const file = join(dir, 'schedule.json');
  if (tasks.length) await writeFile(file, JSON.stringify({ version: 1, tasks }));
  const clock = { at };
  /** @type {Array<{ target: ConversationTarget, message: string }>} */
  const sent = [];
  const store = await loadSchedule({
    file,
    now: () => clock.at,
    tickMs: 10,
    archivedFrom: async () => archived(),
    deliver: async (target, message) => {
      const err = failWith();
      if (err) throw err;
      sent.push({ target, message });
    },
  });
  await settle();
  return { store, clock, sent, file };
}

describe('when a scheduled prompt runs', () => {
  test('one coming due while the daemon runs is sent to its conversation, then gone', async () => {
    const { store, clock, sent } = await schedule({ tasks: [task({ dueAt: 1_000_500 })] });
    assert.equal(sent.length, 0, 'not before its time');
    clock.at = 1_000_500;
    await settle();
    assert.deepEqual(sent, [{ target: TARGET, message: scheduledMessage(task({ dueAt: 1_000_500 })) }]);
    assert.match(sent[0].message, /check CI$/);
    assert.deepEqual(store.all(), []);
    store.stop();
  });

  test('one a little late (a slow tick, a quick restart) still runs', async () => {
    const { store, sent } = await schedule({ tasks: [task({ dueAt: 1_000_000 - MISSED_AFTER_MS + 1 })] });
    assert.equal(sent.length, 1);
    store.stop();
  });

  test('one due while the daemon was off is missed: moved ten minutes on, not sent, its first time kept', async () => {
    const due = 1_000_000 - MISSED_AFTER_MS - 1;
    const { store, sent } = await schedule({ tasks: [task({ dueAt: due })] });
    assert.equal(sent.length, 0);
    assert.deepEqual(store.all(), [task({ dueAt: 1_000_000 + MISSED_DELAY_MS, missedAt: due })]);
    store.stop();
  });

  test('one due while the Mac slept is missed once it wakes, and missed again keeps when it was first due', async () => {
    const { store, clock, sent } = await schedule({ tasks: [task({ dueAt: 1_000_500 })] });
    clock.at = 1_000_500 + 2 * 3_600_000; // the clock jumped: two hours asleep
    await settle();
    assert.equal(sent.length, 0);
    assert.deepEqual(store.all(), [task({ dueAt: clock.at + MISSED_DELAY_MS, missedAt: 1_000_500 })]);
    clock.at += MISSED_DELAY_MS + 3_600_000; // slept through the new time too
    await settle();
    assert.equal(store.all()[0].missedAt, 1_000_500);
    clock.at = store.all()[0].dueAt; // awake when it comes due: it runs
    await settle();
    assert.equal(sent.length, 1);
    store.stop();
  });

  test('a failed delivery is tried again ten minutes later, saying why; a conversation that is gone drops it', async () => {
    let failure = /** @type {Error | null} */ (new DeliveryRefused(409, 'the agent did not start'));
    const { store, clock, sent } = await schedule({ tasks: [task({ dueAt: 1_000_000 })], failWith: () => failure });
    assert.deepEqual(store.all(), [task({ dueAt: 1_000_000 + MISSED_DELAY_MS, error: 'the agent did not start' })]);
    failure = new DeliveryRefused(404, 'the conversation is gone');
    clock.at += MISSED_DELAY_MS;
    await settle();
    assert.deepEqual(store.all(), []);
    assert.equal(sent.length, 0);
    store.stop();
  });

  test('one for an archived conversation waits; restored, it is missed and runs ten minutes later', async () => {
    let archived = true;
    const { store, clock, sent } = await schedule({ tasks: [task({ dueAt: 1_000_000 })], archived: () => archived });
    clock.at += 3_600_000;
    await settle();
    assert.deepEqual(store.all(), [task({ dueAt: 1_000_000 })], 'untouched while archived');
    archived = false;
    await settle();
    assert.deepEqual(store.all(), [task({ dueAt: clock.at + MISSED_DELAY_MS, missedAt: 1_000_000 })]);
    assert.equal(sent.length, 0);
    store.stop();
  });

  test('a rewind moves the prompts of its conversation onto the new journal', async () => {
    const other = task({ id: 't2', target: { ...TARGET, sessionFile: '/sessions/p/b.jsonl' }, dueAt: 2_000_000 });
    const { store } = await schedule({ tasks: [task({ dueAt: 2_000_000 }), other] });
    await store.moved(TARGET.sessionFile, '/sessions/p/c.jsonl');
    assert.deepEqual(
      store.all().map((t) => t.target.sessionFile),
      ['/sessions/p/c.jsonl', '/sessions/p/b.jsonl'],
    );
    store.stop();
  });
});

describe('the schedule tool', () => {
  test('add takes a while from now or a time, and answers when it will run', async () => {
    const { store, clock } = await schedule();
    const added = await store.call(META, { op: 'add', in: '1h 30m', prompt: '  check CI  ' });
    assert.equal(added.isError, undefined);
    assert.match(added.text, /in 1 h 30 min/);
    const [first] = store.all();
    assert.deepEqual(first, { id: first.id, target: TARGET, prompt: 'check CI', dueAt: clock.at + 90 * 60_000, createdAt: clock.at, missedAt: null, error: null });
    store.stop();
  });

  test('refuses what does not name one moment to come, so the agent asks instead of guessing', async () => {
    const { store, clock } = await schedule();
    for (const args of [
      { op: 'add', prompt: 'x' },
      { op: 'add', prompt: 'x', in: '1h', at: '2030-01-01T09:00' },
      { op: 'add', prompt: 'x', at: 'tomorrow at 9' },
      { op: 'add', prompt: 'x', in: 'an hour' },
      { op: 'add', prompt: 'x', at: new Date(clock.at - 60_000).toISOString() },
      { op: 'add', prompt: '  ', in: '1h' },
      { op: 'later' },
    ]) {
      const answer = await store.call(META, args);
      assert.equal(answer.isError, true, JSON.stringify(args));
    }
    assert.deepEqual(store.all(), []);
    store.stop();
  });

  test('list and cancel see only this conversation', async () => {
    const theirs = task({ id: 'theirs', target: { ...TARGET, sessionFile: '/sessions/p/other.jsonl' }, dueAt: 9_000_000 });
    const { store } = await schedule({ tasks: [theirs] });
    await store.call(META, { op: 'add', in: '10m', prompt: 'mine' });
    const mine = store.all()[1];
    const listed = await store.call(META, { op: 'list' });
    assert.match(listed.text, new RegExp(mine.id));
    assert.doesNotMatch(listed.text, /theirs/);
    assert.equal((await store.call(META, { op: 'cancel', id: 'theirs' })).isError, true);
    assert.equal((await store.call(META, { op: 'cancel', id: mine.id })).isError, undefined);
    assert.deepEqual(store.all(), [theirs]);
    store.stop();
  });
});

describe('the user editing a scheduled prompt', () => {
  test('a new prompt or time is kept, and it is no longer missed or failed', async () => {
    const { store, clock } = await schedule({ tasks: [task({ dueAt: 2_000_000, missedAt: 1_000, error: 'x' })] });
    const edited = await store.edit('t1', { prompt: 'check CI again', dueAt: clock.at + 60_000 });
    assert.deepEqual(edited, task({ prompt: 'check CI again', dueAt: clock.at + 60_000 }));
    await assert.rejects(store.edit('t1', { dueAt: clock.at - 1 }), /passed/);
    await assert.rejects(store.edit('t1', { prompt: '' }), /empty/);
    await assert.rejects(store.edit('nope', { prompt: 'x' }), /no such/);
    await store.remove('t1');
    assert.deepEqual(store.all(), []);
    store.stop();
  });

  test('a file it cannot read stops the daemon rather than being replaced', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ac-schedule-'));
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'schedule.json');
    await writeFile(file, JSON.stringify({ version: 1, tasks: [{ id: 1 }] }));
    await assert.rejects(loadSchedule({ file, deliver: async () => {}, archivedFrom: async () => false }), /not a schedule file/);
  });
});

describe('times the agent writes', () => {
  test('a while: numbers with units, nothing else', () => {
    assert.equal(parseDelay('45s'), 45_000);
    assert.equal(parseDelay('1h 30m'), 90 * 60_000);
    assert.equal(parseDelay('2d'), 2 * 86_400_000);
    assert.equal(parseDelay('1w'), 7 * 86_400_000);
    assert.equal(parseDelay('10 min'), 600_000);
    for (const bad of ['', 'soon', '10', '1h and a bit', 'in 10m']) assert.equal(parseDelay(bad), null, bad);
  });

  test('a time: this machine’s clock unless it carries an offset', () => {
    assert.equal(parseAt('2030-01-02T09:00'), new Date(2030, 0, 2, 9, 0).getTime());
    assert.equal(parseAt('2030-01-02 09:00'), new Date(2030, 0, 2, 9, 0).getTime());
    assert.equal(parseAt('2030-01-02T09:00Z'), Date.UTC(2030, 0, 2, 9, 0));
    assert.equal(parseAt('2030-01-02T09:00+01:00'), Date.UTC(2030, 0, 2, 8, 0));
    for (const bad of ['tomorrow', '2030-01-02', '9am', '2030-13-02T09:00']) assert.equal(parseAt(bad), null, bad);
  });
});
