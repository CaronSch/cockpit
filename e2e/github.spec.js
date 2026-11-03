// Behaviour tests for pull requests in the workbench (the pull request window, # suggestions,
// Bugbot) against the real daemon driving tests/fixtures/fake-omp.js and tests/fixtures/fake-gh.js.
import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newWorkspace, workbenchPath } from './daemon.js';

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

/** A checkout of acme/widgets with two pull requests, as the fake gh reads it; a new one per test. */
function newRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'ac-e2e-repo-'));
  writeFileSync(
    join(dir, '.fake-gh.json'),
    JSON.stringify({
      repo: 'acme/widgets',
      pulls: [
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
  const agent = await startedAgent(page, newRepo());
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
      'My review of PR #12 "feat: pull request window" (https://github.com/acme/widgets/pull/12):',
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
