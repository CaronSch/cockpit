import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { parseInline, parseMarkdown, safeHref } from '../src/omp/markdown.js';

describe('blocks', () => {
  test('headings, paragraphs with line breaks, and rules', () => {
    assert.deepEqual(parseMarkdown('## Plan\n\nfirst line\nsecond line\n\n---'), [
      { type: 'heading', level: 2, children: [{ type: 'text', text: 'Plan' }] },
      { type: 'paragraph', children: [{ type: 'text', text: 'first line' }, { type: 'break' }, { type: 'text', text: 'second line' }] },
      { type: 'rule' },
    ]);
  });

  test('fenced code keeps its language and content verbatim', () => {
    assert.deepEqual(parseMarkdown('```js\nconst a = `**x**`;\n\n<b>hi</b>\n```\nafter'), [
      { type: 'code', lang: 'js', text: 'const a = `**x**`;\n\n<b>hi</b>' },
      { type: 'paragraph', children: [{ type: 'text', text: 'after' }] },
    ]);
  });

  test('an unterminated fence (still streaming) runs to the end', () => {
    assert.deepEqual(parseMarkdown('```\nline 1\nline 2'), [{ type: 'code', lang: '', text: 'line 1\nline 2' }]);
  });

  test('bullet and numbered lists, with nesting', () => {
    const [list] = parseMarkdown('3. one\n4. two\n   - nested');
    assert.equal(list.type, 'list');
    assert.ok(list.type === 'list');
    assert.equal(list.ordered, true);
    assert.equal(list.start, 3);
    assert.equal(list.items.length, 2);
    assert.deepEqual(list.items[1][1], { type: 'list', ordered: false, start: 1, items: [[{ type: 'paragraph', children: [{ type: 'text', text: 'nested' }] }]] });
  });

  test('block quotes parse their contents', () => {
    assert.deepEqual(parseMarkdown('> **note**\n> more'), [
      {
        type: 'quote',
        children: [{ type: 'paragraph', children: [{ type: 'strong', children: [{ type: 'text', text: 'note' }] }, { type: 'break' }, { type: 'text', text: 'more' }] }],
      },
    ]);
  });

  test('a table becomes header and body cells, with inline formatting in the cells', () => {
    /** @param {string} text */
    const t = (text) => ({ type: 'text', text });
    assert.deepEqual(parseMarkdown('| When | What happens | Code |\n|---|---|---|\n| Now | Stuff **happened** | `tracked.rs:67` |'), [
      {
        type: 'table',
        align: [null, null, null],
        head: [[t('When')], [t('What happens')], [t('Code')]],
        rows: [[[t('Now')], [t('Stuff '), { type: 'strong', children: [t('happened')] }], [{ type: 'code', text: 'tracked.rs:67' }]]],
        source: '| When | What happens | Code |\n|---|---|---|\n| Now | Stuff **happened** | `tracked.rs:67` |',
      },
    ]);
  });

  test('alignment, missing outer pipes, escaped pipes, and rows padded or cut to the header', () => {
    const [table] = parseMarkdown('a | b | c\n:--|:-:|--:\n1 \\| 2 | x\n1 | 2 | 3 | 4');
    assert.ok(table.type === 'table');
    assert.deepEqual(table.align, ['left', 'center', 'right']);
    const text = (/** @type {any} */ cell) => cell.map((/** @type {any} */ n) => n.text).join('');
    assert.deepEqual(table.rows.map((row) => row.map(text)), [['1 | 2', 'x', ''], ['1', '2', '3']]);
  });

  test('a table can start right under a paragraph line, and a mismatched divider is not one', () => {
    assert.deepEqual(parseMarkdown('Here it is:\n| a | b |\n|---|---|').map((b) => b.type), ['paragraph', 'table']);
    assert.deepEqual(parseMarkdown('a | b\n---').map((b) => b.type), ['paragraph', 'rule'], 'a rule under text with a pipe');
    assert.deepEqual(parseMarkdown('| a | b |\n|---|').map((b) => b.type), ['paragraph']);
  });

  test("a table's source is its own lines as written, without a paragraph above, text after, or quote markers", () => {
    const [, table] = parseMarkdown('Here it is:\n|a|b \\| c|\n|:-|-:|\n| 1 |  **2** |\n\nafter');
    assert.ok(table.type === 'table');
    assert.equal(table.source, '|a|b \\| c|\n|:-|-:|\n| 1 |  **2** |');
    const [quote] = parseMarkdown('> Note:\n> | a | b |\n> |---|---|\n> | 1 | 2 |\n\n| x |\n|---|');
    assert.ok(quote.type === 'quote' && quote.children[1].type === 'table');
    assert.equal(quote.children[1].source, '| a | b |\n|---|---|\n| 1 | 2 |');
  });
});

describe('inline', () => {
  test('code, bold and italic', () => {
    assert.deepEqual(parseInline('use `a*b*c` and **bold** or *it*'), [
      { type: 'text', text: 'use ' },
      { type: 'code', text: 'a*b*c' },
      { type: 'text', text: ' and ' },
      { type: 'strong', children: [{ type: 'text', text: 'bold' }] },
      { type: 'text', text: ' or ' },
      { type: 'em', children: [{ type: 'text', text: 'it' }] },
    ]);
  });

  test('snake_case identifiers and lone asterisks stay text', () => {
    assert.deepEqual(parseInline('call my_func_name with 2 * 3'), [{ type: 'text', text: 'call my_func_name with 2 * 3' }]);
  });

  test('raw HTML is plain text, never markup', () => {
    assert.deepEqual(parseMarkdown('<img src=x onerror=alert(1)>'), [
      { type: 'paragraph', children: [{ type: 'text', text: '<img src=x onerror=alert(1)>' }] },
    ]);
  });

  test('backslash escapes', () => {
    assert.deepEqual(parseInline('\\*not em\\*'), [{ type: 'text', text: '*not em*' }]);
  });
});

describe('link safety', () => {
  test('http, https and mailto links become links', () => {
    assert.deepEqual(parseInline('[docs](https://example.com/a?b=1) <mailto:me@example.com>'), [
      { type: 'link', href: 'https://example.com/a?b=1', children: [{ type: 'text', text: 'docs' }] },
      { type: 'text', text: ' ' },
      { type: 'link', href: 'mailto:me@example.com', children: [{ type: 'text', text: 'me@example.com' }] },
    ]);
  });

  test('javascript:, data: and relative targets keep only their label', () => {
    assert.deepEqual(parseInline('[x](javascript:alert(1))'), [{ type: 'text', text: 'x' }]);
    assert.deepEqual(parseInline('[w](https://en.wikipedia.org/wiki/A_(b))'), [
      { type: 'link', href: 'https://en.wikipedia.org/wiki/A_(b)', children: [{ type: 'text', text: 'w' }] },
    ]);
    assert.deepEqual(parseInline('[y](data:text/html,hi)'), [{ type: 'text', text: 'y' }]);
    assert.deepEqual(parseInline('[z](/etc/passwd)'), [{ type: 'text', text: 'z' }]);
    assert.equal(safeHref('JaVaScRiPt:alert(1)'), null);
    assert.equal(safeHref('java\tscript:alert(1)'), null);
  });

  test('an image file on this machine is an image; a remote or relative one is never fetched', () => {
    assert.deepEqual(parseInline('see ![p90 [hourly]](/Users/me/chart.png) here'), [
      { type: 'text', text: 'see ' },
      { type: 'image', path: '/Users/me/chart.png', alt: 'p90 [hourly]' },
      { type: 'text', text: ' here' },
    ]);
    assert.deepEqual(parseInline('![x](~/out/a.JPEG)'), [{ type: 'image', path: '~/out/a.JPEG', alt: 'x' }]);
    assert.deepEqual(parseInline('![x](https://evil.example/?q=secret.png)'), [
      { type: 'text', text: '!' },
      { type: 'link', href: 'https://evil.example/?q=secret.png', children: [{ type: 'text', text: 'x' }] },
    ]);
    /** @param {string} source */
    const text = (source) => parseInline(source).map((n) => (n.type === 'text' ? n.text : n.type)).join('');
    assert.equal(text('![x](chart.png)'), '!x');
    assert.equal(text('![x](/etc/passwd)'), '!x', 'only image files');
  });

  test('bare URLs are linked without trailing punctuation', () => {
    assert.deepEqual(parseInline('see https://example.com/x.'), [
      { type: 'text', text: 'see ' },
      { type: 'link', href: 'https://example.com/x', children: [{ type: 'text', text: 'https://example.com/x' }] },
      { type: 'text', text: '.' },
    ]);
  });
});

describe('visuals', () => {
  test('a closed mermaid or vega-lite fence is a visual; one still streaming, or any other language, is code', () => {
    assert.deepEqual(parseMarkdown('```mermaid\nflowchart LR\n  A --> B\n```'), [{ type: 'visual', lang: 'mermaid', source: 'flowchart LR\n  A --> B' }]);
    assert.deepEqual(parseMarkdown('```vega-lite\n{"mark": "bar"}\n```\nafter'), [
      { type: 'visual', lang: 'vega-lite', source: '{"mark": "bar"}' },
      { type: 'paragraph', children: [{ type: 'text', text: 'after' }] },
    ]);
    assert.deepEqual(parseMarkdown('```mermaid\nflowchart LR'), [{ type: 'code', lang: 'mermaid', text: 'flowchart LR' }]);
    assert.deepEqual(parseMarkdown('```vega\n{}\n```'), [{ type: 'code', lang: 'vega', text: '{}' }]);
  });
});

describe('math', () => {
  const math = (/** @type {string} */ tex, display = false) => ({ type: 'math', tex, display });

  test('$$…$$ and \\[…\\] are display math, across lines too; $…$ and \\(…\\) are inline', () => {
    assert.deepEqual(parseMarkdown('$$\na + b\n= c\n$$'), [{ type: 'paragraph', children: [math('a + b\n= c', true)] }]);
    assert.deepEqual(parseInline('so \\[x^2\\] and \\(y\\), or $z_1$.'), [
      { type: 'text', text: 'so ' },
      math('x^2', true),
      { type: 'text', text: ' and ' },
      math('y'),
      { type: 'text', text: ', or ' },
      math('z_1'),
      { type: 'text', text: '.' },
    ]);
  });

  test('prices stay text: a single $ needs no space inside it and no digit after the closing one', () => {
    assert.deepEqual(parseInline('costs $5 and $10'), [{ type: 'text', text: 'costs $5 and $10' }]);
    assert.deepEqual(parseInline('$ x $ and $x$5'), [{ type: 'text', text: '$ x $ and $x$5' }]);
    assert.deepEqual(parseInline('escaped \\$x$'), [{ type: 'text', text: 'escaped $x$' }]);
    assert.deepEqual(parseInline('$5 and $10, then $y$'), [{ type: 'text', text: '$5 and $10, then ' }, math('y')]);
  });

  test('inline math stays on its line; code and unterminated delimiters stay text', () => {
    assert.deepEqual(parseInline('$a\nb$'), [{ type: 'text', text: '$a' }, { type: 'break' }, { type: 'text', text: 'b$' }]);
    assert.deepEqual(parseInline('`$x$`'), [{ type: 'code', text: '$x$' }]);
    assert.deepEqual(parseInline('$$x and \\[y'), [{ type: 'text', text: '$$x and [y' }]);
    assert.deepEqual(parseMarkdown('```\n$$x$$\n```'), [{ type: 'code', lang: '', text: '$$x$$' }]);
  });
});
