// Decision reviews (daemon/decisions.js): turned on in Config, every turn gets a short list of
// the decisions the agent took without its user, shown where the turn ends. Runs a daemon of
// its own, as the setting is the daemon's, for every page.
import { test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort, newWorkspace, startDaemon } from './daemon.js';

test.use({ viewport: { width: 1280, height: 800 }, contextOptions: { reducedMotion: 'reduce' } });

test('turned on in Config, each turn shows the decisions the agent took without its user, under its reply', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-e2e-decisions-'));
  const sessionsDir = join(dir, 'omp-sessions');
  mkdirSync(join(sessionsDir, '-p'), { recursive: true });
  const journal = [
    { type: 'title', v: 1, title: 'Design talk' },
    { type: 'session', version: 3, id: 'design', timestamp: '2026-10-01T10:00:00.000Z', cwd: dir },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: 1 } },
  ];
  writeFileSync(join(sessionsDir, '-p', '2026-10-01_design.jsonl'), `${journal.map((l) => JSON.stringify(l)).join('\n')}\n`);
  /** @type {string[]} */
  const problems = [];
  page.on('pageerror', (err) => problems.push(err.message));
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));

  const daemon = await startDaemon({ port: await freePort(), stateDir: join(dir, 'state'), sessionsDir });
  try {
    await page.goto(daemon.url(newWorkspace()));
    await page.locator('#palette-toggle').click();
    await page.locator('#palette [data-type="sessions"]').click();
    await page.keyboard.press('Escape');
    await page.locator('.sessions-item', { hasText: 'Design talk' }).click();
    const pane = page.locator('.widget[data-widget="omp"]');
    const reviews = pane.locator('.omp-decisions');
    /** @param {string} text */
    const send = async (text) => {
      await pane.locator('textarea').fill(text);
      await pane.locator('textarea').press('Enter');
      await expect(pane.locator('.omp-assistant').last()).toContainText(`You said: ${text}`);
    };

    // Off by default: a turn with decisions in it gets no review.
    await send('decide on a database');
    await page.waitForTimeout(500);
    await expect(reviews).toHaveCount(0);

    await page.locator('.config-toggle').click();
    const setting = page.locator('.config-setting', { hasText: 'Review decisions' }).locator('input');
    await expect(setting).not.toBeChecked();
    await setting.check();
    await page.keyboard.press('Escape');

    await send('now decide the schema');
    // The one that lists decisions: a turn under review shows a line of its own meanwhile.
    const review = reviews.filter({ has: page.locator('li') });
    await expect(review.locator('li')).toHaveText(['Picked SQLite over Postgres, as nothing needs a server.', 'Kept the old API as an alias.']);
    await expect(review).toContainText('Decided without you');
    // Where the turn ends: right after its reply, before the next prompt.
    await send('hello again');
    const around = await review.evaluate((node) => [node.previousElementSibling?.textContent ?? '', node.nextElementSibling?.textContent ?? '']);
    expect(around[0]).toContain('You said: now decide the schema');
    expect(around[1]).toContain('hello again');
    // A turn with nothing to review shows nothing, once its review is done.
    await page.waitForTimeout(1000);
    await expect(reviews).toHaveCount(1);

    // Kept by the daemon: there after a reload, and the setting still on.
    await page.reload();
    await expect(pane.locator('.omp-decisions li')).toHaveCount(2);
    await page.locator('.config-toggle').click();
    await expect(setting).toBeChecked();
  } finally {
    await daemon.stop();
  }
  expect(problems).toEqual([]);
});
