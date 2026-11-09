// Config's Phone access switch (src/ui/settings.js, daemon/remote.js) on the Mac: turned on, the
// daemon listens on the Mac's tailnet address and the menu shows the QR code that signs a phone
// in, the phone's URL and whose devices get in; turned off, all of that goes, and so does the
// listener. Runs a daemon of its own, Phone access off, with the fake tailscale.
import { test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAKE_TAILSCALE, freePort, newWorkspace, startDaemon } from './daemon.js';

test.use({ viewport: { width: 1280, height: 900 }, contextOptions: { reducedMotion: 'reduce' } });

test('Phone access on shows the QR code, the URL and whose devices get in; off removes them', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-e2e-phone-access-'));
  const sessionsDir = join(dir, 'omp-sessions');
  const home = join(dir, 'home');
  for (const d of [sessionsDir, home]) mkdirSync(d, { recursive: true });
  /** @type {string[]} */
  const problems = [];
  page.on('pageerror', (err) => problems.push(err.message));
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));

  const remotePort = await freePort();
  const listening = () => fetch(`http://127.0.0.1:${remotePort}/phone`).then(
    () => true,
    () => false,
  );
  const daemon = await startDaemon({
    port: await freePort(),
    stateDir: join(dir, 'state'),
    sessionsDir,
    env: { HOME: home, COCKPIT_TAILSCALE: FAKE_TAILSCALE, COCKPIT_REMOTE_PORT: String(remotePort) },
  });
  try {
    await page.goto(daemon.url(newWorkspace()));
    await page.locator('.config-toggle').click();
    const menu = page.locator('.config-menu');
    const phone = menu.locator('.config-phone');
    const access = phone.getByRole('checkbox', { name: /Phone access/ });
    await expect(access).not.toBeChecked();
    await expect(phone.locator('.config-phone-qr')).toBeHidden();
    expect(await listening()).toBe(false);

    await access.check();
    await expect(phone.locator('.config-phone-state')).toHaveText('On');
    const qr = phone.locator('img.config-phone-qr');
    await expect(qr).toBeVisible();
    await expect(qr).toHaveAttribute('src', /^data:image\/svg\+xml,/);
    // The fake tailscale's Mac is at 127.0.0.1 on the tailnet; the URL carries no token.
    await expect(phone.locator('.config-phone-url')).toHaveText(`http://127.0.0.1:${remotePort}/phone`);
    await expect(phone).toContainText('Only owner@example.com’s devices');
    expect(await listening()).toBe(true);

    await access.uncheck();
    await expect(qr).toBeHidden();
    await expect(phone.locator('.config-phone-url')).toBeHidden();
    await expect(phone.getByText('Only owner@example.com’s devices')).toBeHidden();
    await expect.poll(listening).toBe(false);
  } finally {
    await daemon.stop();
  }
  expect(problems).toEqual([]);
});
