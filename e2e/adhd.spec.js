// "I have ADHD" (daemon/adhd.js): switched in Config, every agent's system prompt carries the
// rules of github.com/ayghri/i-have-adhd, and a conversation already awake takes them up from
// its next message (it sleeps once idle and wakes with them). Runs a daemon of its own, as the
// setting is the daemon's, for every page. The fake omp says which prompt it runs with when
// asked about its "style".
import { test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort, newWorkspace, startDaemon } from './daemon.js';

test.use({ viewport: { width: 1280, height: 800 }, contextOptions: { reducedMotion: 'reduce' } });

test('switched in Config, an awake conversation answers by the ADHD rules from its next message, and as usual once switched off', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-e2e-adhd-'));
  const sessionsDir = join(dir, 'omp-sessions');
  mkdirSync(join(sessionsDir, '-p'), { recursive: true });
  const journal = [
    { type: 'title', v: 1, title: 'Focus' },
    { type: 'session', version: 3, id: 'focus', timestamp: '2026-10-01T10:00:00.000Z', cwd: dir },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: 1 } },
  ];
  writeFileSync(join(sessionsDir, '-p', '2026-10-01_focus.jsonl'), `${journal.map((l) => JSON.stringify(l)).join('\n')}\n`);
  /** @type {string[]} */
  const problems = [];
  page.on('pageerror', (err) => problems.push(err.message));
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));

  const port = await freePort();
  /** How many sessions the page knows awake: once none, its windows wake their conversation to send. */
  const awake = () =>
    page.evaluate(async () => {
      const url = '/src/daemon/client.js'; // the module the app runs, so the page's own connection
      const { getDaemon } = /** @type {typeof import('../src/daemon/client.js')} */ (await import(url));
      return getDaemon()
        .sessions()
        .filter((s) => s.status === 'ready' || s.status === 'starting').length;
    });
  const daemon = await startDaemon({ port, stateDir: join(dir, 'state'), sessionsDir });
  try {
    await page.goto(daemon.url(newWorkspace()));
    await page.locator('#palette-toggle').click();
    await page.locator('#palette [data-type="sessions"]').click();
    await page.keyboard.press('Escape');
    await page.locator('.sessions-item', { hasText: 'Focus' }).click();
    const pane = page.locator('.widget[data-widget="omp"]');
    const reply = pane.locator('.omp-assistant').last();
    /** @param {string} text */
    const send = async (text) => {
      await pane.locator('textarea').fill(text);
      await pane.locator('textarea').press('Enter');
    };
    const setting = page.locator('.config-setting', { hasText: 'I have ADHD' }).locator('input');
    /** @param {boolean} on */
    const switchTo = async (on) => {
      await page.locator('.config-toggle').click();
      await setting.setChecked(on);
      await page.keyboard.press('Escape');
    };

    // Off by default.
    await send('what style?');
    await expect(reply).toHaveText('Writing as usual.');
    expect(await awake()).toBe(1);

    // On: the idle conversation sleeps at once, and the next message wakes it with the rules.
    await switchTo(true);
    await expect.poll(awake).toBe(0);
    await send('and now, what style?');
    await expect(reply).toHaveText('Writing in ADHD mode.');
    await expect(pane.locator('.omp-user .omp-md')).toHaveText(['hello', 'what style?', 'and now, what style?'], { useInnerText: true });

    // Kept by the daemon: still on after a reload.
    await page.reload();
    await page.locator('.config-toggle').click();
    await expect(setting).toBeChecked();
    await page.keyboard.press('Escape');

    // Off again: as usual from the next message.
    await switchTo(false);
    await expect.poll(awake).toBe(0);
    await send('one more time, what style?');
    await expect(reply).toHaveText('Writing as usual.');
  } finally {
    await daemon.stop();
  }
  expect(problems).toEqual([]);
});
