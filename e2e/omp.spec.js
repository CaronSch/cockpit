// Behaviour tests for the agent pane against the real daemon driving tests/fixtures/fake-omp.js.
import { test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { E2E_HOME, E2E_STATE_DIR, newWorkspace, rpcAnswer, savedLayout, workbenchPath } from './daemon.js';
import { composeAsk, composeFollowUp } from '../src/omp/message.js';

/** @typedef {import('@playwright/test').Page} Page */

test.use({ viewport: { width: 1280, height: 800 }, contextOptions: { reducedMotion: 'reduce' } });

const PROJECT = mkdtempSync(join(tmpdir(), 'ac-e2e-project-'));

/** @type {string[]} */
let problems = [];

/** Opens the workbench in a workspace of its own, and returns its name. @param {Page} page @param {{ signIn?: boolean }} [options] */
async function openWorkbench(page, { signIn = true } = {}) {
  problems = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    // A signed-out page is refused with 401 on purpose; the browser logs that.
    if (msg.type() === 'error' && !(signIn === false && msg.text().includes('401'))) problems.push(`console.error: ${msg.text()}`);
  });
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
  const workspace = newWorkspace();
  await page.goto(workbenchPath(workspace, { signIn }));
  await expect(page.locator('.screen-switch')).toBeVisible(); // the app has started
  return workspace;
}

test.afterEach(() => {
  expect(problems, 'page errors / console errors during the test').toEqual([]);
});

/**
 * Runs `open`, which adds one agent window, and returns a locator pinned to that window
 * (`.last()` would re-resolve to whichever pane was added most recently).
 * @param {Page} page @param {() => Promise<void>} open
 */
async function paneAddedBy(page, open) {
  const ids = () => page.locator('.widget[data-widget="omp"]').evaluateAll((els) => els.map((e) => /** @type {HTMLElement} */ (e).dataset.id));
  const before = await ids();
  await open();
  await expect(page.locator('.widget[data-widget="omp"]')).toHaveCount(before.length + 1);
  const added = (await ids()).find((id) => !before.includes(id));
  return page.locator(`.widget[data-id="${added}"]`);
}

/** Adds an agent pane through the palette. @param {Page} page */
async function addOmpPane(page) {
  return paneAddedBy(page, async () => {
    await page.locator('#palette-toggle').click();
    await page.locator('#palette [data-type="omp"]').click();
    await page.keyboard.press('Escape');
  });
}

/** Starts omp in `dir` (the test project) and waits until it accepts prompts. @param {Page} page @param {string} [dir] */
async function startedPane(page, dir = PROJECT) {
  const pane = await addOmpPane(page);
  await pane.locator('input').fill(dir);
  await pane.getByRole('button', { name: 'Start agent' }).click();
  await expect(pane.locator('textarea')).toBeVisible();
  await expect(pane.getByText('Fake Model')).toBeVisible(); // get_state answered: the session is ready
  return pane;
}

/** @param {import('@playwright/test').Locator} pane @param {string} text */
async function send(pane, text) {
  await pane.locator('textarea').fill(text);
  await pane.locator('textarea').press('Enter');
}

/** The next command of `type` the page sends to omp. @param {Page} page @param {string} type */
const rpcSent = (page, type) => page.waitForRequest((r) => r.url().endsWith('/rpc') && r.postDataJSON()?.type === type);

/**
 * The settings saved with `pane`'s window in `workspace`, as the daemon has them.
 * @param {Page} page @param {string} workspace @param {import('@playwright/test').Locator} pane
 */
async function savedParams(page, workspace, pane) {
  const id = await pane.getAttribute('data-id');
  /** @param {any} node @returns {any} */
  const find = (node) => (node?.id === id ? node : (node?.children ?? []).map(find).find(Boolean));
  return find(await savedLayout(page.request, workspace))?.params;
}

/**
 * Waits until the page has heard everything the daemon logged so far, and the pane has drawn
 * it. The stream delivers events in order and the page takes omp's answers from it, so once
 * the answer to a `get_state` sent now is in, everything logged before it was delivered.
 * @param {Page} page @param {string} workspace @param {import('@playwright/test').Locator} pane
 */
async function caughtUp(page, workspace, pane) {
  const { session } = await savedParams(page, workspace, pane);
  await page.evaluate(async (session) => {
    const url = '/src/daemon/client.js'; // the module the app runs, so the page's own connection
    const { getDaemon } = /** @type {typeof import('../src/daemon/client.js')} */ (await import(url));
    await getDaemon().rpc(session, { type: 'get_state' });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); // and drawn
  }, session);
}

/**
 * Selects the bold word in `reply` and opens Ask on it; resolves to the question box.
 * @param {import('@playwright/test').Locator} pane @param {import('@playwright/test').Locator} reply
 */
async function askAbout(pane, reply) {
  await reply.locator('strong').dblclick();
  await pane.getByRole('button', { name: 'Ask', exact: true }).click();
  return pane.getByRole('textbox', { name: 'Ask about the selected text' });
}

test('a browser without the token is told how to sign in, and the daemon serves it nothing', async ({ page }) => {
  await openWorkbench(page, { signIn: false });
  const pane = await addOmpPane(page);
  await expect(pane.getByText('Open the URL printed by `bun start`')).toBeVisible();
  expect((await page.request.get('/api/sessions')).status()).toBe(401);

  // Its layout works but is kept only in memory, and the switcher says so.
  const switcher = page.locator('.screen-switch');
  await expect(switcher).toHaveText(/^Not saved/);
  await switcher.click();
  await expect(page.locator('.screen-menu')).toContainText('not signed in');
  await page.reload();
  await expect(switcher).toHaveText(/^Not saved/);
  await expect(page.locator('.widget')).toHaveCount(0);
});

test('a streamed reply renders once, as markdown, even though omp pre-fills message_start', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  await send(pane, 'hello');
  const reply = pane.locator('.omp-assistant').last();
  await expect(reply.locator('strong')).toHaveText('hello');
  await expect(reply.locator('li')).toHaveText(['one', 'two']);
  await expect(reply).toHaveText(/^You said: hello\s*one\s*two$/);
  await expect(pane.getByText('idle')).toBeVisible();
});

test('the conversation reads like a terminal: no "you" label, one font for the whole app', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  await send(pane, 'hello');
  const user = pane.locator('.omp-user').last();
  await expect(user.locator('.omp-md')).toHaveText('hello');
  await expect(user.locator('.omp-role')).toHaveCount(0);
  const reply = pane.locator('.omp-assistant').last().locator('.omp-md > p').first();
  await expect(reply).toContainText('You said');
  /** @param {import('@playwright/test').Locator} at */
  const font = (at) => at.evaluate((node) => {
    const style = getComputedStyle(node);
    return { family: style.fontFamily, size: style.fontSize };
  });
  const box = pane.locator('textarea');
  const text = await font(reply);
  expect(text.family).toMatch(/^"IBM Plex Mono"/);
  expect(await font(user.locator('.omp-md p'))).toEqual(text);
  expect(await font(box)).toEqual(text);
  for (const chrome of [pane.locator('.widget-title'), pane.getByRole('button', { name: 'Send' }), page.locator('#palette-toggle')]) {
    expect((await font(chrome)).family).toBe(text.family);
  }
});

test('a markdown table in a reply renders as a table, not as pipes', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  await send(pane, 'show me a table');
  const table = pane.locator('.omp-assistant').last().locator('table');
  await expect(table.locator('th')).toHaveText(['When', 'What happens', 'Code']);
  await expect(table.locator('tbody td')).toHaveText(['Now', 'Stuff happened', 'tracked.rs:67']);
  await expect(table.locator('tbody td code')).toHaveText('tracked.rs:67');
  await expect(pane.locator('.omp-assistant').last()).not.toContainText('|');
});

test('a table wider than the pane scrolls by itself; the reply around it wraps at the pane width, a line apart', async ({ page }) => {
  await openWorkbench(page);
  await page.setViewportSize({ width: 480, height: 800 });
  const pane = await startedPane(page);
  await send(pane, 'show me a wide table');
  const reply = pane.locator('.omp-assistant').last();
  await expect(reply.locator('.md-table')).toBeVisible();

  const sizes = await pane.locator('.omp-transcript').evaluate((transcript) => {
    const md = /** @type {HTMLElement} */ ([...transcript.querySelectorAll('.omp-assistant .omp-md')].at(-1));
    const wrap = /** @type {HTMLElement} */ (md.querySelector('.md-table-wrap'));
    /** The right edge of the furthest-reaching line of text in `node`. @param {Node} node */
    const textRight = (node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return Math.max(...[...range.getClientRects()].map((r) => r.right));
    };
    const block = (/** @type {string} */ selector) => /** @type {HTMLElement} */ (md.querySelector(selector)).getBoundingClientRect();
    return {
      overflow: transcript.scrollWidth - transcript.clientWidth,
      textRight: Math.max(...[...md.querySelectorAll('p, li')].map(textRight)),
      paneRight: transcript.getBoundingClientRect().right - parseFloat(getComputedStyle(transcript).paddingRight),
      tableOverflow: wrap.scrollWidth - wrap.clientWidth,
      tableToList: block('ul').top - block('.md-table-block').bottom,
      line: parseFloat(getComputedStyle(md).lineHeight),
    };
  });
  expect(sizes.overflow, 'the transcript never scrolls sideways').toBeLessThanOrEqual(0);
  expect(sizes.textRight, 'reply text wraps inside the pane').toBeLessThanOrEqual(sizes.paneRight + 0.5);
  expect(sizes.tableOverflow, 'the table scrolls inside its wrapper').toBeGreaterThan(0);
  expect(sizes.tableToList, 'a blank line between the table and the list after it').toBeCloseTo(sizes.line, 0);
});

test('a markdown table copies as Markdown, as CSV, and as a PNG image of the table', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openWorkbench(page);
  const pane = await startedPane(page);
  await send(pane, 'show me a table');
  const block = pane.locator('.omp-assistant').last().locator('.md-table-block');
  const table = block.locator('table');
  const copy = block.locator('.md-table-copy');
  const menu = block.locator('.md-table-copy-menu');
  /** @param {string} format */
  const copyAs = async (format) => {
    await expect(copy).toHaveText('Copy'); // the previous copy's report has gone
    await table.hover();
    await copy.click();
    await menu.getByRole('button', { name: format }).click();
    await expect(menu).toBeHidden();
    await expect(copy).toHaveText('Copied');
  };
  const clipboardText = () => page.evaluate(() => navigator.clipboard.readText());

  await copyAs('Markdown');
  expect(await clipboardText()).toBe('| When | What happens | Code |\n|---|---|---|\n| Now | Stuff happened | `tracked.rs:67` |');
  await copyAs('CSV');
  expect(await clipboardText()).toBe('When,What happens,Code\nNow,Stuff happened,tracked.rs:67');
  await copyAs('PNG image');
  const image = await page.evaluate(async () => {
    const item = (await navigator.clipboard.read()).find((i) => i.types.includes('image/png'));
    if (!item) return null;
    const bitmap = await createImageBitmap(await item.getType('image/png'));
    return { width: bitmap.width, height: bitmap.height };
  });
  const box = await table.boundingBox();
  if (!image || !box) throw new Error(`no image on the clipboard (${JSON.stringify(image)}) or no table (${JSON.stringify(box)})`);
  // Drawn at 2× from the table's own cells: about twice the rendered table, not a blank or the whole pane.
  expect(Math.abs(image.width / (2 * box.width) - 1)).toBeLessThan(0.35);
  expect(Math.abs(image.height / (2 * box.height) - 1)).toBeLessThan(0.35);
});

test('the message box is set like scratchpad text and starts one line high, placeholder and all', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  const draft = pane.locator('textarea');
  /** @param {import('@playwright/test').Locator} node */
  const font = (node) =>
    node.evaluate((el) => {
      const s = getComputedStyle(el);
      return { family: s.fontFamily, size: s.fontSize, lineHeight: s.lineHeight };
    });
  const padText = await page.evaluate(() => {
    const probe = document.body.appendChild(document.createElement('textarea'));
    probe.className = 'pad-text';
    const s = getComputedStyle(probe);
    const style = { family: s.fontFamily, size: s.fontSize, lineHeight: s.lineHeight };
    probe.remove();
    return style;
  });
  expect(await font(draft)).toEqual(padText);

  // One line of text tall, even in a pane too narrow for the whole placeholder.
  const lines = () =>
    draft.evaluate((el) => {
      const s = getComputedStyle(el);
      return (el.clientHeight - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom)) / parseFloat(s.lineHeight);
    });
  await expect(draft).toHaveAttribute('placeholder', /^Message the agent/);
  expect(await lines()).toBeCloseTo(1, 1);
  await page.setViewportSize({ width: 360, height: 800 });
  await expect.poll(lines).toBeCloseTo(1, 1);
  await draft.fill('one\ntwo');
  await expect.poll(lines).toBeCloseTo(2, 1);
});

test('a focused message box lifts its border instead of drawing the accent outline', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  const draft = pane.locator('textarea');
  const look = () =>
    draft.evaluate((el) => {
      const s = getComputedStyle(el);
      return { outline: s.outlineStyle, border: s.borderTopColor };
    });
  await draft.blur(); // a new agent's box starts focused
  const idle = await look();
  await draft.focus();
  const focused = await look();
  const lifted = await page.evaluate(() => {
    const probe = document.body.appendChild(document.createElement('div'));
    probe.style.color = 'var(--color-line-focus)';
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  expect(focused).toEqual({ outline: 'none', border: lifted });
  expect(focused.border).not.toBe(idle.border);
});

test('status lines under a reply look like transcript notes', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  await send(pane, 'interrupt this');
  const status = pane.locator('.omp-assistant').last().locator('.omp-note.is-error');
  await expect(status).toHaveText('Interrupted by user');
  const aborted = pane.locator('.omp-transcript > .omp-note', { hasText: 'prompt: Aborted' });
  await expect(aborted).toBeVisible();
  /** @param {import('@playwright/test').Locator} node */
  const font = (node) => node.evaluate((e) => [getComputedStyle(e).fontFamily, getComputedStyle(e).fontSize]);
  expect(await font(status)).toEqual(await font(aborted));
});

test('a reply stopped before it said anything shows only that the prompt was aborted', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  await send(pane, 'interrupt early');
  await expect(pane.locator('.omp-transcript > .omp-note', { hasText: 'prompt: Aborted' })).toBeVisible();
  await expect(pane.locator('.omp-assistant')).toHaveCount(0);
});

test('omp’s info notices are hidden like the messages it does not display; its warnings show', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  await send(pane, 'notice me');
  const info = pane.locator('.omp-transcript > .omp-note', { hasText: 'xdev' });
  await expect(info).toHaveClass(/is-hidden/);
  await expect(info).toHaveText('xdev'); // its text one click away
  await expect(pane.locator('.omp-transcript > .omp-note.is-warning')).toHaveText('Hindsight: Memory retention failed');
});

test('the message box grows with the prompt, up to half the pane, and shrinks again after sending', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  const draft = pane.locator('textarea');
  const box = () =>
    draft.evaluate((el) => ({ height: el.getBoundingClientRect().height, scrolls: el.scrollHeight > el.clientHeight + 1 }));
  const paneHeight = await pane.locator('.omp-session').evaluate((el) => el.getBoundingClientRect().height);
  const empty = await box();

  await draft.fill(`${'a line of the prompt\n'.repeat(6)}the end`);
  const grown = await box();
  expect(grown.height).toBeGreaterThan(empty.height + 60);
  expect(grown.scrolls, 'the whole prompt shows').toBe(false);

  await draft.fill('a line of the prompt\n'.repeat(80));
  const capped = await box();
  expect(capped.height).toBeLessThanOrEqual(paneHeight / 2 + 1);
  expect(capped.height).toBeGreaterThan(grown.height);
  expect(capped.scrolls, 'past the cap it scrolls').toBe(true);

  await draft.press('Enter');
  await expect.poll(async () => (await box()).height).toBe(empty.height);
});

test('the Directory field suggests folders from home as the path is typed; Tab, arrows, Enter and Esc work the list', async ({ page }) => {
  for (const dir of ['code/app', 'code/apple', 'docs', '.hidden']) mkdirSync(join(E2E_HOME, dir), { recursive: true });
  writeFileSync(join(E2E_HOME, 'notes.txt'), 'not a folder');
  writeFileSync(join(E2E_HOME, 'code', 'apps.txt'), 'not a folder');
  await openWorkbench(page);
  const pane = await addOmpPane(page);
  const field = pane.locator('input');
  const list = pane.locator('.omp-suggest');
  const rows = list.getByRole('option');
  // Home's folders as listed, among those this test made (the daemon's own tools may add more).
  const ours = ['.hidden/', 'code/', 'docs/', 'notes.txt'];
  const homeRows = () => expect.poll(async () => (await rows.allTextContents()).filter((t) => ours.includes(t)));

  // The suggested directory (home) comes selected, with no list; emptied, the field lists home's folders.
  await expect(field).toHaveValue(E2E_HOME);
  await expect(field).toBeFocused();
  await expect(list).toBeHidden();
  await field.press('Backspace');
  await homeRows().toEqual(['code/', 'docs/']);

  // Esc closes the list; focusing the empty field opens it again, as does `~/`.
  await field.press('Escape');
  await expect(list).toBeHidden();
  await field.blur();
  await field.focus();
  await homeRows().toEqual(['code/', 'docs/']);
  await field.pressSequentially('~/');
  await expect(field).toHaveValue('~/');
  await homeRows().toEqual(['code/', 'docs/']);

  // Absolute paths and `../` are read as typed; files are never suggested.
  await field.fill('');
  await field.pressSequentially(`${E2E_HOME}/code/app/../`);
  await expect(rows).toHaveText(['app/', 'apple/']);

  // Tab completes a folder and lists its folders; then the common prefix; arrows move.
  await field.fill('');
  await field.pressSequentially('co');
  await expect(rows).toHaveText(['code/']);
  await field.press('Tab');
  await expect(field).toHaveValue('code/');
  await expect(rows).toHaveText(['app/', 'apple/']);
  await field.press('Tab');
  await expect(field).toHaveValue('code/app');
  await field.press('ArrowDown');
  await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true');

  // Enter picks the selected folder and closes the list; the next Enter starts omp there.
  await field.press('Enter');
  await expect(field).toHaveValue('code/apple/');
  await expect(list).toBeHidden();
  const created = page.waitForResponse((r) => r.url().endsWith('/api/sessions') && r.request().method() === 'POST');
  await field.press('Enter');
  expect((await (await created).json()).session.cwd).toBe(join(E2E_HOME, 'code', 'apple'));
  await expect(pane.locator('textarea')).toBeVisible();
});

test('Enter in the Directory field starts omp in the folder typed, even while its folders are suggested', async ({ page }) => {
  for (const dir of ['code/app', 'code/apple']) mkdirSync(join(E2E_HOME, dir), { recursive: true });
  await openWorkbench(page);
  const pane = await addOmpPane(page);
  const field = pane.locator('input');
  await field.fill('');
  await field.pressSequentially('code/');
  await expect(pane.locator('.omp-suggest').getByRole('option')).toHaveText(['app/', 'apple/']);
  const created = page.waitForResponse((r) => r.url().endsWith('/api/sessions') && r.request().method() === 'POST');
  await field.press('Enter');
  expect((await (await created).json()).session.cwd, 'the folder typed, not the first suggested').toBe(join(E2E_HOME, 'code'));
  await expect(pane.locator('textarea')).toBeVisible();
});

test('@ suggests files from the session directory; Tab, arrows, Enter and clicks complete them into mentions', async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), 'ac-e2e-mentions-'));
  const project = join(root, 'proj');
  mkdirSync(join(project, 'src'), { recursive: true });
  mkdirSync(join(project, 'docs'));
  for (const name of ['src/app.js', 'src/api.js', 'README.md', 'notes with space.md', '.env']) writeFileSync(join(project, name), name);
  writeFileSync(join(root, 'sibling.txt'), 'hi');
  await openWorkbench(page);
  const pane = await startedPane(page, project);
  const draft = pane.locator('textarea');
  const list = pane.locator('.omp-suggest');
  const rows = list.getByRole('option');

  // `@` lists the session's directory: folders first and marked, dotfiles hidden.
  await draft.pressSequentially('read @');
  await expect(rows).toHaveText(['docs/', 'src/', 'notes with space.md', 'README.md']);
  await draft.pressSequentially('.');
  await expect(rows).toHaveText(['.env', 'notes with space.md', 'README.md']);
  await draft.press('Backspace');

  // Tab completes a folder with its slash and lists what is in it; then the common prefix, then the one left.
  await draft.pressSequentially('sr');
  await expect(rows).toHaveText(['src/']);
  await draft.press('Tab');
  await expect(draft).toHaveValue('read @src/');
  await expect(rows).toHaveText(['api.js', 'app.js']);
  await draft.press('Tab');
  await expect(draft).toHaveValue('read @src/ap');
  await draft.pressSequentially('p');
  await draft.press('Tab');
  await expect(draft).toHaveValue('read @src/app.js ');
  await expect(list).toBeHidden();

  // `@../` walks up; arrows move and Enter picks.
  await draft.pressSequentially('and @../');
  await expect(rows).toHaveText(['proj/', 'sibling.txt']);
  await draft.press('ArrowDown');
  await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true');
  await draft.press('Enter');
  await expect(draft).toHaveValue('read @src/app.js and @../sibling.txt ');

  // A click picks too; a name with spaces goes quoted, as omp reads it whole.
  await draft.pressSequentially('and @no');
  await rows.filter({ hasText: 'notes with space.md' }).click();
  await expect(draft).toHaveValue('read @src/app.js and @../sibling.txt and @"notes with space.md" ');
  await expect(draft).toBeFocused();

  // Esc closes the list without touching the draft.
  await draft.pressSequentially('@');
  await expect(list).toBeVisible();
  await draft.press('Escape');
  await expect(list).toBeHidden();
  await draft.press('Backspace');

  // The mentions go to omp as typed: it reads them relative to the session's directory.
  const sent = rpcSent(page, 'prompt');
  await draft.press('Enter');
  expect((await sent).postDataJSON().message).toBe('read @src/app.js and @../sibling.txt and @"notes with space.md"');
});

test('a comment on selected reply text goes with the next prompt, quoting what it is about', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  await send(pane, 'hello');
  const reply = pane.locator('.omp-assistant').last();
  await expect(reply.locator('strong')).toHaveText('hello');

  // Text outside the transcript (here the toolbar) is not something to comment on.
  await pane.locator('.omp-cwd').dblclick();
  expect(await page.evaluate(() => String(getSelection())), 'the toolbar text is selected').not.toBe('');
  await page.evaluate(() => new Promise((r) => setTimeout(r))); // after the popup's own check, queued on mouseup
  await expect(pane.locator('.omp-quote-btn')).toHaveCount(0);

  await reply.locator('strong').dblclick(); // selects the word, as a reader would
  await pane.getByRole('button', { name: 'Comment' }).click();
  const box = pane.getByRole('textbox', { name: 'Comment on the selected text' });
  await expect(box).toBeFocused(); // not the message box, though the click was in the pane
  await expect(pane.locator('.omp-quote-pop .omp-quote-preview')).toHaveText('hello');
  await box.fill('why this word?');
  await box.press('Enter');
  const card = pane.locator('.omp-card.is-comment');
  await expect(card).toContainText('“hello”');
  await expect(card).toContainText('why this word?');
  await expect(pane.locator('.omp-quote-pop')).toBeHidden();

  // A shell line goes as typed and leaves the comment waiting.
  await send(pane, '!echo hi');
  await expect(pane.locator('.omp-bash').last()).toBeVisible();
  await expect(card).toBeVisible();

  const sent = page.waitForRequest((r) => r.url().endsWith('/rpc') && r.postDataJSON()?.type === 'prompt');
  await send(pane, 'and the next step?');
  expect((await sent).postDataJSON().message).toBe('> hello\n\nwhy this word?\n\nand the next step?');
  await expect(card).toHaveCount(0);
  await expect(pane.locator('textarea')).toHaveValue('');
});

test('a click in the pane puts the caret in the message box, unless it is on a control or ends a selection', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  await page.context().route('https://example.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '' }));
  for (let i = 0; i < 6; i++) await send(pane, `hello ${i}`);
  await send(pane, 'think [docs](https://example.com/)');
  const reply = pane.locator('.omp-assistant').last();
  await expect(reply.locator('a')).toHaveText('docs');
  const draft = pane.locator('textarea');
  const transcript = pane.locator('.omp-transcript');
  const blur = () => draft.evaluate((d) => d.blur());

  // Clicking reply text, even scrolled up, focuses the box with the caret at the end, and
  // leaves the transcript where it was.
  const item = pane.locator('.omp-assistant').nth(2).locator('li').first();
  await transcript.evaluate((t) => (t.scrollTop = t.scrollHeight / 3));
  await item.scrollIntoViewIfNeeded(); // so the click below has no need to scroll it into view
  const top = await transcript.evaluate((t) => t.scrollTop);
  await draft.fill('draft text');
  await blur();
  await item.click();
  await expect(draft).toBeFocused();
  expect(await draft.evaluate((d) => /** @type {HTMLTextAreaElement} */ (d).selectionStart)).toBe(10);
  expect(await transcript.evaluate((t) => t.scrollTop)).toBe(top);

  // Dragging across reply text selects it: focus stays put and Comment and Ask appear.
  await blur();
  const items = reply.locator('li');
  await reply.scrollIntoViewIfNeeded();
  const from = await items.first().boundingBox();
  const to = await items.last().boundingBox();
  if (!from || !to) throw new Error('the reply has no list');
  await page.mouse.move(from.x + 1, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(pane.getByRole('button', { name: 'Comment' })).toBeVisible();
  await expect(draft).not.toBeFocused();
  await page.evaluate(() => getSelection()?.removeAllRanges());

  // Controls keep their clicks: the thinking toggle, a link, a toolbar button.
  await reply.locator('.omp-thinking summary').click();
  await expect(reply.locator('.omp-thinking')).toHaveAttribute('open', '');
  await expect(draft).not.toBeFocused();
  const popup = page.waitForEvent('popup');
  await reply.locator('a').click();
  await (await popup).close();
  await expect(draft).not.toBeFocused();
  await pane.getByRole('button', { name: 'Accounts', exact: true }).click();
  await expect(pane.locator('.omp-head-menu')).toBeVisible();
  await expect(draft).not.toBeFocused();
  await page.keyboard.press('Escape');

  // Toolbar text that is not a control counts as the pane.
  await pane.locator('.omp-activity').click();
  await expect(draft).toBeFocused();
});

test('a ! draft turns the message box into a shell line that Enter runs in the session directory', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  const draft = pane.locator('textarea');
  const mark = pane.locator('.omp-shell-mark');
  const sendBtn = pane.locator('.omp-compose-row button');
  const heldNote = pane.getByText('These wait for your next prompt');
  const bashSent = () => page.waitForRequest((r) => r.url().endsWith('/rpc') && r.postDataJSON()?.type === 'bash');

  // A prompt: the box as usual. A pasted file waits as a card for it.
  await draft.evaluate((node) => {
    const data = new DataTransfer();
    data.items.add(new File(['notes'], 'notes.txt', { type: 'text/plain' }));
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  const card = pane.locator('.omp-card.is-file');
  await draft.pressSequentially('ls');
  await expect(sendBtn).toHaveText('Send');
  await expect(mark).toBeHidden();
  await expect(card).toBeVisible();
  await expect(heldNote).toBeHidden();

  // Typing `!` in front, even after a space: a shell command, marked with where it runs, and
  // the card shown as waiting instead of going with it.
  await draft.evaluate((node) => /** @type {HTMLTextAreaElement} */ (node).setSelectionRange(0, 0));
  await page.keyboard.type(' !');
  await expect(sendBtn).toHaveText('Run');
  await expect(mark).toBeVisible();
  await expect(mark).toContainText('$ shell');
  await expect(mark).toContainText(basename(PROJECT));
  await expect(heldNote).toBeVisible();

  // Deleting the `!` makes it a prompt again.
  await draft.press('Backspace');
  await expect(sendBtn).toHaveText('Send');
  await expect(mark).toBeHidden();
  await expect(heldNote).toBeHidden();

  // Enter runs it as a command; its output shows, the card stays for the next prompt.
  await page.keyboard.type('!');
  await expect(sendBtn).toHaveText('Run');
  const sent = bashSent();
  await draft.press('Enter');
  expect((await sent).postDataJSON().command).toBe('ls');
  const run = pane.locator('.omp-bash').last();
  await expect(run.locator('.omp-bash-cmd')).toHaveText('$ ls');
  await expect(run).toContainText('hi');
  await expect(draft).toHaveValue('');
  await expect(sendBtn).toHaveText('Send');
  await expect(mark).toBeHidden();
  await expect(card).toBeVisible();
  await expect(heldNote).toBeHidden();

  // A bare `!` names nothing to run: it stays in the box.
  /** @type {string[]} */
  const ran = [];
  page.on('request', (r) => {
    if (r.url().endsWith('/rpc') && r.postDataJSON()?.type === 'bash') ran.push(r.postDataJSON().command);
  });
  await send(pane, '!');
  await expect(draft).toHaveValue('!');
  await expect(pane.locator('.omp-bash')).toHaveCount(1);
  // A command that does run is sent after anything the bare `!` would have sent.
  const next = bashSent();
  await send(pane, '!pwd');
  await next;
  expect(ran, 'a bare ! sends no command').toEqual(['pwd']);
});

test('a ! command while the agent works runs at once, and is not sent as a steer', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  await send(pane, 'slow');
  await expect(pane.getByText('working')).toBeVisible();
  const sent = page.waitForRequest((r) => r.url().endsWith('/rpc') && ['bash', 'prompt'].includes(r.postDataJSON()?.type));
  await pane.locator('textarea').fill('!echo hi');
  await expect(pane.locator('.omp-compose-row button')).toHaveText('Run');
  await pane.locator('textarea').press('Enter');
  expect((await sent).postDataJSON()).toEqual({ type: 'bash', command: 'echo hi' });
  await expect(pane.locator('.omp-bash').last()).toContainText('hi');
  await expect(pane.getByText('working')).toBeVisible(); // the run came back while the turn went on
  await expect(pane.locator('.omp-assistant').last()).toContainText('You said: slow');
});

test('the toolbar menus open under their button, close on Esc or a click outside, and set what is picked', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  const modelBtn = pane.getByRole('button', { name: 'Fake Model', exact: true });
  const thinkingBtn = pane.getByTitle('Choose thinking level');
  const menu = pane.locator('.omp-menu:popover-open');

  await modelBtn.click();
  await expect(menu.getByRole('button', { name: /Fake Large/ })).toBeVisible();
  await expect(menu.getByRole('searchbox')).toBeFocused();
  const [button, box] = [await modelBtn.boundingBox(), await menu.boundingBox()];
  if (!button || !box) throw new Error('menu not laid out');
  expect(Math.round(box.x)).toBe(Math.round(button.x));
  expect(box.y).toBeGreaterThanOrEqual(button.y + button.height);
  await menu.getByRole('searchbox').fill('large');
  await expect(menu.locator('.omp-menu-item')).toHaveText([/Fake Large/]);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(modelBtn).toBeFocused();

  // Opening another menu closes the first; a click outside closes either.
  await modelBtn.click();
  await expect(menu.getByRole('button', { name: /Fake Large/ })).toBeVisible();
  await thinkingBtn.click();
  await expect(menu).toHaveCount(1);
  await expect(menu.getByRole('button', { name: 'high', exact: true })).toBeVisible();
  await pane.locator('.omp-transcript').click();
  await expect(menu).toHaveCount(0);

  await thinkingBtn.click();
  const picked = page.waitForRequest((r) => r.url().endsWith('/rpc') && r.postDataJSON()?.type === 'set_thinking_level');
  await menu.getByRole('button', { name: 'high', exact: true }).click();
  expect((await picked).postDataJSON().level).toBe('high');
  await expect(menu).toHaveCount(0);
  await expect(thinkingBtn).toHaveText(/high/);
});

test('Sign in is in the toolbar only while the session’s model needs it; Accounts is always in the top bar', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  const toolbar = pane.locator('.omp-toolbar');
  const signIn = toolbar.getByRole('button', { name: 'Sign in', exact: true });
  await expect(signIn, 'the fake model’s provider is not signed in to').toBeVisible();

  await pane.getByRole('button', { name: 'Fake Model', exact: true }).click();
  await pane.locator('.omp-menu:popover-open').getByRole('button', { name: /Keyed Model/ }).click();
  await expect(pane.getByRole('button', { name: 'keyed-model', exact: true })).toBeVisible();
  await expect(signIn, 'its provider is signed in to').toBeHidden();

  await pane.locator('.widget-head').getByRole('button', { name: 'Accounts', exact: true }).click();
  await expect(pane.locator('.omp-head-menu:popover-open').getByRole('button', { name: /Keyed Provider/ })).toContainText('logged in');
});

test('a login under way is shown from the stream, so a reload still shows it', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  await pane.locator('.omp-toolbar').getByRole('button', { name: 'Sign in', exact: true }).click();
  await pane.locator('.omp-menu:popover-open').getByRole('button', { name: /Fake Provider/ }).click();
  await expect(pane.getByText('Logging in to fake…')).toBeVisible();
  await page.reload();
  await expect(page.locator('.widget[data-widget="omp"]').getByText('Logging in to fake…')).toBeVisible();
});

test('the top bar sizes all text up and down, resets it, and keeps it across a reload', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  await send(pane, 'hello');
  const reply = pane.locator('.omp-assistant').last().locator('.omp-md > p').first();
  await expect(reply).toContainText('You said');
  const size = () => reply.evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
  const base = await size();
  const larger = page.getByRole('button', { name: 'Larger text' });
  const level = page.getByRole('button', { name: /^Text size/ });

  await larger.click();
  await larger.click();
  await expect(level).toHaveText('120%');
  expect(await size()).toBeCloseTo(base * 1.2, 1);
  const height = await page.locator('.topbar').evaluate((n) => n.getBoundingClientRect().height);
  expect(height, 'layout stays as it is').toBe(40);

  await page.reload();
  await expect(level).toHaveText('120%');
  expect(await size()).toBeCloseTo(base * 1.2, 1);

  await level.click();
  await expect(level).toHaveText('100%');
  expect(await size()).toBeCloseTo(base, 1);
  await page.getByRole('button', { name: 'Smaller text' }).click();
  await expect(level).toHaveText('90%');
  expect(await size()).toBeCloseTo(base * 0.9, 1);
  await page.reload();
  await expect(level).toHaveText('90%');
  await level.click();
});

test('New, Fork, Accounts and Stop sit in the window’s top bar; pressing them never drags the window, its title still does', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  const head = pane.locator('.widget-head');
  const toolbar = pane.locator('.omp-toolbar');
  await expect(head.locator('.widget-actions button')).toHaveText(['New', 'Fork', 'Accounts', 'Stop']);
  for (const name of ['New', 'Fork', 'Accounts', 'Stop']) await expect(toolbar.getByRole('button', { name, exact: true })).toHaveCount(0);
  await expect(head.getByRole('button', { name: 'More actions' }), 'no menu of the rest: there is no rest').toHaveCount(0);

  // Stop is live while a turn runs.
  const stopBtn = head.getByRole('button', { name: 'Stop', exact: true });
  await expect(stopBtn).toBeDisabled();
  await send(pane, 'slow');
  await expect(stopBtn).toBeEnabled();
  await stopBtn.click();
  await expect(stopBtn).toBeDisabled();

  // Accounts opens its menu under its button, keyboard too.
  await head.getByRole('button', { name: 'Accounts', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(pane.locator('.omp-head-menu:popover-open')).toBeVisible();
  await page.keyboard.press('Escape');

  // Pressing a button and moving onto another window does not pick this one up; pressing its title does.
  const target = await addOmpPane(page);
  const indicator = page.locator('.drop-indicator');
  const at = /** @param {import('@playwright/test').Locator} l */ async (l) => {
    const box = await l.boundingBox();
    if (!box) throw new Error('not laid out');
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  for (const [from, picks] of /** @type {const} */ ([[head.getByRole('button', { name: 'New', exact: true }), false], [pane.locator('.widget-title'), true]])) {
    const [start, end] = [await at(from), await at(target)];
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 10 });
    await (picks ? expect(indicator).toHaveClass(/is-visible/) : expect(indicator).not.toHaveClass(/is-visible/));
    await page.keyboard.press('Escape');
    await page.mouse.up();
  }

  // New starts over in this window: the setup screen, and the bar loses the session's controls.
  await head.getByRole('button', { name: 'New', exact: true }).click();
  await expect(pane.getByRole('button', { name: 'Start agent' })).toBeVisible();
  await expect(head.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
});

test('with Animated selection on, a drag shows whole words in its own highlight; off, the browser’s', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  await send(pane, 'hello');
  const reply = pane.locator('.omp-assistant').last();
  await expect(reply.locator('li')).toHaveText(['one', 'two']);
  await expect(pane.locator('.widget-label')).toHaveText('About hello'); // settled and titled: nothing redraws it
  const paragraph = reply.locator('.omp-md > p').first();
  // The middle of "said" and of "one", and where "said" starts.
  const points = await reply.evaluate((node) => {
    /** @param {string} selector */
    const textIn = (selector) => /** @type {Node} */ (document.createTreeWalker(/** @type {Node} */ (node.querySelector(selector)), NodeFilter.SHOW_TEXT).nextNode());
    /** @param {Node} text @param {number} offset */
    const box = (text, offset) => {
      const range = document.createRange();
      range.setStart(text, offset);
      range.setEnd(text, offset + 1);
      return range.getBoundingClientRect();
    };
    const [first, one] = [textIn('.omp-md > p'), textIn('li')];
    const from = box(first, 'You sa'.length);
    const to = box(one, 'o'.length);
    return { from: { x: from.x + from.width / 2, y: from.y + from.height / 2 }, to: { x: to.x + to.width / 2, y: to.y + to.height / 2 }, wordLeft: box(first, 'You '.length).left };
  });
  const lines = pane.locator('.omp-highlight-line:visible');
  const selectionBackground = () => paragraph.evaluate((p) => getComputedStyle(p, '::selection').backgroundColor);

  // Mid-drag: the selection is still where the pointer is, but the highlight covers "said" whole.
  await page.mouse.move(points.from.x, points.from.y);
  await page.mouse.down();
  await page.mouse.move(points.to.x, points.to.y, { steps: 8 });
  await expect(lines.first()).toBeVisible();
  expect(await page.evaluate(() => document.getSelection()?.toString().startsWith('id'))).toBe(true);
  const first = await lines.first().boundingBox();
  expect(Math.abs((first?.x ?? 0) + 2 - points.wordLeft)).toBeLessThan(2); // drawn 2px wider each side
  expect(await selectionBackground()).toBe('rgba(0, 0, 0, 0)');
  await page.mouse.up();
  await expect(lines).toHaveCount(2); // a line each for "said: hello" and "one"

  // Within one line, even inside a single run of text, it is drawn too.
  await paragraph.evaluate((p) => {
    const text = /** @type {Text} */ (p.firstChild);
    document.getSelection()?.setBaseAndExtent(text, 'You '.length, text, 'You said'.length);
  });
  await expect(lines).toHaveCount(1);

  // Off: no highlight of its own, the browser's selection colour back.
  await page.evaluate(() => getSelection()?.removeAllRanges());
  await page.getByRole('button', { name: 'Config' }).click();
  await page.locator('.config-menu').getByRole('checkbox', { name: 'Animated selection' }).uncheck();
  await page.keyboard.press('Escape');
  await page.mouse.move(points.from.x, points.from.y);
  await page.mouse.down();
  await page.mouse.move(points.to.x, points.to.y, { steps: 8 });
  await expect(lines).toHaveCount(0);
  await expect(pane.locator('.omp-transcript')).not.toHaveClass(/has-highlight/);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString().replace(/\s+/g, ' '))).toBe('said: hello one');
});

test('a rough drag over reply text snaps out to whole words once it spans two, punctuation included, before Comment', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  await send(pane, 'hello');
  const reply = pane.locator('.omp-assistant').last();
  await expect(reply.locator('li')).toHaveText(['one', 'two']);
  await expect(pane.locator('.widget-label')).toHaveText('About hello'); // settled and titled: nothing redraws it
  // From inside "said" to inside "one" on the next line, as a hurried drag would.
  const [from, to] = await reply.evaluate((node) => {
    /** @param {Node} text @param {number} offset */
    const at = (text, offset) => {
      const range = document.createRange();
      range.setStart(text, offset);
      range.setEnd(text, offset + 1);
      const r = range.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };
    /** @param {string} selector */
    const textIn = (selector) => /** @type {Node} */ (document.createTreeWalker(/** @type {Node} */ (node.querySelector(selector)), NodeFilter.SHOW_TEXT).nextNode());
    const [first, one] = [textIn('.omp-md > p'), textIn('li')];
    return [at(first, 'You sa'.length), at(one, 'o'.length)];
  });
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString().replace(/\s+/g, ' '))).toBe('said: hello one');
  await pane.getByRole('button', { name: 'Comment', exact: true }).click();
  const box = pane.getByRole('textbox', { name: 'Comment on the selected text' });
  await box.fill('why bold?');
  await box.press('Enter');
  await expect(pane.locator('.omp-card.is-comment')).toContainText('“said: hello one”');

  // A word split by code or bold within a line is still one word, and the next line is not part
  // of it; dragged backwards, it snaps the same and keeps its direction; inside one word, nothing moves.
  const snapped = await page.evaluate(async () => {
    const url = '/src/ui/word-snap.js'; // the module the app runs
    const { snapToWords } = /** @type {typeof import('../src/ui/word-snap.js')} */ (await import(url));
    const host = document.createElement('div');
    host.innerHTML = '<p>call <code>foo</code>.bar(), then</p><p>next</p>';
    document.body.append(host);
    const [, code, rest] = /** @type {Node[]} */ ([...host.querySelector('p')?.childNodes ?? []].map((n) => n.firstChild ?? n));
    const sel = /** @type {Selection} */ (document.getSelection());
    sel.setBaseAndExtent(code, 1, rest, '.bar(), th'.length);
    snapToWords(sel);
    const forward = sel.toString();
    sel.setBaseAndExtent(rest, '.bar(), th'.length, code, 1);
    snapToWords(sel);
    const backward = [sel.toString(), sel.anchorNode === rest && sel.anchorOffset === '.bar(), then'.length];
    sel.setBaseAndExtent(rest, '.bar(), t'.length, rest, '.bar(), th'.length);
    snapToWords(sel);
    const inside = sel.toString();
    // A paragraph's line breaks (<br>) end words: the lines between tags select without them.
    host.innerHTML = '<p>&lt;attachment&gt;<br>One feature to scope.<br>&lt;/attachment&gt;</p>';
    const [open, , middle, , close] = /** @type {Node[]} */ ([...host.querySelector('p')?.childNodes ?? []]);
    sel.setBaseAndExtent(middle, 0, middle, 'One feature to scope.'.length);
    snapToWords(sel);
    const lines = [sel.toString()];
    sel.setBaseAndExtent(open, 0, open, '<attachment>'.length);
    snapToWords(sel);
    lines.push(sel.toString());
    sel.setBaseAndExtent(middle, 'One fea'.length, close, 0);
    snapToWords(sel);
    lines.push(sel.toString().replace(/\n/g, '⏎'));
    host.remove();
    return [forward, backward, inside, lines];
  });
  expect(snapped).toEqual(['foo.bar(), then', ['foo.bar(), then', true], 'h', ['One feature to scope.', '<attachment>', 'feature to scope.']]);
});

test('Ask on selected reply text answers in the popup and leaves the chat as it was', async ({ page }) => {
  const workspace = await openWorkbench(page);
  const pane = await startedPane(page);
  await send(pane, 'hello');
  const reply = pane.locator('.omp-assistant').last();
  await expect(reply.locator('strong')).toHaveText('hello');
  await expect(pane.getByText('idle')).toBeVisible(); // the chat has settled
  await expect(pane.locator('.widget-label')).toHaveText('About hello'); // and been titled
  const transcript = pane.locator('.omp-transcript');
  const chat = await transcript.innerText();

  // "slow": the answer streams in well after omp has taken the question.
  const box = await askAbout(pane, reply);
  await expect(box).toBeFocused();
  const asked = rpcSent(page, 'btw');
  await box.fill('slow: what does this mean?');
  await box.press('Enter');
  expect((await asked).postDataJSON().question).toBe(composeAsk('hello', 'slow: what does this mean?'));
  const pop = pane.locator('.omp-quote-pop');
  await expect(pop.locator('.omp-ask-question')).toHaveText('slow: what does this mean?');
  await expect(pop.locator('.omp-ask-status')).toHaveText('Thinking…');
  await expect(pop.locator('.omp-ask-answer strong')).toHaveText('hello'); // the answer, as Markdown
  expect(await transcript.innerText()).toBe(chat);
  await expect(pane.locator('.omp-card')).toHaveCount(0); // and nothing waits for the next prompt
  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();

  // A reload replays the side answer's frames; they still stay out of the chat.
  await page.reload();
  await expect(reply.locator('strong')).toHaveText('hello');
  await caughtUp(page, workspace, pane);
  expect(await transcript.innerText()).toBe(chat);

  /** Asks `question` about the selection; resolves to omp's id for it. @param {string} question */
  const ask = async (question) => {
    const box = await askAbout(pane, reply);
    const started = rpcSent(page, 'btw');
    await box.fill(question);
    await box.press('Enter');
    return /** @type {string} */ ((await rpcAnswer(await started)).data?.record?.id);
  };

  // A stray click does not throw away an answer still coming; closing the popup stops it.
  const id = await ask('slow: and why?');
  expect(id).toEqual(expect.any(String));
  await expect(pop.locator('.omp-ask-status')).toHaveText('Thinking…');
  await transcript.click({ position: { x: 5, y: 5 } });
  await expect(pop).toBeVisible();
  let cancelled = rpcSent(page, 'btw_cancel');
  await pop.getByRole('button', { name: 'Close' }).click();
  expect((await cancelled).postDataJSON().recordId).toBe(id);
  await expect(pop).toBeHidden();

  // Closed before omp has even taken the question: it is cancelled once omp names it, so the
  // next Ask is not refused for one still running.
  /** @type {() => void} */
  let release = () => {};
  const held = new Promise((resolve) => (release = () => resolve(undefined)));
  await page.route('**/rpc', async (route) => {
    if (route.request().postDataJSON()?.type === 'btw') await held;
    await route.continue();
  });
  const early = await askAbout(pane, reply);
  await early.fill('slow: never mind');
  await early.press('Enter');
  await pop.getByRole('button', { name: 'Close' }).click();
  cancelled = rpcSent(page, 'btw_cancel');
  release();
  expect((await cancelled).postDataJSON().recordId).toEqual(expect.any(String));
  await page.unroute('**/rpc');
  await ask('why, then?');
  await expect(pop.locator('.omp-ask-answer strong')).toHaveText('hello');
});

test('Ask takes follow-ups in the same topic, one at a time, and keeps the whole thread out of the chat', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  await send(pane, 'hello');
  const reply = pane.locator('.omp-assistant').last();
  await expect(reply.locator('strong')).toHaveText('hello');
  await expect(pane.getByText('idle')).toBeVisible(); // the chat has settled
  await expect(pane.locator('.widget-label')).toHaveText('About hello'); // and been titled
  const transcript = pane.locator('.omp-transcript');
  const chat = await transcript.innerText();
  const pop = pane.locator('.omp-quote-pop');
  const questions = pop.locator('.omp-ask-question');
  const answers = pop.locator('.omp-ask-answer');
  const followUp = pop.getByRole('textbox', { name: 'Ask a follow-up' });

  const box = await askAbout(pane, reply);
  const first = rpcSent(page, 'btw');
  await box.fill('what does this mean?');
  await pop.getByRole('button', { name: 'Ask', exact: true }).click(); // focus stays in the popup
  const topic = (await rpcAnswer(await first)).data?.record?.id;
  expect(topic).toEqual(expect.any(String));
  await expect(answers.nth(0).locator('strong')).toHaveText('hello');
  await expect(followUp).toBeFocused();

  // Shift+Enter starts a new line; Enter sends the follow-up in the topic, asking for a short answer.
  await followUp.fill('slow: and');
  await followUp.press('Shift+Enter');
  await followUp.pressSequentially('why?');
  await expect(followUp).toHaveValue('slow: and\nwhy?');
  const asked = rpcSent(page, 'btw');
  await followUp.press('Enter');
  expect((await asked).postDataJSON()).toMatchObject({ question: composeFollowUp('slow: and\nwhy?'), recordId: topic });
  // omp answers one side question at a time: nothing more can be asked until this answer is in.
  await expect(answers.nth(1)).toHaveText('Thinking…');
  await expect(followUp).toBeDisabled();
  await expect(pop.getByRole('button', { name: 'Ask', exact: true })).toBeDisabled();
  await expect(answers.nth(1)).toHaveText('More on hello: it came up once.');
  await expect(questions).toHaveText(['what does this mean?', 'slow: and\nwhy?']);
  await expect(answers.nth(0)).toHaveText('hello is what the conversation said.');
  await expect(followUp).toBeEnabled();

  // A failed answer shows in the thread, and the topic can still be asked about.
  await followUp.fill('fail, please');
  await followUp.press('Enter');
  await expect(answers.nth(2).locator('.omp-ask-error')).toHaveText('Provider error: overloaded');
  await followUp.fill('once more?');
  await followUp.press('Enter');
  await expect(answers.nth(3)).toHaveText('More on hello: it came up once.');
  await expect(questions).toHaveCount(4);

  expect(await transcript.innerText()).toBe(chat);
  await expect(pane.locator('.omp-card')).toHaveCount(0); // and nothing waits for the next prompt
});

test('pasted text is typing, however long; pasted or dropped files go with the next prompt as attachments', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  const draft = pane.locator('textarea');
  /** Pastes `text` into the draft; true when the browser was left to paste it as typing. @param {string} text */
  const paste = (text) =>
    draft.evaluate((node, text) => {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      return node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, text);

  // Text, however long, is left to the browser to paste as typing.
  expect(await paste('one\ntwo')).toBe(true);
  expect(await paste(Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n'))).toBe(true);
  await expect(pane.locator('.omp-card')).toHaveCount(0);

  // A screenshot pasted from the clipboard shows as a thumbnail once stored.
  await draft.evaluate((node) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' }));
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  const files = pane.locator('.omp-card.is-file');
  await expect(files.first()).not.toHaveClass(/is-uploading/);
  await expect(files.first().locator('img')).toBeVisible();

  // A file dropped anywhere on the pane; its upload is held so the message goes while it is on its way.
  /** @type {() => void} */
  let release = () => {};
  const held = new Promise((resolve) => (release = () => resolve(undefined)));
  await page.route('**/api/attachments', async (route) => {
    if (route.request().headers()['x-file-name'] === 'notes.txt') await held;
    await route.continue();
  });
  const dataTransfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File(['hello from a file'], 'notes.txt', { type: 'text/plain' }));
    return data;
  });
  const session = pane.locator('.omp-session');
  await pane.locator('.omp-transcript').dispatchEvent('dragover', { dataTransfer });
  await expect(session).toHaveClass(/is-dropping/);
  await pane.locator('.omp-transcript').dispatchEvent('drop', { dataTransfer });
  await expect(session).not.toHaveClass(/is-dropping/);
  await expect(files.last()).toHaveClass(/is-uploading/);

  const sent = page.waitForRequest((r) => r.url().endsWith('/rpc') && r.postDataJSON()?.type === 'prompt');
  await draft.fill('what are these?');
  await draft.press('Enter');
  release();
  const message = (await sent).postDataJSON().message;
  const paths = [...message.matchAll(/@"([^"]+)"/g)].map((m) => m[1]);
  expect(message).toBe(`what are these?\n\n@"${paths[0]}"\n\n@"${paths[1]}"`);
  expect(paths[0]).toMatch(new RegExp(`^${join(E2E_STATE_DIR, 'attachments')}/.+-image\\.png$`));
  expect(paths[1]).toMatch(/-notes\.txt$/);
  expect(readFileSync(paths[1], 'utf8')).toBe('hello from a file');
  await expect(pane.locator('.omp-card')).toHaveCount(0);
});

test('a final response that lands while you are elsewhere lights the pane until you look at it', async ({ page }) => {
  const workspace = await openWorkbench(page);
  const pane = await startedPane(page);
  const draft = pane.locator('textarea');
  const lookAway = () => page.mouse.move(5, 5); // the top bar, outside the pane
  /** Sends from the keyboard, so the pointer stays wherever it is. @param {string} text */
  const sendFromKeyboard = async (text) => {
    await draft.fill(text);
    await draft.press('Enter');
    await expect(pane.locator('.omp-assistant').last()).toContainText(text);
  };
  await lookAway();
  await sendFromKeyboard('first');
  await expect(pane).toHaveClass(/is-unread/);

  // Still unread after a reload: what was not seen is not forgotten.
  await page.reload();
  await expect(pane.locator('.omp-assistant').last()).toContainText('first');
  await expect(pane).toHaveClass(/is-unread/);

  const box = await pane.boundingBox();
  if (!box) throw new Error('pane not laid out');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(pane).not.toHaveClass(/is-unread/);
  // …and read stays read, even across a reload straight after.
  await lookAway();
  await page.reload();
  await expect(pane.locator('.omp-assistant').last()).toContainText('first');
  await caughtUp(page, workspace, pane);
  await expect(pane).not.toHaveClass(/is-unread/);

  // Scrolling the transcript reads it.
  await sendFromKeyboard('second');
  await expect(pane).toHaveClass(/is-unread/);
  await pane.locator('.omp-transcript').dispatchEvent('wheel');
  await expect(pane).not.toHaveClass(/is-unread/);

  // So does putting the cursor in the message box (without the mouse).
  await sendFromKeyboard('third');
  await expect(pane).toHaveClass(/is-unread/);
  await page.locator('#palette-toggle').focus();
  await draft.focus();
  await expect(pane).not.toHaveClass(/is-unread/);

  // Output that arrives while the pointer is over the pane is read as it comes.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await sendFromKeyboard('fourth');
  await caughtUp(page, workspace, pane);
  await expect(pane).not.toHaveClass(/is-unread/);

  // The middle of a turn (an intermediate reply, a tool run) is not news; its end is.
  await lookAway();
  await draft.fill('slow');
  await draft.press('Enter');
  await expect(pane.locator('.omp-assistant', { hasText: 'Let me check first.' })).toBeVisible();
  await expect(pane.locator('.omp-tool').last()).toBeVisible();
  await expect(pane).not.toHaveClass(/is-unread/);
  await expect(pane.locator('.omp-assistant').last()).toContainText('You said: slow');
  await expect(pane).toHaveClass(/is-unread/);
});

test('unread follows the daemon’s clock, whatever time the browser thinks it is', async ({ page }) => {
  await page.clock.setFixedTime(Date.now() + 60 * 60 * 1000); // the browser runs an hour fast
  await openWorkbench(page);
  const pane = await startedPane(page);
  await page.mouse.move(5, 5); // the top bar, outside the pane
  await pane.locator('textarea').fill('first');
  await pane.locator('textarea').press('Enter');
  await expect(pane.locator('.omp-assistant').last()).toContainText('first');
  await expect(pane).toHaveClass(/is-unread/);
});

test('TeX math renders as MathML: display math on its own line, inline math in the text, unreadable TeX as its source', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  const formula = String.raw`\text{P&L} = \underbrace{x(1-f),M}_{\text{user's input at market}} - \text{minOut} - \text{fees on our own swaps} - \text{gas}`;
  await send(pane, `So $$${formula}$$ and inline $x^2$ costs $5 and $10, but ${String.raw`$\frac{1$`} is broken.`);
  const prompt = pane.locator('.omp-user').last();
  const display = prompt.locator('.md-math.is-display math');
  await expect(display).toHaveCount(1);
  await expect(display).toHaveAttribute('display', 'block');
  await expect(display).toContainText('P&L'); // the bare & read as text
  const inline = prompt.locator('.md-math:not(.is-display) math');
  await expect(inline).toHaveCount(1);
  expect(await inline.evaluate((node) => getComputedStyle(/** @type {Element} */ (node.parentElement)).display)).toBe('inline');
  await expect(prompt).toContainText('costs $5 and $10');
  const broken = prompt.locator('.md-math-error');
  await expect(broken).toHaveText(String.raw`$\frac{1$`);
  expect(await broken.getAttribute('title')).toBeTruthy();
  await page.setViewportSize({ width: 1000, height: 420 });
  if (process.env.SHOT) await pane.screenshot({ path: process.env.SHOT });
});

test('a tool call is one card whose output appears when expanded', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  await send(pane, 'run a tool');
  const card = pane.locator('.omp-tool');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('bash');
  await card.locator('summary').click();
  await expect(card.locator('pre').last()).toHaveText('hi');
});

test('starting an agent puts the cursor in its message box, and starts it once', async ({ page }) => {
  await openWorkbench(page);
  let created = 0;
  page.on('request', (r) => void (r.method() === 'POST' && r.url().endsWith('/api/sessions') && created++));
  const pane = await addOmpPane(page);
  await pane.locator('input').fill(PROJECT);
  await pane.locator('input').press('Enter');
  await expect(pane.locator('textarea')).toBeFocused();
  await send(pane, 'hello');
  await expect(pane.locator('.omp-assistant', { hasText: 'You said: hello' })).toBeVisible();
  expect(created).toBe(1);
});

test('the top bar’s Config opens on hover or a click and shows only prompts and final replies in every agent window, across a reload', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  const reply = pane.locator('.omp-assistant', { hasText: 'You said: run a tool and think' });
  await send(pane, 'run a tool and think');
  await expect(reply).toBeVisible();
  await expect(pane.locator('.omp-tool')).toHaveCount(1);
  await expect(pane.locator('.omp-thinking')).toHaveCount(1);
  const other = await startedPane(page);
  await send(other, 'run a tool');
  await expect(other.locator('.omp-tool')).toHaveCount(1);

  // Resting the pointer on Config opens its menu; leaving closes it again.
  const config = page.getByRole('button', { name: 'Config' });
  const menu = page.locator('.config-menu');
  const only = menu.getByRole('checkbox', { name: 'Only prompts and responses' });
  await config.hover();
  await expect(menu).toBeVisible();
  const [button, opened] = [await config.boundingBox(), await menu.boundingBox()];
  expect(Math.abs((opened?.y ?? 0) - ((button?.y ?? 0) + (button?.height ?? 0))), 'right under its button').toBeLessThan(12);
  await expect(only).not.toBeChecked();
  await page.mouse.move(5, 300);
  await expect(menu).toBeHidden();

  // A click opens it to stay; the switch applies to every agent window.
  await config.click();
  await page.mouse.move(5, 300);
  await expect(menu).toBeVisible();
  await only.check();
  for (const p of [pane, other]) await expect(p.locator('.omp-tool')).toHaveCount(0);
  await expect(pane.locator('.omp-thinking')).toHaveCount(0);
  await expect(pane.locator('.omp-user')).toHaveText(/run a tool and think/);
  await expect(reply).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  // A running turn is one indicator: its tool run stays hidden, its narration shows.
  await send(pane, 'slow');
  await expect(pane.locator('.omp-working')).toHaveText('Working… 2 steps');
  await expect(pane.locator('.omp-tool')).toHaveCount(0);
  await expect(pane.getByText('Let me check first.')).toBeVisible();
  await expect(pane.locator('.omp-assistant').last()).toContainText('You said: slow');
  await expect(pane.locator('.omp-working')).toHaveCount(0);

  // The browser keeps the setting across a reload.
  await page.reload();
  await expect(pane.locator('.omp-assistant').last()).toContainText('You said: slow');
  await expect(pane.locator('.omp-tool')).toHaveCount(0);
  await expect(pane.locator('.omp-thinking')).toHaveCount(0);

  // Switching it off brings back everything it hid.
  await config.click();
  await expect(only).toBeChecked();
  await only.uncheck();
  await expect(pane.locator('.omp-tool')).toHaveCount(2);
  await expect(pane.locator('.omp-thinking')).toHaveCount(1);
  await expect(other.locator('.omp-tool')).toHaveCount(1);
});

test('an ask dialog is answered from the pane and omp continues with the answer', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  await send(pane, 'ask me');
  const dialog = pane.locator('.omp-dialogs');
  await expect(dialog.getByText('Which database?')).toBeVisible();
  await dialog.getByText('SQLite', { exact: true }).click();
  await dialog.getByRole('button', { name: 'Submit' }).click();
  await expect(pane.locator('.omp-assistant').last()).toHaveText('You picked SQLite.');
  await expect(dialog.getByText('Which database?')).toHaveCount(0);
});

test('frames the pane does not know and stdout that is not JSON are shown, not dropped', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  await send(pane, 'mystery garble');
  await expect(pane.locator('.omp-unrecognised', { hasText: 'mystery_frame' })).toHaveCount(1);
  const garbled = pane.locator('.omp-unrecognised', { hasText: /garbled|not a JSON object/ });
  await expect(garbled).toHaveCount(1);
  await garbled.locator('summary').click();
  await expect(garbled).toContainText('this line is not json');
});

test('a reload shows the same conversation in the same window', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  await send(pane, 'remember me');
  await expect(pane.locator('.omp-assistant').last()).toContainText('You said: remember me');
  await page.reload();
  const again = page.locator('.widget[data-widget="omp"]');
  await expect(again.locator('.omp-user')).toContainText('remember me');
  await expect(again.locator('.omp-assistant').last()).toContainText('You said: remember me');
  await expect(again.locator('.omp-assistant', { hasText: 'You said: remember me' })).toHaveCount(1);
});

test('two panes run separate sessions side by side', async ({ page }) => {
  await openWorkbench(page);
  const left = await startedPane(page);
  const right = await startedPane(page);
  await send(left, 'left only');
  await expect(left.locator('.omp-assistant').last()).toContainText('You said: left only');
  await send(right, 'right only');
  await expect(right.locator('.omp-assistant').last()).toContainText('You said: right only');
  await expect(left.getByText('right only')).toHaveCount(0);
  await expect(right.getByText('left only')).toHaveCount(0);
});

test('Fork continues a copy of the conversation in a new pane, as a session of its own', async ({ page }) => {
  const workspace = await openWorkbench(page);
  const source = await startedPane(page);
  const fork = source.getByRole('button', { name: 'Fork', exact: true });
  await expect(fork, 'omp has saved nothing yet').toBeDisabled();
  await send(source, 'shared start');
  await expect(source.locator('.omp-assistant').last()).toContainText('You said: shared start');

  const forked = await paneAddedBy(page, () => fork.click());
  await expect(forked.locator('.omp-user .omp-md')).toHaveText([/shared start$/]);
  await expect(forked.locator('.omp-assistant')).toHaveText([/You said: shared start/]);
  await expect(forked.getByText('Fake Model')).toBeVisible();

  await send(forked, 'fork only');
  await expect(forked.locator('.omp-assistant').last()).toContainText('You said: fork only');
  await send(source, 'source only');
  await expect(source.locator('.omp-assistant').last()).toContainText('You said: source only');
  await expect(source.locator('.omp-user .omp-md')).toHaveText([/shared start$/, /source only$/]);
  await expect(forked.locator('.omp-user .omp-md')).toHaveText([/shared start$/, /fork only$/]);

  // The window saves its own journal, not the source's, and drops the fork request: after a
  // daemon restart it shows the fork, and goes on with it, instead of forking again.
  await expect.poll(async () => (await savedParams(page, workspace, forked))?.sessionFile).toMatch(/\.jsonl$/);
  const [mine, theirs] = [await savedParams(page, workspace, forked), await savedParams(page, workspace, source)];
  expect(theirs.sessionFile).toMatch(/\.jsonl$/);
  expect(mine.sessionFile).not.toBe(theirs.sessionFile);
  expect(mine.fork).toBeNull();
});

test('windows only render: the daemon asks omp for the state and a fork’s history, never the page', async ({ page }) => {
  /** @type {string[]} */
  const asked = [];
  page.on('request', (r) => {
    if (r.url().endsWith('/rpc')) asked.push(r.postDataJSON()?.type);
  });
  await openWorkbench(page);
  const source = await startedPane(page);
  await send(source, 'shared start');
  await expect(source.locator('.omp-assistant').last()).toContainText('You said: shared start');
  const thinking = source.getByTitle('Choose thinking level');
  await thinking.click();
  await source.locator('.omp-menu:popover-open').getByRole('button', { name: 'high', exact: true }).click();
  await expect(thinking).toHaveText(/high/);

  const forked = await paneAddedBy(page, () => source.getByRole('button', { name: 'Fork', exact: true }).click());
  await expect(forked.locator('.omp-assistant')).toHaveText([/You said: shared start/]);
  await expect(forked.getByText('Fake Model')).toBeVisible();
  expect(asked).toEqual(['prompt', 'get_available_thinking_levels', 'set_thinking_level']);
});

test('dragging Send sends the message in a fork placed where it is dropped, and empties this box', async ({ page }) => {
  const workspace = await openWorkbench(page);
  const source = await startedPane(page);
  await send(source, 'shared start');
  await expect(source.locator('.omp-assistant').last()).toContainText('You said: shared start');
  const draft = source.locator('textarea');
  const sendBtn = source.getByRole('button', { name: 'Send', exact: true });
  const grid = await page.locator('#grid').boundingBox();
  const button = await sendBtn.boundingBox();
  if (!grid || !button) throw new Error('not laid out');
  const onSend = { x: button.x + button.width / 2, y: button.y + button.height / 2 };

  // Dropped on the grid's left edge: the fork goes left of this pane, not beside it as Fork's would.
  await draft.fill('fork only');
  const forked = await paneAddedBy(page, async () => {
    await page.mouse.move(onSend.x, onSend.y);
    await page.mouse.down();
    await page.mouse.move(grid.x + 10, grid.y + grid.height / 2, { steps: 12 });
    await expect(page.locator('.drop-indicator')).toHaveClass(/is-visible/);
    await page.mouse.up();
  });
  await expect(forked.locator('.omp-user .omp-md')).toHaveText([/shared start$/, /fork only$/]);
  await expect(forked.locator('.omp-assistant').last()).toContainText('You said: fork only');
  await expect(draft).toHaveValue('');
  const [mine, theirs] = [await forked.boundingBox(), await source.boundingBox()];
  expect(mine && theirs && mine.x < theirs.x).toBe(true);
  // Sent once: the window drops the message as it sends it, so a reload does not send it again.
  await expect.poll(async () => (await savedParams(page, workspace, forked))?.prompt).toBeNull();
  await page.reload();
  const again = page.locator(`.widget[data-id="${await forked.getAttribute('data-id')}"]`);
  await expect(again.locator('.omp-assistant').last()).toContainText('You said: fork only');
  await expect(again.locator('.omp-user .omp-md')).toHaveText([/shared start$/, /fork only$/]);

  // A drag called off with Esc and let go over Send sends nothing anywhere; the message stays.
  const box = page.locator(`.widget[data-id="${await source.getAttribute('data-id')}"] textarea`);
  await box.fill('stay here');
  await page.mouse.move(onSend.x, onSend.y);
  await page.mouse.down();
  await page.mouse.move(grid.x + 10, grid.y + grid.height / 2, { steps: 12 });
  await page.keyboard.press('Escape');
  await page.mouse.move(onSend.x, onSend.y, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('.widget[data-widget="omp"]')).toHaveCount(2);
  await expect(box).toHaveValue('stay here');
  await box.press('Enter');
  const home = page.locator(`.widget[data-id="${await source.getAttribute('data-id')}"]`);
  await expect(home.locator('.omp-assistant').last()).toContainText('You said: stay here');
  await expect(home.locator('.omp-user .omp-md')).toHaveText([/shared start$/, /stay here$/]);
});

test('a suggestion list open when Send is dragged into a fork closes as the box empties', async ({ page }) => {
  const project = mkdtempSync(join(tmpdir(), 'ac-e2e-fork-mention-'));
  writeFileSync(join(project, 'notes.md'), 'hi');
  await openWorkbench(page);
  const source = await startedPane(page, project);
  await send(source, 'shared start');
  await expect(source.locator('.omp-assistant').last()).toContainText('You said: shared start');
  const draft = source.locator('textarea');
  const list = source.locator('.omp-suggest');
  await draft.pressSequentially('see @');
  await expect(list.getByRole('option')).toHaveText(['notes.md']);
  const grid = await page.locator('#grid').boundingBox();
  const button = await source.getByRole('button', { name: 'Send', exact: true }).boundingBox();
  if (!grid || !button) throw new Error('not laid out');
  await paneAddedBy(page, async () => {
    await page.mouse.move(button.x + button.width / 2, button.y + button.height / 2);
    await page.mouse.down();
    await page.mouse.move(grid.x + 10, grid.y + grid.height / 2, { steps: 12 });
    await page.mouse.up();
  });
  await expect(draft).toHaveValue('');
  await expect(list).toBeHidden();
});

test('the window’s top bar names its conversation, and the name is saved with the window', async ({ page }) => {
  const workspace = await openWorkbench(page);
  const pane = await startedPane(page);
  const label = pane.locator('.widget-label');
  await expect(label, 'a new session has no name yet').toBeHidden();
  await send(pane, 'hi');
  // "hi" is too little for omp to name the session by.
  await expect(pane.locator('.omp-note.is-muted', { hasText: 'Could not generate a session title' })).toBeVisible();
  await expect(label, 'untitled: named by the first prompt').toHaveText('hi');
  await expect(pane.getByRole('heading', { name: 'Agent hi' })).toBeVisible();
  await expect.poll(async () => (await savedParams(page, workspace, pane))?.name).toBe('hi');
  await send(pane, '/rename Login fix');
  await expect(label, 'a title the user gives wins').toHaveText('Login fix');
  await expect.poll(async () => (await savedParams(page, workspace, pane))?.name).toBe('Login fix');
});

test('during the first turn the daemon titles the session, and one line of command output is a quiet note', async ({ page }) => {
  const workspace = await openWorkbench(page);
  const pane = await startedPane(page);
  const label = pane.locator('.widget-label');
  await send(pane, 'fix the login bug');
  await expect(label, 'the title omp generated').toHaveText('About fix the login bug');
  await expect.poll(async () => (await savedParams(page, workspace, pane))?.name).toBe('About fix the login bug');
  await expect(pane.locator('.omp-note.is-muted')).toHaveText(['command: Session renamed to About fix the login bug.']);
  await expect(pane.locator('.omp-command-output')).toHaveCount(0);
  await send(pane, 'and add tests');
  await expect(pane.locator('.omp-assistant').last()).toContainText('You said: and add tests');
  await expect(pane.getByText('idle')).toBeVisible();
  await expect(pane.locator('.omp-note', { hasText: 'Session renamed' }), 'asked once only').toHaveCount(1);

  // Output of several lines is the answer to read, shown open.
  await send(pane, '/dirs');
  await expect(pane.locator('.omp-command-output')).toContainText(/^Workspace directories:\n {2}\S.* \(working directory\)$/);

  // The title is the conversation's, not the window's: with its window closed, a Sessions
  // window opened afterwards lists it under that title.
  await expect.poll(async () => (await savedParams(page, workspace, pane))?.sessionFile).toMatch(/\.jsonl$/);
  const { session, sessionFile } = await savedParams(page, workspace, pane);
  await pane.locator('.widget-close').click();
  await page.locator('#palette-toggle').click();
  await page.locator('#palette [data-type="sessions"]').click();
  await page.keyboard.press('Escape');
  await expect(page.locator(`.sessions-item[data-key="${sessionFile}"] .sessions-title`)).toHaveText('About fix the login bug');
  await stopSession(page, session);
});

/** Sends `texts` one at a time, each once the reply before it is in. @param {import('@playwright/test').Locator} pane @param {string[]} texts */
async function conversation(pane, texts) {
  for (const [i, text] of texts.entries()) {
    await send(pane, text);
    await expect(pane.locator('.omp-assistant')).toHaveCount(i + 1);
  }
  await expect(pane.getByText('idle')).toBeVisible();
}

/** The user's prompts in `pane`, as shown. @param {import('@playwright/test').Locator} pane */
const prompts = (pane) => pane.locator('.omp-user .omp-md');

/** Clicks Rewind on the `n`th prompt of `pane`. @param {import('@playwright/test').Locator} pane @param {number} n */
async function rewindTo(pane, n) {
  const prompt = pane.locator('.omp-user').nth(n);
  await prompt.hover();
  await prompt.getByRole('button', { name: 'Rewind' }).click();
}

test('Rewind puts a prompt back in the box and marks what sending sets aside; Undo or Esc puts it all back, sending nothing', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  await conversation(pane, ['first question', 'second question', 'third question']);
  const draft = pane.locator('textarea');
  await draft.fill('half-written');
  /** @type {string[]} */
  const sent = [];
  page.on('request', (r) => {
    if (r.url().endsWith('/rpc')) sent.push(r.postDataJSON()?.type);
  });

  await rewindTo(pane, 1);
  await expect(draft).toHaveValue('second question');
  await expect(draft).toBeFocused();
  const bar = pane.locator('.omp-rewind-bar');
  await expect(bar).toContainText('sending sets aside 2 prompts');
  await expect(pane.locator('.omp-user').nth(1)).toHaveClass(/is-set-aside/);
  await expect(pane.locator('.omp-assistant').nth(2)).toHaveClass(/is-set-aside/);
  await expect(pane.locator('.omp-user').nth(0)).not.toHaveClass(/is-set-aside/);

  // Another prompt instead: the box it goes back to is still the one from before.
  await rewindTo(pane, 0);
  await expect(draft).toHaveValue('first question');
  await expect(bar).toContainText('sending sets aside 3 prompts');
  await draft.press('Escape');
  await expect(bar).toHaveCount(0);
  await expect(pane.locator('.is-set-aside')).toHaveCount(0);
  await expect(draft).toHaveValue('half-written');

  await rewindTo(pane, 2);
  await expect(bar).toContainText('sending sets aside 1 prompt and');
  await bar.getByRole('button', { name: 'Undo' }).click();
  await expect(bar).toHaveCount(0);
  await expect(draft).toHaveValue('half-written');
  await expect(prompts(pane)).toHaveText(['first question', 'second question', 'third question']);
  expect(sent).toEqual([]);
});

test('sending a reworded prompt rewinds omp to just before it, in every window showing the session', async ({ page }) => {
  const workspace = await openWorkbench(page);
  const pane = await startedPane(page);
  await conversation(pane, ['first question', 'second question', 'third question']);
  await expect.poll(async () => (await savedParams(page, workspace, pane))?.sessionFile).toMatch(/\.jsonl$/);
  const { session, sessionFile } = await savedParams(page, workspace, pane);
  // A second window showing the same conversation: Sessions shows it in the agent window used last.
  const other = await addOmpPane(page);
  await other.click();
  await page.locator('#palette-toggle').click();
  await page.locator('#palette [data-type="sessions"]').click();
  await page.keyboard.press('Escape');
  await page.locator(`.sessions-item[data-key="${sessionFile}"]`).click();
  await expect(prompts(other)).toHaveText(['first question', 'second question', 'third question']);

  await rewindTo(pane, 1);
  const draft = pane.locator('textarea');
  await draft.fill('second question, reworded');
  const branched = rpcSent(page, 'branch');
  await draft.press('Enter');
  await branched;
  for (const window of [pane, other]) {
    await expect(prompts(window)).toHaveText(['first question', 'second question, reworded']);
    await expect(window.locator('.omp-assistant').last()).toContainText('You said: second question, reworded');
    await expect(window.locator('.omp-assistant')).toHaveCount(2);
  }
  await expect(pane.locator('.omp-rewind-bar')).toHaveCount(0);
  await expect(draft).toHaveValue('');
  // omp goes on in a new journal, and both windows follow it there.
  for (const window of [pane, other]) {
    await expect.poll(async () => (await savedParams(page, workspace, window))?.sessionFile).not.toBe(sessionFile);
  }
  expect((await savedParams(page, workspace, pane)).sessionFile).toBe((await savedParams(page, workspace, other)).sessionFile);
  await stopSession(page, session);
});

test('a rewind is refused, sending nothing, when omp’s conversation no longer matches the window’s', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  // "drift": omp lists this prompt as if it had been reworded elsewhere.
  await conversation(pane, ['first question', 'drift question']);
  await rewindTo(pane, 1);
  const draft = pane.locator('textarea');
  await draft.fill('reworded');
  /** @type {string[]} */
  const sent = [];
  page.on('request', (r) => {
    if (r.url().endsWith('/rpc')) sent.push(r.postDataJSON()?.type);
  });
  await draft.press('Enter');
  await expect(pane.locator('.omp-note', { hasText: 'no longer matches' })).toBeVisible();
  expect(sent).toEqual(['get_branch_messages']);
  await expect(draft, 'the reworded prompt is given back').toHaveValue('reworded');
  await expect(prompts(pane)).toHaveText(['first question', 'drift question']);
  await expect(pane.locator('.omp-rewind-bar'), 'still pending, to Undo or try again').toBeVisible();
});

test('Up and Down in the message box step through what was sent, as in a shell', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  const draft = pane.locator('textarea');
  await send(pane, 'first');
  await expect(pane.locator('.omp-assistant').last()).toContainText('You said: first');
  await send(pane, '!echo hi');
  await expect(pane.locator('.omp-bash.is-ok')).toContainText('hi');
  await send(pane, 'third');
  await expect(pane.locator('.omp-assistant').last()).toContainText('You said: third');

  await draft.press('ArrowUp');
  await expect(draft).toHaveValue('third');
  await draft.press('ArrowUp');
  await expect(draft).toHaveValue('!echo hi');
  await expect(pane.locator('.omp-composer')).toHaveClass(/is-shell/); // recalled as the command it was
  await draft.press('ArrowUp');
  await expect(draft).toHaveValue('first');
  await draft.press('ArrowDown');
  await draft.press('ArrowDown');
  await expect(draft).toHaveValue('third');
  await draft.press('ArrowDown');
  await expect(draft).toHaveValue('');

  // Up never throws away what the user is writing.
  await draft.fill('my draft');
  await draft.press('ArrowUp');
  await expect(draft).toHaveValue('my draft');
});

test('while the agent works through its todo list, the toolbar shows how far it is', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  const progress = pane.locator('.omp-progress');
  await send(pane, 'slow todo'); // a three-task list, one done, then 1.5 s of work
  await expect(progress).toHaveText('1/3');
  await expect(progress).toHaveAttribute('title', '1 of 3 tasks done\nNow: Write the fix');
  await expect(progress.locator('progress')).toHaveJSProperty('value', 1);
  await expect(pane.getByText('idle')).toBeVisible();
  await expect(progress, 'no turn, no progress').toBeHidden();
});

test('a shell the agent backgrounds shows as running until its result comes', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  const running = pane.locator('.omp-running');
  await expect(running).toBeHidden();
  await send(pane, 'background'); // a backgrounded `./deploy.sh`, its result 2 s later
  await expect(pane.getByText('idle')).toBeVisible();
  await expect(running, 'the job runs on after the turn').toBeVisible();
  await expect(running.locator('.omp-chip')).toHaveCount(1);
  await expect(running.locator('.omp-chip-kind')).toHaveText('shell');
  await expect(running.locator('.omp-chip-text')).toHaveText('Deploying');
  await expect(running.locator('.omp-chip-time')).toHaveText(/^\d+s$/);
  await expect(running).toBeHidden();
});

test('a comment and a file waiting for the next prompt are kept with it across a reload', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  await send(pane, 'hello');
  await pane.locator('.omp-assistant').last().locator('strong').dblclick();
  await pane.getByRole('button', { name: 'Comment' }).click();
  const box = pane.getByRole('textbox', { name: 'Comment on the selected text' });
  await box.fill('why this word?');
  await box.press('Enter');
  const draft = pane.locator('textarea');
  await draft.evaluate((node) => {
    const data = new DataTransfer();
    data.items.add(new File(['notes'], 'notes.txt', { type: 'text/plain' }));
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(pane.locator('.omp-card.is-file')).not.toHaveClass(/is-uploading/);
  await draft.fill('and the next step?');

  await page.reload();
  await expect(draft).toHaveValue('and the next step?');
  await expect(pane.locator('.omp-card.is-comment')).toContainText('why this word?');
  await expect(pane.locator('.omp-card.is-file')).toContainText('notes.txt');

  const sent = page.waitForRequest((r) => r.url().endsWith('/rpc') && r.postDataJSON()?.type === 'prompt');
  await draft.press('Enter');
  const message = (await sent).postDataJSON().message;
  expect(message).toContain('> hello\n\nwhy this word?');
  expect(message).toContain('notes.txt');
  await expect(pane.locator('.omp-card')).toHaveCount(0);
  await page.reload();
  await expect(pane.locator('.omp-user').last()).toContainText('and the next step?');
  await expect(pane.locator('.omp-card'), 'sent: nothing comes back').toHaveCount(0);
});

/** The daemon's view of session `id`. @param {Page} page @param {string} id */
const daemonSession = async (page, id) => (await (await page.request.get('/api/sessions')).json()).sessions.find((/** @type {any} */ s) => s.id === id);

/** Stops session `id`, as the page would (the daemon wants the page's Origin). @param {Page} page @param {string} id */
const stopSession = (page, id) => page.evaluate((id) => fetch(`/api/sessions/${id}`, { method: 'DELETE' }).then(() => {}), id);

test('closing the window leaves its omp session running', async ({ page }) => {
  const workspace = await openWorkbench(page);
  const pane = await startedPane(page);
  const sessionOf = async () => (await savedLayout(page.request, workspace))?.params?.session;
  await expect.poll(sessionOf).toBeTruthy();
  const session = await sessionOf();
  /** @type {string[]} */
  const ended = [];
  page.on('request', (r) => {
    if (r.method() === 'DELETE') ended.push(r.url());
  });
  await pane.locator('.widget-close').click();
  // Saved once the window is gone, so after anything closing it would have sent.
  await expect.poll(() => savedLayout(page.request, workspace)).toBeNull();
  expect(ended).toEqual([]);
  expect((await daemonSession(page, session)).status).toBe('ready');
  await stopSession(page, session);
});

test('New starts another session in the window, in the same directory, and the one before keeps running', async ({ page }) => {
  const workspace = await openWorkbench(page);
  const pane = await startedPane(page);
  await send(pane, 'first conversation');
  await expect(pane.locator('.omp-assistant').last()).toContainText('You said: first conversation');
  const sessionOf = async () => (await savedParams(page, workspace, pane))?.session;
  await expect.poll(sessionOf).toBeTruthy();
  const before = await sessionOf();

  await pane.getByRole('button', { name: 'New', exact: true }).click();
  await expect(pane.locator('input')).toHaveValue(PROJECT);
  await pane.getByRole('button', { name: 'Start agent' }).click();
  await expect(pane.getByText('Fake Model')).toBeVisible();
  await expect.poll(sessionOf).not.toBe(before);
  await expect(pane.getByText('first conversation')).toHaveCount(0);
  expect((await daemonSession(page, before)).status).toBe('ready');
  await stopSession(page, before);
});

test('asleep, a window keeps showing its conversation; a message sent wakes it and goes once omp is up', async ({ page }) => {
  const workspace = await openWorkbench(page);
  const pane = await startedPane(page);
  await send(pane, 'remember me');
  await expect(pane.locator('.omp-assistant').last()).toContainText('You said: remember me');
  await expect.poll(async () => (await savedParams(page, workspace, pane))?.sessionFile).toMatch(/\.jsonl$/);
  const { session, sessionFile } = await savedParams(page, workspace, pane);

  // The daemon puts it to sleep, as it does once it is idle and unused for a while.
  await stopSession(page, session);
  await expect.poll(async () => (await daemonSession(page, session)).status).toBe('exited');
  await expect(pane.locator('.omp-user .omp-md')).toHaveText([/remember me$/]);
  await expect(pane.locator('.omp-banner'), 'going to sleep is not news').toBeHidden();
  await expect(pane.locator('textarea')).toBeEnabled();

  /** @type {string[]} */
  const asked = [];
  page.on('request', (r) => {
    if (r.url().endsWith('/rpc')) asked.push(r.postDataJSON()?.type);
  });
  await send(pane, 'and this');
  await expect(pane.locator('.omp-assistant').last()).toContainText('You said: and this');
  await expect(pane.locator('.omp-user .omp-md')).toHaveText([/remember me$/, /and this$/]);
  expect(asked, 'sent once, after it woke').toEqual(['prompt']);
  await expect.poll(async () => (await savedParams(page, workspace, pane))?.session).not.toBe(session);
  const woken = await savedParams(page, workspace, pane);
  expect(woken.sessionFile, 'the same conversation').toBe(sessionFile);
  expect((await daemonSession(page, woken.session)).sessionFile).toBe(sessionFile);
  await stopSession(page, woken.session);
});

test('Tab indents in the message box, Shift+Tab outdents, Cmd/Ctrl+Z undoes it; an @ list still takes Tab; Esc then Tab leaves', async ({ page }) => {
  const project = mkdtempSync(join(tmpdir(), 'ac-e2e-indent-'));
  writeFileSync(join(project, 'notes.md'), 'notes');
  await openWorkbench(page);
  const pane = await startedPane(page, project);
  const draft = pane.locator('textarea');
  /** The selected text. */
  const selection = () =>
    draft.evaluate((node) => {
      const a = /** @type {HTMLTextAreaElement} */ (node);
      return a.value.slice(a.selectionStart, a.selectionEnd);
    });

  // No selection: the indent goes in at the caret.
  await draft.pressSequentially('list');
  await draft.press('ArrowLeft');
  await draft.press('ArrowLeft');
  await draft.press('Tab');
  await expect(draft).toHaveValue('li  st');
  await expect(draft).toBeFocused();

  // A selection over lines: every line moves, and the same text stays selected.
  await draft.fill('- one\n- two');
  await draft.press('ControlOrMeta+a');
  await draft.press('Tab');
  await expect(draft).toHaveValue('  - one\n  - two');
  expect(await selection()).toBe('  - one\n  - two');
  await draft.press('Tab');
  await draft.press('Shift+Tab');
  await expect(draft).toHaveValue('  - one\n  - two');
  await draft.press('ControlOrMeta+z');
  await expect(draft).toHaveValue('    - one\n    - two');
  await draft.press('ControlOrMeta+z');
  await expect(draft).toHaveValue('  - one\n  - two');
  await draft.press('ControlOrMeta+Shift+z');
  await expect(draft).toHaveValue('    - one\n    - two');

  // An open @ list completes with Tab, as before.
  await draft.fill('read @no');
  await expect(pane.locator('.omp-suggest').getByRole('option')).toHaveText(['notes.md']);
  await draft.press('Tab');
  await expect(draft).toHaveValue('read @notes.md ');

  // Esc arms the next Tab to leave the box, which keeps its text.
  await draft.press('Escape');
  await draft.press('Tab');
  await expect(pane.getByRole('button', { name: 'Send' })).toBeFocused();
  await expect(draft).toHaveValue('read @notes.md ');
});
