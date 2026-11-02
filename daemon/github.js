/**
 * GitHub, through the user's own `gh` CLI (https://cli.github.com), signed in as they are: the
 * pull requests of a directory's repository, one pull request to review (its conversation,
 * line comments and diff), a comment on one, and Bugbot's reviews of one (src/github/bugbot.js).
 *
 * `gh` is not a dependency, as omp is not: the daemon runs the `gh` on PATH unless told
 * otherwise, never prompts (GH_PROMPT_DISABLED), and reports `gh`'s own words when it fails:
 * missing, signed out, or a directory in no GitHub repository.
 */
/** @import { Pull, PullList, PullSummary, ReviewComment } from './wire.js' */
/** @import { InlineComment, Review } from '../src/github/bugbot.js' */
/** A repository (`owner/name`) and a directory it is checked out in, where `gh` runs for it. @typedef {{ repo: string, cwd: string }} RepoAt */

const RUN_TIMEOUT_MS = 30_000;
/** A directory's pull requests are listed again after this long: `#` suggestions ask on every keystroke. */
const LIST_FRESH_MS = 15_000;
const LIST_LIMIT = 100;
/** The most of a diff the window is sent; past it the diff is cut at a line and said to be. */
const MAX_DIFF_BYTES = 3 * 1024 * 1024;
const SUMMARY_FIELDS = 'number,title,state,isDraft,author,headRefName,url,updatedAt';
const PULL_FIELDS = `${SUMMARY_FIELDS},baseRefName,createdAt,body,additions,deletions,comments,reviews`;
/** `owner/name` and number in a pull request's (or one of its comments') URL. */
const PULL_URL = /^https:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/(\d+)/;

/** `gh` failed; `message` is what it said. */
export class GithubError extends Error {}

/** @param {any} user @returns {string} */
const login = (user) => (typeof user?.login === 'string' ? user.login : 'ghost');

/** @param {any} pr parsed `gh` JSON @returns {PullSummary} */
const summary = (pr) => ({
  number: Number(pr.number),
  title: String(pr.title ?? ''),
  state: String(pr.state ?? ''),
  isDraft: pr.isDraft === true,
  author: login(pr.author),
  headRefName: String(pr.headRefName ?? ''),
  url: String(pr.url ?? ''),
  updatedAt: String(pr.updatedAt ?? ''),
});

/** The repository (`owner/name`) a pull request URL is in. @param {string} url */
export function repoOf(url) {
  const match = PULL_URL.exec(url);
  if (!match) throw new GithubError(`not a pull request URL: ${url}`);
  return match[1];
}

/** `text` cut at its last whole line within `max` bytes, and whether it was cut. @param {string} text @param {number} max */
function upTo(text, max) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= max) return { text, cut: false };
  const head = new TextDecoder().decode(bytes.subarray(0, max));
  return { text: head.slice(0, head.lastIndexOf('\n') + 1), cut: true };
}

/**
 * @param {{ ghPath: string, now?: () => number }} options `ghPath`: the `gh` to run (a command
 * on PATH, or a path)
 */
export function createGithub({ ghPath, now = Date.now }) {
  /**
   * `gh args…` run in `cwd`: its output, or a GithubError with what it said.
   * @param {string[]} args @param {string} [cwd] @returns {Promise<string>}
   */
  async function gh(args, cwd) {
    /** @type {import('bun').Subprocess<'ignore', 'pipe', 'pipe'>} */
    let proc;
    try {
      proc = Bun.spawn([ghPath, ...args], {
        cwd,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: RUN_TIMEOUT_MS,
        env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', CLICOLOR: '0' },
      });
    } catch {
      throw new GithubError(`GitHub CLI not found ("${ghPath}"): install it from https://cli.github.com and run \`gh auth login\``);
    }
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new GithubError(err.trim().split('\n').slice(0, 3).join(' ') || `gh ${args[0]} failed (exit ${code})`);
    return out;
  }

  /**
   * `gh api path --paginate --slurp`, run in `cwd`: every page's items, as one list.
   * @param {string} path @param {string} cwd @returns {Promise<any[]>}
   */
  const api = async (path, cwd) => /** @type {any[][]} */ (JSON.parse(await gh(['api', path, '--paginate', '--slurp'], cwd))).flat();

  /** @type {Map<string, { at: number, list: Promise<PullList> }>} */
  const lists = new Map();

  return {
    /**
     * The pull requests of the repository `cwd` is in, newest first, or why there are none
     * to list. Kept for a few seconds per directory.
     * @param {string} cwd @returns {Promise<PullList>}
     */
    pulls(cwd) {
      const kept = lists.get(cwd);
      if (kept && now() - kept.at < LIST_FRESH_MS) return kept.list;
      const list = gh(['pr', 'list', '--state', 'all', '--limit', String(LIST_LIMIT), '--json', SUMMARY_FIELDS], cwd).then(
        (out) => /** @type {PullList} */ ({ connected: true, pulls: /** @type {any[]} */ (JSON.parse(out)).map(summary) }),
        (err) => /** @type {PullList} */ ({ connected: false, reason: err instanceof Error ? err.message : String(err) }),
      );
      lists.set(cwd, { at: now(), list });
      return list;
    },

    /**
     * Pull request `number` of the repository `cwd` is in, to review.
     * @param {string} cwd @param {number} number @returns {Promise<Pull>}
     */
    async pull(cwd, number) {
      const pr = JSON.parse(await gh(['pr', 'view', String(number), '--json', PULL_FIELDS], cwd));
      const repo = repoOf(String(pr.url));
      const [diff, lineComments] = await Promise.all([gh(['pr', 'diff', String(number)], cwd), api(`repos/${repo}/pulls/${number}/comments`, cwd)]);
      const shown = upTo(diff, MAX_DIFF_BYTES);
      return {
        ...summary(pr),
        repo,
        body: String(pr.body ?? ''),
        baseRefName: String(pr.baseRefName ?? ''),
        createdAt: String(pr.createdAt ?? ''),
        additions: Number(pr.additions ?? 0),
        deletions: Number(pr.deletions ?? 0),
        comments: (Array.isArray(pr.comments) ? pr.comments : []).map((/** @type {any} */ c) => ({
          author: login(c.author),
          body: String(c.body ?? ''),
          createdAt: String(c.createdAt ?? ''),
          url: String(c.url ?? ''),
        })),
        reviews: (Array.isArray(pr.reviews) ? pr.reviews : []).map((/** @type {any} */ r) => ({
          id: String(r.id ?? ''),
          author: login(r.author),
          state: String(r.state ?? ''),
          body: String(r.body ?? ''),
          submittedAt: String(r.submittedAt ?? ''),
        })),
        reviewComments: lineComments.map(
          (c) =>
            /** @type {ReviewComment} */ ({
              id: Number(c.id),
              author: login(c.user),
              body: String(c.body ?? ''),
              path: String(c.path ?? ''),
              line: Number.isInteger(c.line) ? c.line : null,
              startLine: Number.isInteger(c.start_line) ? c.start_line : null,
              side: c.side === 'LEFT' ? 'LEFT' : 'RIGHT',
              inReplyTo: Number.isInteger(c.in_reply_to_id) ? c.in_reply_to_id : null,
              createdAt: String(c.created_at ?? ''),
              url: String(c.html_url ?? ''),
            }),
        ),
        diff: shown.text,
        diffTruncated: shown.cut,
      };
    },

    /**
     * Comments `body` on pull request `number` of the repository `cwd` is in, as the user:
     * where the comment is, and when GitHub says it was made.
     * @param {string} cwd @param {number} number @param {string} body
     * @returns {Promise<{ repo: string, url: string, createdAt: string }>}
     */
    async comment(cwd, number, body) {
      const url = (await gh(['pr', 'comment', String(number), '--body', body], cwd)).trim().split('\n').at(-1) ?? '';
      const repo = repoOf(url);
      const id = /#issuecomment-(\d+)$/.exec(url)?.[1];
      if (!id) throw new GithubError(`gh did not say where the comment is: ${url}`);
      const made = JSON.parse(await gh(['api', `repos/${repo}/issues/comments/${id}`], cwd));
      return { repo, url, createdAt: String(made.created_at) };
    },

    /**
     * The reviews of pull request `number` of `at.repo` (checked out in `at.cwd`), oldest first.
     * @param {RepoAt} at @param {number} number @returns {Promise<Review[]>}
     */
    async reviews(at, number) {
      return (await api(`repos/${at.repo}/pulls/${number}/reviews`, at.cwd)).map((r) => ({
        id: Number(r.id),
        author: login(r.user),
        body: String(r.body ?? ''),
        submittedAt: String(r.submitted_at ?? ''),
      }));
    },

    /**
     * The line comments review `review` of pull request `number` of `at.repo` made.
     * @param {RepoAt} at @param {number} number @param {number} review @returns {Promise<InlineComment[]>}
     */
    async reviewComments(at, number, review) {
      return (await api(`repos/${at.repo}/pulls/${number}/reviews/${review}/comments`, at.cwd)).map((c) => ({
        body: String(c.body ?? ''),
        path: String(c.path ?? ''),
        line: Number.isInteger(c.line) ? c.line : null,
        startLine: Number.isInteger(c.start_line) ? c.start_line : null,
      }));
    },
  };
}

/** @typedef {ReturnType<typeof createGithub>} Github */
