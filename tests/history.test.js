import { test, describe, beforeEach } from 'bun:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHistory } from '../daemon/history.js';

/** @param {unknown[]} entries */
const journal = (entries) => `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`;
/** @param {string} text @param {Record<string, unknown>} [extra] */
const user = (text, extra = {}) => ({ type: 'message', id: 'u', message: { role: 'user', content: [{ type: 'text', text }], ...extra } });
/** @param {string} text */
const assistant = (text) => ({ type: 'message', id: 'a', message: { role: 'assistant', content: [{ type: 'text', text }] } });
/** @param {string} id @param {string} cwd */
const header = (id, cwd) => ({ type: 'session', version: 3, id, timestamp: '2026-10-01T10:00:00.000Z', cwd });

let root = '';
let archive = '';
/** @type {string} */
let alpha = '';

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'ac-history-'));
  root = join(base, 'sessions');
  archive = join(base, 'archive', 'sessions');
  await mkdir(join(root, '-p-alpha', '2026-10-01_aaa'), { recursive: true });
  await mkdir(join(root, '-p-beta'));
  alpha = join(root, '-p-alpha', '2026-10-01_aaa.jsonl');
  await writeFile(
    alpha,
    journal([
      { type: 'title', v: 1, title: '\u{F056E} Fix the login flow', source: 'auto', pad: '   ' },
      header('aaa', '/p/alpha'),
      { type: 'custom_message', customType: 'notice', content: 'mounted tools, "role":"user" in passing' },
      user('fix the login bug'),
      assistant('done'),
      user('handoff summary', { attribution: 'agent' }),
      user('now add tests'),
    ]),
  );
  await writeFile(join(root, '-p-beta', '2026-10-02_bbb.jsonl'), journal([header('bbb', '/p/beta'), user('deploy staging')]));
  await writeFile(join(root, '-p-beta', '2026-10-03_ccc.jsonl'), journal([header('ccc', '/p/beta')])); // never prompted
  await writeFile(join(root, '-p-alpha', '2026-10-01_aaa', 'Explorer.jsonl'), journal([header('sub', '/p/alpha'), user('subagent task')]));
});

describe('session history', () => {
  test('one summary per conversation; subagent journals and never-prompted sessions are left out', async () => {
    const sessions = await createHistory({ root, archive }).list();
    assert.deepEqual(sessions.map((s) => s.id).sort(), ['aaa', 'bbb']);
    const a = sessions.find((s) => s.id === 'aaa');
    assert.equal(a?.title, 'Fix the login flow', 'the nerd-font icon is stripped');
    assert.equal(a?.cwd, '/p/alpha');
    assert.equal(a?.file, alpha);
    assert.equal(a?.prompts, 2, 'agent-authored user messages are not prompts');
    assert.equal(a?.firstPrompt, 'fix the login bug');
    assert.equal(a?.createdAt, Date.parse('2026-10-01T10:00:00.000Z'));
  });

  test('search needs every word, in any of title, directory or prompts, ignoring case', async () => {
    const history = createHistory({ root, archive });
    /** @param {string} q */
    const ids = async (q) => (await history.list(q)).map((s) => s.id).sort();
    assert.deepEqual(await ids('TESTS alpha'), ['aaa']);
    assert.deepEqual(await ids('login'), ['aaa'], 'title and prompt');
    assert.deepEqual(await ids('beta'), ['bbb'], 'directory');
    assert.deepEqual(await ids('deploy login'), []);
    assert.deepEqual(await ids('handoff'), [], 'agent-authored text is not searched');
  });

  test('a journal that grew since the last listing is read again', async () => {
    const history = createHistory({ root, archive });
    assert.deepEqual(await history.list('rollback'), []);
    await appendFile(alpha, journal([user('plan the rollback')]));
    const later = new Date(Date.now() + 5000);
    await utimes(alpha, later, later);
    const [hit] = await history.list('rollback');
    assert.equal(hit?.id, 'aaa');
    assert.equal(hit?.prompts, 3);
  });

  test('a torn last line (omp mid-write) does not lose the session', async () => {
    await appendFile(alpha, '{"type":"message","message":{"role":"user","content":[{"type":"te');
    const [a] = (await createHistory({ root, archive }).list()).filter((s) => s.id === 'aaa');
    assert.equal(a?.prompts, 2);
  });

  test('a missing sessions directory is an empty history, not an error', async () => {
    assert.deepEqual(await createHistory({ root: join(root, 'nope'), archive }).list(), []);
  });
});

describe('archive', () => {
  /** Every file and folder under `dir`, relative to it, sorted. @param {string} dir */
  const tree = async (dir) => (await readdir(dir, { recursive: true }).catch(() => [])).sort();
  const subagent = () => join('-p-alpha', '2026-10-01_aaa', 'Explorer.jsonl');

  test('archiving moves the journal and its folder to the same place in the archive, and lists it there', async () => {
    const history = createHistory({ root, archive });
    const before = await stat(alpha);
    const text = await readFile(alpha, 'utf8');
    const moved = await history.archive(alpha);

    assert.equal(moved, join(archive, '-p-alpha', '2026-10-01_aaa.jsonl'));
    assert.equal(await readFile(moved, 'utf8'), text, 'the journal is intact');
    assert.equal((await stat(moved)).mtimeMs, before.mtimeMs, 'and keeps its last-active time');
    assert.deepEqual(await tree(archive), ['-p-alpha', join('-p-alpha', '2026-10-01_aaa'), join('-p-alpha', '2026-10-01_aaa.jsonl'), subagent()]);
    assert.deepEqual(await tree(join(root, '-p-alpha')), [], 'nothing of it is left where omp looks');

    assert.deepEqual((await history.list()).map((s) => s.id), ['bbb']);
    const [shelved] = await history.list('', { archived: true });
    assert.equal(shelved?.id, 'aaa');
    assert.equal(shelved?.file, moved);
    assert.deepEqual((await history.list('tests', { archived: true })).map((s) => s.id), ['aaa'], 'searchable like the others');
  });

  test('restoring puts it back exactly, and the listing follows both moves', async () => {
    const history = createHistory({ root, archive });
    assert.equal((await history.list()).length, 2); // cached
    const moved = await history.archive(alpha);
    assert.equal(await history.restore(moved), alpha);
    assert.deepEqual((await history.list()).map((s) => s.id).sort(), ['aaa', 'bbb']);
    assert.deepEqual(await history.list('', { archived: true }), []);
    assert.deepEqual(await tree(join(root, '-p-alpha')), ['2026-10-01_aaa', '2026-10-01_aaa.jsonl', join('2026-10-01_aaa', 'Explorer.jsonl')]);
  });

  test('watch tells, coalesced, which journals changed or moved, and not files deeper down', async () => {
    const history = createHistory({ root, archive });
    /** A journal written only to learn that a watch has started; no notice is checked for it. */
    const probe = join(root, '-p-beta', '2026-10-09_probe.jsonl');
    /**
     * Follows `history.watch`, keeping every notice it gives (without the probe), once it
     * hears changes: macOS starts a watch a moment after `watch` returns, and `fs.watch` cannot
     * say when, so a write made before then is never heard.
     */
    const listen = async () => {
      /** @type {(string | null)[][]} */
      const notices = [];
      let probed = false;
      let heard = () => {};
      const stop = history.watch((changed) => {
        probed ||= changed.has(probe);
        const rest = [...changed].filter((file) => file !== probe).sort();
        if (rest.length) notices.push(rest);
        heard();
      });
      /** Waits for the next notice, or for `ms` when given, whichever comes first. @param {number} [ms] */
      const next = (ms) =>
        new Promise((resolve) => {
          const timer = ms === undefined ? undefined : setTimeout(resolve, ms);
          heard = () => resolve(clearTimeout(timer));
        });
      for (let n = 0; !probed; n++) {
        await writeFile(probe, journal([header('probe', '/p/beta'), user(`probe ${n}`)]));
        await next(1000);
      }
      /**
       * Waits for a notice naming `file`, then hands over every notice since the last wait.
       * @param {string} file
       */
      const told = async (file) => {
        while (!notices.some((n) => n.includes(file))) await next();
        return notices.splice(0);
      };
      return { notices, told, stop };
    };
    /** A new journal, written to give a signal that later notices can be measured against. @param {string} name */
    const marker = async (name) => {
      const file = join(root, '-p-beta', `2026-10-09_${name}.jsonl`);
      await writeFile(file, journal([header(name, '/p/beta'), user(name)]));
      return file;
    };

    const watching = await listen();
    try {
      // macOS may still report the writes this test's setup made just before the watch began;
      // they come before the first marker's notice.
      await watching.told(await marker('m1'));

      await writeFile(join(root, subagent()), journal([header('sub', '/p/alpha'), user('more subagent work')]));
      const m2 = await marker('m2');
      assert.deepEqual(await watching.told(m2), [[m2]], 'a subagent journal is no conversation of its own');

      await appendFile(alpha, journal([user('one')]));
      await appendFile(alpha, journal([user('two')]));
      const m3 = await marker('m3');
      assert.deepEqual(await watching.told(m3), [[alpha, m3].sort()], 'writes close together are one notice');

      const moved = await history.archive(alpha);
      await watching.told(moved);
    } finally {
      watching.stop();
    }
    // A second watch hears the next change; the stopped one must not.
    const still = await listen();
    try {
      const after = await marker('m4');
      await still.told(after);
      assert.deepEqual(watching.notices, [], 'nothing after the watch is stopped');
    } finally {
      still.stop();
    }
  });

  test('a journal without a folder moves alone', async () => {
    const beta = join(root, '-p-beta', '2026-10-02_bbb.jsonl');
    const moved = await createHistory({ root, archive }).archive(beta);
    assert.deepEqual(await tree(join(archive, '-p-beta')), ['2026-10-02_bbb.jsonl']);
    assert.equal(moved, join(archive, '-p-beta', '2026-10-02_bbb.jsonl'));
  });

  test('restore never replaces what is there now, journal or folder, and moves nothing then', async () => {
    const history = createHistory({ root, archive });
    const moved = await history.archive(alpha);
    await writeFile(alpha, 'a new journal at the same name');
    await assert.rejects(history.restore(moved), { status: 409 });
    assert.equal(await readFile(alpha, 'utf8'), 'a new journal at the same name');

    await rm(alpha);
    await mkdir(join(root, '-p-alpha', '2026-10-01_aaa'));
    await writeFile(join(root, '-p-alpha', '2026-10-01_aaa', 'new.txt'), 'new');
    await assert.rejects(history.restore(moved), { status: 409 });
    assert.ok((await tree(archive)).includes(subagent()), 'the archived copy is untouched');
    assert.deepEqual(await tree(join(root, '-p-alpha', '2026-10-01_aaa')), ['new.txt']);
  });

  test('only journals the list shows can move: no other path, no traversal, nothing deeper', async () => {
    const history = createHistory({ root, archive });
    const outside = join(root, '..', 'secret.jsonl');
    await writeFile(outside, 'not omp’s');
    /** @type {unknown[]} */
    const refused = [
      outside,
      join(root, '-p-alpha', '..', '..', 'secret.jsonl'),
      join(root, subagent()),
      join(root, '-p-alpha', '.2026-10-01_aaa.jsonl.lock.os'),
      join(root, '-p-alpha', '2026-10-01_aaa'),
      join(root, 'top.jsonl'),
      join(archive, '-p-alpha', '2026-10-01_aaa.jsonl'),
      '',
      42,
      null,
    ];
    for (const file of refused) await assert.rejects(history.archive(file), { status: 400 }, String(file));
    await assert.rejects(history.restore(alpha), { status: 400 }, 'restore takes only archived journals');
    await assert.rejects(history.archive(join(root, '-p-alpha', 'gone.jsonl')), { status: 404 });
    assert.equal(await readFile(outside, 'utf8'), 'not omp’s');
    assert.deepEqual(await tree(archive), []);
  });
});
