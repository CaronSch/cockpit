import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { citeLines, lineKey, lineKeys, parseDiff } from '../src/github/diff.js';
import { readableBody } from '../src/github/text.js';
import { BUGBOT_LOGIN, bugbotMessage, bugbotReviewSince, parseFinding } from '../src/github/bugbot.js';
import { completePull, completeRepo, matchPulls, matchRepos, pullQueryAt, resolveRepo } from '../src/github/pr-mention.js';
import { reviewMessage } from '../src/github/review.js';
import { REPO, pullOfUrl, splitRefs } from '../src/github/pr-refs.js';
/** @import { PullSummary } from '../daemon/wire.js' */

const DIFF = [
  'diff --git a/src/app.js b/src/app.js',
  'index 1111111..2222222 100644',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -10,4 +10,5 @@ export function start() {',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  ' return a;',
  '\\ No newline at end of file',
  'diff --git a/old/name.txt b/new/name.txt',
  'similarity index 90%',
  'rename from old/name.txt',
  'rename to new/name.txt',
  'diff --git a/gone.js b/gone.js',
  'deleted file mode 100644',
  '--- a/gone.js',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-one',
  '-two',
  'diff --git a/logo.png b/logo.png',
  'new file mode 100644',
  'Binary files /dev/null and b/logo.png differ',
  '',
].join('\n');

describe('a pull request diff', () => {
  const files = parseDiff(DIFF);

  test('is split into files that say how they changed', () => {
    assert.deepEqual(
      files.map((f) => [f.path, f.from, f.status, f.binary, f.additions, f.deletions]),
      [
        ['src/app.js', null, 'modified', false, 2, 1],
        ['new/name.txt', 'old/name.txt', 'renamed', false, 0, 0],
        ['gone.js', null, 'deleted', false, 0, 2],
        ['logo.png', null, 'added', true, 0, 0],
      ],
    );
  });

  test('numbers each line in the old file and the new one, counting from its hunk', () => {
    assert.deepEqual(
      files[0].hunks[0].lines.map((l) => [l.kind, l.old, l.new, l.text]),
      [
        ['context', 10, 10, 'const a = 1;'],
        ['del', 11, null, 'const b = 2;'],
        ['add', null, 11, 'const b = 3;'],
        ['add', null, 12, 'const c = 4;'],
        ['context', 12, 13, 'return a;'],
      ],
    );
  });

  test('a comment finds its line by side: removed lines on the left, added on the right, unchanged on both', () => {
    const [context, del, add] = files[0].hunks[0].lines;
    assert.deepEqual(lineKeys(context), [lineKey('RIGHT', 10), lineKey('LEFT', 10)]);
    assert.deepEqual(lineKeys(del), [lineKey('LEFT', 11)]);
    assert.deepEqual(lineKeys(add), [lineKey('RIGHT', 11)]);
  });

  test('highlighted lines are cited by the new file’s numbers, or the old file’s when only removed lines are', () => {
    const lines = files[0].hunks[0].lines;
    assert.equal(citeLines('src/app.js', lines.slice(1, 4)), 'src/app.js:11-12');
    assert.equal(citeLines('src/app.js', [lines[1]]), 'src/app.js:11 (before the change)');
    assert.equal(citeLines('src/app.js', []), 'src/app.js');
  });
});

describe('a GitHub comment body, to read', () => {
  test('loses HTML comments and tags but keeps their words', () => {
    const body = '<!-- marker -->\nFound **1** issue.<br>Next line\n\n<div><a href="x"><img alt="Fix"></a></div>\n\n<sup>Reviewed by [Bugbot](https://cursor.com)</sup>';
    assert.equal(readableBody(body), 'Found **1** issue.\nNext line\n\nReviewed by [Bugbot](https://cursor.com)');
  });

  test('keeps code exactly as written, angle brackets and comments included', () => {
    const body = 'Use `Array<string>` here.\n\n```html\n<div><!-- kept --></div>\n```\n<span>done</span>';
    assert.equal(readableBody(body), 'Use `Array<string>` here.\n\n```html\n<div><!-- kept --></div>\n```\ndone');
  });

  test('takes a generic type in prose for text, not a tag', () => {
    assert.equal(readableBody('returns Map<string, Pull> now'), 'returns Map<string, Pull> now');
  });
});

/** A Bugbot finding as it comments one on a line. */
const FINDING = [
  '### Cache never expires',
  '',
  '**Medium Severity**',
  '',
  '<!-- DESCRIPTION START -->',
  '`listPulls` keeps the first answer for good, so a pull request opened later is never offered.',
  '<!-- DESCRIPTION END -->',
  '',
  '<!-- BUGBOT_BUG_ID: 0000 -->',
  '',
  '<!-- LOCATIONS START',
  'daemon/github.js#L90-L96',
  'src/omp/pr-suggest.js#L40',
  'LOCATIONS END -->',
  '<div><a href="https://cursor.com/open"><picture><img alt="Fix in Cursor"></picture></a></div>',
].join('\n');

describe('Bugbot', () => {
  const review = (/** @type {number} */ id, /** @type {string} */ submittedAt, body = '<!-- BUGBOT_REVIEW -->\nCursor Bugbot has reviewed your changes and found 1 potential issue.', author = BUGBOT_LOGIN) => ({ id, author, body, submittedAt });

  test('the review that answers a request is Bugbot’s first current one since it was asked', () => {
    const reviews = [
      review(1, '2026-11-02T10:00:00Z'),
      review(2, '2026-11-02T10:05:00Z', '<!-- BUGBOT_REVIEW -->\n<!-- BUGBOT_REVIEW_STALE -->\nStale Bugbot comment from a previous run.'),
      review(3, '2026-11-02T10:06:00Z', 'Looks good', 'octocat'),
      review(4, '2026-11-02T10:07:00Z', 'no marker'),
      review(6, '2026-11-02T10:09:00Z'),
      review(5, '2026-11-02T10:08:00Z'),
    ];
    assert.equal(bugbotReviewSince(reviews, '2026-11-02T10:04:00Z')?.id, 5);
    assert.equal(bugbotReviewSince(reviews, '2026-11-02T10:10:00Z'), null);
  });

  test('a finding is read from its markers: title, severity, description and every place', () => {
    assert.deepEqual(parseFinding({ body: FINDING, path: 'daemon/github.js', line: 96, startLine: 90 }), {
      title: 'Cache never expires',
      severity: 'Medium Severity',
      description: '`listPulls` keeps the first answer for good, so a pull request opened later is never offered.',
      locations: ['daemon/github.js#L90-L96', 'src/omp/pr-suggest.js#L40'],
    });
  });

  test('a finding without markers is placed where its comment is', () => {
    const found = parseFinding({ body: '### Off by one\n\nThe loop stops a line early.', path: 'a.js', line: 7, startLine: 3 });
    assert.deepEqual(found, { title: 'Off by one', severity: null, description: 'The loop stops a line early.', locations: ['a.js#L3-L7'] });
  });

  test('the agent is told what Bugbot found on which pull request, each finding with where it is', () => {
    const message = bugbotMessage({
      number: 12,
      url: 'https://github.com/acme/widgets/pull/12',
      review: review(1, '2026-11-02T10:00:00Z'),
      comments: [{ body: FINDING, path: 'daemon/github.js', line: 96, startLine: 90 }],
    });
    assert.equal(
      message,
      [
        'Cursor Bugbot reviewed PR #12 (https://github.com/acme/widgets/pull/12): Cursor Bugbot has reviewed your changes and found 1 potential issue.',
        '1. **Cache never expires** (Medium Severity), `daemon/github.js#L90-L96`, `src/omp/pr-suggest.js#L40`\n\n`listPulls` keeps the first answer for good, so a pull request opened later is never offered.',
      ].join('\n\n'),
    );
  });
});

describe('# pull request mentions', () => {
  /** @param {number} number @param {string} title @returns {PullSummary} */
  const pr = (number, title) => ({ number, title, state: 'OPEN', isDraft: false, author: 'octo', headRefName: 'b', url: '', updatedAt: '' });
  const pulls = [pr(120, 'fix: cache never expires'), pr(12, 'feat: pull request window'), pr(7, 'docs: pull requests'), pr(1205, 'chore: bump')];

  test('the mention is a # at the start or after whitespace, up to the caret, for the conversation’s repository', () => {
    assert.deepEqual(pullQueryAt('see #12', 7), { start: 4, end: 7, repo: null, query: '12' });
    assert.deepEqual(pullQueryAt('#', 1), { start: 0, end: 1, repo: null, query: '' });
    assert.deepEqual(pullQueryAt('a\n#pull', 7), { start: 2, end: 7, repo: null, query: 'pull' });
    for (const text of ['x#y#12', '#12 ', '## heading', 'plain', 'https://github.com/a/b#', '-x#1']) assert.equal(pullQueryAt(text, text.length), null, text);
  });

  test('another repository goes before the # (name#, owner/name#) or right after it, then a colon', () => {
    assert.deepEqual(pullQueryAt('see k8s-infra#85', 16), { start: 4, end: 16, repo: 'k8s-infra', query: '85' });
    assert.deepEqual(pullQueryAt('blink-labs/k8s-infra#', 21), { start: 0, end: 21, repo: 'blink-labs/k8s-infra', query: '' });
    assert.deepEqual(pullQueryAt('see #k8s-infra:859', 18), { start: 4, end: 18, repo: 'k8s-infra', query: '859' });
    // No colon yet: part of a name, which suggests repositories as well as titles.
    assert.deepEqual(pullQueryAt('#k8s', 4), { start: 0, end: 4, repo: null, query: 'k8s' });
    assert.deepEqual(pullQueryAt('#:12', 4), { start: 0, end: 4, repo: null, query: ':12' });
  });

  test('digits match numbers that start with them; words match titles holding them all, those starting with them first', () => {
    assert.deepEqual(matchPulls(pulls, '12').map((p) => p.number), [120, 12, 1205]);
    assert.deepEqual(matchPulls(pulls, 'pull').map((p) => p.number), [12, 7]);
    assert.deepEqual(matchPulls(pulls, 'docs').map((p) => p.number), [7]);
    assert.deepEqual(matchPulls(pulls, 'cache-expires').map((p) => p.number), [120]);
    assert.deepEqual(matchPulls(pulls, '').map((p) => p.number), [120, 12, 7, 1205]);
  });

  const repos = ['blink-labs/eth-rpc', 'blink-labs/customer-ui', 'blink-labs/k8s-infra', 'blink-labs/infra-docs'].map((repo) => ({ repo, description: '' }));

  test('part of a name matches the other repositories holding it, those starting with it first; digits match none', () => {
    assert.deepEqual(matchRepos(repos, 'infra', 'blink-labs/eth-rpc').map((r) => r.repo), ['blink-labs/infra-docs', 'blink-labs/k8s-infra']);
    assert.deepEqual(matchRepos(repos, 'ETH', 'blink-labs/eth-rpc'), []);
    assert.deepEqual(matchRepos(repos, '8', null).map((r) => r.repo), []);
    assert.deepEqual(matchRepos(repos, 'k8s', null).map((r) => r.repo), ['blink-labs/k8s-infra']);
  });

  test('a typed repository is the owner’s one of that name, or named with its owner', () => {
    assert.equal(resolveRepo('K8s-Infra', repos), 'blink-labs/k8s-infra');
    assert.equal(resolveRepo('k8s', repos), null);
    assert.equal(resolveRepo('acme/widgets', repos), 'acme/widgets');
  });

  test('a picked pull request goes in as GitHub writes it, the caret after a space; a repository, as its name and #', () => {
    assert.equal(completePull(12, null, 'blink-labs/eth-rpc'), '#12 ');
    assert.equal(completePull(12, 'blink-labs/eth-rpc', 'blink-labs/eth-rpc'), '#12 ');
    assert.equal(completePull(859, 'blink-labs/k8s-infra', 'blink-labs/eth-rpc'), 'blink-labs/k8s-infra#859 ');
    assert.equal(completeRepo('blink-labs/k8s-infra', 'blink-labs/eth-rpc'), 'k8s-infra#');
    assert.equal(completeRepo('acme/widgets', 'blink-labs/eth-rpc'), 'acme/widgets#');
    assert.equal(completeRepo('acme/widgets', null), 'acme/widgets#');
  });
});

describe('a review sent to the agent', () => {
  const pull = { number: 12, title: 'feat: pull request window', url: 'https://github.com/acme/widgets/pull/12' };

  test('names the pull request, quotes each highlighted part with where it is, then the reviewer’s note', () => {
    const message = reviewMessage(pull, {
      notes: [
        { kind: 'comment', quote: 'const b = 3;', cite: 'src/app.js:11', text: 'Why 3?' },
        { kind: 'question', quote: 'Adds a window', cite: null, text: 'Is this tested?' },
      ],
      text: 'Otherwise fine.',
    });
    assert.equal(
      message,
      [
        'My review of PR #12 "feat: pull request window" (https://github.com/acme/widgets/pull/12):',
        'On `src/app.js:11`:\n> const b = 3;\n\nWhy 3?',
        'Question about this:\n> Adds a window\n\nIs this tested?',
        'Otherwise fine.',
      ].join('\n\n'),
    );
  });

  test('is nothing to send when nothing is written', () => {
    assert.equal(reviewMessage(pull, { notes: [], text: '  ' }), '');
  });
});

describe('pull requests named in text', () => {
  test('a link to any page of a pull request names it, with its repository', () => {
    assert.deepEqual(pullOfUrl('https://github.com/blink-labs/eth-rpc/pull/3841'), { repo: 'blink-labs/eth-rpc', number: 3841 });
    assert.deepEqual(pullOfUrl('https://github.com/blink-labs/k8s-infra/pull/860/files#diff-1'), { repo: 'blink-labs/k8s-infra', number: 860 });
    assert.deepEqual(pullOfUrl('https://github.com/acme/.github/pull/2?w=1'), { repo: 'acme/.github', number: 2 });
    for (const href of ['https://github.com/acme/widgets/issues/3', 'https://github.com/acme/widgets/pull/', 'https://gitlab.com/acme/widgets/pull/3', 'https://github.com/acme/../pull/3', 'http://github.com/acme/widgets/pull/3']) {
      assert.equal(pullOfUrl(href), null, href);
    }
  });

  test('#123 and owner/repo#123 are references on their own, not inside a word, a longer token or an anchor', () => {
    assert.deepEqual(splitRefs('stacked on #3841, see (#12) and blink-labs/k8s-infra#860.'), [
      { text: 'stacked on ' },
      { text: '#3841', number: 3841, repo: null },
      { text: ', see (' },
      { text: '#12', number: 12, repo: null },
      { text: ') and ' },
      { text: 'blink-labs/k8s-infra#860', number: 860, repo: 'blink-labs/k8s-infra' },
      { text: '.' },
    ]);
    assert.deepEqual(splitRefs('#7'), [{ text: '#7', number: 7, repo: null }]);
    for (const text of ['issue#12', 'color #fff', '#12abc', '#12-x', 'page.html#3', 'a/..#3', 'x/a/b#3', '']) assert.deepEqual(splitRefs(text), [{ text }], text);
  });

  test('a repository named outright is owner/name, never a path or a flag', () => {
    for (const ok of ['blink-labs/eth-rpc', 'acme/.github', 'a/b_c.d']) assert.ok(REPO.test(ok), ok);
    for (const bad of ['../x', 'acme/..', 'acme/.', '-R/x', 'acme', 'a/b/c', '']) assert.ok(!REPO.test(bad), bad);
  });
});
