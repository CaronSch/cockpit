#!/usr/bin/env bun
/**
 * Scripted stand-in for the GitHub CLI (`gh`), for daemon and browser tests: it answers the
 * commands the daemon runs (daemon/github.js) from a `.fake-gh.json` in the directory it runs in
 * or one above it, as `gh` finds a repository from its git checkout, and writes what it is told
 * to do back there. Without one, it fails as `gh` does outside a repository. A command that
 * names its repository (`-R owner/name`, `api repos/owner/name/…`) reads the one checked out at
 * `$FAKE_GH_ROOT/owner/name`, as `gh` finds any repository on GitHub, and fails as `gh` does for
 * one that does not exist. `repo list owner` lists the repositories checked out under
 * `$FAKE_GH_ROOT/owner/`. `api user --jq .login` names the account signed in: `$FAKE_GH_USER`.
 *
 * `.fake-gh.json`: `{ repo: 'owner/name', description?, pushedAt?, pulls: [Pull-like objects,
 * with `diff` and `reviewComments` in GitHub's REST shape], bugbot?: { afterMs, body, comments } }`. Commenting
 * `bugbot go` makes Cursor Bugbot "review" `afterMs` later, with that body and those line
 * comments; comments made are kept in `issueComments`, Bugbot's reviews in `botReviews`.
 *
 * Shapes and error messages follow gh 2.103.3 and GitHub's REST API, in the fields the daemon reads.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);

/** @param {string} message @returns {never} */
function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** The `.fake-gh.json` of the repository the command names, else of the directory or one above it. */
function stateFile() {
  const named = option('-R') ?? /^repos\/([^/]+\/[^/]+)\//.exec(args[0] === 'api' ? (args[1] ?? '') : '')?.[1];
  if (named) {
    const file = join(process.env.FAKE_GH_ROOT ?? fail('fake gh: FAKE_GH_ROOT is not set'), named, '.fake-gh.json');
    return existsSync(file) ? file : fail(`GraphQL: Could not resolve to a Repository with the name '${named}'. (repository)`);
  }
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const file = join(dir, '.fake-gh.json');
    if (existsSync(file)) return file;
    if (dirname(dir) === dir) return null;
  }
}

/** @param {string} name */
const option = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? null : args[at + 1];
};

/** @param {unknown} value */
const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

const nowIso = () => new Date().toISOString();
// An owner's repositories: those checked out under $FAKE_GH_ROOT/<owner>/, wherever it runs.
if (args[0] === 'repo' && args[1] === 'list') {
  const owner = args[2] ?? fail('fake gh: repo list needs an owner');
  const dir = join(process.env.FAKE_GH_ROOT ?? fail('fake gh: FAKE_GH_ROOT is not set'), owner);
  const names = existsSync(dir) ? readdirSync(dir).filter((name) => existsSync(join(dir, name, '.fake-gh.json'))) : [];
  const listed = names.map((name) => JSON.parse(readFileSync(join(dir, name, '.fake-gh.json'), 'utf8')));
  const fields = (option('--json') ?? 'nameWithOwner').split(',');
  print(listed.map((s) => Object.fromEntries(fields.map((f) => [f, { nameWithOwner: s.repo, description: s.description ?? '', pushedAt: s.pushedAt ?? '' }[f]]))));
  process.exit(0);
}
// Who is signed in (Setup's check, daemon/setup.js): `$FAKE_GH_USER`, `octocat` unless set; set empty, nobody.
if (args[0] === 'api' && args[1] === 'user') {
  const user = process.env.FAKE_GH_USER ?? 'octocat';
  if (!user) {
    process.stderr.write('To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n');
    process.exit(4);
  }
  process.stdout.write(`${user}\n`);
  process.exit(0);
}
// The repository named, else the one the directory is in.
const file = stateFile();
if (!file) fail('failed to run git: fatal: not a git repository (or any of the parent directories): .git');
/** @type {any} */
const state = JSON.parse(readFileSync(file, 'utf8'));
const save = () => writeFileSync(file, JSON.stringify(state, null, 2));
const url = (/** @type {number} */ n) => `https://github.com/${state.repo}/pull/${n}`;
/** @param {unknown} n */
const pull = (n) => state.pulls.find((/** @type {any} */ p) => p.number === Number(n)) ?? fail(`GraphQL: Could not resolve to a PullRequest with the number of ${n}. (repository.pullRequest)`);
/** A pull request in `gh pr` JSON, in the fields asked for. @param {any} p @param {string} fields */
const asJson = (p, fields) => {
  const full = { ...p, author: { login: p.author }, url: url(p.number), comments: (p.comments ?? []).map((/** @type {any} */ c) => ({ ...c, author: { login: c.author } })), reviews: p.reviews ?? [] };
  return Object.fromEntries(fields.split(',').map((f) => [f, full[f]]));
};

const [group, verb, ...rest] = args;
if (group === 'repo' && verb === 'view') {
  print({ nameWithOwner: state.repo });
} else if (group === 'pr' && verb === 'list') {
  print(state.pulls.map((/** @type {any} */ p) => asJson(p, option('--json') ?? 'number')));
} else if (group === 'pr' && verb === 'view') {
  print(asJson(pull(rest[0]), option('--json') ?? 'number'));
} else if (group === 'pr' && verb === 'diff') {
  process.stdout.write(pull(rest[0]).diff ?? '');
} else if (group === 'pr' && verb === 'comment') {
  const number = pull(rest[0]).number;
  const body = option('--body') ?? '';
  state.issueComments ??= [];
  const id = 1000 + state.issueComments.length;
  state.issueComments.push({ id, number, body, created_at: nowIso() });
  if (body === 'bugbot go' && state.bugbot) {
    state.botReviews ??= [];
    state.botReviews.push({
      id: 5000 + state.botReviews.length,
      number,
      body: state.bugbot.body,
      submitted_at: new Date(Date.now() + (state.bugbot.afterMs ?? 0)).toISOString(),
      comments: state.bugbot.comments ?? [],
    });
  }
  save();
  process.stdout.write(`${url(number)}#issuecomment-${id}\n`);
} else if (group === 'api') {
  const path = verb;
  /** @param {unknown[]} items */
  const pages = (items) => print(args.includes('--slurp') ? [items] : items);
  /** @type {RegExpExecArray | null} */
  let m;
  if ((m = /^repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)$/.exec(path))) {
    print((state.issueComments ?? []).find((/** @type {any} */ c) => c.id === Number(m?.[1])) ?? fail('gh: Not Found (HTTP 404)'));
  } else if ((m = /^repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/comments$/.exec(path))) {
    pages(pull(m[1]).reviewComments ?? []);
  } else if ((m = /^repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/reviews$/.exec(path))) {
    const number = Number(m[1]);
    const shown = (state.botReviews ?? []).filter((/** @type {any} */ r) => r.number === number && Date.parse(r.submitted_at) <= Date.now());
    pages(shown.map((/** @type {any} */ r) => ({ id: r.id, user: { login: 'cursor[bot]' }, body: r.body, submitted_at: r.submitted_at, state: 'COMMENTED' })));
  } else if ((m = /^repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/reviews\/(\d+)\/comments$/.exec(path))) {
    const review = (state.botReviews ?? []).find((/** @type {any} */ r) => r.id === Number(m?.[2]));
    pages(review?.comments ?? []);
  } else {
    fail(`fake gh: no such api path: ${path}`);
  }
} else {
  fail(`fake gh: unsupported command: ${args.join(' ')}`);
}
