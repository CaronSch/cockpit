// Behaviour tests for the Timeline window: conversations by how recently they were active, the
// prompts agents scheduled where they run, opening either by dragging it out, archiving and
// deleting by dropping it on the bin, editing a scheduled prompt in place, and a prompt missed
// while the daemon was off. Against a daemon of the spec's own (startDaemon), with journals and
// scheduled prompts laid out before it starts, so no other spec's conversations are listed.
import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort, newWorkspace, startDaemon } from './daemon.js';

/** @typedef {import('@playwright/test').Page} Page */
/** @typedef {import('@playwright/test').Locator} Locator */

test.use({ viewport: { width: 1280, height: 800 }, contextOptions: { reducedMotion: 'reduce' } });

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ROOT = mkdtempSync(join(tmpdir(), 'ac-e2e-timeline-'));
const SESSIONS = join(ROOT, 'sessions');
const STATE = join(ROOT, 'state');
const CWD = join(ROOT, 'work');
/** @param {string} name */
const fileOf = (name) => join(SESSIONS, '-timeline', `2026-11-01_${name}.jsonl`);

/** Past conversations, by how long ago they were last active. */
const JOURNALS = [
  { name: 'old', title: 'Old experiment to archive', ageMs: 30 * HOUR },
  { name: 'renderer', title: 'Refactor the markdown renderer', ageMs: 5 * HOUR },
  { name: 'flaky', title: 'Investigate the flaky e2e tests', ageMs: 2 * HOUR },
  { name: 'phone', title: 'Write the phone access spec', ageMs: 40 * MINUTE },
  { name: 'deploy', title: 'Deploy staging and watch it', ageMs: 5 * MINUTE },
];

/** @type {Awaited<ReturnType<typeof startDaemon>>} */
let daemon;
/** When the daemon started: the missed prompt was due two hours before. */
let startedAt = 0;
/** @type {string[]} */
let problems = [];

test.beforeAll(async () => {
  mkdirSync(join(SESSIONS, '-timeline'), { recursive: true });
  mkdirSync(STATE, { recursive: true });
  mkdirSync(CWD, { recursive: true });
  for (const j of JOURNALS) {
    const lines = [
      { type: 'title', v: 1, title: j.title, source: 'auto' },
      { type: 'session', version: 3, id: `tl-${j.name}`, timestamp: '2026-11-01T10:00:00.000Z', cwd: CWD },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: j.title }] } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] } },
    ];
    writeFileSync(fileOf(j.name), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    const at = new Date(Date.now() - j.ageMs);
    utimesSync(fileOf(j.name), at, at);
  }
  startedAt = Date.now();
  /** @param {string} id @param {string} name @param {number} dueAt @param {string} prompt */
  const task = (id, name, dueAt, prompt) => ({ id, target: { sessionFile: fileOf(name), session: null, cwd: CWD }, prompt, dueAt, createdAt: startedAt - 3 * HOUR, missedAt: null, error: null });
  writeFileSync(
    join(STATE, 'schedule.json'),
    JSON.stringify({
      version: 1,
      tasks: [
        task('soon', 'deploy', startedAt + 2 * HOUR, 'Check that the staging rollout finished.'),
        task('later', 'renderer', startedAt + 26 * HOUR, 'Read the review comments on the renderer PR.'),
        task('missed', 'flaky', startedAt - 2 * HOUR, 'Look at the flaky test dashboard again.'),
      ],
    }),
  );
  daemon = await startDaemon({ port: await freePort(), stateDir: STATE, sessionsDir: SESSIONS });
});

test.afterAll(async () => {
  await daemon?.stop();
});

test.beforeEach(async ({ page }) => {
  problems = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`);
  });
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.goto(daemon.url(newWorkspace()));
  await expect(page.locator('.screen-switch')).toBeVisible();
  await page.locator('#palette-toggle').click();
  await page.locator('#palette [data-type="timeline"]').click();
  await page.keyboard.press('Escape');
  await expect(past(page, 'deploy')).toBeVisible();
});

test.afterEach(() => {
  expect(problems, 'page errors / console errors during the test').toEqual([]);
});

/** A past conversation's label. @param {Page} page @param {string} name */
const past = (page, name) => page.locator(`.timeline-chip.is-past[data-name="${/** @type {any} */ (JOURNALS.find((j) => j.name === name)).title}"]`);
/** A scheduled prompt's label, by its conversation. @param {Page} page @param {string} name */
const future = (page, name) => page.locator(`.timeline-chip.is-future[data-name="${/** @type {any} */ (JOURNALS.find((j) => j.name === name)).title}"]`);
/** @param {Page} page */
const agentWindows = (page) => page.locator('.widget[data-widget="omp"]');
/** The daemon's scheduled prompts, as its file keeps them. @returns {any[]} */
const readSchedule = () => JSON.parse(readFileSync(join(STATE, 'schedule.json'), 'utf8')).tasks;

/**
 * Presses on `from` and moves the pointer far enough for the drag to be on; then on to the
 * point `to` gives (asked once the drag is on: the bin only shows then), holding the button.
 * @param {Page} page @param {Locator} from @param {() => Promise<{ x: number, y: number }>} to
 */
async function drag(page, from, to) {
  await from.scrollIntoViewIfNeeded();
  const box = await from.boundingBox();
  if (!box) throw new Error('nothing to drag');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2 - 12, { steps: 3 });
  const point = await to();
  await page.mouse.move(point.x, point.y, { steps: 10 });
}

/** The middle of the bin, once it shows. @param {Page} page */
async function bin(page) {
  const shown = page.locator('.timeline-bin.is-drop-armed');
  await expect(shown).toBeVisible();
  const box = /** @type {NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>} */ (await shown.boundingBox());
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Near the grid's right edge: dropped there, a new window opens on the right. @param {Page} page */
async function gridRight(page) {
  const grid = /** @type {NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>} */ (await page.locator('#grid').boundingBox());
  return { x: grid.x + grid.width - 30, y: grid.y + grid.height / 2 };
}

test('the past lists conversations by when they were last active, the latest beside now; pointing at one shows its whole name', async ({ page }) => {
  const names = await page.locator('.timeline-chip.is-past').evaluateAll((chips) => chips.map((c) => /** @type {HTMLElement} */ (c).dataset.name));
  expect(names).toEqual(JOURNALS.map((j) => j.title));
  // Only the start of a name shows…
  const label = past(page, 'phone').locator('.timeline-name');
  expect(await label.evaluate((n) => n.scrollWidth > n.clientWidth)).toBe(true);
  // …and the whole of it over the label pointed at.
  await past(page, 'phone').hover();
  await expect(page.locator('.timeline-face')).toHaveText('Write the phone access spec');
  // The latest is beside now: in view, at the past's right end.
  const deploy = /** @type {any} */ (await past(page, 'deploy').boundingBox());
  const now = /** @type {any} */ (await page.locator('.timeline-now').boundingBox());
  expect(now.x - (deploy.x + deploy.width)).toBeLessThan(20);
});

test('a past label dragged onto the grid opens its conversation there; dropped on Archive, it is archived and leaves the timeline', async ({ page }) => {
  await drag(page, past(page, 'renderer'), () => gridRight(page));
  await page.mouse.up();
  await expect(agentWindows(page)).toHaveCount(1);
  await expect(agentWindows(page).locator('.widget-label')).toHaveText('Refactor the markdown renderer');

  await drag(page, past(page, 'old'), () => bin(page));
  await expect(page.locator('.timeline-bin')).toHaveText('Archive');
  await expect(page.locator('.timeline-bin')).toHaveClass(/is-drop-over/);
  await page.mouse.up();
  await expect(past(page, 'old')).toHaveCount(0);
  expect(existsSync(fileOf('old'))).toBe(false);
  expect(existsSync(join(STATE, 'archive', 'sessions', '-timeline', '2026-11-01_old.jsonl'))).toBe(true);
  await expect(agentWindows(page), 'nothing opened').toHaveCount(1);
});

test('scheduled prompts show where they run, soonest nearest now; one missed while the daemon was off is marked and moved ten minutes on', async ({ page }) => {
  await expect(future(page, 'deploy')).toBeVisible();
  const x = async (/** @type {string} */ name) => /** @type {any} */ (await future(page, name).locator('.timeline-stem').boundingBox()).x;
  const [missed, soon, later] = [await x('flaky'), await x('deploy'), await x('renderer')];
  expect(missed).toBeLessThan(soon);
  expect(soon).toBeLessThan(later);
  await expect(future(page, 'flaky')).toHaveClass(/is-missed/);
  await expect(future(page, 'flaky').locator('.timeline-when')).toContainText('missed');
  const kept = (await readSchedule()).find((t) => t.id === 'missed');
  expect(kept.missedAt).toBe(startedAt - 2 * HOUR);
  expect(kept.dueAt - Date.now()).toBeGreaterThan(5 * MINUTE);
  expect(kept.dueAt - Date.now()).toBeLessThanOrEqual(10 * MINUTE);
});

test('a click on a scheduled prompt edits its prompt and its time in place', async ({ page }) => {
  await future(page, 'renderer').click();
  const editor = page.locator('.timeline-editor');
  await expect(editor).toBeVisible();
  await expect(editor.locator('textarea')).toHaveValue('Read the review comments on the renderer PR.');
  await editor.locator('textarea').fill('Merge the renderer PR if it is approved.');
  const when = new Date(Date.now() + 3 * 24 * HOUR);
  when.setHours(9, 30, 0, 0);
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  await editor.locator('input[type="datetime-local"]').fill(`${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T09:30`);
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(editor).toBeHidden();
  await expect.poll(async () => (await readSchedule()).find((t) => t.id === 'later')).toMatchObject({ prompt: 'Merge the renderer PR if it is approved.', dueAt: when.getTime() });
  await expect(future(page, 'renderer')).toHaveAttribute('title', /Merge the renderer PR/);
});

test('an agent schedules a prompt from its window; its label opens the conversation, and dropped on Delete the prompt is gone', async ({ page }) => {
  // A click shows the conversation; with no agent window yet, it opens one.
  await past(page, 'phone').click();
  const pane = agentWindows(page);
  await expect(pane).toHaveCount(1);
  await pane.locator('textarea').first().fill('schedule {"op":"add","in":"3h","prompt":"Ask for a review of the phone spec."}');
  await pane.locator('textarea').first().press('Enter');
  await expect(future(page, 'phone')).toBeVisible();
  await expect(page.locator('.widget[data-widget="timeline"] .widget-label')).toHaveText('4 scheduled');

  await drag(page, future(page, 'phone'), () => gridRight(page));
  await page.mouse.up();
  await expect(agentWindows(page)).toHaveCount(2);
  await expect(agentWindows(page).nth(1).locator('.widget-label')).toHaveText('Write the phone access spec');

  await drag(page, future(page, 'phone'), () => bin(page));
  await expect(page.locator('.timeline-bin')).toHaveText('Delete');
  await page.mouse.up();
  await expect(future(page, 'phone')).toHaveCount(0);
  await expect.poll(async () => (await readSchedule()).some((t) => t.target.sessionFile === fileOf('phone'))).toBe(false);
  await expect(agentWindows(page), 'nothing more opened').toHaveCount(2);
  await expect(past(page, 'phone'), 'the conversation stays').toBeVisible();
});
