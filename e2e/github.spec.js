// Behaviour tests for pull requests in the workbench (the pull request window, # suggestions,
// Bugbot) against the real daemon driving tests/fixtures/fake-omp.js and tests/fixtures/fake-gh.js.
import { test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { E2E_GH_ROOT, newWorkspace, workbenchPath } from './daemon.js';

/** @typedef {import('@playwright/test').Page} Page */
/** @typedef {import('@playwright/test').Locator} Locator */

test.use({ viewport: { width: 1400, height: 900 }, contextOptions: { reducedMotion: 'reduce' } });

const FINDING = [
  '### Answer is hard-coded',
  '',
  '**Medium Severity**',
  '',
  '<!-- DESCRIPTION START -->',
  'The answer never changes, whatever is asked.',
  '<!-- DESCRIPTION END -->',
  '',
  '<!-- LOCATIONS START',
  'src/app.js#L2',
  'LOCATIONS END -->',
].join('\n');

/**
 * A new checkout of a repository `<owner>/widgets` (or `<owner>/<name>`) with two pull requests
 * (or `pulls`), as the fake gh reads it, both there and named outright. The owner is a new one
 * per test unless given, so its repositories are that test's alone.
 * @param {{ pulls?: any[], owner?: string, name?: string }} [options]
 */
function newRepo({ pulls, owner = `acme-${randomUUID().slice(0, 8)}`, name = 'widgets' } = {}) {
  const dir = join(E2E_GH_ROOT, owner, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, '.fake-gh.json'),
    JSON.stringify({
      repo: repoOf(dir),
      pulls: pulls ?? [
        {
          number: 12,
          title: 'feat: pull request window',
          state: 'OPEN',
          isDraft: false,
          author: 'octo',
          headRefName: 'feat/pr-window',
          baseRefName: 'main',
          body: 'Adds a pull request window beside the agent.',
          createdAt: '2026-11-01T09:00:00Z',
          updatedAt: '2026-11-02T09:00:00Z',
          additions: 2,
          deletions: 1,
          comments: [],
          reviews: [],
          diff: 'diff --git a/src/app.js b/src/app.js\n--- a/src/app.js\n+++ b/src/app.js\n@@ -1,2 +1,3 @@\n const greeting = 1;\n-const answer = 41;\n+const answer = 42;\n+const question = 6;\n',
          reviewComments: [{ id: 9, user: { login: 'hubot' }, body: 'Why **42**?', path: 'src/app.js', line: 2, start_line: null, side: 'RIGHT', in_reply_to_id: null, created_at: '2026-11-01T11:00:00Z', html_url: 'u' }],
        },
        { number: 7, title: 'docs: readme', state: 'MERGED', isDraft: false, author: 'octo', headRefName: 'docs', baseRefName: 'main', body: '', updatedAt: '' },
      ],
      bugbot: { afterMs: 400, body: '<!-- BUGBOT_REVIEW -->\nCursor Bugbot has reviewed your changes and found 1 potential issue.', comments: [{ body: FINDING, path: 'src/app.js', line: 2, start_line: null }] },
    }),
  );
  return dir;
}

/** The repository a checkout made by `newRepo` is, as `owner/name`. @param {string} dir */
const repoOf = (dir) => `${basename(dirname(dir))}/${basename(dir)}`;

/** @type {string[]} */
let problems = [];

/** @param {Page} page */
async function openWorkbench(page) {
  problems = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`);
  });
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.goto(workbenchPath(newWorkspace()));
  await expect(page.locator('.screen-switch')).toBeVisible();
}

test.afterEach(() => {
  expect(problems, 'page errors / console errors during the test').toEqual([]);
});

/** Starts an agent in `dir` and waits until it accepts prompts. @param {Page} page @param {string} dir */
async function startedAgent(page, dir) {
  await page.locator('#palette-toggle').click();
  await page.locator('#palette [data-type="omp"]').click();
  await page.keyboard.press('Escape');
  const pane = page.locator('.widget[data-widget="omp"]');
  await pane.locator('input').fill(dir);
  await pane.getByRole('button', { name: 'Start agent' }).click();
  await expect(pane.getByText('Fake Model')).toBeVisible();
  return pane;
}

/** Opens pull request #12 from the agent window's PRs menu. @param {Page} page @param {Locator} agent */
async function openPull(page, agent) {
  await agent.getByRole('button', { name: 'PRs' }).click();
  await page.getByRole('button', { name: /#12 feat: pull request window/ }).click();
  const pr = page.locator('.widget[data-widget="github"]');
  await expect(pr.locator('.gh-title')).toHaveText('#12 feat: pull request window');
  return pr;
}

/** Selects `word` in `where` by double-clicking it, as a reader would. @param {Locator} where @param {string} word */
async function selectWord(where, word) {
  const box = await where.evaluate((node, word) => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      const at = text.textContent?.indexOf(word) ?? -1;
      if (at === -1) continue;
      const range = document.createRange();
      range.setStart(text, at);
      range.setEnd(text, at + word.length);
      const r = range.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }
    return null;
  }, word);
  if (!box) throw new Error(`"${word}" is not shown`);
  await where.page().mouse.dblclick(box.x, box.y);
}

test('the pull request list sets open ones and drafts apart from merged and closed ones, and narrows to a status and an author, kept by the window', async ({ page }) => {
  await openWorkbench(page);
  /** @param {number} number @param {string} state @param {boolean} isDraft @param {string} author */
  const pull = (number, state, isDraft, author) => ({ number, title: `change ${number}`, state, isDraft, author, headRefName: `b${number}`, baseRefName: 'main', body: '', createdAt: '', updatedAt: '', additions: 0, deletions: 0, comments: [], reviews: [], diff: '' });
  const repo = newRepo({ pulls: [pull(12, 'OPEN', false, 'octo'), pull(11, 'OPEN', true, 'hubot'), pull(7, 'MERGED', false, 'octo'), pull(5, 'CLOSED', false, 'hubot')] });
  await page.locator('#palette-toggle').click();
  await page.locator('#palette [data-type="github"]').click();
  await page.keyboard.press('Escape');
  const pane = page.locator('.widget[data-widget="github"]');
  await pane.locator('input').fill(repo);
  await pane.getByRole('button', { name: 'List pull requests' }).click();
  const rows = pane.locator('.gh-pick-item');
  await expect(rows.locator('.gh-state')).toHaveText(['open', 'draft', 'merged', 'closed']);
  const opacities = await rows.evaluateAll((items) => items.map((item) => getComputedStyle(item).opacity));
  expect(opacities).toEqual(['1', '1', '0.5', '0.5']);

  await pane.getByLabel('Status').selectOption({ label: 'Open or draft' });
  await expect(rows.locator('.gh-number')).toHaveText(['#12', '#11']);
  await expect(pane.getByLabel('Author').locator('option')).toHaveText(['Any author', 'hubot', 'octo']);
  await pane.getByLabel('Author').selectOption('hubot');
  await expect(rows.locator('.gh-number')).toHaveText(['#11']);
  await expect(pane.locator('.gh-pick-filters')).toContainText('1 of 4 pull requests');
  await pane.getByLabel('Status').selectOption({ label: 'Merged' });
  await expect(pane.locator('.gh-pick-list')).toHaveText('No pull requests match.');

  // The window's own choice: still there after a reload, for the next listing.
  await pane.getByLabel('Status').selectOption({ label: 'Closed' });
  await page.waitForTimeout(500); // the layout is saved after a pause
  await page.reload();
  await pane.locator('input').fill(repo);
  await pane.getByRole('button', { name: 'List pull requests' }).click();
  await expect(rows.locator('.gh-number')).toHaveText(['#5']);
  await expect(pane.getByLabel('Status')).toHaveValue('closed');
  await expect(pane.getByLabel('Author')).toHaveValue('hubot');
});

test('# in the message box suggests the repository’s pull requests by title, and a pick puts in #N', async ({ page }) => {
  await openWorkbench(page);
  const agent = await startedAgent(page, newRepo());
  const draft = agent.locator('textarea');
  await draft.fill('look at #');
  await draft.press('End');
  await draft.pressSequentially('w'); // typed, so the list follows it
  const rows = agent.locator('.omp-suggestion');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('#12');
  await expect(rows.first()).toContainText('feat: pull request window');
  await draft.press('Backspace');
  await expect(rows).toHaveCount(2); // a bare # lists them all
  await expect(rows.nth(1)).toContainText('docs: readme');
  await draft.pressSequentially('7');
  await draft.press('Tab');
  await expect(draft).toHaveValue('look at #7 ');
  await expect(rows).toHaveCount(0);
});

test('without GitHub, # is plain text and the agent window offers no pull requests', async ({ page }) => {
  await openWorkbench(page);
  const agent = await startedAgent(page, mkdtempSync(join(tmpdir(), 'ac-e2e-plain-')));
  const draft = agent.locator('textarea');
  await draft.pressSequentially('see #1');
  await page.waitForTimeout(300); // GitHub has had time to answer
  await expect(agent.locator('.omp-suggestion')).toHaveCount(0);
  await expect(agent.getByRole('button', { name: 'PRs' })).toBeHidden();
});

test('PRs opens a pull request beside the agent; comments and questions on highlighted parts reach the agent in one message', async ({ page }) => {
  await openWorkbench(page);
  const repo = newRepo();
  const agent = await startedAgent(page, repo);
  const pr = await openPull(page, agent);
  // Beside the agent: on its right, the same height.
  const [a, p] = [await agent.boundingBox(), await pr.boundingBox()];
  expect(p && a && p.x > a.x + a.width - 1 && Math.abs(p.y - a.y) < 2).toBe(true);
  await expect(pr.getByText('Adds a pull request window beside the agent.')).toBeVisible();

  // A question on the description.
  await selectWord(pr.locator('.gh-item-body'), 'beside');
  await pr.getByRole('button', { name: 'Ask', exact: true }).click();
  await pr.getByRole('textbox', { name: 'Ask about the selected text' }).fill('Beside which agent?');
  await pr.getByRole('button', { name: 'Add question' }).click();

  // A comment on a changed line, with the review comment on it shown under it.
  await pr.getByRole('tab', { name: 'Files (1)' }).click();
  await expect(pr.locator('.gh-thread')).toContainText('Why 42?');
  await selectWord(pr.locator('.gh-line.is-add').first(), 'answer');
  await pr.getByRole('button', { name: 'Comment', exact: true }).click();
  await pr.getByRole('textbox', { name: 'Comment on the selected text' }).fill('Name it better');
  await pr.getByRole('button', { name: 'Add comment' }).click();

  await expect(pr.locator('.gh-note-card')).toHaveCount(2);
  await expect(pr.locator('.gh-note-cite')).toHaveText(['the description', 'src/app.js:2']);
  await pr.getByRole('textbox', { name: 'Your note to the agent' }).fill('Otherwise good.');
  const delivered = page.waitForRequest((r) => r.url().endsWith('/api/deliver'));
  await pr.getByRole('button', { name: 'Send 3 to agent' }).click();
  const body = (await delivered).postDataJSON();
  expect(body.message).toBe(
    [
      `My review of PR #12 "feat: pull request window" (https://github.com/${repoOf(repo)}/pull/12):`,
      'Question about `the description`:\n> beside\n\nBeside which agent?',
      'On `src/app.js:2`:\n> answer\n\nName it better',
      'Otherwise good.',
    ].join('\n\n'),
  );
  await expect(pr.locator('.gh-sent')).toHaveText(/^Sent to /);
  await expect(pr.locator('.gh-note-card')).toHaveCount(0);
  // The agent took it as its next prompt.
  await expect(agent.locator('.omp-user').last()).toContainText('My review of PR #12');
  await expect(agent.locator('.omp-assistant').last()).toContainText('You said:');
});

test('a pull request dragged out of the PRs menu opens where it is dropped', async ({ page }) => {
  await openWorkbench(page);
  const agent = await startedAgent(page, newRepo());
  await agent.getByRole('button', { name: 'PRs' }).click();
  const item = page.getByRole('button', { name: /#7 docs: readme/ });
  const from = await item.boundingBox();
  const box = await agent.boundingBox();
  if (!from || !box) throw new Error('nothing to drag');
  await page.mouse.move(from.x + 10, from.y + from.height / 2);
  await page.mouse.down();
  // Onto the lower edge of the agent window: below it.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 40, { steps: 8 });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 8, { steps: 4 });
  await page.mouse.up();
  const pr = page.locator('.widget[data-widget="github"]');
  await expect(pr.locator('.gh-title')).toHaveText('#7 docs: readme');
  const [a, p] = [await agent.boundingBox(), await pr.boundingBox()];
  expect(p && a && p.y > a.y + a.height - 1).toBe(true);
});

test('Bugbot comments `bugbot go` and sends Cursor Bugbot’s review to the agent once it is posted', async ({ page }) => {
  await openWorkbench(page);
  const repo = newRepo();
  const agent = await startedAgent(page, repo);
  const pr = await openPull(page, agent);
  await pr.getByRole('button', { name: 'Bugbot' }).click();
  await expect(pr.locator('.gh-bugbot')).toContainText('waiting for its review');
  await expect(pr.getByRole('button', { name: 'Bugbot' })).toBeDisabled();
  const comments = JSON.parse(readFileSync(join(repo, '.fake-gh.json'), 'utf8')).issueComments;
  expect(comments.map((/** @type {any} */ c) => c.body)).toEqual(['bugbot go']);

  // Polled every 300 ms here, with a fake gh process per poll: a loaded machine takes a while.
  await expect(pr.locator('.gh-bugbot')).toContainText('Bugbot’s review went to the agent', { timeout: 20_000 });
  await expect(agent.locator('.omp-user').last()).toContainText('Cursor Bugbot reviewed PR #12');
  await expect(agent.locator('.omp-user').last()).toContainText('Answer is hard-coded');
  await expect(pr.getByRole('button', { name: 'Bugbot' })).toBeEnabled();
});

/**
 * Drags `from` with the mouse and lets go at (`x`, `y`), past the drag threshold.
 * @param {Page} page @param {Locator} from @param {number} x @param {number} y
 */
async function dragTo(page, from, x, y) {
  const box = await from.boundingBox();
  if (!box) throw new Error('nothing to drag');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(x - 30, y, { steps: 6 });
  await page.mouse.move(x, y, { steps: 4 });
  await page.mouse.up();
}

test('a pull request a reply links, in any repository, or refers to as #N drags out as a pull request window, and onto one shows there', async ({ page }) => {
  await openWorkbench(page);
  const here = newRepo();
  const other = newRepo({
    pulls: [
      { number: 860, title: 'route searcher to customer-ui', state: 'OPEN', isDraft: false, author: 'octo', headRefName: 'route', baseRefName: 'main', body: 'Routing.', createdAt: '2026-11-01T09:00:00Z', updatedAt: '', additions: 0, deletions: 0, comments: [], reviews: [], diff: '' },
    ],
  });
  const agent = await startedAgent(page, here);
  await agent.locator('textarea').fill(`say:| Repo | PR |\n|---|---|\n| infra | [#860](https://github.com/${repoOf(other)}/pull/860) |\n\nStacked on #12.`);
  await agent.locator('textarea').press('Enter');
  const link = agent.locator('.omp-assistant .md-pr-link');
  await expect(link).toHaveText('#860');

  // Out onto the grid, at the agent window's right edge: a window of its own, of the repository linked.
  const box = await agent.boundingBox();
  if (!box) throw new Error('no agent window');
  await dragTo(page, link, box.x + box.width - 6, box.y + box.height / 2);
  const pr = page.locator('.widget[data-widget="github"]');
  await expect(pr.locator('.gh-title')).toHaveText('#860 route searcher to customer-ui');
  expect(await page.evaluate(() => getSelection()?.toString() ?? '')).toBe('');

  // `#12`, of the conversation's own repository, dropped on that window: it shows there instead.
  const prBox = await pr.boundingBox();
  if (!prBox) throw new Error('no pull request window');
  await dragTo(page, agent.locator('.omp-assistant .md-pr-ref', { hasText: '#12' }), prBox.x + prBox.width / 2, prBox.y + prBox.height / 2);
  await expect(pr.locator('.gh-title')).toHaveText('#12 feat: pull request window');
  await expect(page.locator('.widget[data-widget="github"]')).toHaveCount(1);

  // A click (no drag) on the link still opens it on GitHub, in a new tab; so does one on `#12`,
  // in the conversation's repository. The drags above opened none.
  expect(page.context().pages()).toHaveLength(1);
  await page.context().route('https://github.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: 'GitHub' }));
  const [tab] = await Promise.all([page.context().waitForEvent('page'), link.click()]);
  expect(tab.url()).toBe(`https://github.com/${repoOf(other)}/pull/860`);
  await tab.close();
  const [refTab] = await Promise.all([page.context().waitForEvent('page'), agent.locator('.omp-assistant .md-pr-ref', { hasText: '#12' }).click()]);
  expect(refTab.url()).toBe(`https://github.com/${repoOf(here)}/pull/12`);
  await refTab.close();
  await expect(page.locator('.widget[data-widget="github"]')).toHaveCount(1);
});

test('#N in a pull request’s own text drags out as another pull request of its repository, and a click opens it on GitHub', async ({ page }) => {
  await openWorkbench(page);
  const repo = newRepo();
  const agent = await startedAgent(page, repo);
  const json = join(repo, '.fake-gh.json');
  const state = JSON.parse(readFileSync(json, 'utf8'));
  state.pulls[0].body = 'Follows #7.';
  writeFileSync(json, JSON.stringify(state));
  const pr = await openPull(page, agent);
  const box = await pr.boundingBox();
  if (!box) throw new Error('no pull request window');
  await dragTo(page, pr.locator('.gh-item-body .md-pr-ref'), box.x + box.width / 2, box.y + box.height - 6);
  await expect(page.locator('.widget[data-widget="github"] .gh-title')).toHaveText(['#12 feat: pull request window', '#7 docs: readme']);
  await page.context().route('https://github.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: 'GitHub' }));
  const [tab] = await Promise.all([page.context().waitForEvent('page'), pr.first().locator('.gh-item-body .md-pr-ref').click()]);
  expect(tab.url()).toBe(`https://github.com/${repoOf(repo)}/pull/7`);
});

test('# finds the owner’s other repositories by name, and a pick of one and then of its pull request puts in owner/name#N', async ({ page }) => {
  await openWorkbench(page);
  const here = newRepo();
  const owner = basename(dirname(here));
  /** @param {number} number @param {string} title */
  const pr = (number, title) => ({ number, title, state: 'OPEN', isDraft: false, author: 'octo', headRefName: `b${number}`, baseRefName: 'main', body: '', createdAt: '2026-11-01T09:00:00Z', updatedAt: '', additions: 0, deletions: 0, comments: [], reviews: [], diff: '' });
  newRepo({ owner, name: 'k8s-infra', pulls: [pr(860, 'add searcher cronjobs'), pr(859, 'route searcher')] });
  const agent = await startedAgent(page, here);
  const draft = agent.locator('textarea');
  const rows = agent.locator('.omp-suggestion');

  // Part of its name after #: the repository, to go on into.
  await draft.pressSequentially('see #k8s');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('k8s-infra#');
  await expect(rows.first()).toContainText('repository');
  await draft.press('Tab');
  await expect(draft).toHaveValue('see k8s-infra#');
  await expect(rows).toHaveCount(2); // its pull requests
  await draft.pressSequentially('859');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('k8s-infra#859');
  await expect(rows.first()).toContainText('route searcher');
  await draft.press('Tab');
  // As GitHub writes it, so the agent (and GitHub) know which repository.
  await expect(draft).toHaveValue(`see ${owner}/k8s-infra#859 `);

  // Typed outright, the other way round, it finds the same; the conversation's own stays #N.
  await draft.pressSequentially('and #k8s-infra:cron');
  await expect(rows).toHaveCount(1);
  await draft.press('Tab');
  await draft.pressSequentially('or widgets#7');
  await expect(rows).toHaveCount(1);
  await draft.press('Tab');
  await expect(draft).toHaveValue(`see ${owner}/k8s-infra#859 and ${owner}/k8s-infra#860 or #7 `);

  // The agent echoes it back: there, it drags out as that pull request's window.
  await draft.press('Enter');
  const ref = agent.locator('.omp-assistant .md-pr-ref', { hasText: `${owner}/k8s-infra#859` });
  await expect(ref).toBeVisible();
  const box = await agent.boundingBox();
  if (!box) throw new Error('no agent window');
  await dragTo(page, ref, box.x + box.width - 6, box.y + box.height / 2);
  await expect(page.locator('.widget[data-widget="github"] .gh-title')).toHaveText('#859 route searcher');
});
