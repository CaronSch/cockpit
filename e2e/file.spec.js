// The file window (widgets/file.js): text files an agent's reply names open in it with a click,
// or where they are dropped with a drag (files/file-window.js).
import { test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  await expect(files.locator('.fv-text')).toHaveValue('{\n  "jobs": 4\n}\n');
  await expect(files.locator('.fv-path')).toHaveText(join(dir, 'astralane.json'));

  // Another one, relative to the conversation's directory and at a line: the same window shows
  // it, as written (a line was asked for), that line marked; Rendered shows the Markdown.
  await reply.locator('code.md-file-ref').click();
  await expect(files).toHaveCount(1);
  await expect(files.locator('.fv-text')).toHaveValue(/line four/);
  await expect(files.locator('.fv-line-mark')).toBeVisible();
  // The line numbers are text set beside the source's lines: number 4 is where line 4 is.
  const [mark, line] = await files.locator('.fv-source').evaluate((node) => {
    const text = /** @type {Text} */ (node.querySelector('.fv-gutter')?.firstChild);
    const range = document.createRange();
    const at = (text.textContent ?? '').split('\n').slice(0, 3).join('\n').length + 1;
    range.setStart(text, at);
    range.setEnd(text, at + 1);
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
  await expect(files.locator('.fv-text')).toHaveCount(1);
  await expect(files.locator('.fv-text')).toHaveValue(/"jobs": 4/);
  await expect(files.locator('.fv-rendered')).toHaveCount(1);
  expect(problems).toEqual([]);
});

test('the source is edited and saved; an edit begun before the file changed asks whose text stays', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-e2e-edit-'));
  const plan = join(dir, 'plan.md');
  writeFileSync(plan, '# Plan\n\nline three\n');
  /** @type {string[]} */
  const problems = [];
  page.on('pageerror', (err) => problems.push(err.message));
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.goto(workbenchPath(newWorkspace()));
  await page.locator('#palette-toggle').click();
  await page.locator('#palette [data-type="file"]').click();
  await page.keyboard.press('Escape');
  const win = page.locator('.widget[data-widget="file"]');
  await win.getByRole('textbox', { name: 'File' }).fill(plan);
  await win.getByRole('button', { name: 'Open' }).click();

  // Rendered, the Markdown only shows: nothing in it takes typing, and there is nothing to save.
  await expect(win.locator('.fv-rendered .md-heading')).toHaveText('Plan');
  await expect(win.locator('textarea, [contenteditable="true"]')).toHaveCount(0);
  await expect(win.getByRole('button', { name: 'Save' })).toBeHidden();

  // Its source takes typing; Cmd/Ctrl+S saves it to the file.
  await win.getByRole('button', { name: 'Source' }).click();
  const text = win.locator('textarea.fv-text');
  await text.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('line four\n');
  await expect(win.locator('.fv-status')).toHaveText('Unsaved edits');
  await expect(win.locator('.fv-gutter')).toHaveText('1\n2\n3\n4');
  await expect(win.getByRole('button', { name: 'Save' })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+s');
  await expect(win.getByRole('button', { name: 'Save' })).toBeHidden();
  expect(readFileSync(plan, 'utf8')).toBe('# Plan\n\nline three\nline four\n');
  await expect(text).toBeFocused();

  // Rendered again, it shows the edit, unsaved ones too.
  await page.keyboard.type('line five\n');
  await win.getByRole('button', { name: 'Rendered' }).click();
  await expect(win.locator('.fv-rendered')).toContainText('line five');
  await win.getByRole('button', { name: 'Source' }).click();

  // The file changes under the edit (an agent): Reload keeps the edit and says so; saving it waits for a choice.
  writeFileSync(plan, '# Plan\n\nby the agent\n');
  await win.getByRole('button', { name: 'Reload' }).click();
  await expect(win.locator('.fv-conflict')).toBeVisible();
  await expect(text).toHaveValue('# Plan\n\nline three\nline four\nline five\n');
  await expect(win.getByRole('button', { name: 'Save' })).toBeDisabled();
  await win.getByRole('button', { name: 'Keep mine' }).click();
  await expect(win.locator('.fv-conflict')).toBeHidden();
  await expect(win.getByRole('button', { name: 'Save' })).toBeHidden();
  expect(readFileSync(plan, 'utf8')).toBe('# Plan\n\nline three\nline four\nline five\n');

  // Once more, the file's text wins this time.
  await text.click();
  await page.keyboard.type('mine');
  writeFileSync(plan, '# Plan\n\ntheirs\n');
  await win.getByRole('button', { name: 'Reload' }).click();
  await win.getByRole('button', { name: 'Use the file' }).click();
  await expect(text).toHaveValue('# Plan\n\ntheirs\n');
  await expect(win.getByRole('button', { name: 'Save' })).toBeHidden();
  expect(readFileSync(plan, 'utf8')).toBe('# Plan\n\ntheirs\n');

  // A file with Windows line ends keeps them, though its text box holds `\n` alone.
  const notes = join(dir, 'notes.txt');
  writeFileSync(notes, 'one\r\ntwo\r\n');
  await page.locator('#palette-toggle').click();
  await page.locator('#palette [data-type="file"]').click();
  await page.keyboard.press('Escape');
  const other = win.filter({ has: page.getByRole('textbox', { name: 'File', exact: true }) });
  await other.getByRole('textbox', { name: 'File', exact: true }).fill(notes);
  await other.getByRole('button', { name: 'Open' }).click();
  const notesText = win.locator('textarea.fv-text').nth(1);
  await expect(notesText).toHaveValue('one\ntwo\n');
  await notesText.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('three\n');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(win.getByRole('button', { name: 'Save' })).toHaveCount(0);
  await expect.poll(() => readFileSync(notes, 'utf8')).toBe('one\r\ntwo\r\nthree\r\n');
  expect(problems).toEqual([]);
});

test('a CSV file shows as a table; its source is edited as text, and the table shows the edit', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-e2e-csv-'));
  const jobs = join(dir, 'jobs.csv');
  writeFileSync(jobs, 'name,jobs,note\nastralane,4,"has, a comma"\nsol,12,plain\n');
  /** @type {string[]} */
  const problems = [];
  page.on('pageerror', (err) => problems.push(err.message));
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.goto(workbenchPath(newWorkspace()));
  await page.locator('#palette-toggle').click();
  await page.locator('#palette [data-type="file"]').click();
  await page.keyboard.press('Escape');
  const win = page.locator('.widget[data-widget="file"]');
  await win.getByRole('textbox', { name: 'File' }).fill(jobs);
  await win.getByRole('button', { name: 'Open' }).click();

  const table = win.locator('.fv-rendered table.md-table');
  await expect(table.locator('th')).toHaveText(['name', 'jobs', 'note']);
  await expect(table.locator('tbody tr').first().locator('td')).toHaveText(['astralane', '4', 'has, a comma']);
  await expect(table.locator('tbody td').nth(1)).toHaveCSS('text-align', 'right');
  await expect(win.locator('textarea')).toHaveCount(0);

  await win.getByRole('button', { name: 'Source' }).click();
  const text = win.locator('textarea.fv-text');
  await expect(text).toHaveValue('name,jobs,note\nastralane,4,"has, a comma"\nsol,12,plain\n');
  await text.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('base,7,new\n');
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readFileSync(jobs, 'utf8')).toBe('name,jobs,note\nastralane,4,"has, a comma"\nsol,12,plain\nbase,7,new\n');
  await win.getByRole('button', { name: 'Rendered' }).click();
  await expect(table.locator('tbody tr')).toHaveCount(3);
  await expect(table.locator('tbody tr').last().locator('td')).toHaveText(['base', '7', 'new']);
  expect(problems).toEqual([]);
});
