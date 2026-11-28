/**
 * The quote check's matching (daemon/research/skills/cockpit-research/quote-check.js): what
 * counts as a quoted passage being on its page. A report cites what this lets through, so it
 * must see through how a page's text differs from a quotation of it, and through nothing else.
 */
import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, linksOf, pageText, parseNotes, quoteCheck, refusedUrl, urlKey } from '../daemon/research/skills/cockpit-research/quote-check.js';

/**
 * How a finding quoting `quotes` checks against a page of `page`.
 * @param {string} page @param {...string} quotes
 */
const statusOf = (page, ...quotes) => check({ file: 'notes.md', claim: 'claim', url: 'https://example.org/', quotes }, { text: pageText(page) }).status;

test('a passage is on the page whatever its case, punctuation, line breaks and hyphenation', () => {
  const page = 'Results.\nOver-\nconfidence is greatest for diffi cult tasks, for fore-\ncasts with low predictability.';
  expect(statusOf(page, '"Overconfidence is greatest for difficult tasks, for forecasts with low predictability."')).toBe('verbatim');
});

test('link targets, footnote marks and PDF page marks on the page are not part of its text', () => {
  const page = 'It applies under [Article 6](/article/6/)(2) and [Annex III](/annex/3/ "Annex") to\n<!-- Page 4 -->\nhigh-risk systems.¹²';
  expect(statusOf(page, 'It applies under Article 6(2) and Annex III to high-risk systems.')).toBe('verbatim');
});

test('a changed figure is not on the page', () => {
  const page = 'The rate of death was 1.5% before the checklist was introduced and declined to 0.8% afterward.';
  expect(statusOf(page, 'The rate of death was 1.5% before the checklist was introduced and declined to 0.8% afterward.')).toBe('verbatim');
  expect(statusOf(page, 'The rate of death was 15% before the checklist was introduced and declined to 0.8% afterward.')).not.toBe('verbatim');
  expect(statusOf('Most portfolio managers continue to rely on Excel.', '95% of portfolio managers rely on Excel.')).toBe('not found');
});

test('words left out count against a passage unless an ellipsis marks them', () => {
  const page = 'A simple prompt achieves a performance of 52%, which is lower than the analyst benchmark. However, with the chain-of-thought prompt we find that it achieves an accuracy of 60%.';
  expect(statusOf(page, 'A simple prompt achieves a performance of 52%... However, with the chain-of-thought prompt we find that it achieves an accuracy of 60%.')).toBe('verbatim');
  expect(statusOf(page, 'A simple prompt achieves a performance of 52%. However, with the chain-of-thought prompt we find that it achieves an accuracy of 60%.')).toBe('near');
});

test('a Quote line may hold several passages, but none of its writer’s own words', () => {
  const page = 'Good investment ideas are rare and valuable things. Much later: a bargain should be inspected and reinspected for possible flaws.';
  expect(statusOf(page, '"Good investment ideas are rare and valuable things." Also: "A bargain should be inspected and reinspected for possible flaws."')).toBe('verbatim');
  expect(statusOf(page, '"Good investment ideas are rare and valuable things." The author adds that most ideas fail within a year.')).toBe('not found');
  // A passage that itself quotes is still one passage.
  expect(statusOf('The “Risk Factors” section includes information about significant risks.', '“Risk Factors” section includes information about significant risks.')).toBe('verbatim');
});

test('a finding is checked by its weakest quote, and is incomplete without a URL or a quote', () => {
  const page = { text: pageText('Only this sentence is on the page, and nothing else at all.') };
  const finding = { file: 'notes.md', claim: 'claim', url: 'https://example.org/', quotes: ['Only this sentence is on the page, and nothing else at all.', 'A sentence that the page does not hold anywhere.'] };
  expect(check(finding, page).status).toBe('not found');
  expect(check({ ...finding, quotes: [] }, page).status).toBe('incomplete');
  expect(check({ ...finding, url: '' }, undefined).status).toBe('incomplete');
  expect(check(finding, { failed: 'HTTP 403' }).status).toBe('page not fetched');
});

test('notes are read as gatherers write them, up to their Conflicts and Not found sections', () => {
  const notes = [
    '# Sub-question',
    '',
    '## Findings',
    '',
    '### The first claim',
    '- Source: A paper — Someone, 2024',
    '- URL: https://example.org/a_(b).pdf (opened; a copy)',
    '- Quote: "One passage."',
    '- Quote: Another passage.',
    '- Kind: academic',
    '',
    '### A claim with no quote',
    '- URL: <https://example.org/c>',
    '',
    '## Not found',
    '',
    '### Not a finding',
    '- URL: https://example.org/d',
    '- Quote: "Never checked."',
  ].join('\n');
  expect(parseNotes(notes, 'notes.md')).toEqual([
    { file: 'notes.md', claim: 'The first claim', url: 'https://example.org/a_(b).pdf', quotes: ['"One passage."', 'Another passage.'] },
    { file: 'notes.md', claim: 'A claim with no quote', url: 'https://example.org/c', quotes: [] },
  ]);
});

test('a report’s links are matched to findings whatever the spelling of their URL', () => {
  expect(linksOf('See [one](https://example.org/a_(b).pdf), [two](https://example.org/x%29.pdf) and [one again](https://example.org/a_(b).pdf); not ![an image](/local.png).')).toEqual([
    'https://example.org/a_(b).pdf',
    'https://example.org/x%29.pdf',
  ]);
  expect(urlKey('https://example.org/x%29.pdf#page=2')).toBe(urlKey('https://example.org/x).pdf'));
  expect(urlKey('https://example.org/path/')).toBe(urlKey('https://example.org/path'));
});

test('only the public web is read: no local, numeric, intranet or credentialed address', () => {
  for (const url of [
    'https://example.org/page',
    'http://sub.example.co.uk/a/b?c=d#e',
    'https://www.ft.com/content/abc',
    'https://example.org./trailing-dot-is-still-public',
  ]) expect(refusedUrl(url)).toBeNull();
  for (const url of [
    'file:///etc/passwd',
    'ftp://example.org/x',
    'http://localhost/x',
    'http://cockpit.localhost/?token=abc',
    'http://printer.local/x',
    'http://db.internal/x',
    'http://intranet/x',
    'http://127.0.0.1/x',
    'http://2130706433/x', // 127.0.0.1 as one number
    'http://0x7f.0.0.1/x',
    'http://0177.0.0.1/x',
    'http://169.254.169.254/latest/meta-data/',
    'http://192.168.0.1/',
    'http://[::1]/x',
    'http://[::ffff:127.0.0.1]/x',
    'https://example.org:8443/x',
    'https://user:pass@example.org/x',
    'not a url',
  ]) expect(refusedUrl(url)).not.toBeNull();
});

test('a URL that is not the public web is never handed to the read tool, and its finding is not citable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quote-check-test-'));
  try {
    await mkdir(join(dir, 'sources'));
    await writeFile(
      join(dir, 'sources', '1-notes.md'),
      [
        '# Notes',
        '',
        '## Findings',
        '',
        '### A public page',
        '- URL: https://example.org/page',
        '- Quote: The public page says that the quoted passage is present on it.',
        '',
        '### A page a hostile page chose',
        '- URL: http://127.0.0.1:4777/api/secret',
        '- Quote: The private page says that the quoted passage is present on it.',
        '',
      ].join('\n'),
    );
    /** @type {string[]} */
    const asked = [];
    const read = async (/** @type {string} */ path) => {
      asked.push(path);
      return { text: 'The public page says that the quoted passage is present on it.', details: { method: 'native' } };
    };
    const out = await quoteCheck(dir, read);
    expect(asked).toEqual(['https://example.org/page']);
    expect(out).toContain('1 verbatim');
    expect(out).toContain('1 page not fetched');
    expect(out).toContain('not read: the host is an IP address');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
