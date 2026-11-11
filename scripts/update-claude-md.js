#!/usr/bin/env bun
/**
 * Regenerates the code-derived block of CLAUDE.md from the source tree, so a new
 * agent session starts from the app as it is, not as it was last described.
 *
 *   bun scripts/update-claude-md.js          rewrite the block in place
 *   bun scripts/update-claude-md.js --check  exit 1 if the block is stale
 *
 * Only the text between the markers is touched; everything else in CLAUDE.md is
 * hand-written and must be kept current by whoever changes the behaviour.
 */
import { join, resolve } from 'node:path';
/** @import { WidgetDef } from '../src/widgets/registry.js' */

const ROOT = resolve(import.meta.dir, '..');
const DOC = join(ROOT, 'CLAUDE.md');
const BEGIN = '<!-- BEGIN GENERATED: scripts/update-claude-md.js — do not edit by hand -->';
const END = '<!-- END GENERATED -->';

/** Paths (relative to the repo) of the files in `dir` matching `pattern`. @param {string} dir @param {string} pattern */
const listFiles = (dir, pattern) => [...new Bun.Glob(pattern).scanSync(join(ROOT, dir))].map((path) => `${dir}/${path}`).sort();

/**
 * First sentence of the module's leading doc comment: the first block comment
 * reached before any statement other than an import.
 * @param {string} source
 * @returns {string | null}
 */
function moduleSummary(source) {
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#!') || line.startsWith('import ')) continue;
    if (!line.startsWith('/**')) return null;
    const end = lines.findIndex((l, j) => j >= i && l.includes('*/'));
    const text = lines
      .slice(i, end + 1)
      .map((l) => l.replace(/^\s*\/\*\*\s?|\s*\*\/\s*$|^\s*\*\s?/g, '').trim())
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    return text.match(/^.*?\.(?=\s|$)/)?.[0] ?? text;
  }
  return null;
}

async function generate() {
  const sources = [...listFiles('src', '**/*.js'), ...listFiles('daemon', '**/*.js')];
  const modules = await Promise.all(
    sources.map(async (path) => {
      const summary = moduleSummary(await Bun.file(join(ROOT, path)).text());
      return `- \`${path}\` — ${summary ?? '**no module doc comment; add one**'}`;
    }),
  );

  const { WIDGETS } = await import(join(ROOT, 'src/widgets/registry.js'));
  /** @type {Readonly<Record<string, WidgetDef>>} */
  const registry = WIDGETS;
  const widgets = Object.values(registry).map((w) => `- \`${w.type}\` — ${w.title}: ${w.description}`);

  const { scripts } = await Bun.file(join(ROOT, 'package.json')).json();
  const commands = Object.entries(scripts).map(([name, cmd]) => `- \`bun run ${name}\` — \`${cmd}\``);

  const tests = listFiles('tests', '**/*.test.js').map((path) => `\`${path}\``);

  return [
    BEGIN,
    '',
    '### Modules (`src/` browser, `daemon/` local daemon)',
    '',
    ...modules,
    '',
    '### Registered widgets',
    '',
    ...widgets,
    '',
    '### Scripts',
    '',
    ...commands,
    '',
    '### Test suites',
    '',
    tests.join(', '),
    '',
    END,
  ].join('\n');
}

const doc = await Bun.file(DOC).text();
const start = doc.indexOf(BEGIN);
const stop = doc.indexOf(END);
if (start === -1 || stop === -1 || stop < start) {
  console.error(`[update-claude-md] CLAUDE.md is missing its generated-block markers:\n  ${BEGIN}\n  ${END}`);
  process.exit(2);
}

const next = doc.slice(0, start) + (await generate()) + doc.slice(stop + END.length);
if (process.argv.includes('--check')) {
  if (next !== doc) {
    console.error('[update-claude-md] CLAUDE.md is stale; run: bun run claude-md');
    process.exit(1);
  }
} else if (next !== doc) {
  await Bun.write(DOC, next);
}
