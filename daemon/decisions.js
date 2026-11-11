/**
 * Decision reviews: once the user turns them on in Config, every turn an agent hands back is
 * read by a small model, which lists the decisions the agent took without its user (at most
 * five, a sentence each; src/omp/decisions.js), so none goes by unnoticed. The reviews are
 * kept per conversation in the state directory, so they outlive windows, sleep and restarts.
 *
 * The reviewer is a one-shot omp of its own (`omp -p`) on omp's `smol` role with thinking off,
 * no tools and no session, reading the turn only (the prompt and the agent's replies,
 * thinking and tool calls, not tool output), never the conversation before it: a few
 * thousand tokens of a cheap model per turn, not the conversation's own cache.
 *
 * `<dir>/<ompId>.json` (state-file.js): `{ version: 1, reviews: Reviews }`. A review under way
 * is kept in memory only: one a daemon restart cut short is not tried again.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadStateFile } from './state-file.js';
import { OMP_ID } from './unread.js';
import { REVIEW_SYSTEM_PROMPT, parseDecisions, turnToReview } from '../src/omp/decisions.js';
/** @import { Review, Reviews } from '../src/omp/decisions.js' */
/** @import { Transcript } from '../src/omp/transcript.js' */

const VERSION = 1;
/** How long the reviewer may take before it is stopped and the review fails. */
const REVIEW_TIMEOUT_MS = 120_000;

/** @param {any} review parsed untrusted JSON @returns {review is Review} */
const isStoredReview = (review) =>
  (review?.status === 'done' && Array.isArray(review.decisions) && review.decisions.every((/** @type {unknown} */ d) => typeof d === 'string')) ||
  (review?.status === 'failed' && typeof review.error === 'string');

/** @param {any} data parsed untrusted JSON @returns {data is { version: 1, reviews: Reviews }} */
const isReviewsFile = (data) =>
  data?.version === VERSION && data.reviews !== null && typeof data.reviews === 'object' && !Array.isArray(data.reviews) && Object.values(data.reviews).every(isStoredReview);

/**
 * Asks omp's `smol` model for the decisions in `turn` (turnToReview's text).
 * @param {string} turn @param {{ ompPath: string, timeoutMs?: number }} options @returns {Promise<string[]>}
 */
export async function askReviewer(turn, { ompPath, timeoutMs = REVIEW_TIMEOUT_MS }) {
  // Run outside any project, so no project's context files or rules are read with it.
  const proc = Bun.spawn(
    [ompPath, '-p', '--no-session', '--no-tools', '--no-skills', '--no-rules', '--no-extensions', '--no-lsp', '--no-title', '--model', '@smol', '--thinking', 'off', '--system-prompt', REVIEW_SYSTEM_PROMPT, turn],
    { cwd: tmpdir(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs },
  );
  const [answer, errors, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (proc.signalCode) throw new Error(`the reviewer took longer than ${Math.round(timeoutMs / 1000)} s`);
  if (code !== 0) throw new Error(errors.trim().split('\n').at(-1) || `the reviewer exited with ${code}`);
  return parseDecisions(answer);
}

/**
 * @param {{ dir: string, on: () => boolean, ask: (turn: string) => Promise<string[]> }} options
 *   `on`: the user's setting; `ask`: the reviewer (askReviewer)
 */
export function createDecisionReviews({ dir, on, ask }) {
  /** Each conversation's stored reviews, loaded when first needed. @type {Map<string, ReturnType<typeof loadReviews>>} */
  const stores = new Map();
  /** Reviews under way, by conversation. @type {Map<string, Set<string>>} */
  const pending = new Map();
  /** Where each session's last reviewed turn ended: its last item's key. @type {WeakMap<Transcript, string>} */
  const reviewedTo = new WeakMap();
  /** @type {Set<(ompId: string, reviews: Reviews) => void>} */
  const listeners = new Set();

  /** @param {string} file */
  function loadReviews(file) {
    return loadStateFile({
      file,
      what: 'a decision reviews file',
      initial: /** @type {Reviews} */ ({}),
      read: (data) => (isReviewsFile(data) ? data.reviews : null),
      write: (reviews) => ({ version: VERSION, reviews }),
    });
  }

  /** @param {string} ompId */
  function storeOf(ompId) {
    let store = stores.get(ompId);
    if (!store) {
      store = loadReviews(join(dir, `${ompId}.json`));
      stores.set(ompId, store);
      // A file that cannot be read is named again next time, not cached broken.
      store.catch(() => stores.delete(ompId));
    }
    return store;
  }

  /** The conversation's reviews: those kept, and those under way. @param {string} ompId @returns {Promise<Reviews>} */
  async function reviewsOf(ompId) {
    const kept = (await storeOf(ompId)).get();
    const running = pending.get(ompId);
    if (!running?.size) return kept;
    return { ...kept, ...Object.fromEntries([...running].map((at) => [at, /** @type {Review} */ ({ status: 'pending' })])) };
  }

  /** @param {string} ompId */
  async function changed(ompId) {
    const reviews = await reviewsOf(ompId);
    for (const fn of listeners) fn(ompId, reviews);
  }

  /** @param {string} ompId @param {{ promptAt: number, text: string }} turn */
  async function review(ompId, turn) {
    const at = String(turn.promptAt);
    let running = pending.get(ompId);
    if (!running) pending.set(ompId, (running = new Set()));
    running.add(at);
    await changed(ompId);
    /** @type {Review} */
    let result;
    try {
      result = { status: 'done', decisions: await ask(turn.text) };
    } catch (err) {
      result = { status: 'failed', error: err instanceof Error ? err.message : String(err) };
    }
    running.delete(at);
    const store = await storeOf(ompId);
    await store.set({ ...store.get(), [at]: result });
    await changed(ompId);
  }

  return {
    /**
     * The agent of `transcript`'s session handed its turn back: reviews it, if the user
     * wants reviews and the turn has a prompt of the user's to name it by.
     * @param {Transcript} transcript
     */
    turnEnded(transcript) {
      const since = reviewedTo.get(transcript) ?? null;
      const end = transcript.items.at(-1)?.key;
      if (end) reviewedTo.set(transcript, end);
      const ompId = transcript.meta?.ompId;
      if (!on() || !ompId || !OMP_ID.test(ompId)) return;
      const turn = turnToReview(transcript.items, transcript.tools, since);
      if (!turn) return;
      review(ompId, turn).catch((err) => console.error(`[daemon] could not review the decisions of conversation ${ompId}:`, err));
    },
    reviews: reviewsOf,
    /** Hears every change to a conversation's reviews, with all of them. @param {(ompId: string, reviews: Reviews) => void} fn */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** @typedef {ReturnType<typeof createDecisionReviews>} DecisionReviews */
