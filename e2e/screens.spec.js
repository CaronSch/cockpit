// Behaviour tests for screens: each browser window shows one screen of its workspace, which
// the real daemon keeps in E2E_STATE_DIR/workspaces/<name>.json.
import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { e2eToken, newWorkspace, workbenchPath, workspaceFile } from './daemon.js';

/** @typedef {import('@playwright/test').Page} Page */
/** @typedef {import('@playwright/test').BrowserContext} BrowserContext */

test.use({ viewport: { width: 1280, height: 720 }, contextOptions: { reducedMotion: 'reduce' } });

const PROJECT = mkdtempSync(join(tmpdir(), 'ac-e2e-screens-'));

/** @type {string[]} */
let problems = [];

test.beforeEach(async ({ context }) => {
  problems = [];
  await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
});

test.afterEach(() => {
  expect(problems, 'page errors / console errors during the test').toEqual([]);
});

/**
 * A new browser window, not loaded yet. `tabScreen` is the screen this tab showed before, as
 * a reloaded tab, or a duplicated one, carries over.
 * @param {BrowserContext} context @param {{ tabScreen?: { workspace: string, id: string } }} [options]
 */
async function newWindow(context, { tabScreen } = {}) {
  const page = await context.newPage();
  watch(page);
  if (tabScreen) await page.addInitScript(({ workspace, id }) => sessionStorage.setItem(`cockpit.screen.${workspace}`, id), tabScreen);
  return page;
}

/** Records a page's errors in `problems`. @param {Page} page */
function watch(page) {
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`);
  });
}

/** Opens another browser window on the workbench (see `newWindow`). @param {BrowserContext} context @param {string} path @param {{ tabScreen?: { workspace: string, id: string } }} [options] */
async function openWindow(context, path, options) {
  const page = await newWindow(context, options);
  await page.goto(path);
  await expect(page.locator('.screen-switch')).toBeVisible(); // the app has started
  return page;
}

/** The screens the daemon keeps, as each one's window ids. @param {Page} page @param {string} workspace */
async function storedScreens(page, workspace) {
  const { screens } = await (await page.request.get(`/api/workspaces/${workspace}`)).json();
  return /** @type {Array<{ id: string, rev: number, tree: any }>} */ (screens);
}

/** Each stored screen's window ids, in screen order. @param {Page} page @param {string} workspace */
async function storedIds(page, workspace) {
  /** @param {any} node @returns {string[]} */
  const ids = (node) => (node.kind === 'leaf' ? [node.id] : node.children.flatMap(ids));
  return (await storedScreens(page, workspace)).map((s) => ids(s.tree).sort());
}

/** The windows a page shows. @param {Page} page */
const shownIds = (page) =>
  page.locator('.widget').evaluateAll((els) => els.map((e) => /** @type {string} */ (/** @type {HTMLElement} */ (e).dataset.id)).sort());

/** Adds a window of `type` (an empty Pane unless told) through the palette; returns its id. @param {Page} page @param {string} [type] */
async function addWindow(page, type = 'pane') {
  const before = await shownIds(page);
  await page.locator('#palette-toggle').click();
  await page.locator(`#palette [data-type="${type}"]`).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.widget')).toHaveCount(before.length + 1);
  const added = (await shownIds(page)).find((id) => !before.includes(id));
  if (!added) throw new Error('no window added');
  return added;
}

/** The switcher's label: which screen the page shows. @param {Page} page */
const switcher = (page) => page.locator('.screen-switch .screen-label');
/** The switcher menu's row for screen `n`. @param {Page} page @param {number} n */
const row = (page, n) => page.locator('.screen-row', { has: page.locator('.screen-row-name', { hasText: new RegExp(`^Screen ${n}$`) }) });

/** @param {Page} page @param {string} id */
async function session(page, id) {
  const { sessions } = await (await page.request.get('/api/sessions')).json();
  return sessions.find((/** @type {{ id: string }} */ s) => s.id === id);
}

/** @param {number} pid */
function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('a second window opens a screen of its own; neither undoes the other’s layout, and each keeps its screen on reload', async ({ context }) => {
  const workspace = newWorkspace();
  const path = workbenchPath(workspace);
  const one = await openWindow(context, path);
  const a = await addWindow(one);
  const b = await addWindow(one);
  await expect.poll(() => storedIds(one, workspace)).toEqual([[a, b].sort()]);
  const [first] = await storedScreens(one, workspace);

  // Even a copy of the first tab (which carries over its screen) gets a new, empty screen.
  const two = await openWindow(context, path, { tabScreen: { workspace, id: first.id } });
  await expect(switcher(two)).toHaveText('Screen 2 of 2');
  await expect(two.locator('.widget')).toHaveCount(0);
  expect(await shownIds(one)).toEqual([a, b].sort());

  const c = await addWindow(two);
  await expect.poll(() => storedIds(one, workspace)).toEqual([[a, b].sort(), [c]]);
  await one.locator(`.widget[data-id="${b}"] .widget-close`).click();
  await expect.poll(() => storedIds(one, workspace)).toEqual([[a], [c]]);
  const d = await addWindow(two);
  await expect.poll(() => storedIds(one, workspace)).toEqual([[a], [c, d].sort()]);

  await one.reload();
  await two.reload();
  await expect(switcher(one)).toHaveText('Screen 1 of 2');
  await expect(switcher(two)).toHaveText('Screen 2 of 2');
  await expect.poll(() => shownIds(one)).toEqual([a]);
  await expect.poll(() => shownIds(two)).toEqual([c, d].sort());
});

test('a window opened after another was closed brings its screen back, and a reload keeps it while an earlier screen is free', async ({ context }) => {
  const workspace = newWorkspace();
  const path = workbenchPath(workspace);
  const one = await openWindow(context, path);
  const a = await addWindow(one);
  const two = await openWindow(context, path);
  const c = await addWindow(two);
  await expect.poll(() => storedIds(one, workspace)).toEqual([[a], [c]]);

  await two.close();
  const three = await openWindow(context, path);
  await expect(switcher(three)).toHaveText('Screen 2 of 2');
  await expect.poll(() => shownIds(three)).toEqual([c]);

  await one.close(); // Screen 1 is free now, but this tab's screen is Screen 2
  await three.reload();
  await expect(switcher(three)).toHaveText('Screen 2 of 2');
  await expect.poll(() => shownIds(three)).toEqual([c]);
});

test('a reload gets its screen back however long the page it replaces holds on to it', async ({ context }) => {
  const workspace = newWorkspace();
  const path = workbenchPath(workspace);
  const one = await openWindow(context, path);
  const a = await addWindow(one);
  await expect.poll(() => storedIds(one, workspace)).toEqual([[a]]);
  const [screen] = await storedScreens(one, workspace);
  const lock = `cockpit:${workspace}:${screen.id}`;

  // Stands in for a page slow to go away: queued first, it takes the screen's lock as the old
  // page lets go and keeps it until closed.
  const slow = await openWindow(context, workbenchPath(newWorkspace()));
  await slow.evaluate((name) => void navigator.locks.request(name, () => new Promise(() => {})), lock);
  /** Whether a page is waiting for the screen's lock. */
  const waiting = async () =>
    (await slow.evaluate(async (name) => (await navigator.locks.query()).pending?.filter((l) => l.name === name).length ?? 0, lock));
  await expect.poll(waiting).toBe(1);

  await one.reload();
  await expect.poll(waiting).toBe(1); // the reloaded page asks for its screen, and waits
  await one.waitForTimeout(2000); // far longer than a page takes to go away
  await slow.close();

  await expect(switcher(one)).toHaveText('Screen 1 of 1');
  await expect.poll(() => shownIds(one)).toEqual([a]);
});

test('a duplicated tab takes a screen of its own at once', async ({ context }) => {
  const workspace = newWorkspace();
  const path = workbenchPath(workspace);
  const one = await openWindow(context, path);
  const a = await addWindow(one);
  await expect.poll(() => storedIds(one, workspace)).toEqual([[a]]);
  await one.reload(); // so the copy also carries the note a page going away leaves
  await expect(switcher(one)).toHaveText('Screen 1 of 1');

  // A window opened by the page starts with a copy of its sessionStorage, as a duplicate does.
  const [two] = await Promise.all([context.waitForEvent('page'), one.evaluate(() => void window.open(location.href))]);
  watch(two);
  await expect(switcher(two)).toHaveText('Screen 2 of 2');
  expect(await two.evaluate(() => performance.now()), 'ms from navigation to its screen').toBeLessThan(1500);
  await expect(two.locator('.widget')).toHaveCount(0);
  await expect.poll(() => shownIds(one)).toEqual([a]);
});

test('the switcher opens a screen open nowhere in this window, and deletes one, its agents running on either way', async ({ context }) => {
  const workspace = newWorkspace();
  const path = workbenchPath(workspace);
  const one = await openWindow(context, path);
  const omp = await addWindow(one, 'omp');
  const pane = one.locator(`.widget[data-id="${omp}"]`);
  await pane.locator('input').fill(PROJECT);
  await pane.getByRole('button', { name: 'Start agent' }).click();
  await expect(pane.getByText('Fake Model')).toBeVisible(); // the session is ready
  await expect.poll(async () => (await storedScreens(one, workspace))[0]?.tree.params?.session).toBeTruthy();
  const agent = (await storedScreens(one, workspace))[0].tree.params.session;
  const { pid } = await session(one, agent);

  const two = await openWindow(context, path);
  const p = await addWindow(two);
  await expect.poll(() => storedIds(two, workspace)).toEqual([[omp], [p]]);
  await one.close(); // closing a browser window is not closing its windows: the agent runs on
  expect((await session(two, agent)).status).toBe('ready');

  // Open here: this window shows Screen 1 instead, and Screen 2 stays, open nowhere.
  await switcher(two).click();
  await expect(row(two, 1)).toContainText('1 Agent');
  await expect(row(two, 2)).toContainText('this window');
  await two.getByRole('button', { name: 'Open Screen 1 here' }).click();
  await expect(switcher(two)).toHaveText('Screen 1 of 2');
  await expect.poll(() => shownIds(two)).toEqual([omp]);
  await expect(two.locator(`.widget[data-id="${omp}"]`).getByText('Fake Model')).toBeVisible();

  // Leaving a screen does not close its windows either.
  await switcher(two).click();
  await expect(row(two, 2)).toContainText('1 Pane');
  await two.getByRole('button', { name: 'Open Screen 2 here' }).click();
  await expect(switcher(two)).toHaveText('Screen 2 of 2');
  await expect.poll(() => shownIds(two)).toEqual([p]);
  expect((await session(two, agent)).status).toBe('ready');
  expect(isRunning(pid)).toBe(true);

  // Delete asks first, then closes the screen's windows; as closing a window does not, it ends no agent.
  await switcher(two).click();
  await two.getByRole('button', { name: 'Delete Screen 1' }).click();
  const menu = two.locator('.screen-menu');
  await expect(menu).toContainText('Delete Screen 1 and close its windows (1 Agent)?');
  await menu.getByRole('button', { name: 'Cancel' }).click();
  await expect(row(two, 1)).toBeVisible();
  await two.getByRole('button', { name: 'Delete Screen 1' }).click();
  await menu.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(row(two, 1)).toContainText('this window');
  await expect(switcher(two)).toHaveText('Screen 1 of 1');
  expect(await storedIds(two, workspace)).toEqual([[p]]);
  expect((await session(two, agent)).status).toBe('ready');
  expect(isRunning(pid)).toBe(true);
  await two.evaluate((id) => fetch(`/api/sessions/${id}`, { method: 'DELETE' }).then(() => {}), agent);
  await expect.poll(() => isRunning(pid)).toBe(false);
});

test('the first window of workspace main adopts the layout this address kept before workspaces, once', async ({ context }) => {
  rmSync(workspaceFile('main'), { force: true }); // only this test uses the default workspace
  const tree = { kind: 'branch', axis: 'row', sizes: [0.5, 0.5], children: [
    { kind: 'leaf', id: 'w_legacy1', widget: 'pane' },
    { kind: 'leaf', id: 'w_legacy2', widget: 'pane' },
  ] };
  const setup = await openWindow(context, workbenchPath(newWorkspace()));
  await setup.evaluate((saved) => localStorage.setItem('cockpit.layout.v1', JSON.stringify({ version: 1, savedAt: '2026-10-01T00:00:00.000Z', tree: saved })), tree);
  await setup.close();

  const page = await openWindow(context, `/?token=${e2eToken()}`);
  await expect.poll(() => shownIds(page)).toEqual(['w_legacy1', 'w_legacy2']);
  expect(await storedScreens(page, 'main')).toEqual([{ id: expect.any(String), rev: 1, tree }]);
  expect(await page.evaluate(() => localStorage.getItem('cockpit.layout.v1'))).toBeNull();
  await page.reload();
  await expect.poll(() => shownIds(page)).toEqual(['w_legacy1', 'w_legacy2']);
});

test('New screen opens a copy of this screen in a new tab, whose windows are its own', async ({ context }) => {
  const workspace = newWorkspace();
  const path = workbenchPath(workspace);
  const one = await openWindow(context, path);
  const a = await addWindow(one);
  const b = await addWindow(one);
  await expect.poll(() => storedIds(one, workspace)).toEqual([[a, b].sort()]);

  await switcher(one).click();
  const opening = context.waitForEvent('page');
  await one.getByRole('button', { name: 'New screen' }).click();
  const two = await opening;
  watch(two);
  await expect(switcher(two)).toHaveText('Screen 2 of 2');
  await expect(two.locator('.widget')).toHaveCount(2);
  const copied = await shownIds(two);
  expect(copied.some((id) => id === a || id === b), 'the copy’s windows have ids of their own').toBe(false);
  expect(new URL(two.url()).searchParams.has('screen'), 'the address drops the screen it named').toBe(false);
  expect(await shownIds(one)).toEqual([a, b].sort());

  // Each is its own screen from then on, a reload included.
  await two.locator(`.widget[data-id="${copied[0]}"] .widget-close`).click();
  await expect.poll(() => storedIds(one, workspace)).toEqual([[a, b].sort(), [copied[1]]]);
  await two.reload();
  await expect(switcher(two)).toHaveText('Screen 2 of 2');
  await expect.poll(() => shownIds(two)).toEqual([copied[1]]);
});
