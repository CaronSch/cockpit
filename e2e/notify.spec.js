// Desktop notifications against the real daemon driving tests/fixtures/fake-omp.js. A headless
// browser cannot show real ones (or a permission prompt), so `Notification` is a stand-in that
// records what the page shows, and the page is told it is hidden while the user is "away".
import { test, expect } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newWorkspace, savedLayout, workbenchPath } from './daemon.js';

/** @typedef {import('@playwright/test').Page} Page */
/** @typedef {{ title: string, body: string, tag: string, closed: boolean }} ShownNote */

test.use({ viewport: { width: 1280, height: 800 }, contextOptions: { reducedMotion: 'reduce' } });

const PROJECT = mkdtempSync(join(tmpdir(), 'ac-e2e-notify-'));

/** @param {Page} page */
async function stubNotifications(page) {
  await page.addInitScript(() => {
    const w = /** @type {any} */ (window);
    w.__notes = [];
    w.__away = false;
    Object.defineProperty(document, 'visibilityState', { get: () => (w.__away ? 'hidden' : 'visible') });
    document.hasFocus = () => !w.__away;
    // Granted once the user turned notifications on, as a browser remembers it.
    let permission = localStorage.getItem('cockpit.notify') === 'on' ? 'granted' : 'default';
    class FakeNotification {
      static get permission() {
        return permission;
      }
      static async requestPermission() {
        return (permission = 'granted');
      }
      /** @param {string} title @param {NotificationOptions} options */
      constructor(title, options) {
        Object.assign(this, { title, body: options.body, tag: options.tag, closed: false, onclick: null, onclose: null });
        w.__notes.push(this);
      }
      close() {
        /** @type {any} */ (this).closed = true;
        /** @type {any} */ (this).onclose?.();
      }
    }
    w.Notification = FakeNotification;
  });
}

/**
 * What the page has shown for conversation `ompId` (each is tagged with it): other specs'
 * sessions run on the same daemon, and their turns end while this page is away too.
 * @param {Page} page @param {string} ompId @returns {Promise<ShownNote[]>}
 */
const notes = async (page, ompId) => (await shown(page)).filter((n) => n.tag === ompId);

/** omp's id for the conversation session `session` holds. @param {Page} page @param {string} session @returns {Promise<string>} */
async function ompIdOf(page, session) {
  let ompId = null;
  await expect
    .poll(async () => (ompId = (await (await page.request.get('/api/sessions')).json()).sessions.find((/** @type {any} */ s) => s.id === session)?.ompId ?? null))
    .toBeTruthy();
  return /** @type {string} */ (/** @type {unknown} */ (ompId));
}

/** Everything the page has shown. @param {Page} page @returns {Promise<ShownNote[]>} */
const shown = (page) => page.evaluate(() => /** @type {any} */ (window).__notes.map((/** @type {ShownNote} */ { title, body, tag, closed }) => ({ title, body, tag, closed })));

/** @param {Page} page @param {boolean} away */
const setAway = (page, away) => page.evaluate((a) => (/** @type {any} */ (window).__away = a), away);

/** The session the only agent window shows, as the daemon saved it. @param {Page} page @param {string} workspace */
async function shownSession(page, workspace) {
  /** @param {any} node @returns {any} */
  const find = (node) => (node?.widget === 'omp' ? node : (node?.children ?? []).map(find).find(Boolean));
  let session = null;
  await expect.poll(async () => (session = find(await savedLayout(page.request, workspace))?.params?.session ?? null)).toBeTruthy();
  return /** @type {string} */ (/** @type {unknown} */ (session));
}

/** @param {import('@playwright/test').Locator} pane */
async function startOmp(pane) {
  await pane.locator('input').fill(PROJECT);
  await pane.getByRole('button', { name: 'Start agent' }).click();
  await expect(pane.getByText('Fake Model')).toBeVisible();
}

test('a turn that ends while the user is away notifies once; a click shows the session; replays and a watched session never notify', async ({ page }) => {
  /** @type {string[]} */
  const problems = [];
  page.on('pageerror', (err) => problems.push(err.message));
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await stubNotifications(page);
  const workspace = newWorkspace();
  await page.goto(workbenchPath(workspace));
  await page.locator('#palette-toggle').click();
  await page.locator('#palette [data-type="omp"]').click();
  await page.keyboard.press('Escape');
  const pane = page.locator('.widget[data-widget="omp"]');
  await startOmp(pane);
  const session = await shownSession(page, workspace);
  const first = await ompIdOf(page, session);

  // Off until turned on in Config, from a click.
  const toggle = page.locator('.config-menu').getByRole('checkbox', { name: /^Desktop notifications/ });
  await page.getByRole('button', { name: 'Config' }).click();
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(toggle).toBeChecked();
  await page.keyboard.press('Escape');

  // Away (another tab in front): the turn's end notifies, once.
  await setAway(page, true);
  await pane.locator('textarea').fill('fix the login bug');
  await pane.locator('textarea').press('Enter');
  await expect(pane.locator('.omp-assistant').last()).toContainText('You said: fix the login bug');
  await expect.poll(() => notes(page, first)).toEqual([{ title: expect.stringContaining('fix the login bug'), body: 'Finished', tag: first, closed: false }]);
  await page.waitForTimeout(1500);
  expect(await notes(page, first)).toHaveLength(1);

  // The window moves on to another session; clicking the notification brings this one back, read.
  await pane.getByRole('button', { name: 'New', exact: true }).click();
  await startOmp(pane);
  await expect.poll(() => shownSession(page, workspace)).not.toBe(session);
  await page.evaluate((tag) => /** @type {any} */ (window).__notes.find((/** @type {ShownNote} */ n) => n.tag === tag).onclick(), first);
  await expect.poll(() => shownSession(page, workspace)).toBe(session);
  await expect(pane.locator('.omp-assistant').last()).toContainText('You said: fix the login bug');
  expect((await notes(page, first))[0].closed).toBe(true);

  // A reload replays every session's events: none of that notifies.
  await page.reload();
  await expect(pane.locator('.omp-assistant').last()).toContainText('You said: fix the login bug');
  await page.getByRole('button', { name: 'Config' }).click();
  await expect(toggle, 'the choice is kept').toBeChecked();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1500);
  expect(await notes(page, first)).toEqual([]);

  // Looking at the session (this tab in front, its window showing it): no notification.
  await pane.locator('textarea').fill('and the signup bug');
  await pane.locator('textarea').press('Enter');
  await expect(pane.locator('.omp-assistant').last()).toContainText('You said: and the signup bug');
  await page.waitForTimeout(1500);
  expect(await notes(page, first)).toEqual([]);

  // A question while away notifies with the question.
  await setAway(page, true);
  await pane.locator('textarea').fill('ask me');
  await pane.locator('textarea').press('Enter');
  await expect.poll(() => notes(page, first)).toEqual([expect.objectContaining({ body: 'Needs your input: Which database?', tag: first })]);
  expect(problems).toEqual([]);
});
