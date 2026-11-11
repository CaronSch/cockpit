// Setup (widgets/setup.js, daemon/setup.js): a machine starting afresh gets the Setup window on its
// first empty screen, signs in to a model provider through omp's own login from there, picks the
// agents' browser, and starts its first agent; once ready, empty screens stay empty. Its optional
// phone step says how to get Tailscale until it runs here, then offers Phone access and, switched
// on, the QR code a phone signs in with. Runs daemons of their own, fresh, with the fake omp, the
// fake gh signed out and the fake tailscale.
import { test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
    const output = models.locator('.login-output');
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
    await expect(models.locator('.login-status')).toHaveText('omp login finished');
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

test('Config’s Accounts signs in through the same omp login, and stays open while it runs', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-e2e-accounts-'));
  const sessionsDir = join(dir, 'omp-sessions');
  mkdirSync(sessionsDir, { recursive: true });
  /** @type {string[]} */
  const problems = [];
  page.on('pageerror', (err) => problems.push(err.message));
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));

  const daemon = await startDaemon({ port: await freePort(), stateDir: join(dir, 'state'), sessionsDir, env: { FAKE_OMP_AUTH: join(dir, 'auth') }, fresh: true });
  try {
    await page.goto(daemon.url(newWorkspace()));
    const models = page.locator('.setup-step', { has: page.locator('.setup-step-title', { hasText: '2. A model provider' }) });
    await expect(models).toHaveAttribute('data-state', 'missing');

    // Opened by resting the pointer on it; a click inside pins it, so the login survives the pointer leaving.
    await page.getByRole('button', { name: 'Config' }).hover();
    const menu = page.locator('.config-menu');
    const accounts = menu.locator('.config-accounts');
    await accounts.getByRole('button', { name: 'Sign in…' }).click();
    await page.mouse.move(5, 500);
    const output = accounts.locator('.login-output');
    await expect(output).toContainText('1. Fake Cloud');
    await expect(menu).toBeVisible();
    const answer = accounts.getByRole('textbox', { name: 'Answer omp login' });
    await answer.fill('1');
    await answer.press('Enter');
    await expect(output).toContainText('Paste the authorization code');
    await answer.fill('good');
    await answer.press('Enter');
    await expect(accounts.locator('.login-status')).toHaveText('omp login finished');
    // One login for the whole daemon: Setup saw it end, and checked again.
    await expect(models).toHaveAttribute('data-state', 'ok');
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  } finally {
    await daemon.stop();
  }
  expect(problems).toEqual([]);
});

test('the optional phone step says how to get Tailscale, then offers Phone access and its QR code, holding nothing up', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-e2e-setup-phone-'));
  const sessionsDir = join(dir, 'omp-sessions');
  mkdirSync(sessionsDir, { recursive: true });
  // Signed in to a model provider already: Setup is ready while Tailscale is not.
  const auth = join(dir, 'auth');
  writeFileSync(auth, 'fake-cloud\n');
  const tailscaleStatus = join(dir, 'tailscale-status.json');
  writeFileSync(tailscaleStatus, JSON.stringify({ BackendState: 'Stopped' }));
  /** @type {string[]} */
  const problems = [];
  page.on('pageerror', (err) => problems.push(err.message));
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));

  const remotePort = await freePort();
  const daemon = await startDaemon({
    port: await freePort(),
    stateDir: join(dir, 'state'),
    sessionsDir,
    env: { FAKE_OMP_AUTH: auth, FAKE_TAILSCALE_STATUS_FILE: tailscaleStatus, COCKPIT_REMOTE_PORT: String(remotePort) },
    fresh: true,
  });
  try {
    await page.goto(daemon.url(newWorkspace()));
    const setup = page.locator('.widget[data-widget="setup"]');
    const phone = setup.locator('.setup-step', { has: page.locator('.setup-step-title', { hasText: '5. Your phone (optional)' }) });
    await expect(phone).toHaveAttribute('data-state', 'missing');
    await expect(phone.locator('.setup-state')).toHaveText('✗ Tailscale is not connected (Stopped)');
    await expect(phone.locator('.setup-todo')).toContainText('https://tailscale.com/download');
    await expect(phone.getByRole('checkbox', { name: /Phone access/ })).toBeHidden();
    await expect(setup.getByRole('button', { name: 'Start an agent' })).toBeEnabled();

    // Tailscale connected: checked again, the step offers Phone access, and how to set the phone up.
    writeFileSync(
      tailscaleStatus,
      JSON.stringify({
        BackendState: 'Running',
        Self: { TailscaleIPs: ['127.0.0.1'], DNSName: 'mac.example.ts.net.', UserID: 1 },
        User: { 1: { LoginName: 'owner@example.com' } },
      }),
    );
    await setup.getByRole('button', { name: 'Check again' }).click();
    await expect(phone).toHaveAttribute('data-state', 'ok');
    await expect(phone.locator('.setup-state')).toHaveText('✓ Connected as owner@example.com');
    await expect(phone.locator('.setup-todo')).toBeHidden();
    await expect(phone).toContainText('Always-on VPN');
    const access = phone.getByRole('checkbox', { name: /Phone access/ });
    await expect(access).not.toBeChecked();
    await expect(phone.locator('.config-phone-qr')).toHaveCount(0);

    await access.check();
    await expect(phone.locator('.config-phone-state')).toHaveText('On');
    await expect(phone.locator('img.config-phone-qr')).toBeVisible();
    await expect(phone.locator('.config-phone-url')).toHaveText(`http://127.0.0.1:${remotePort}/phone`);
    await expect(phone).toContainText('Only owner@example.com’s devices');
    // The same setting Config shows.
    await page.locator('.config-toggle').click();
    await expect(page.locator('.config-menu').getByRole('checkbox', { name: /Phone access/ })).toBeChecked();
    await page.keyboard.press('Escape');

    await access.uncheck();
    await expect(phone.locator('.config-phone-panel')).toBeHidden();
    await expect(phone.locator('.config-phone-qr')).toHaveCount(0);
  } finally {
    await daemon.stop();
  }
  expect(problems).toEqual([]);
});
