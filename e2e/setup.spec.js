// Setup (widgets/setup.js, daemon/setup.js): a machine starting afresh gets the Setup window on its
// first empty screen, signs in to a model provider through omp's own login from there, picks the
// agents' browser, and starts its first agent; once ready, empty screens stay empty. Runs a daemon
// of its own, fresh, with the fake omp signed in to nothing and the fake gh signed out.
import { test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort, newWorkspace, startDaemon } from './daemon.js';

test.use({ viewport: { width: 1280, height: 900 }, contextOptions: { reducedMotion: 'reduce' } });

test('a fresh machine opens Setup, signs in through omp login, picks the agents’ browser and starts an agent', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-e2e-setup-'));
  const sessionsDir = join(dir, 'omp-sessions');
  mkdirSync(sessionsDir, { recursive: true });
  /** @type {string[]} */
  const problems = [];
  page.on('pageerror', (err) => problems.push(err.message));
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));

  const daemon = await startDaemon({
    port: await freePort(),
    stateDir: join(dir, 'state'),
    sessionsDir,
    env: { FAKE_OMP_AUTH: join(dir, 'auth'), FAKE_GH_USER: '' },
    fresh: true,
  });
  try {
    await page.goto(daemon.url(newWorkspace()));
    const setup = page.locator('.widget[data-widget="setup"]');
    await expect(setup).toHaveCount(1);
    const stepOf = (/** @type {string} */ title) => setup.locator('.setup-step', { has: page.locator('.setup-step-title', { hasText: title }) });
    const omp = stepOf('1. omp');
    const models = stepOf('2. A model provider');
    const gh = stepOf('4. GitHub');
    await expect(omp).toHaveAttribute('data-state', 'ok');
    await expect(omp.locator('.setup-state')).toHaveText('✓ omp/fake');
    await expect(models).toHaveAttribute('data-state', 'missing');
    await expect(models.locator('.setup-state')).toHaveText('✗ No model provider signed in');
    await expect(gh).toHaveAttribute('data-state', 'missing');
    await expect(gh.locator('.setup-todo')).toContainText('gh auth login');
    const start = setup.getByRole('button', { name: 'Start an agent' });
    await expect(start).toBeDisabled();

    // The agents' browser: a separate one unless chosen otherwise, kept by the daemon.
    const browser = stepOf('3. Agents’ browser');
    await expect(browser.getByRole('radio', { name: /A separate browser/ })).toBeChecked();
    await browser.getByRole('radio', { name: /Your Chrome/ }).check();
    await page.locator('.config-toggle').click();
    await expect(page.locator('.config-menu').getByRole('radio', { name: /Your Chrome/ })).toBeChecked();
    await page.keyboard.press('Escape');

    // omp login, answered from the window: a provider by number, then the code it asks for.
    await models.getByRole('button', { name: 'Sign in…' }).click();
    const output = models.locator('.setup-login-output');
    await expect(output).toContainText('Enter number (1-2):');
    await expect(output).toContainText('1. Fake Cloud');
    const answer = models.getByRole('textbox', { name: 'Answer omp login' });
    await answer.fill('1');
    await answer.press('Enter');
    await expect(output).toContainText('https://login.fake.example/fake-cloud');
    await expect(output).toContainText('Paste the authorization code');
    await answer.fill('good');
    await answer.press('Enter');
    await expect(output).toContainText('Logged in to Fake Cloud');
    await expect(models.locator('.setup-login-status')).toHaveText('omp login finished');
    // The login ending checks again: signed in now, and ready.
    await expect(models).toHaveAttribute('data-state', 'ok');
    await expect(models.locator('.setup-state')).toHaveText('✓ fake-cloud (2 models)');
    await expect(start).toBeEnabled();

    await start.click();
    await expect(page.locator('.widget[data-widget="omp"]')).toHaveCount(1);
    await expect(setup).toHaveCount(1);

    // Kept: the choice after a reload, and a new screen of another workspace stays empty.
    await page.reload();
    await expect(stepOf('3. Agents’ browser').getByRole('radio', { name: /Your Chrome/ })).toBeChecked();
    await page.goto(daemon.url(newWorkspace()));
    await expect(page.locator('.grid-empty')).toBeVisible();
    await expect(page.locator('.widget')).toHaveCount(0);
  } finally {
    await daemon.stop();
  }
  expect(problems).toEqual([]);
});
