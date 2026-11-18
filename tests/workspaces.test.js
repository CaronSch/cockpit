import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkspaces } from '../daemon/workspace.js';
import { loadOrigins } from '../daemon/origins.js';
import { leaf } from '../src/layout/grid-model.js';
/** @import { SessionMeta } from '../daemon/wire.js' */

describe('workspaces on disk', () => {
  test('the screens kept before become workspaces of their own, main’s first, once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ac-workspaces-'));
    const legacyDir = join(dir, 'workspaces');
    await mkdir(legacyDir);
    const screen = (/** @type {string} */ id, /** @type {any} */ tree) => ({ id, rev: 2, tree });
    await writeFile(join(legacyDir, 'side.json'), JSON.stringify({ version: 1, screens: [screen('s_00000003', leaf('w_00000003', 'file'))] }));
    await writeFile(
      join(legacyDir, 'main.json'),
      JSON.stringify({ version: 1, screens: [screen('s_00000001', leaf('w_00000001', 'omp')), screen('s_00000002', leaf('w_00000002', 'scratchpad'))] }),
    );
    const file = join(dir, 'workspaces.json');
    const migrated = await loadWorkspaces({ file, legacyDir });
    const widgets = (/** @type {typeof migrated} */ store) => store.all().map((w) => w.tree?.kind === 'leaf' && w.tree.widget);
    assert.deepEqual(widgets(migrated), ['omp', 'scratchpad', 'file']);
    assert.equal(new Set(migrated.all().map((w) => w.name)).size, 3, 'each named apart');

    // Changed since, then read again: the migration does not run twice.
    const [first] = migrated.all();
    assert.equal(migrated.save(first.id, leaf('w_00000009', 'terminal'), first.rev).ok, true);
    await Bun.sleep(50);
    const again = await loadWorkspaces({ file, legacyDir });
    assert.deepEqual(widgets(again), ['terminal', 'scratchpad', 'file']);
  });

  test('a save made from an older layout is refused with the newer one, and the last workspace stays', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ac-workspaces-'));
    const store = await loadWorkspaces({ file: join(dir, 'workspaces.json'), legacyDir: join(dir, 'none') });
    const [only] = store.all();
    assert.equal(store.remove(only.id), 'last');
    const saved = store.save(only.id, leaf('w_00000001', 'omp'), only.rev);
    assert.ok(saved.ok);
    const stale = store.save(only.id, leaf('w_00000002', 'file'), only.rev);
    assert.ok(!stale.ok && stale.current?.tree?.kind === 'leaf' && stale.current.tree.widget === 'omp');
  });

  test('a conversation is noted as started in its workspace once omp names it, and keeps it through a rewind', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'ac-origins-')), 'origins.json');
    const origins = await loadOrigins({ file });
    /** @param {string | null} ompId @returns {any} */
    const event = (ompId) => {
      /** @type {SessionMeta} */
      const meta = { id: 's1', cwd: '/', resume: null, fork: null, sessionFile: null, status: 'ready', pid: 1, exitCode: null, error: null, startedAt: 0, ompId };
      return { kind: 'session', meta, seq: 1, at: 0, session: 's1' };
    };
    const A = '01a1cacf-44ec-7483-a118-e5d911a16e50';
    const B = '01a1cacf-44ec-7483-a118-e5d911a16e51';
    origins.expect('s1', 'ws_0000000a');
    origins.heard(event(null));
    assert.deepEqual(origins.all(), {}, 'not until omp says which conversation it is');
    origins.heard(event(A));
    await origins.moved(A, B);
    const again = await loadOrigins({ file });
    assert.deepEqual(again.all(), { [B]: 'ws_0000000a' });
  });
});
