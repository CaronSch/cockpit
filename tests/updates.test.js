import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UpdateRefused, createUpdates } from '../daemon/updates.js';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

/** @param {string} cwd @param {string[]} args */
function git(cwd, ...args) {
  const run = Bun.spawnSync(['git', ...args], { cwd, env: GIT_ENV });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout.toString().trim();
}

/** @param {string} repo @param {string} file @param {string} text */
async function commit(repo, file, text) {
  await writeFile(join(repo, file), text);
  git(repo, 'add', file);
  git(repo, 'commit', '-q', '-m', `change ${file}`);
}

/**
 * GitHub (a bare `origin`), someone pushing to its `main`, and Cockpit's checkout cloned from
 * it, with the updates of that checkout; `restarts` counts the restarts it asked for.
 */
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'ac-updates-test-'));
  const origin = join(dir, 'origin.git');
  const publisher = join(dir, 'publisher');
  const checkout = join(dir, 'checkout');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(dir, 'clone', '-q', origin, publisher);
  git(publisher, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  await commit(publisher, 'package.json', '{}\n');
  await commit(publisher, 'app.js', 'one\n');
  git(publisher, 'push', '-q', 'origin', 'main');
  git(dir, 'clone', '-q', origin, checkout);
  const counter = { restarts: 0 };
  const updates = createUpdates({ root: checkout, restart: () => counter.restarts++ });
  /** Pushes a new commit to `main` on GitHub. @param {string} [file] */
  const publish = async (file = 'app.js') => {
    await commit(publisher, file, `${Math.random()}\n`);
    git(publisher, 'push', '-q', 'origin', 'main');
  };
  return { checkout, updates, counter, publish };
}

/** @param {Promise<unknown>} promise @param {number} status @param {RegExp} message */
async function refused(promise, status, message) {
  await assert.rejects(promise, (err) => err instanceof UpdateRefused && err.status === status && message.test(err.message));
}

describe('updates', () => {
  test('nothing is offered while the checkout has all of main', async () => {
    const { updates } = await setup();
    assert.deepEqual(await updates.check(), { behind: 0, blocked: null, updating: false, error: null });
    await refused(updates.apply(), 409, /up to date/);
  });

  test('a newer main is offered once fetched, and taking it fast-forwards the checkout, then restarts', async () => {
    const { checkout, updates, counter, publish } = await setup();
    await publish();
    await publish();
    assert.equal((await updates.refresh())?.behind, 0, 'not fetched yet: refresh never asks GitHub');
    assert.deepEqual(await updates.check(), { behind: 2, blocked: null, updating: false, error: null });
    await updates.apply();
    assert.equal(git(checkout, 'rev-parse', 'HEAD'), git(checkout, 'rev-parse', 'origin/main'));
    assert.equal(counter.restarts, 1);
  });

  test('a pull made by hand ends the offer on the next refresh, without fetching', async () => {
    const { checkout, updates, publish } = await setup();
    await publish();
    assert.equal((await updates.check())?.behind, 1);
    git(checkout, 'merge', '-q', '--ff-only', 'origin/main');
    assert.equal((await updates.refresh())?.behind, 0);
  });

  test('uncommitted changes block the update, and leave the checkout alone', async () => {
    const { checkout, updates, counter, publish } = await setup();
    await publish();
    await writeFile(join(checkout, 'app.js'), 'edited\n');
    assert.match((await updates.check())?.blocked ?? '', /uncommitted changes/);
    const head = git(checkout, 'rev-parse', 'HEAD');
    await refused(updates.apply(), 409, /uncommitted changes/);
    assert.equal(git(checkout, 'rev-parse', 'HEAD'), head);
    assert.equal(counter.restarts, 0);
  });

  test('a checkout on another branch is not moved to main', async () => {
    const { checkout, updates, publish } = await setup();
    await publish();
    git(checkout, 'checkout', '-q', '-b', 'feat/x');
    assert.match((await updates.check())?.blocked ?? '', /on feat\/x, not main/);
    await refused(updates.apply(), 409, /feat\/x/);
  });

  test('commits main lacks block it: that would be a merge, not a fast-forward', async () => {
    const { checkout, updates, publish } = await setup();
    await publish();
    await commit(checkout, 'local.txt', 'mine\n');
    assert.match((await updates.check())?.blocked ?? '', /commits origin\/main does not/);
  });

  test('an update that changes dependencies is offered, but not taken from here', async () => {
    const { updates, counter, publish } = await setup();
    await publish('package.json');
    const state = await updates.check();
    assert.equal(state?.behind, 1);
    assert.match(state?.blocked ?? '', /dependencies/);
    await refused(updates.apply(), 409, /dependencies/);
    assert.equal(counter.restarts, 0);
  });

  test('a directory that is no git checkout offers nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ac-updates-none-'));
    const updates = createUpdates({ root: dir, restart: () => assert.fail('restarted') });
    assert.equal(await updates.check(), null);
    await refused(updates.apply(), 409, /up to date/);
  });
});
