// The phone page (phone.html, src/phone.js) through Phone access's listener (daemon/remote.js), as
// an Android phone on the owner's tailnet reaches it: plain HTTP at a tailnet name, so no secure
// context, and touch. It lists how each conversation is doing, opens one full screen, reads it
// without waking it, replies, stops the agent, answers its question, and goes back; a device the
// tailnet does not know as the owner's gets nothing. Runs a daemon of its own with Phone access
// on, the fake omp and the fake tailscale, whose listener binds 127.0.0.1 at a port of its own;
// Chromium resolves the tailnet name `phone.test` to it.
import { test, expect, devices } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAKE_TAILSCALE, freePort, remoteOn, startDaemon } from './daemon.js';

/** @typedef {import('@playwright/test').Page} Page */

// Pixel 7's screen, touch and coarse pointer, in the Chromium the project runs.
const { defaultBrowserType: _, ...pixel7 } = devices['Pixel 7'];
test.use({ ...pixel7, launchOptions: { args: ['--host-resolver-rules=MAP phone.test 127.0.0.1'] } });

/** `tailscale status --json` of a Mac whose MagicDNS name is `phone.test`, at 127.0.0.1. */
const STATUS = {
  BackendState: 'Running',
  Self: { TailscaleIPs: ['127.0.0.1'], DNSName: 'phone.test.', UserID: 1 },
  User: { 1: { LoginName: 'owner@example.com', DisplayName: 'Owner' } },
};

/** Conversations in the daemon's omp sessions, each in a journal of its own. */
const NAMES = ['working', 'asking', 'done', 'asleep', 'prefill', 'chat', 'work'];

/**
 * A daemon with Phone access on, its journals in a directory of its own, the remote listener up.
 * @param {Record<string, string>} [env]
 */
async function phoneDaemon(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ac-e2e-phone-'));
  const stateDir = join(dir, 'state');
  const sessionsDir = join(dir, 'omp-sessions');
  const project = join(dir, 'project');
  const home = join(dir, 'home');
  for (const d of [stateDir, join(sessionsDir, '-e2e-phone'), project, home]) mkdirSync(d, { recursive: true });
  writeFileSync(join(stateDir, 'settings.json'), JSON.stringify({ version: 1, settings: { setupDone: true, remote: true } }));
  /** @param {string} name */
  const fileOf = (name) => join(sessionsDir, '-e2e-phone', `2026-10-01_${name}.jsonl`);
  for (const name of NAMES) {
    const lines = [
      { type: 'title', v: 1, title: `About ${name}`, source: 'auto' },
      { type: 'session', version: 3, id: `phone-${name}`, timestamp: '2026-10-01T10:00:00.000Z', cwd: project },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: `start ${name}` }] } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: `Started ${name}.` }] } },
    ];
    writeFileSync(fileOf(name), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  }
  const port = await freePort();
  const remotePort = await freePort();
  const daemon = await startDaemon({
    port,
    stateDir,
    sessionsDir,
    env: {
      HOME: home,
      COCKPIT_TAILSCALE: FAKE_TAILSCALE,
      COCKPIT_REMOTE_PORT: String(remotePort),
      FAKE_TAILSCALE_STATUS: JSON.stringify(STATUS),
      ...env,
    },
  });
  await remoteOn(daemon);
  return {
    daemon,
    project,
    fileOf,
    signIn: `http://phone.test:${remotePort}/phone?token=${daemon.token()}`,
    phone: `http://phone.test:${remotePort}/phone`,
    /** The listener's own address, for requests from outside the browser (its host resolver maps phone.test). */
    remote: `http://127.0.0.1:${remotePort}`,
  };
}

/** @type {Awaited<ReturnType<typeof phoneDaemon>>} */
let at;
/** @type {string[]} */
let problems = [];

/**
 * Wakes the conversation `name` from its journal, as a window on the Mac would, and resolves
 * with its session's id once omp is ready.
 * @param {string} name
 */
async function wake(name) {
  const res = await at.daemon.api('/api/sessions', { method: 'POST', body: { cwd: at.project, resume: at.fileOf(name) } });
  const { session } = await res.json();
  await expect.poll(async () => (await awake(name))?.status).toBe('ready');
  return /** @type {string} */ (session.id);
}

/** The session holding `name`'s journal, if one is awake. @param {string} name */
async function awake(name) {
  const { sessions } = await (await at.daemon.api('/api/sessions')).json();
  return sessions.find((/** @type {any} */ s) => s.sessionFile === at.fileOf(name) && s.status !== 'exited' && s.status !== 'failed') ?? null;
}

/** Sends `text` to session `id` as the Mac's own window would. @param {string} id @param {string} text */
async function prompt(id, text) {
  const res = await at.daemon.api(`/api/sessions/${id}/rpc`, { method: 'POST', body: { type: 'prompt', message: text } });
  expect(res.status).toBe(202);
}

/** The phone's list row of conversation `name`, by its journal. @param {Page} page @param {string} name */
const rowOf = (page, name) => page.locator(`.sessions-item[data-key="${at.fileOf(name)}"]`);

/** Opens conversation `name` from the list with a tap. @param {Page} page @param {string} name */
async function open(page, name) {
  await rowOf(page, name).locator('.sessions-title').tap();
  await expect(page.locator('.phone-title')).toContainText(`About ${name}`);
  await expect(page.locator('.omp-transcript')).toContainText(`Started ${name}.`);
}

test.describe('the phone page', () => {
  test.beforeAll(async () => {
    at = await phoneDaemon();
  });

  test.afterAll(async () => {
    await at.daemon.stop();
  });

  test.beforeEach(async ({ page }) => {
    problems = [];
    page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`);
    });
    await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    await page.goto(at.signIn);
    await expect(page).toHaveURL(at.phone); // the sign-in keeps the path, and drops the token
    await expect(rowOf(page, 'asleep')).toBeVisible();
  });

  test.afterEach(() => {
    expect(problems).toEqual([]);
  });

  test('signs in over plain HTTP at a tailnet name, and lists how each conversation is doing', async ({ page }) => {
    // What the phone page loads must work outside a secure context: this is the phone's case.
    expect(await page.evaluate(() => isSecureContext)).toBe(false);
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    // The page is the phone's, with the same import map as the workbench's.
    const importMap = async (/** @type {string} */ path) => (await (await at.daemon.api(path)).text()).match(/<script type="importmap">([\s\S]*?)<\/script>/)?.[1]?.trim();
    expect(await importMap('/phone')).toBeTruthy();
    expect(await importMap('/phone')).toBe(await importMap('/'));

    const asking = await wake('asking');
    const done = await wake('done');
    const working = await wake('working');
    await prompt(asking, 'ask me');
    await prompt(done, 'hello');
    await expect(rowOf(page, 'asking')).toHaveClass(/is-asking/);
    await expect(rowOf(page, 'asking').locator('.sessions-state')).toHaveText('needs you');
    await expect(rowOf(page, 'done')).toHaveClass(/is-done/);
    await prompt(working, 'slow');
    await expect(rowOf(page, 'working')).toHaveClass(/is-working/);
    await expect(rowOf(page, 'working').locator('.sessions-state')).toHaveText('working');
    await expect(rowOf(page, 'asleep')).not.toHaveClass(/is-(working|asking|done|starting)/);

    // Archive and Pin are not the phone's: invisible on the desktop until hovered, they would
    // still take taps here.
    const row = rowOf(page, 'asleep');
    for (const control of [row.locator('.sessions-archive'), row.locator('.sessions-pin')]) {
      await expect(control).toHaveCount(1);
      await expect(control).toBeHidden();
    }
    // Answered, so later tests find it idle.
    await expect(rowOf(page, 'working')).toHaveClass(/is-done/, { timeout: 5000 });
  });

  test('a tap opens a conversation, which reads without waking; back returns to the list, and a reload keeps it', async ({ page }) => {
    await open(page, 'asleep');
    const draft = page.locator('.omp-draft');
    await expect(draft).toBeVisible();
    // The message box sits at the foot of the screen, under the conversation, which scrolls on
    // its own: the page itself never grows past the screen.
    const { height } = /** @type {{ height: number }} */ (page.viewportSize());
    const box = /** @type {{ y: number, height: number }} */ (await draft.boundingBox());
    expect(box.y + box.height).toBeGreaterThan(height - 64);
    expect(await page.evaluate(() => document.scrollingElement?.scrollHeight)).toBeLessThanOrEqual(height);
    // Tapping to read is no click to type: the box keeps the keyboard closed, and the
    // conversation sleeps on (focusing the box would wake it).
    await page.locator('.omp-transcript').getByText('Started asleep.').tap();
    await expect(draft).not.toBeFocused();
    expect(await awake('asleep')).toBeNull();

    // A reload reopens the conversation from the page's history entry.
    await page.reload();
    await expect(page.locator('.omp-transcript')).toContainText('Started asleep.');
    // Android's back gesture is the browser's back.
    await page.goBack();
    await expect(rowOf(page, 'asleep')).toBeVisible();
    await expect(page.locator('.omp-transcript')).toHaveCount(0);
    await expect(page.locator('.phone-back')).toBeHidden();
    // So is the top bar's Back.
    await open(page, 'asleep');
    await page.locator('.phone-back').tap();
    await expect(rowOf(page, 'asleep')).toBeVisible();
    expect(await awake('asleep')).toBeNull();
  });

  test('an earlier request of the agent to fill the box leaves the draft alone', async ({ page }) => {
    const id = await wake('prefill');
    await prompt(id, 'prefill');
    await expect.poll(() => readFileSync(at.fileOf('prefill'), 'utf8')).toContain('You said: **prefill**');
    await open(page, 'prefill');
    await expect(page.locator('.omp-transcript')).toContainText('You said: prefill');
    const draft = page.locator('.omp-draft');
    await expect(draft).toHaveValue('');
    await expect(draft).not.toBeFocused();
  });

  test('Enter makes a new line and Send sends; Stop stops the agent; its question and approval are answered', async ({ page }) => {
    await wake('chat');
    await open(page, 'chat');
    const draft = page.locator('.omp-draft');
    const send = page.getByRole('button', { name: 'Send', exact: true });
    await draft.tap();
    await draft.pressSequentially('first line');
    await draft.press('Enter');
    await draft.pressSequentially('second line');
    await expect(draft).toHaveValue('first line\nsecond line');
    await send.tap();
    await expect(draft).toHaveValue('');
    await expect(page.locator('.omp-user').last()).toContainText('first line');
    await expect(page.locator('.omp-assistant').last()).toContainText('You said: first line');

    const stop = page.locator('.phone-actions').getByRole('button', { name: 'Stop', exact: true });
    await expect(stop).toBeDisabled();
    await draft.fill('slow');
    await send.tap();
    await expect(stop).toBeEnabled();
    await stop.tap();
    await expect(stop).toBeDisabled();

    await draft.fill('ask me');
    await send.tap();
    const dialog = page.locator('.omp-dialogs');
    await expect(dialog.getByText('Which database?')).toBeVisible();
    await dialog.getByText('SQLite', { exact: true }).tap();
    await dialog.getByRole('button', { name: 'Submit' }).tap();
    await expect(page.locator('.omp-assistant').last()).toHaveText('You picked SQLite.');
    await expect(dialog.getByText('Which database?')).toHaveCount(0);

    await draft.fill('approve it');
    await send.tap();
    await expect(dialog.getByText('Allow this command?')).toBeVisible();
    await dialog.getByRole('button', { name: 'Yes', exact: true }).tap();
    await expect(page.locator('.omp-assistant').last()).toHaveText('Approved: going ahead.');
    await expect(dialog.getByText('Allow this command?')).toHaveCount(0);
  });

  test('prompts and responses only by default, Show work shows the rest; controls the phone has no use for are absent', async ({ page }) => {
    const id = await wake('work');
    // A tool call, then a reply holding a code block and a table.
    await prompt(id, 'say: The tool ran.\n\n```\necho hi\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |');
    await open(page, 'work');
    const transcript = page.locator('.omp-transcript');
    const reply = transcript.locator('.omp-assistant').last();
    await expect(reply.locator('.md-table-block')).toHaveCount(1);
    const work = page.getByRole('button', { name: 'Show work' });
    await expect(work).toHaveAttribute('aria-pressed', 'false');
    await expect(transcript.locator('.omp-tool')).toHaveCount(0);
    await work.tap();
    await expect(work).toHaveAttribute('aria-pressed', 'true');
    await expect(transcript.locator('.omp-tool').first()).toBeVisible();
    // The choice is this browser's, kept across reloads.
    await page.reload();
    await expect(work).toHaveAttribute('aria-pressed', 'true');
    await work.tap();
    await expect(transcript.locator('.omp-tool')).toHaveCount(0);
    await page.reload();
    await expect(work).toHaveAttribute('aria-pressed', 'false');

    // Rewind, Copy (it needs a secure context), and New, Forks, PRs and Accounts are not the
    // phone's: there, yet never shown.
    await expect(page.locator('.phone-actions button:visible')).toHaveText(['↑', '↓', 'Stop']);
    await expect(page.locator('.phone-actions .omp-new')).toHaveCount(1);
    const rewind = transcript.locator('.omp-user .omp-rewind-btn').first();
    await expect(rewind).toBeAttached();
    await expect(rewind).toBeHidden();
    for (const copy of [reply.locator('.md-code-copy'), reply.locator('.md-table-copy')]) {
      await expect(copy).toHaveCount(1);
      await expect(copy).toBeHidden();
    }
  });
});

test.describe('a device that is not one of the owner’s', () => {
  // Each daemon below whois answers otherwise for 127.0.0.1: unknown to the tailnet (a LAN
  // peer), or another person's device.
  for (const [who, peers] of /** @type {const} */ ([
    ['unknown to the tailnet', {}],
    ['signed in as someone else', { '127.0.0.1': { login: 'other@example.com' } }],
  ])) {
    test(`gets nothing when ${who}`, async ({ page }) => {
      const other = await phoneDaemon({ FAKE_TAILSCALE_PEERS: JSON.stringify(peers) });
      try {
        const res = await page.goto(other.signIn);
        expect(res?.status()).toBe(403);
        expect(res?.headers()['content-type']).toMatch(/^text\/plain/);
        await expect(page.locator('.phone')).toHaveCount(0);
        // Its API is refused too, though the token is right.
        const api = await fetch(`${other.remote}/api/sessions`, { headers: { cookie: `ac_token=${other.daemon.token()}` } });
        expect(api.status).toBe(403);
      } finally {
        await other.daemon.stop();
      }
    });
  }
});
