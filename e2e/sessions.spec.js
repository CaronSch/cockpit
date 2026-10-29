// Behaviour tests for the Sessions window: one list of conversations, how awake ones are
// doing, search, sort, showing one in an agent window (asleep or awake), unread marks, links to
// the agent windows, and archiving, against the real daemon reading journals from
// E2E_OMP_SESSIONS.
import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { E2E_OMP_SESSIONS, E2E_STATE_DIR, newWorkspace, savedLayout, workbenchPath } from './daemon.js';

/** @typedef {import('@playwright/test').Page} Page */
/** @typedef {import('@playwright/test').Locator} Locator */

test.use({ viewport: { width: 1280, height: 800 }, contextOptions: { reducedMotion: 'reduce' } });

const ALPHA = mkdtempSync(join(tmpdir(), 'ac-e2e-alpha-'));
const BRAVO = mkdtempSync(join(tmpdir(), 'ac-e2e-bravo-'));
const MINUTE = 60_000;

/**
 * Three past conversations. Last active: zebra, then deploy, then login, so every ordering
 * the tests check (by activity, by title either way) is a different sequence.
 */
const JOURNALS = [
  { name: 'login', cwd: ALPHA, title: 'Fix the login flow', prompts: ['fix the login bug', 'now add tests'], replies: ['The session cookie expired before the redirect, so the sign-in loop restarted.'], ageMs: 120 * MINUTE },
  { name: 'deploy', cwd: BRAVO, title: null, prompts: ['deploy staging'], ageMs: 30 * MINUTE },
  { name: 'zebra', cwd: ALPHA, title: 'Zebra cleanup', prompts: ['remove dead code'], ageMs: 10 * MINUTE },
];
/** @param {string} name */
const fileOf = (name) => join(E2E_OMP_SESSIONS, '-e2e-project', `2026-10-01_${name}.jsonl`);
const ARCHIVE = join(E2E_STATE_DIR, 'archive', 'sessions');

/** @type {string[]} */
let problems = [];
/** The workspace this test lays out its windows in. */
let workspace = '';

/**
 * Empties `dir`, keeping the directory itself: the daemon watches it for changes, and a
 * watch does not follow a directory that is deleted and made again.
 * @param {string} dir
 */
function empty(dir) {
  mkdirSync(dir, { recursive: true });
  for (const entry of readdirSync(dir)) rmSync(join(dir, entry), { recursive: true, force: true });
}

/** Writes a past conversation's journal, last active `ageMs` ago. @param {typeof JOURNALS[number]} j */
function writeJournal(j) {
  const lines = [
    ...(j.title ? [{ type: 'title', v: 1, title: j.title, source: 'auto' }] : []),
    { type: 'session', version: 3, id: j.name, timestamp: '2026-10-01T10:00:00.000Z', cwd: j.cwd },
    ...j.prompts.map((text) => ({ type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } })),
    ...(j.replies ?? []).map((text) => ({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text }] } })),
  ];
  writeFileSync(fileOf(j.name), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  const at = new Date(Date.now() - j.ageMs);
  utimesSync(fileOf(j.name), at, at);
}

test.beforeEach(async ({ page }) => {
  empty(E2E_OMP_SESSIONS);
  empty(ARCHIVE);
  mkdirSync(join(E2E_OMP_SESSIONS, '-e2e-project'), { recursive: true });
  for (const j of JOURNALS) writeJournal(j);

  problems = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`);
  });
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
  workspace = newWorkspace();
  await page.goto(workbenchPath(workspace));
  await expect(page.locator('.screen-switch')).toBeVisible(); // the app has started
  // Unread marks and pins outlive sessions: an earlier test's must not show in this one.
  await page.evaluate(async (ids) => {
    for (const id of ids) {
      await fetch(`/api/unread/${id}/read`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ at: Number.MAX_SAFE_INTEGER }) });
      await fetch(`/api/pins/${id}`, { method: 'DELETE' });
    }
  }, JOURNALS.map((j) => j.name));
});

test.afterEach(async ({ page }) => {
  // Sessions this spec woke would otherwise stay awake and show as such in the next test.
  await page.evaluate(async (dir) => {
    const { sessions } = await (await fetch('/api/sessions')).json();
    for (const s of sessions) {
      if (s.sessionFile?.startsWith(dir) && s.status !== 'exited') await fetch(`/api/sessions/${s.id}`, { method: 'DELETE' });
    }
  }, E2E_OMP_SESSIONS);
  expect(problems, 'page errors / console errors during the test').toEqual([]);
});

/** @param {Page} page */
async function addSessionsWindow(page) {
  await page.locator('#palette-toggle').click();
  await page.locator('#palette [data-type="sessions"]').click();
  await page.keyboard.press('Escape');
  const window = page.locator('.widget[data-widget="sessions"]');
  await expect(window).toHaveCount(1);
  return window;
}

/**
 * This spec's rows, in display order: its own journals', archived or not. Tests run in
 * parallel against one daemon, so the list also holds other spec files' conversations; those
 * are left out.
 * @param {Locator} window
 */
const ours = (window) => window.locator(`.sessions-list .sessions-item:is([data-key^="${E2E_OMP_SESSIONS}/"], [data-key^="${ARCHIVE}/"])`);

/** This spec's rows' titles, in display order. @param {Locator} window */
const titles = (window) => ours(window).locator('.sessions-title');

/** A conversation's row, by title. @param {Locator} window @param {string} title */
const row = (window, title) => window.locator('.sessions-list .sessions-item', { has: window.page().locator('.sessions-title', { hasText: title }) });

/** A conversation's row, by what names it (its journal, else a new one's session). @param {Locator} window @param {string} key */
const keyRow = (window, key) => window.locator(`.sessions-list .sessions-item[data-key="${key}"]`);

/** @param {Page} page */
const daemonSessions = async (page) => (await (await page.request.get('/api/sessions')).json()).sessions;

/** The awake sessions holding journal `file`. @param {Page} page @param {string} file */
const awake = async (page, file) => (await daemonSessions(page)).filter((/** @type {any} */ s) => s.sessionFile === file && (s.status === 'ready' || s.status === 'starting'));

/** The settings agent window `pane` is saved with, once the layout saved has it. @param {Page} page @param {Locator} pane */
async function savedPane(page, pane) {
  const id = await pane.getAttribute('data-id');
  /** @param {any} node @returns {any} */
  const find = (node) => (node?.id === id ? node : (node?.children ?? []).map(find).find(Boolean));
  return find(await savedLayout(page.request, workspace))?.params ?? null;
}

/**
 * The conversation agent window `pane` shows (its journal, else a new one's session), once the
 * layout saved with it says.
 * @param {Page} page @param {Locator} pane @returns {Promise<string>}
 */
async function shownConversation(page, pane) {
  let key = null;
  await expect.poll(async () => (key = ((p) => p?.sessionFile ?? p?.session ?? null)(await savedPane(page, pane)))).toBeTruthy();
  return /** @type {string} */ (/** @type {unknown} */ (key));
}

/** Starts omp in a new agent window (added through the palette), in `dir`. @param {Page} page @param {string} dir */
async function startedPane(page, dir) {
  const before = new Set(await page.locator('.widget[data-widget="omp"]').evaluateAll((nodes) => nodes.map((n) => /** @type {HTMLElement} */ (n).dataset.id)));
  await page.locator('#palette-toggle').click();
  await page.locator('#palette [data-type="omp"]').click();
  await page.keyboard.press('Escape');
  // The new window, wherever the layout put it.
  const id = await expect
    .poll(async () => (await page.locator('.widget[data-widget="omp"]').evaluateAll((nodes) => nodes.map((n) => /** @type {HTMLElement} */ (n).dataset.id))).find((i) => !before.has(i)))
    .toBeTruthy()
    .then(async () => (await page.locator('.widget[data-widget="omp"]').evaluateAll((nodes) => nodes.map((n) => /** @type {HTMLElement} */ (n).dataset.id))).find((i) => !before.has(i)));
  const pane = page.locator(`.widget[data-id="${id}"]`);
  await pane.locator('input').fill(dir);
  // Enter in the directory field starts it, as the button does.
  await pane.locator('input').press('Enter');
  await expect(pane.getByText('Fake Model')).toBeVisible();
  // Its journal is known as omp starts, and names it from then on.
  await expect.poll(async () => (await savedPane(page, pane))?.sessionFile ?? null).toBeTruthy();
  return pane;
}

/** @param {Page} page */
async function settle(page) {
  await page.evaluate(
    () => /** @type {Promise<void>} */ (new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))),
  );
}

/** Real pointer drag from a row to a point, holding the button there. @param {Page} page @param {Locator} from @param {{ x: number, y: number }} to */
async function dragTo(page, from, to) {
  await from.scrollIntoViewIfNeeded();
  const box = await from.boundingBox();
  if (!box) throw new Error('nothing to drag');
  await page.mouse.move(box.x + 40, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await settle(page);
}

/** Real pointer drag from a row to the grid's right edge. @param {Page} page @param {Locator} from */
async function dragToGridRight(page, from) {
  const grid = await page.locator('#grid').boundingBox();
  if (!grid) throw new Error('no grid');
  await dragTo(page, from, { x: grid.x + grid.width - 40, y: grid.y + grid.height / 2 });
}

/** The middle of a window. @param {Locator} window */
async function middleOf(window) {
  const box = await window.boundingBox();
  if (!box) throw new Error('window not laid out');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Sends `text` in agent window `pane` and waits for the reply. @param {Locator} pane @param {string} text */
async function turn(pane, text) {
  await pane.locator('textarea').fill(text);
  await pane.locator('textarea').press('Enter');
  await expect(pane.locator('.omp-assistant').last()).toContainText(`You said: ${text}`);
}

test('sessions are listed newest first, searchable across prompts and directories, and sortable', async ({ page }) => {
  const window = await addSessionsWindow(page);
  await expect(titles(window)).toHaveText(['Zebra cleanup', 'deploy staging', 'Fix the login flow']);
  // Separate words, not "2h ago2 prompts": what copy-paste and screen readers get.
  await expect(row(window, 'Fix the login flow').locator('.sessions-meta')).toHaveText(`${ALPHA} 2h ago 2 prompts`);

  const search = window.getByRole('searchbox', { name: 'Search sessions' });
  await search.fill('tests');
  await expect(titles(window)).toHaveText(['Fix the login flow'], { timeout: 3000 }); // a later prompt, not the title
  await search.fill(BRAVO.split('/').pop() ?? '');
  await expect(titles(window)).toHaveText(['deploy staging']);
  await search.fill('');
  await expect(titles(window)).toHaveCount(3);

  await window.getByRole('combobox', { name: 'Sort by' }).selectOption('title');
  await expect(titles(window)).toHaveText(['deploy staging', 'Fix the login flow', 'Zebra cleanup']);
  await window.getByRole('button', { name: 'Reverse sort order' }).click();
  await expect(titles(window)).toHaveText(['Zebra cleanup', 'Fix the login flow', 'deploy staging']);

  await search.fill('zebra');
  await expect(titles(window)).toHaveText(['Zebra cleanup']);
  await page.reload();
  const again = page.locator('.widget[data-widget="sessions"]');
  await expect(again.getByRole('searchbox', { name: 'Search sessions' })).toHaveValue('zebra');
  await expect(again.getByRole('combobox', { name: 'Sort by' })).toHaveValue('title');
  await expect(titles(again)).toHaveText(['Zebra cleanup']);
});

test('a question in plain words finds the conversation whose agent answered it, with the passage that did', async ({ page }) => {
  const window = await addSessionsWindow(page);
  const search = window.getByRole('searchbox', { name: 'Search sessions' });
  await search.fill('In which session did the sign-in loop restart because of a cookie?');
  await expect(titles(window)).toHaveText(['Fix the login flow']);
  const snippet = row(window, 'Fix the login flow').locator('.sessions-snippet');
  await expect(snippet).toHaveText('The session cookie expired before the redirect, so the sign-in loop restarted.');
  await expect(snippet.locator('mark')).toHaveText(['cookie', 'sign', 'loop', 'restarted']);
  // The list is by relevance while searching: the sort rests until the search is cleared.
  await expect(window.getByRole('combobox', { name: 'Sort by' })).toBeDisabled();
  await search.fill('');
  await expect(titles(window)).toHaveCount(3);
  await expect(window.locator('.sessions-snippet')).toHaveCount(0);
  await expect(window.getByRole('combobox', { name: 'Sort by' })).toBeEnabled();
});

test('⌘K floats a search over the workbench: a question finds the conversation, Enter shows it, Esc closes', async ({ page }) => {
  const spotlight = page.getByRole('dialog', { name: 'Search conversations' });
  const input = spotlight.getByRole('combobox', { name: 'Search conversations' });
  await page.keyboard.press('ControlOrMeta+k');
  await expect(spotlight).toBeVisible();
  await expect(input).toBeFocused();
  await expect(spotlight.getByRole('option').first()).toBeVisible(); // the latest, with nothing typed

  await input.fill('In which session did the sign-in loop restart because of a cookie?');
  const first = spotlight.getByRole('option').first();
  await expect(first.locator('.spotlight-title')).toHaveText('Fix the login flow');
  await expect(first.locator('.spotlight-snippet mark')).toHaveText(['cookie', 'sign', 'loop', 'restarted']);
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await input.press('Enter');
  await expect(spotlight).toBeHidden();
  const pane = page.locator('.widget[data-widget="omp"]');
  await expect(pane.locator('.omp-user').first()).toContainText('fix the login bug');

  // The top bar's Search opens it too; Esc closes it, leaving the workbench as it was.
  await page.getByRole('button', { name: /^Search/ }).click();
  await expect(spotlight).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(spotlight).toBeHidden();
  await expect(page.locator('.widget[data-widget="omp"]')).toHaveCount(1);
});

test('a session omp writes while the window is open shows up by itself', async ({ page }) => {
  const window = await addSessionsWindow(page);
  await expect(titles(window)).toHaveText(['Zebra cleanup', 'deploy staging', 'Fix the login flow']);
  writeJournal({ name: 'fresh', cwd: BRAVO, title: 'Fresh work', prompts: ['start fresh'], ageMs: 0 });
  await expect(titles(window)).toHaveText(['Fresh work', 'Zebra cleanup', 'deploy staging', 'Fix the login flow']);
});

test('a conversation dragged onto the grid shows in a new agent window without starting omp; dragged again, a second window shows it too', async ({ page }) => {
  const window = await addSessionsWindow(page);
  const deploy = row(window, 'deploy staging');
  await dragToGridRight(page, deploy);
  await expect(page.locator('.drop-indicator')).toHaveClass(/is-visible/);
  await expect(page.locator('.widget[data-widget="omp"]'), 'nothing is placed before the drop').toHaveCount(0);
  await page.mouse.up();

  const pane = page.locator('.widget[data-widget="omp"]');
  await expect(pane).toHaveCount(1);
  await expect(pane.locator('.omp-user .omp-md')).toHaveText(['deploy staging'], { useInnerText: true });
  expect(await awake(page, fileOf('deploy')), 'shown from its journal: no omp').toHaveLength(0);
  expect(await shownConversation(page, pane)).toBe(fileOf('deploy'));

  await dragToGridRight(page, deploy);
  await page.mouse.up();
  await expect(pane).toHaveCount(2);
  expect(await shownConversation(page, pane.nth(1))).toBe(fileOf('deploy'));

  // Sending from one wakes it once; the other window follows the same session.
  await turn(pane.nth(0), 'hello');
  await expect(pane.nth(1).locator('.omp-assistant').last()).toContainText('You said: hello');
  const live = await awake(page, fileOf('deploy'));
  expect(live).toHaveLength(1);
  expect(live[0].cwd).toBe(BRAVO);
  await expect(deploy, 'listed once, awake or not').toHaveCount(1);
});

test('a click shows a conversation in a new agent window when there is none, then in the last one used; Enter does the same', async ({ page }) => {
  const window = await addSessionsWindow(page);
  await row(window, 'Fix the login flow').click();
  const pane = page.locator('.widget[data-widget="omp"]');
  await expect(pane).toHaveCount(1);
  await expect(pane.locator('.omp-user .omp-md')).toHaveText(['fix the login bug', 'now add tests'], { useInnerText: true });
  expect(await shownConversation(page, pane)).toBe(fileOf('login'));

  await row(window, 'Zebra cleanup').focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => shownConversation(page, pane)).toBe(fileOf('zebra'));
  await expect(pane, 'shown in the window there is, not a new one').toHaveCount(1);
  await expect(pane.locator('.omp-user .omp-md')).toHaveText(['remove dead code'], { useInnerText: true });
  await expect(page.locator('.widget[data-widget="sessions"]'), 'the list stays').toHaveCount(1);
});

test('what is typed in a conversation waits there while the window shows another, and across a reload', async ({ page }) => {
  const window = await addSessionsWindow(page);
  await row(window, 'Fix the login flow').click();
  const pane = page.locator('.widget[data-widget="omp"]');
  const box = pane.locator('textarea');
  await box.fill('half a thought');
  await row(window, 'Zebra cleanup').click();
  await expect.poll(() => shownConversation(page, pane)).toBe(fileOf('zebra'));
  await expect(box, 'each conversation its own').toHaveValue('');
  await box.fill('another');

  await row(window, 'Fix the login flow').click();
  await expect.poll(() => shownConversation(page, pane)).toBe(fileOf('login'));
  await expect(box).toHaveValue('half a thought');
  await page.reload();
  await expect(box).toHaveValue('half a thought');

  // Sent, it is gone: nothing comes back after another reload.
  await box.press('Enter');
  await expect(pane.locator('.omp-user').last()).toContainText('half a thought');
  await expect(box).toHaveValue('');
  await page.reload();
  await expect(pane.locator('.omp-user').last()).toContainText('half a thought');
  await expect(box).toHaveValue('');
  await row(window, 'Zebra cleanup').click();
  await expect(box).toHaveValue('another');
});

test('a conversation whose directory is gone shows, and says so once something is sent', async ({ page }) => {
  const gone = join(tmpdir(), 'ac-e2e-gone-dir-that-does-not-exist');
  writeFileSync(
    fileOf('gone'),
    `${[{ type: 'session', version: 3, id: 'gone', timestamp: '2026-10-01T10:00:00.000Z', cwd: gone }, { type: 'message', message: { role: 'user', content: 'old work' } }].map((l) => JSON.stringify(l)).join('\n')}\n`,
  );
  const window = await addSessionsWindow(page);
  await row(window, 'old work').click();
  const pane = page.locator('.widget[data-widget="omp"]');
  await expect(pane.locator('.omp-user')).toContainText('old work');
  await pane.locator('textarea').fill('carry on');
  await pane.locator('textarea').press('Enter');
  await expect(pane.locator('.omp-note', { hasText: 'The agent did not start' })).toContainText('cwd is not an existing directory');
  await expect(pane.locator('textarea'), 'the message stays to send again').toHaveValue('carry on');
  // A failed request logs a console error in the browser; that is the expected outcome here.
  problems = problems.filter((p) => !p.includes('400'));
});

test('Archive hides a session from the list (and from omp), Archived lists it, and Restore puts it back', async ({ page }) => {
  mkdirSync(fileOf('zebra').replace(/\.jsonl$/, ''));
  writeFileSync(join(fileOf('zebra').replace(/\.jsonl$/, ''), 'Explorer.jsonl'), '');
  const window = await addSessionsWindow(page);
  await row(window, 'Zebra cleanup').getByRole('button', { name: 'Archive' }).click();
  await expect(titles(window)).toHaveText(['deploy staging', 'Fix the login flow']);
  expect(existsSync(fileOf('zebra')), 'gone from where omp resumes sessions').toBe(false);
  expect(existsSync(join(ARCHIVE, '-e2e-project', '2026-10-01_zebra', 'Explorer.jsonl')), 'kept, folder and all').toBe(true);

  const toggle = window.getByRole('button', { name: 'Archived' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(titles(window)).toHaveText(['Zebra cleanup']);
  await expect(window.locator('.sessions-status')).toHaveText('1 archived session');
  const archived = row(window, 'Zebra cleanup');
  await expect(archived.getByRole('button', { name: 'Archive' })).toHaveCount(0);
  await archived.dblclick();
  await settle(page);
  await expect(page.locator('.widget[data-widget="omp"]'), 'an archived session does not show').toHaveCount(0);

  await archived.getByRole('button', { name: 'Restore' }).click();
  await expect(window.locator('.sessions-status')).toHaveText('No archived sessions.');
  await toggle.click();
  await expect(titles(window)).toHaveText(['Zebra cleanup', 'deploy staging', 'Fix the login flow']);
  expect(existsSync(join(fileOf('zebra').replace(/\.jsonl$/, ''), 'Explorer.jsonl'))).toBe(true);
});

test('Archive does not drag the session out: pressed and moved onto the grid, it opens nothing', async ({ page }) => {
  const window = await addSessionsWindow(page);
  await row(window, 'Zebra cleanup').scrollIntoViewIfNeeded();
  const from = await row(window, 'Zebra cleanup').getByRole('button', { name: 'Archive' }).boundingBox();
  const grid = await page.locator('#grid').boundingBox();
  if (!from || !grid) throw new Error('nothing to drag');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(grid.x + 10, grid.y + grid.height / 2, { steps: 12 });
  await expect(page.locator('.drop-indicator')).not.toHaveClass(/is-visible/);
  await page.mouse.up();
  await settle(page);
  await expect(page.locator('.widget[data-widget="omp"]')).toHaveCount(0);
});

test('a conversation is listed once, awake or not, even with its window closed; archived while idle, its session goes to sleep', async ({ page }) => {
  const window = await addSessionsWindow(page);
  await row(window, 'deploy staging').click();
  const pane = page.locator('.widget[data-widget="omp"]');
  await turn(pane, 'hello');
  await pane.locator('.widget-close').click();
  await expect(pane).toHaveCount(0);

  const deploy = keyRow(window, fileOf('deploy'));
  await expect(deploy).toHaveCount(1);
  expect(await awake(page, fileOf('deploy'))).toHaveLength(1);
  const search = window.getByRole('searchbox', { name: 'Search sessions' });
  await search.fill('deploy');
  await expect(titles(window)).toHaveText([/deploy staging/], { timeout: 3000 }); // titled by omp since it woke
  await search.fill('login');
  await expect(titles(window)).toHaveText(['Fix the login flow'], { timeout: 3000 });
  await search.fill('');

  await deploy.getByRole('button', { name: 'Archive' }).click();
  await expect(titles(window)).toHaveText(['Zebra cleanup', 'Fix the login flow']);
  expect(await awake(page, fileOf('deploy')), 'asleep before its journal moved').toHaveLength(0);
});

test('a conversation running a background job says so while it runs', async ({ page }) => {
  const window = await addSessionsWindow(page);
  await window.getByRole('combobox', { name: 'Directory' }).selectOption(ALPHA); // only this test's sessions
  const pane = await startedPane(page, ALPHA);
  const fresh = keyRow(window, await shownConversation(page, pane));
  await pane.locator('textarea').fill('background'); // a backgrounded shell, its result 2 s later
  await pane.locator('textarea').press('Enter');
  await expect(fresh.locator('.sessions-state')).toHaveText('1 running');
  await expect(fresh.locator('.sessions-state')).toHaveCount(0);
});

test('a new session nothing was sent to is archived by ending it: gone from the list, and not among the archived', async ({ page }) => {
  const window = await addSessionsWindow(page);
  await window.getByRole('combobox', { name: 'Directory' }).selectOption(ALPHA); // only this test's sessions
  const pane = await startedPane(page, ALPHA);
  const fresh = keyRow(window, await shownConversation(page, pane));
  await expect(fresh.locator('.sessions-title')).toHaveText('New session');
  await fresh.getByRole('button', { name: 'Archive' }).click();
  await expect(fresh).toHaveCount(0);
  await window.getByRole('button', { name: 'Archived' }).click();
  await expect(window.locator('.sessions-title', { hasText: 'New session' })).toHaveCount(0);
});

test('awake conversations are listed with how each is doing; a click shows one in the agent window used last', async ({ page }) => {
  const window = await addSessionsWindow(page);
  await window.getByRole('combobox', { name: 'Directory' }).selectOption(ALPHA); // only this test's sessions
  await row(window, 'Fix the login flow').click();
  const first = page.locator('.widget[data-widget="omp"]').first();
  await expect(first.locator('.omp-user').first()).toContainText('fix the login bug');
  const second = await startedPane(page, ALPHA);
  const fresh = await shownConversation(page, second);
  const freshRow = keyRow(window, fresh);
  await expect(freshRow.locator('.sessions-title')).toHaveText('New session');
  // Ready, as the session is: never left showing as starting.
  await expect(freshRow).toHaveClass(/is-idle/);
  await expect(freshRow.locator('.sessions-state'), 'idle needs no word').toHaveCount(0);
  await expect(keyRow(window, fileOf('login')), 'asleep: no state at all').not.toHaveClass(/is-(idle|working|done|asking|starting)/);

  // Working while a turn runs; done (and unread) once it ends unread; idle again once looked at.
  await page.mouse.move(5, 5); // the top bar: no window is being looked at
  await second.locator('textarea').fill('slow');
  await second.locator('textarea').press('Enter');
  await expect(freshRow.locator('.sessions-state')).toHaveText('working');
  await expect(freshRow.locator('.sessions-title'), 'titled while the turn runs').toHaveText('About slow');
  await expect(freshRow).toHaveClass(/is-done/, { timeout: 5000 });
  await expect(freshRow).toHaveClass(/is-unread/);
  const { x, y } = await middleOf(second);
  await page.mouse.move(x, y);
  await expect(freshRow).toHaveClass(/is-idle/);

  // The second window was used last: a click shows the conversation there; its own carries on.
  await keyRow(window, fileOf('login')).click();
  await expect.poll(() => shownConversation(page, second)).toBe(fileOf('login'));
  await expect(second.locator('.omp-user').first()).toContainText('fix the login bug');
  expect(await shownConversation(page, first)).toBe(fileOf('login'));
  await expect(freshRow).toBeVisible();
});

test('a session dragged onto the middle of an agent window is shown there', async ({ page }) => {
  const window = await addSessionsWindow(page);
  const target = await startedPane(page, ALPHA);
  const before = await shownConversation(page, target);
  await dragTo(page, row(window, 'Zebra cleanup'), await middleOf(target));
  await expect(page.locator('.drop-indicator')).toHaveClass(/is-visible/);
  await expect(page.locator('.drop-indicator')).toContainText('Show here');
  await page.mouse.up();
  await expect(page.locator('.widget[data-widget="omp"]'), 'no window added').toHaveCount(1);
  await expect(target.locator('.omp-user')).toContainText('remove dead code');
  await expect.poll(() => shownConversation(page, target)).toBe(fileOf('zebra'));

  // An awake one too: the window goes back to the conversation it showed first.
  await dragTo(page, keyRow(window, before), await middleOf(target));
  await page.mouse.up();
  await expect.poll(() => shownConversation(page, target)).toBe(before);
  await expect(page.locator('.widget[data-widget="omp"]')).toHaveCount(1);
});

test('the directory menu narrows the list to one directory, with search, sort and the archive, and is kept per window', async ({ page }) => {
  const window = await addSessionsWindow(page);
  const menu = window.getByRole('combobox', { name: 'Directory' });
  await expect(menu.locator('option')).toHaveText(['All directories', `${ALPHA} (2)`, `${BRAVO} (1)`]);
  await expect(menu).toHaveValue('');

  await menu.selectOption(ALPHA);
  await expect(titles(window)).toHaveText(['Zebra cleanup', 'Fix the login flow']);
  await window.getByRole('combobox', { name: 'Sort by' }).selectOption('title');
  await expect(titles(window)).toHaveText(['Fix the login flow', 'Zebra cleanup']);
  await window.getByRole('searchbox', { name: 'Search sessions' }).fill('tests');
  await expect(titles(window)).toHaveText(['Fix the login flow'], { timeout: 3000 });
  await window.getByRole('searchbox', { name: 'Search sessions' }).fill('deploy');
  await expect(window.locator('.sessions-status')).toHaveText('No session matches.');
  await expect(menu, 'the choice stays while nothing there matches').toHaveValue(ALPHA);
  await window.getByRole('searchbox', { name: 'Search sessions' }).fill('');

  await row(window, 'Zebra cleanup').getByRole('button', { name: 'Archive' }).click();
  await expect(titles(window)).toHaveText(['Fix the login flow']);
  await window.getByRole('button', { name: 'Archived' }).click();
  await expect(titles(window)).toHaveText(['Zebra cleanup']);
  await expect(menu.locator('option')).toHaveText(['All directories', `${ALPHA} (1)`]);
  await window.getByRole('button', { name: 'Archived' }).click();

  // A second Sessions window starts on all directories and keeps a choice of its own.
  const id = await window.getAttribute('data-id');
  const first = page.locator(`.widget[data-id="${id}"]`);
  await page.locator('#palette-toggle').click();
  await page.locator('#palette [data-type="sessions"]').click();
  await page.keyboard.press('Escape');
  const other = page.locator(`.widget[data-widget="sessions"]:not([data-id="${id}"])`);
  await expect(other).toHaveCount(1);
  await expect(other.getByRole('combobox', { name: 'Directory' })).toHaveValue('');
  await other.getByRole('combobox', { name: 'Directory' }).selectOption(BRAVO);
  await expect(titles(other)).toHaveText(['deploy staging']);
  await expect(titles(first)).toHaveText(['Fix the login flow']);

  await page.reload();
  await expect(first.getByRole('combobox', { name: 'Directory' })).toHaveValue(ALPHA);
  await expect(titles(first)).toHaveText(['Fix the login flow']);
  await expect(other.getByRole('combobox', { name: 'Directory' })).toHaveValue(BRAVO);
  await expect(titles(other)).toHaveText(['deploy staging']);
});

/** A finished turn in `pane`, sent from the keyboard while the pointer is on the top bar, outside every window. @param {Page} page @param {Locator} pane @param {string} text */
async function turnWhileAway(page, pane, text) {
  await page.mouse.move(5, 5);
  await pane.locator('textarea').fill(text);
  await pane.locator('textarea').press('Enter');
  await expect(pane.locator('.omp-assistant').last()).toContainText(text);
}

/** Puts the sessions holding `file` to sleep, as the daemon does once they are idle and unused. @param {Page} page @param {string} file */
async function sleep(page, file) {
  for (const s of await awake(page, file)) await page.evaluate((id) => fetch(`/api/sessions/${id}`, { method: 'DELETE' }).then(() => {}), s.id);
  await expect.poll(async () => (await awake(page, file)).length).toBe(0);
}

test('a turn that ends while nobody looks stays unread, across reloads and asleep, until it is read', async ({ page }) => {
  const window = await addSessionsWindow(page);
  await window.getByRole('combobox', { name: 'Directory' }).selectOption(BRAVO); // only this test's sessions
  await row(window, 'deploy staging').click();
  const pane = page.locator('.widget[data-widget="omp"]');
  await expect(window.locator('.widget-label')).toBeHidden();

  await turnWhileAway(page, pane, 'hello');
  const deploy = keyRow(window, fileOf('deploy'));
  await expect(deploy).toHaveClass(/is-unread/);
  await expect(deploy).toHaveClass(/is-done/);
  await expect(deploy.getByRole('img', { name: 'Unread' })).toBeVisible();
  await expect(window.locator('.widget-label')).toHaveText('1 unread');
  await expect(pane).toHaveClass(/is-unread/);

  await page.reload();
  await expect(deploy).toHaveClass(/is-unread/);
  await expect(pane).toHaveClass(/is-unread/);

  // Asleep, still unread: blue dot, bold title, in its window too.
  await sleep(page, fileOf('deploy'));
  await expect(deploy).not.toHaveClass(/is-done/);
  await expect(deploy).toHaveClass(/is-unread/);
  await expect(deploy.locator('.sessions-title')).toHaveCSS('font-weight', '600');
  await expect(window.locator('.widget-label')).toHaveText('1 unread');
  await page.reload();
  await expect(deploy).toHaveClass(/is-unread/);
  await expect(pane).toHaveClass(/is-unread/);

  // Archived, it keeps the mark; restored, it still has it.
  await deploy.getByRole('button', { name: 'Archive' }).click();
  await window.getByRole('button', { name: 'Archived' }).click();
  const archived = row(window, 'deploy staging');
  await expect(archived).toHaveClass(/is-unread/);
  await archived.getByRole('button', { name: 'Restore' }).click();
  await window.getByRole('button', { name: 'Archived' }).click();
  await expect(deploy).toHaveClass(/is-unread/);

  // Showing it from Sessions reads it.
  await deploy.click();
  await expect(deploy).not.toHaveClass(/is-unread/);
  await expect(pane).not.toHaveClass(/is-unread/);
  await expect(window.locator('.widget-label')).toBeHidden();
});

test('reading a session in its agent window clears its mark in Sessions', async ({ page }) => {
  const window = await addSessionsWindow(page);
  await row(window, 'deploy staging').click();
  const pane = page.locator('.widget[data-widget="omp"]');
  const deploy = keyRow(window, fileOf('deploy'));
  await turnWhileAway(page, pane, 'hello');
  await expect(deploy).toHaveClass(/is-unread/);
  const { x, y } = await middleOf(pane);
  await page.mouse.move(x, y);
  await expect(pane).not.toHaveClass(/is-unread/);
  await expect(deploy).not.toHaveClass(/is-unread/);
  await expect(deploy).toHaveClass(/is-idle/);
  await page.reload();
  await expect(deploy).toBeVisible();
  await expect(deploy).not.toHaveClass(/is-unread/);
});

test('a row’s menu, from a right-click or its ⋯ button, marks a session read or unread beside its other actions', async ({ page }) => {
  const window = await addSessionsWindow(page);
  await window.getByRole('combobox', { name: 'Directory' }).selectOption(ALPHA); // only this test's sessions
  const menu = page.getByRole('menu');
  const zebra = row(window, 'Zebra cleanup');
  await zebra.click({ button: 'right' });
  await expect(menu.getByRole('menuitem')).toHaveText(['Show', 'Mark as unread', 'Pin to top', 'Archive']);
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await menu.getByRole('menuitem', { name: 'Mark as unread' }).click();
  await expect(menu).toHaveCount(0);
  await expect(zebra).toHaveClass(/is-unread/);
  await expect(window.locator('.widget-label')).toHaveText('1 unread');

  await zebra.hover();
  await zebra.getByRole('button', { name: 'More actions' }).click();
  await expect(menu.getByRole('menuitem')).toHaveText(['Show', 'Mark as read', 'Pin to top', 'Archive']);
  await menu.getByRole('menuitem', { name: 'Mark as read' }).click();
  await expect(zebra).not.toHaveClass(/is-unread/);

  // The menu's Archive is the row's.
  await zebra.click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Archive' }).click();
  await expect(titles(window)).toHaveText(['Fix the login flow']);
  await window.getByRole('button', { name: 'Archived' }).click();
  await zebra.click({ button: 'right' });
  await expect(menu.getByRole('menuitem')).toHaveText(['Mark as unread', 'Pin to top', 'Restore']);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
});

test('a row’s actions float over its end when pointed at, taking none of its text’s width otherwise', async ({ page }) => {
  const window = await addSessionsWindow(page);
  const zebra = row(window, 'Zebra cleanup');
  const width = async (/** @type {Locator} */ at) => /** @type {{ width: number }} */ (await at.boundingBox()).width;
  await page.mouse.move(0, 0);
  const text = await width(zebra.locator('.sessions-main'));
  expect(text, 'the text runs to the row’s end').toBeGreaterThan((await width(zebra)) - 40);
  await zebra.hover();
  await expect(zebra.getByRole('button', { name: 'Archive' })).toBeVisible();
  expect(await width(zebra.locator('.sessions-main')), 'pointing at the row moves nothing').toBe(text);
});

test('a pinned session is listed first, whatever the sort, in every window and across a reload, until it is unpinned', async ({ page }) => {
  const window = await addSessionsWindow(page);
  await expect(titles(window)).toHaveText(['Zebra cleanup', 'deploy staging', 'Fix the login flow']);
  const fix = row(window, 'Fix the login flow');
  await expect(fix.getByRole('button', { name: 'Pin to top' })).toHaveCSS('opacity', '0');
  await fix.hover();
  await fix.getByRole('button', { name: 'Pin to top' }).click();
  await expect(titles(window)).toHaveText(['Fix the login flow', 'Zebra cleanup', 'deploy staging']);
  await expect(fix).toHaveClass(/is-pinned/);
  await expect(fix.getByRole('button', { name: 'Pin to top' })).toHaveAttribute('aria-pressed', 'true');

  // Pinned ones keep the window's order among themselves, before the rest.
  await row(window, 'deploy staging').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Pin to top' }).click();
  await expect(titles(window)).toHaveText(['deploy staging', 'Fix the login flow', 'Zebra cleanup']);
  await window.getByRole('combobox', { name: 'Sort by' }).selectOption('title');
  await expect(titles(window)).toHaveText(['deploy staging', 'Fix the login flow', 'Zebra cleanup']);
  await window.getByRole('button', { name: 'Reverse sort order' }).click();
  await expect(titles(window)).toHaveText(['Fix the login flow', 'deploy staging', 'Zebra cleanup']);

  await page.reload();
  const again = page.locator('.widget[data-widget="sessions"]');
  await expect(titles(again)).toHaveText(['Fix the login flow', 'deploy staging', 'Zebra cleanup']);
  await row(again, 'Fix the login flow').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Unpin' }).click();
  await expect(titles(again)).toHaveText(['deploy staging', 'Zebra cleanup', 'Fix the login flow']);
});

test('from the keyboard, Shift+F10 opens a row’s menu; Mark as unread lights its window, which the pointer resting there does not clear', async ({ page }) => {
  const window = await addSessionsWindow(page);
  await row(window, 'Zebra cleanup').click();
  const pane = page.locator('.widget[data-widget="omp"]');
  const zebra = keyRow(window, fileOf('zebra'));
  await expect(pane.locator('.omp-user')).toContainText('remove dead code');
  const { x, y } = await middleOf(pane);
  await page.mouse.move(x, y); // looking at the window

  const menu = page.getByRole('menu');
  await zebra.focus();
  await page.keyboard.press('Shift+F10');
  await expect(menu.getByRole('menuitem')).toHaveText(['Show', 'Mark as unread', 'Pin to top', 'Archive']);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(zebra, 'Esc gives focus back to the row').toBeFocused();

  await page.keyboard.press('ContextMenu');
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Mark as unread' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(zebra).toHaveClass(/is-unread/);
  await expect(zebra, 'focus is back on the row').toBeFocused();
  await expect(pane).toHaveClass(/is-unread/);
  // The pointer has been resting on the window all along: that is not reading the mark.
  await settle(page);
  await expect(pane).toHaveClass(/is-unread/);
  await expect(zebra).toHaveClass(/is-unread/);
  // Moving it there again is.
  await page.mouse.move(x + 10, y + 10);
  await expect(pane).not.toHaveClass(/is-unread/);
  await expect(zebra).not.toHaveClass(/is-unread/);
});

test('rows mark the sessions shown in agent windows, the last-used one brighter; pointing links rows and windows both ways', async ({ page }) => {
  const window = await addSessionsWindow(page);
  // Only this test's directory: Sessions lists every conversation, newest first, and those
  // other test files start meanwhile would push these rows out from under the pointer.
  await window.getByRole('combobox', { name: 'Directory' }).selectOption(ALPHA);
  const first = await startedPane(page, ALPHA);
  const second = await startedPane(page, ALPHA);
  const [a, b] = [keyRow(window, await shownConversation(page, first)), keyRow(window, await shownConversation(page, second))];
  await expect(a).toHaveClass(/is-shown/);
  await expect(b).toHaveClass(/is-shown/);

  // The brighter mark follows the agent window used last: where a click in Sessions shows a session.
  await first.locator('.omp-transcript').click();
  await expect(a).toHaveClass(/is-current/);
  await expect(b).not.toHaveClass(/is-current/);
  await second.locator('.omp-transcript').click();
  await expect(b).toHaveClass(/is-current/);
  await expect(a).not.toHaveClass(/is-current/);

  // Pointing at a row outlines its window, and only while pointed at.
  await a.locator('.sessions-title').hover();
  await expect(first).toHaveClass(/is-outlined/);
  await expect(second).not.toHaveClass(/is-outlined/);
  await page.mouse.move(5, 5); // the top bar
  await expect(first).not.toHaveClass(/is-outlined/);

  // Straight from one row to the next: the outline moves with the pointer.
  await a.locator('.sessions-title').hover();
  await b.locator('.sessions-title').hover();
  await expect(second).toHaveClass(/is-outlined/);
  await expect(first).not.toHaveClass(/is-outlined/);

  // A click focuses its row too; that focus does not keep the outline once the pointer leaves.
  await b.locator('.sessions-title').click();
  await expect(b).toBeFocused();
  await page.mouse.move(5, 5);
  await expect(second).not.toHaveClass(/is-outlined/);

  // A row redrawn under the pointer (its session starts working) keeps the outline while
  // pointed at, and lets go of it as the pointer leaves.
  await a.locator('.sessions-title').hover();
  await first.locator('textarea').evaluate((node) => {
    const area = /** @type {HTMLTextAreaElement} */ (node);
    area.value = 'slow';
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
  await expect(a.locator('.sessions-state')).toHaveText('working');
  await expect(first).toHaveClass(/is-outlined/);
  await page.mouse.move(5, 5);
  await expect(first).not.toHaveClass(/is-outlined/);

  // Pointing at an agent window lights its conversation's row.
  await first.locator('.omp-transcript').hover();
  await expect(a).toHaveClass(/is-pointed/);
  await expect(b).not.toHaveClass(/is-pointed/);

  // A window that stops showing it takes the mark away.
  await second.locator('.widget-close').click();
  await expect(b).not.toHaveClass(/is-shown/);
});

test('a rewind moves the conversation onto a new journal: the window and its row follow it, and the old one is archived', async ({ page }) => {
  const window = await addSessionsWindow(page);
  await window.getByRole('combobox', { name: 'Directory' }).selectOption(ALPHA); // only this test's sessions
  await row(window, 'Zebra cleanup').click();
  const pane = page.locator('.widget[data-widget="omp"]');
  await turn(pane, 'first question');
  await turn(pane, 'second question');

  await pane.locator('.omp-user', { hasText: 'second question' }).hover();
  await pane.locator('.omp-user', { hasText: 'second question' }).getByRole('button', { name: 'Rewind' }).click();
  await pane.locator('textarea').fill('second question, reworded');
  await pane.locator('textarea').press('Enter');
  await expect(pane.locator('.omp-assistant').last()).toContainText('You said: second question, reworded');

  // omp goes on in a new journal beside the old one; the window names the conversation by it.
  await expect.poll(() => shownConversation(page, pane)).not.toBe(fileOf('zebra'));
  const moved = await shownConversation(page, pane);
  expect(moved.startsWith(join(E2E_OMP_SESSIONS, '-e2e-project'))).toBe(true);
  await expect(keyRow(window, moved)).toHaveClass(/is-shown/);
  await expect(keyRow(window, moved).locator('.sessions-title')).toHaveText('Zebra cleanup');
  // The journal before the rewind keeps what was set aside, archived: listed there, not here.
  await expect(keyRow(window, fileOf('zebra'))).toHaveCount(0);
  expect(existsSync(join(ARCHIVE, '-e2e-project', '2026-10-01_zebra.jsonl'))).toBe(true);
  await window.getByRole('button', { name: 'Archived' }).click();
  await expect(titles(window)).toHaveText(['Zebra cleanup']);
});
