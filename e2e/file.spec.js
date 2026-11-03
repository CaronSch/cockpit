// The file window (widgets/file.js): text files an agent's reply names open in it with a click,
// or where they are dropped with a drag (files/file-window.js).
import { test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newWorkspace, workbenchPath } from './daemon.js';

test.use({ viewport: { width: 1400, height: 900 }, contextOptions: { reducedMotion: 'reduce' } });

test('a text file a reply names opens beside with a click, at the line named, and a drag places one where it is dropped', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-e2e-files-'));
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'astralane.json'), '{\n  "jobs": 4\n}\n');
  writeFileSync(join(dir, 'docs', 'plan.md'), '# Plan\n\nline three\nline four\n');
  /** @type {string[]} */
  const problems = [];
  page.on('pageerror', (err) => problems.push(err.message));
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.goto(workbenchPath(newWorkspace()));
  await page.locator('#palette-toggle').click();
  await page.locator('#palette [data-type="omp"]').click();
  await page.keyboard.press('Escape');
  const agent = page.locator('.widget[data-widget="omp"]');
  await agent.locator('input').fill(dir);
  await agent.getByRole('button', { name: 'Start agent' }).click();
  await expect(agent.getByText('Fake Model')).toBeVisible();
  await agent.locator('textarea').fill(`say:Files (all validated)\n${dir}/astralane.json has 4 Jobs in sol-mainnet.\n\nThe plan is in \`docs/plan.md:4\`.`);
  await agent.locator('textarea').press('Enter');
  const reply = agent.locator('.omp-assistant').last();
  const json = reply.locator('.md-file-ref', { hasText: 'astralane.json' });
  await expect(json).toHaveText(`${dir}/astralane.json`);

  // A click: a file window beside the agent, showing the file.
  await json.click();
  const files = page.locator('.widget[data-widget="file"]');
  await expect(files).toHaveCount(1);
  await expect(files.locator('.fv-text')).toHaveText('{\n  "jobs": 4\n}\n');
  await expect(files.locator('.fv-path')).toHaveText(join(dir, 'astralane.json'));

  // Another one, relative to the conversation's directory and at a line: the same window shows
  // it, as written (a line was asked for), that line marked; Rendered shows the Markdown.
  await reply.locator('code.md-file-ref').click();
  await expect(files).toHaveCount(1);
  await expect(files.locator('.fv-text')).toContainText('line four');
  await expect(files.locator('.fv-line-mark')).toBeVisible();
  const [mark, line] = await files.locator('.fv-source').evaluate((node) => {
    const text = /** @type {Text} */ (node.querySelector('.fv-text')?.firstChild);
    const range = document.createRange();
    const at = (text.textContent ?? '').indexOf('line four');
    range.setStart(text, at);
    range.setEnd(text, at + 9);
    return [node.querySelector('.fv-line-mark')?.getBoundingClientRect().toJSON(), range.getBoundingClientRect().toJSON()];
  });
  expect(mark.top <= line.top && mark.bottom >= line.bottom, 'the mark covers line 4').toBe(true);
  await files.getByRole('button', { name: 'Rendered' }).click();
  await expect(files.locator('.fv-rendered .md-heading')).toHaveText('Plan');

  // A drag: a window of its own where it is dropped, and no click.
  const box = await agent.boundingBox();
  if (!box) throw new Error('no agent window');
  const at = await json.boundingBox();
  if (!at) throw new Error('no path');
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 30, box.y + box.height / 2, { steps: 6 });
  await page.mouse.move(box.x + 6, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(files).toHaveCount(2);
  await expect(files.locator('.fv-text', { hasText: '"jobs": 4' })).toHaveCount(1);
  await expect(files.locator('.fv-rendered')).toHaveCount(1);
  expect(problems).toEqual([]);
});
