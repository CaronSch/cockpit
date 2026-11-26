/**
 * The quote check of a deep research run (`/research`, the cockpit-research skill beside this
 * file): every finding in the run's notes names a page and quotes it, and this looks for each
 * quoted passage on its page, read again, so that the report cites only what its sources say.
 *
 * The agent leading the research imports it in its `eval` tool and calls `quoteCheck` with the
 * run's directory and its own read tool, after each wave of gatherers and again once the report
 * is written. Reading through the agent's tool gives a page as a gatherer saw it (PDFs converted),
 * whole from one fetch: the rest of a long page is read from what omp kept of that fetch. The
 * check reads the notes in `sources/*.md` (findings as research-gatherer.md has them written: a
 * `### claim`, then `- URL:` and `- Quote:` lines), keeps each page it read in `.pages/` (a later
 * run judges the same text), and compares passage and page with case, punctuation, line breaks
 * and hyphenation set aside. A site that limits requests answers some of them with part of a
 * page, so the pages of one site are read one after another, and a page that lacks a passage is
 * read once more. It writes `sources/quote-check.md` and returns what needs the agent: passages
 * only nearly found or not found, pages that refused, arXiv papers marked withdrawn, and the
 * links in `report.md` that no checked finding backs.
 *
 * It says that the words are on the page: not that the finding reads them fairly, nor that the
 * source is right.
 */
import { mkdir, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** What omp's read tool answers: the text it shows, and how it got it (untrusted: omp's own shape). @typedef {{ text: string, details?: any }} ReadResult */
/** The agent's read tool, by path, URL or internal URL. @typedef {(path: string) => Promise<ReadResult>} Read */
/** A finding of a notes file: what it claims, the page it names and its Quote lines. @typedef {{ file: string, claim: string, url: string, quotes: string[] }} Finding */
/** A page's text as passages are looked for in it: its words, and the same without the spaces. @typedef {{ spaced: string, tight: string }} PageText */
/** A page as read, or why it was not. @typedef {{ text: PageText } | { failed: string }} Page */
/** @typedef {'verbatim' | 'near' | 'not found' | 'page not fetched' | 'incomplete'} Status */
/** A finding as checked; `trouble` holds each passage not found whole, with the page's nearest text. @typedef {{ finding: Finding, status: Status, why: string, trouble: { passage: string, nearest: string }[] }} Checked */

/** How many words of a passage are looked for together when it is not on the page whole. */
const RUN_WORDS = 6;
/** From what share of its runs found a passage counts as nearly there. */
const NEAR_FROM = 0.5;
/**
 * The fewest words looked for by themselves: a shorter stretch between quote marks is part of its
 * line, and a shorter passage is not looked for with its spaces removed, where a few letters
 * match by chance.
 */
const MIN_WORDS = 4;
const SITES_AT_ONCE = 6;
/** How many lines of a long page are read at a time from what omp kept of it. */
const PART_LINES = 400;
/** The statuses a report may cite: `near` once its agent has read it. */
const CITABLE = new Set(['verbatim', 'near']);
/** @type {readonly Status[]} */
const STATUSES = ['verbatim', 'near', 'not found', 'page not fetched', 'incomplete'];

/**
 * Text as it is compared: lower case, letters and digits only (a `.` stays inside a number),
 * without accents, Markdown link targets, footnote marks or the page marks of a converted PDF.
 * @param {string} text
 */
export function normalize(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\]\([^)\s]*(?:\s+"[^"]*")?\)/g, '] ')
    .replace(/[\u00b9\u00b2\u00b3\u2070-\u2079]+/g, '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f'’‘`"“”*_]/g, '')
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ')
    .replace(/[^\p{L}\p{N}%$.]+/gu, ' ')
    .trim();
}

/** @param {string} text @returns {PageText} */
export function pageText(text) {
  const spaced = normalize(text);
  return { spaced: ` ${spaced} `, tight: spaced.replaceAll(' ', '') };
}

/**
 * How much of `passage` is on the page, 0 to 1: 1 when every stretch of it between ellipses is
 * there word for word (a word a line break or a PDF split in two still counts), else the share
 * of its runs of six words that are, of the stretch found least.
 * @param {string} passage @param {PageText} page
 */
export function matchPassage(passage, page) {
  const parts = passage.split(/\.{3}|…/).map(normalize).filter(Boolean);
  if (!parts.length) return 0;
  return Math.min(
    ...parts.map((part) => {
      const words = part.split(' ');
      if (page.spaced.includes(` ${part} `) || (words.length >= MIN_WORDS && page.tight.includes(words.join('')))) return 1;
      if (words.length < RUN_WORDS) return 0;
      const runs = words.length - RUN_WORDS + 1;
      let found = 0;
      for (let i = 0; i < runs; i++) if (page.spaced.includes(` ${words.slice(i, i + RUN_WORDS).join(' ')} `)) found++;
      return found / runs;
    }),
  );
}

/**
 * A Quote line against the page: how much of it is there (as `matchPassage`), and the passages
 * of it that are not there whole. The line is one passage; if it is not on the page as one, each
 * stretch of it between double quote marks is looked for by itself (a line quoting two passages,
 * or one that itself quotes), so the writer's own words between passages count against it.
 * @param {string} line @param {PageText} page @returns {{ score: number, missing: string[] }}
 */
export function matchQuote(line, page) {
  if (matchPassage(line, page) === 1) return { score: 1, missing: [] };
  const stretches = line.split(/["“”]/).map((s) => s.trim()).filter((s) => normalize(s).split(' ').length >= MIN_WORDS);
  const passages = stretches.length ? stretches : [line];
  const scores = passages.map((passage) => matchPassage(passage, page));
  return { score: Math.min(...scores), missing: passages.filter((_, i) => scores[i] < 1) };
}

/**
 * The page's text around the longest run of `passage` it holds, for a reader to compare ('' when
 * it holds none).
 * @param {string} passage @param {PageText} page
 */
export function nearestText(passage, page) {
  const words = normalize(passage).split(' ');
  for (const length of [8, 6, 4, 3]) {
    for (let i = 0; i + length <= words.length; i++) {
      const at = page.spaced.indexOf(` ${words.slice(i, i + length).join(' ')} `);
      if (at < 0) continue;
      const before = words.slice(0, i).join(' ').length + 40;
      return page.spaced.slice(Math.max(0, at - before), at + words.join(' ').length + 120).trim();
    }
  }
  return '';
}

/** The URL a URL line names: its first, without what was written after it. @param {string} line */
function urlOf(line) {
  const url = /https?:\/\/\S+/.exec(line)?.[0].replace(/[.,;>]+$/, '') ?? '';
  return url.endsWith(')') && !url.includes('(') ? url.slice(0, -1) : url;
}

/**
 * The findings of a notes file: each `### claim` before its Conflicts and Not found sections,
 * with the URL of its `- URL:` line and its `- Quote:` lines.
 * @param {string} text @param {string} file @returns {Finding[]}
 */
export function parseNotes(text, file) {
  const findings = text.split(/^##\s+(?:conflicts|not found)\b.*$/im)[0];
  return findings
    .split(/^###\s+/m)
    .slice(1)
    .map((block) => {
      const [claim = '', ...lines] = block.split('\n');
      /** @param {string} name */
      const field = (name) => [...lines.join('\n').matchAll(new RegExp(`^\\s*[-*]\\s*\\**${name}\\**[^:\\n]*:\\**\\s*(.*)$`, 'gim'))].map((m) => m[1].trim());
      return { file, claim: claim.trim(), url: urlOf(field('URL')[0] ?? ''), quotes: field('Quote').filter(Boolean) };
    });
}

/**
 * A finding against its page.
 * @param {Finding} finding @param {Page | undefined} page @returns {Checked}
 */
export function check(finding, page) {
  if (!finding.url || !finding.quotes.length || !page) return { finding, status: 'incomplete', why: finding.url ? 'no Quote line' : 'no URL line', trouble: [] };
  if ('failed' in page) return { finding, status: 'page not fetched', why: page.failed, trouble: [] };
  const matches = finding.quotes.map((quote) => matchQuote(quote, page.text));
  const least = Math.min(...matches.map((m) => m.score));
  const trouble = matches.flatMap((m) => m.missing).map((passage) => ({ passage, nearest: nearestText(passage, page.text) }));
  return { finding, status: least === 1 ? 'verbatim' : least >= NEAR_FROM ? 'near' : 'not found', why: '', trouble };
}

/** A URL as two spellings of it compare: without its fragment, percent-escapes or final slash. @param {string} url */
export function urlKey(url) {
  const plain = url.replace(/#.*$/, '');
  try {
    return decodeURI(plain).replace(/\/$/, '');
  } catch {
    return plain.replace(/\/$/, '');
  }
}

/** The pages a report links: its Markdown links to the web, once each. @param {string} report */
export const linksOf = (report) => [...new Set([...report.matchAll(/\]\((https?:\/\/[^\s()]+(?:\([^\s()]*\)[^\s()]*)*)\)/g)].map((m) => m[1]))];

/** @param {unknown} err */
const messageOf = (err) => (err instanceof Error ? err.message : String(err));

/**
 * The text of the page at `url`, whole. The read tool says how it got a page (`method`,
 * `notes`), which says when it did not: a refusal, or HTML no reader could make text of (a bot
 * check's page). It shows the start of a long page and keeps the rest, read here part by part.
 * @param {Read} read @param {string} url @returns {Promise<{ text: string } | { failed: string }>}
 */
async function readPage(read, url) {
  try {
    const first = await read(url);
    const details = first.details ?? {};
    if (details.method === 'failed' || details.method === 'raw-html') return { failed: Array.isArray(details.notes) && details.notes.length ? details.notes.join('; ') : 'the page could not be read' };
    const cut = details.meta?.truncation;
    let text = first.text;
    if (cut?.artifactId) {
      text = '';
      for (let from = 1; from <= cut.totalLines; ) {
        const part = await read(`artifact://${cut.artifactId}:raw:${from}-${from + PART_LINES - 1}`);
        text += `${part.text}\n`;
        const next = Number(part.details?.meta?.truncation?.nextOffset);
        from = next > from ? next : from + PART_LINES;
      }
    }
    return text.trim() ? { text } : { failed: 'the page is empty' };
  } catch (err) {
    return { failed: messageOf(err) };
  }
}

/** The arXiv paper a URL is of. @param {string} url */
const arxivId = (url) => /arxiv\.org\/(?:abs|html|pdf)\/(\d{4}\.\d{4,5})/.exec(url)?.[1] ?? null;

/**
 * arXiv's notice that paper `id` is withdrawn, with the authors' reason, or null when it is not:
 * its abstract page says so in its HTML, which a reader's text of the page leaves out.
 * @param {Read} read @param {string} id
 */
async function arxivWithdrawal(read, id) {
  const html = await read(`https://arxiv.org/abs/${id}:raw`).then(
    (page) => page.text,
    () => '',
  );
  const notice = /This paper has been withdrawn[^<]*/i.exec(html)?.[0].trim();
  if (!notice) return null;
  const comments = /<td class="tablecell comments[^"]*">([\s\S]*?)<\/td>/.exec(html)?.[1] ?? '';
  return `${notice}. ${comments.replace(/<[^>]+>/g, ' ')}`.replace(/\s+/g, ' ').trim();
}

/** The site a URL is of. @param {string} url */
function siteOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/**
 * `fn` of each of `urls`: a few sites at a time, the pages of one site one after another (a site
 * asked for several pages at once answers some in part, or refuses).
 * @param {readonly string[]} urls @param {(url: string) => Promise<void>} fn
 */
async function eachSite(urls, fn) {
  const sites = [...Map.groupBy(urls, siteOf).values()];
  const worker = async () => {
    for (let site = sites.shift(); site; site = sites.shift()) for (const url of site) await fn(url);
  };
  await Promise.all(Array.from({ length: SITES_AT_ONCE }, worker));
}

/** A cell of a Markdown table, or a line of the summary. @param {string} text @param {number} max */
const cell = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text).replaceAll('|', '/').replace(/\s+/g, ' ');

/** Notes files in the order they were numbered. @param {string} a @param {string} b */
const byNumber = (a, b) => (Number.parseInt(a, 10) || Infinity) - (Number.parseInt(b, 10) || Infinity) || a.localeCompare(b);

/**
 * Checks the research run in `dir` and writes `sources/quote-check.md`: what needs the agent,
 * to print.
 * @param {string} dir the run's directory (`~/research/<slug>`)
 * @param {Read} read the agent's read tool: `(path) => tool.read({ path })`
 * @returns {Promise<string>}
 */
export async function quoteCheck(dir, read) {
  const root = resolve(dir.replace(/^~(?=\/|$)/, homedir()));
  const sources = join(root, 'sources');
  const files = (await readdir(sources).catch(() => [])).filter((name) => name.endsWith('.md') && name !== 'quote-check.md').sort(byNumber);
  if (!files.length) throw new Error(`no notes in ${sources}`);
  /** @type {Finding[]} */
  const findings = [];
  for (const file of files) findings.push(...parseNotes(await Bun.file(join(sources, file)).text(), file));

  const urls = [...new Set(findings.map((f) => f.url).filter(Boolean))];
  /** arXiv's notice for each paper cited that is withdrawn. @type {Map<string, string>} */
  const withdrawals = new Map();
  for (const id of new Set(urls.flatMap((url) => arxivId(url) ?? []))) {
    const notice = await arxivWithdrawal(read, id);
    if (notice) withdrawals.set(id, notice);
  }
  /** arXiv's notice for the paper at `url`, if it is withdrawn. @param {string} url */
  const withdrawn = (url) => withdrawals.get(arxivId(url) ?? '') ?? null;

  // A page read once is kept: a later run of the same research judges the same text, and a site
  // that refuses the second time takes nothing back. A refusal is tried again.
  const kept = join(root, '.pages');
  await mkdir(kept, { recursive: true });
  /** @param {string} url */
  const keptFile = (url) => Bun.file(join(kept, `${new Bun.CryptoHasher('sha256').update(url).digest('hex').slice(0, 24)}.txt`));
  /** @type {Map<string, Page>} */
  const pages = new Map();
  /** The page at `url` as `text`. A withdrawn paper's abstract page says so, in the part of it a reader's text leaves out. @param {string} url @param {string} text @returns {Page} */
  const pageOf = (url, text) => {
    const notice = /arxiv\.org\/abs\//.test(url) ? withdrawn(url) : null;
    return { text: pageText(notice ? `${text}\n${notice}` : text) };
  };
  await eachSite(urls, async (url) => {
    const file = keptFile(url);
    if (await file.exists()) return void pages.set(url, pageOf(url, await file.text()));
    const page = await readPage(read, url);
    if ('text' in page) await Bun.write(file, page.text);
    pages.set(url, 'text' in page ? pageOf(url, page.text) : page);
  });

  // A page that lacks a passage may have been read in part: it is read once more, and what both
  // readings hold is kept if more of the passages are in it.
  /** How many of the passages quoted from `url` are not on `page` whole. @param {string} url @param {Page | undefined} page */
  const missing = (url, page) => findings.filter((f) => f.url === url).reduce((n, f) => n + check(f, page).trouble.length, 0);
  const doubtful = urls.filter((url) => missing(url, pages.get(url)) > 0);
  await eachSite(doubtful, async (url) => {
    const again = await readPage(read, url);
    if ('failed' in again) return;
    const both = `${await keptFile(url).text()}\n${again.text}`;
    const page = pageOf(url, both);
    if (missing(url, page) >= missing(url, pages.get(url))) return;
    await Bun.write(keptFile(url), both);
    pages.set(url, page);
  });

  const checked = findings.map((finding) => check(finding, pages.get(finding.url)));
  const counts = STATUSES.map((status) => `${checked.filter((c) => c.status === status).length} ${status}`).join(', ');
  /** @param {Checked} c */
  const title = (c) => `${c.finding.file} · ${cell(c.finding.claim, 110)}`;

  const doc = [
    '# Quote check',
    '',
    `**${counts}, of ${checked.length} findings on ${urls.length} pages.**`,
    '',
    'Each finding of the notes files, with its quoted passages looked for on the page its URL names, read again. Passage and page are compared without case, punctuation, line breaks or hyphenation. The check says the words are on the page; it does not say the finding reads them fairly, or that the source is right.',
    '',
    '- **verbatim**: every passage is on the page word for word.',
    '- **near**: most of the wording is there, broken by something the comparison does not see through (a footnote mark, a damaged PDF word, words left out without an ellipsis). To be read by hand before it is cited.',
    '- **not found**: a passage is not on the page as written.',
    '- **page not fetched**: the site refused, so nothing was checked.',
    '- **incomplete**: the finding names no URL, or quotes nothing.',
    '',
  ];
  for (const file of files) {
    doc.push(`## ${file}`, '', '| Check | Finding | URL |', '|---|---|---|');
    for (const c of checked.filter((x) => x.finding.file === file)) {
      doc.push(`| ${c.status}${withdrawn(c.finding.url) ? ' (WITHDRAWN on arXiv)' : ''} | ${cell(c.finding.claim, 140)} | ${c.finding.url} |`);
    }
    doc.push('');
  }
  const unsure = checked.filter((c) => c.trouble.length);
  if (unsure.length) {
    doc.push('## Passages not found whole', '');
    for (const c of unsure) {
      doc.push(`### ${title(c)}`, '', `${c.status} · ${c.finding.url}`, '');
      for (const t of c.trouble) doc.push(`- Quote: ${t.passage}`, `- Page: ${t.nearest || 'nothing like it'}`);
      doc.push('');
    }
  }
  await Bun.write(join(sources, 'quote-check.md'), `${doc.join('\n')}\n`);

  const out = [`Quote check: ${counts}, of ${checked.length} findings on ${urls.length} pages.`, `Written: ${join(sources, 'quote-check.md')}`];
  if (withdrawals.size) {
    out.push('', 'WITHDRAWN on arXiv (cite only to say so):');
    for (const [id, notice] of withdrawals) {
      out.push(`  https://arxiv.org/abs/${id}: ${notice}`);
      for (const c of checked.filter((x) => arxivId(x.finding.url) === id)) out.push(`    cited by ${title(c)}`);
    }
  }
  for (const [status, heading] of /** @type {const} */ ([
    ['near', 'NEAR (read each; cite it only if the page has the same text):'],
    ['not found', 'NOT FOUND (not citable as written):'],
  ])) {
    const of = checked.filter((c) => c.status === status);
    if (!of.length) continue;
    out.push('', heading);
    for (const c of of) {
      out.push(`  ${title(c)}`);
      for (const t of c.trouble) out.push(`    quote: ${cell(t.passage, 300)}`, `    page:  ${cell(t.nearest || 'nothing like it', 420)}`);
    }
  }
  const refused = urls.filter((url) => 'failed' in (pages.get(url) ?? {}));
  if (refused.length) {
    out.push('', 'PAGE NOT FETCHED (not citable):');
    for (const url of refused) {
      const page = pages.get(url);
      out.push(`  ${url}: ${page && 'failed' in page ? page.failed : ''} (${checked.filter((c) => c.finding.url === url).length} findings)`);
    }
  }
  const incomplete = checked.filter((c) => c.status === 'incomplete');
  if (incomplete.length) {
    out.push('', 'INCOMPLETE (not citable):');
    for (const c of incomplete) out.push(`  ${title(c)}: ${c.why}`);
  }

  const report = Bun.file(join(root, 'report.md'));
  if (await report.exists()) {
    /** The best check of each page, by its URL. @type {Map<string, Status>} */
    const best = new Map();
    for (const c of checked) {
      const key = urlKey(c.finding.url);
      const known = best.get(key);
      if (!known || STATUSES.indexOf(c.status) < STATUSES.indexOf(known)) best.set(key, c.status);
    }
    const links = linksOf(await report.text());
    const unbacked = links.filter((link) => !CITABLE.has(best.get(urlKey(link)) ?? ''));
    out.push('', `report.md: ${links.length} links, ${unbacked.length} not backed by a checked finding${unbacked.length ? ':' : '.'}`);
    for (const link of unbacked) out.push(`  ${link}: ${best.has(urlKey(link)) ? `its finding is "${best.get(urlKey(link))}"` : 'no finding names it'}`);
    const cited = links.filter((link) => withdrawn(link));
    if (cited.length) out.push('', 'report.md cites a withdrawn paper (it must say so):', ...cited.map((link) => `  ${link}`));
  }
  return out.join('\n');
}
