// A long conversation left idle is compacted before its prompt cache expires, as Claude Code
// does (daemon/idle-compaction.js), and stays awake until then. Runs a daemon of its own that
// compacts 1.5 s after the last request and puts sessions to sleep sooner than that.
import { test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort, newWorkspace, startDaemon } from './daemon.js';

test.use({ viewport: { width: 1280, height: 800 }, contextOptions: { reducedMotion: 'reduce' } });

test('an idle long conversation is compacted before its cache expires, staying awake until then, unless turned off in Config', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-e2e-idle-compact-'));
  const sessionsDir = join(dir, 'omp-sessions');
  mkdirSync(join(sessionsDir, '-p'), { recursive: true });
  const journal = [
    { type: 'title', v: 1, title: 'Long talk' },
    { type: 'session', version: 3, id: 'long', timestamp: '2026-10-01T10:00:00.000Z', cwd: dir },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
  ];
  writeFileSync(join(sessionsDir, '-p', '2026-10-01_long.jsonl'), `${journal.map((l) => JSON.stringify(l)).join('\n')}\n`);
  /** @type {string[]} */
  const problems = [];
  page.on('pageerror', (err) => problems.push(err.message));
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));

  const port = await freePort();
  const awake = async () =>
    (await (await page.request.get(`http://127.0.0.1:${port}/api/sessions`)).json()).sessions.filter((/** @type {any} */ s) => s.status === 'ready' || s.status === 'starting');
  const env = { COCKPIT_SLEEP_AFTER_MS: '500', COCKPIT_IDLE_COMPACT_AFTER_MS: '1500' };
  const daemon = await startDaemon({ port, stateDir: join(dir, 'state'), sessionsDir, env });
  try {
    await page.goto(daemon.url(newWorkspace()));
    await page.locator('#palette-toggle').click();
    await page.locator('#palette [data-type="sessions"]').click();
    await page.keyboard.press('Escape');
    await page.locator('.sessions-item', { hasText: 'Long talk' }).click();
    const pane = page.locator('.widget[data-widget="omp"]');
    await page.mouse.move(5, 5); // nobody uses the window from here on

    // A short reply: nothing to compact, so it sleeps as usual.
    await pane.locator('textarea').fill('short');
    await pane.locator('textarea').press('Enter');
    await expect(pane.locator('.omp-assistant').last()).toContainText('You said: short');
    await expect.poll(awake, { timeout: 5000 }).toEqual([]);

    // A long one, read from a one-hour cache: awake past its sleep until compacted, then asleep.
    await pane.locator('textarea').fill('long');
    await pane.locator('textarea').press('Enter');
    await expect(pane.locator('.omp-assistant').last()).toContainText('You said: long');
    const note = pane.locator('.omp-note', { hasText: 'Compacted while idle, before the prompt cache expired' });
    await expect(note).toBeVisible({ timeout: 5000 });
    expect(await awake(), 'awake until compacted').toHaveLength(1);
    await expect.poll(awake, { timeout: 5000 }).toEqual([]);
    await expect(note).toHaveCount(1);

    // Turned off in Config, for the daemon: a long one sleeps as a short one does.
    await page.locator('.config-toggle').click();
    const setting = page.locator('.config-setting', { hasText: 'Compact idle conversations' }).locator('input');
    await expect(setting).toBeChecked();
    await setting.uncheck();
    await page.keyboard.press('Escape');
    await page.mouse.move(5, 5);
    await pane.locator('textarea').fill('long again');
    await pane.locator('textarea').press('Enter');
    await expect(pane.locator('.omp-assistant').last()).toContainText('You said: long again');
    await expect.poll(awake, { timeout: 5000 }).toEqual([]);
    // Woken, the pane shows the conversation from its journal, where the fake omp keeps no
    // compaction: any note now would be a new one.
    await page.waitForTimeout(2000); // past when it would have compacted
    await expect(note).toHaveCount(0);

    // Kept by the daemon: still off after a reload.
    await page.reload();
    await page.locator('.config-toggle').click();
    await expect(setting).not.toBeChecked();
  } finally {
    await daemon.stop();
  }
  expect(problems).toEqual([]);
});
