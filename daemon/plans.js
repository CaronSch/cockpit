/**
 * Plans: for a large task, an agent keeps a plan its user watches live beside the conversation
 * (the Plan window, src/widgets/plan.js, and the Plan line at the foot of the agent window): the
 * goal and approach, the steps, and a log of the decisions it took along the way and why. The
 * agent writes the plan and its decisions with the `plan` tool the daemon gives every omp it
 * launches (omp's RPC host tools: omp-session.js `HostTools`); the steps are its omp todo list,
 * which the daemon follows from the session's events (hub.js `onTodo`) rather than asking the
 * agent to say them twice.
 *
 * A conversation has one plan at a time, named by omp's conversation id: a new one replaces the
 * last. Plans are kept per conversation in the state directory, so they outlive windows, sleep
 * and restarts, and a plan window shows one whether its conversation is awake or not.
 *
 * `<dir>/<ompId>.json` (state-file.js): `{ version: 1, plan: Plan | null }` (null once a rewind
 * moved the plan to the conversation's new id).
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadStateFile } from './state-file.js';
import { OMP_ID } from './unread.js';
import { todoPhases, todoProgress } from '../src/omp/todos.js';
/** @import { SessionMeta } from './wire.js' */
/** @import { HostToolResult, HostTools } from './omp-session.js' */
/** @import { TodoPhase } from '../src/omp/todos.js' */

const VERSION = 1;
/** The longest title kept: a line, not a paragraph. */
const MAX_TITLE_CHARS = 120;
/** The longest plan kept: a page or two, not a document. */
const MAX_PLAN_CHARS = 20_000;
/** The longest decision, or reason, kept: a few sentences. */
const MAX_ENTRY_CHARS = 2_000;

/**
 * Something that happened to a plan, in the order it happened: a decision the agent took
 * (`text`), or the plan revised (`text` is the plan before, so the window can show what
 * changed); `why` in the agent's words.
 * @typedef {{ at: number, kind: 'decision' | 'revision', text: string, why: string }} PlanEntry
 */
/**
 * A conversation's plan: `title` names the task, `body` (Markdown) is the goal and approach,
 * `todo` the agent's todo list as it last reported it, `log` its decisions and revisions, oldest
 * first; `cwd` the directory its session ran in. Times are daemon epoch milliseconds.
 * @typedef {{ title: string, body: string, cwd: string, todo: TodoPhase[], log: PlanEntry[], createdAt: number, updatedAt: number }} Plan
 */
/**
 * A plan as the Plan window lists them: its conversation, title and directory, when it last
 * changed, and how many of its steps are done.
 * @typedef {{ ompId: string, title: string, cwd: string, updatedAt: number, done: number, total: number }} PlanSummary
 */

/**
 * The tool every omp the daemon launches is given (omp's `set_host_tools`): its description is
 * all the agent knows of it, so it says when to use it and what goes in it. Essential, so it
 * sits in the agent's own tools rather than behind tool discovery.
 */
const PLAN_TOOL = Object.freeze({
  name: 'plan',
  label: 'Plan',
  description:
    "Keeps this conversation's plan, which the user watches live in a window beside the conversation while you work: the goal and approach, and a log of the decisions you take along the way and why. " +
    'The steps are your todo list (the todo tool): the window shows them under the plan, ticked off as you mark them, so never repeat them here. ' +
    'Use it for every large task (several steps or files, or work the user will not follow step by step): start one with `new` before the work, alongside your todo list. Skip it for a question or a small change. ' +
    'Whenever you choose between real options without asking the user (an approach, a library, a trade-off, cutting scope, how to handle something unexpected), record it with `decide`: what you chose, and why in a sentence or two. ' +
    'When the approach itself changes, `revise` the plan and say why. `view` shows the plan as it stands, with its decisions (after a compaction, say). `new` replaces any earlier plan of this conversation.',
  parameters: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['new', 'revise', 'decide', 'view'], description: 'new (title, plan), revise (plan, why), decide (decision, why) or view' },
      title: { type: 'string', description: 'new: the task in a few words' },
      plan: { type: 'string', description: 'new, revise: the goal, the approach and what is still open, in Markdown; short (the steps go in the todo list)' },
      decision: { type: 'string', description: 'decide: what you chose' },
      why: { type: 'string', description: 'decide, revise: why, in a sentence or two' },
    },
    required: ['op'],
    additionalProperties: false,
  },
  loadMode: 'essential',
});

/** @param {any} e @returns {e is PlanEntry} */
const isEntry = (e) => Number.isFinite(e?.at) && (e.kind === 'decision' || e.kind === 'revision') && typeof e.text === 'string' && typeof e.why === 'string';

/** @param {any} plan parsed untrusted JSON @returns {plan is Plan} */
const isPlan = (plan) =>
  typeof plan?.title === 'string' &&
  typeof plan.body === 'string' &&
  typeof plan.cwd === 'string' &&
  todoPhases(plan.todo) !== null &&
  Array.isArray(plan.log) &&
  plan.log.every(isEntry) &&
  Number.isFinite(plan.createdAt) &&
  Number.isFinite(plan.updatedAt);

/** @param {string} message @returns {HostToolResult} */
const refused = (message) => ({ text: message, isError: true });

/**
 * `value` as text of at most `max` characters, trimmed; throws a reason the agent reads when it
 * is missing or too long.
 * @param {unknown} value @param {string} name @param {number} max
 */
function textOf(value, name, max) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`\`${name}\` is missing`);
  if (value.length > max) throw new Error(`\`${name}\` is longer than ${max} characters`);
  return value.trim();
}

/** The plan as the agent reads it back (`view`). @param {Plan} plan */
function planText(plan) {
  const progress = todoProgress(plan.todo);
  const lines = [`# ${plan.title}`, '', plan.body, ''];
  lines.push(progress ? `Steps (your todo list): ${progress.done} of ${progress.total} done${progress.current ? `; on: ${progress.current}` : ''}.` : 'Steps: your todo list is empty.');
  const decisions = plan.log.filter((e) => e.kind === 'decision');
  if (decisions.length) lines.push('', 'Decisions so far:', ...decisions.map((e) => `- ${e.text} (${e.why})`));
  return lines.join('\n');
}

/**
 * @param {{ dir: string, now?: () => number }} options `dir` holds a file per conversation
 */
export function createPlans({ dir, now = Date.now }) {
  /** Each conversation's stored plan, loaded when first needed. @type {Map<string, ReturnType<typeof loadPlan>>} */
  const stores = new Map();
  /** Each awake conversation's todo list as its session last reported it, for a plan started later. @type {Map<string, TodoPhase[]>} */
  const todos = new Map();
  /** @type {Set<(ompId: string, plan: Plan | null) => void>} */
  const listeners = new Set();

  /** @param {string} file */
  function loadPlan(file) {
    return loadStateFile({
      file,
      what: 'a plan file',
      initial: /** @type {Plan | null} */ (null),
      read: (data) => (data?.version === VERSION && (data.plan === null || isPlan(data.plan)) ? /** @type {{ plan: Plan | null }} */ (data).plan : null),
      write: (plan) => ({ version: VERSION, plan }),
    });
  }

  /** @param {string} ompId */
  function storeOf(ompId) {
    let store = stores.get(ompId);
    if (!store) {
      store = loadPlan(join(dir, `${ompId}.json`));
      stores.set(ompId, store);
      // A file that cannot be read is named again next time, not cached broken.
      store.catch(() => stores.delete(ompId));
      // Every change is heard by every page, with the plan as it is now.
      void store.then((s) => s.subscribe((plan) => listeners.forEach((fn) => fn(ompId, plan))));
    }
    return store;
  }

  /** @param {string} ompId @returns {Promise<Plan | null>} */
  const planOf = async (ompId) => (await storeOf(ompId)).get();

  /**
   * The agent of session `meta` called the plan tool with `args` (untrusted: the model wrote them).
   * @param {SessionMeta} meta @param {Record<string, unknown>} args @returns {Promise<HostToolResult>}
   */
  async function call(meta, args) {
    const ompId = meta.ompId;
    if (!ompId || !OMP_ID.test(ompId)) return refused('This conversation has no id yet, so it cannot keep a plan: try again in a moment.');
    const store = await storeOf(ompId);
    const plan = store.get();
    const at = now();
    try {
      switch (args.op) {
        case 'new': {
          const title = textOf(args.title, 'title', MAX_TITLE_CHARS).split('\n')[0];
          const body = textOf(args.plan, 'plan', MAX_PLAN_CHARS);
          await store.set({ title, body, cwd: meta.cwd, todo: todos.get(ompId) ?? [], log: [], createdAt: at, updatedAt: at });
          return { text: 'Plan started: the user sees it beside the conversation, with your todo list as its steps. Record each decision you take with `decide`.', details: { op: 'new' } };
        }
        case 'revise': {
          if (!plan) return refused('This conversation has no plan to revise: start one with `new`.');
          const body = textOf(args.plan, 'plan', MAX_PLAN_CHARS);
          const why = textOf(args.why, 'why', MAX_ENTRY_CHARS);
          await store.set({ ...plan, body, log: [...plan.log, { at, kind: 'revision', text: plan.body, why }], updatedAt: at });
          return { text: 'Plan revised.', details: { op: 'revise' } };
        }
        case 'decide': {
          if (!plan) return refused('This conversation has no plan to record a decision in: start one with `new`.');
          const decision = textOf(args.decision, 'decision', MAX_ENTRY_CHARS);
          const why = textOf(args.why, 'why', MAX_ENTRY_CHARS);
          await store.set({ ...plan, log: [...plan.log, { at, kind: 'decision', text: decision, why }], updatedAt: at });
          return { text: 'Decision recorded.', details: { op: 'decide' } };
        }
        case 'view':
          return plan ? { text: planText(plan), details: { op: 'view' } } : { text: 'This conversation has no plan.', details: { op: 'view' } };
        default:
          return refused('`op` must be new, revise, decide or view.');
      }
    } catch (err) {
      return refused(`Plan unchanged: ${/** @type {Error} */ (err).message}.`);
    }
  }

  return {
    call,
    /** Conversation `ompId`'s plan, or null if it has none. */
    plan: planOf,
    /**
     * Every plan kept, most recently changed first.
     * @returns {Promise<PlanSummary[]>}
     */
    async list() {
      const names = await readdir(dir).catch((err) => {
        if (err?.code === 'ENOENT') return /** @type {string[]} */ ([]);
        throw err;
      });
      const ids = names.flatMap((name) => (name.endsWith('.json') && OMP_ID.test(name.slice(0, -5)) ? [name.slice(0, -5)] : []));
      const plans = await Promise.all(ids.map(async (ompId) => ({ ompId, plan: await planOf(ompId).catch(() => null) })));
      return plans
        .flatMap(({ ompId, plan }) => {
          if (!plan) return [];
          const progress = todoProgress(plan.todo);
          return [{ ompId, title: plan.title, cwd: plan.cwd, updatedAt: plan.updatedAt, done: progress?.done ?? 0, total: progress?.total ?? 0 }];
        })
        .sort((a, b) => b.updatedAt - a.updatedAt);
    },
    /**
     * Conversation `ompId`'s session reported its todo list (`phases`): its plan, if it has one,
     * shows it.
     * @param {string} ompId @param {TodoPhase[]} phases
     */
    async todo(ompId, phases) {
      todos.set(ompId, phases);
      const store = await storeOf(ompId);
      const plan = store.get();
      if (plan && JSON.stringify(plan.todo) !== JSON.stringify(phases)) await store.set({ ...plan, todo: phases, updatedAt: now() });
    },
    /** A rewound conversation goes on under id `to`: its plan goes with it. @param {string} from @param {string} to */
    async moved(from, to) {
      const todo = todos.get(from);
      if (todo) todos.set(to, todo);
      todos.delete(from);
      const source = await storeOf(from);
      const plan = source.get();
      if (!plan) return;
      await (await storeOf(to)).set(plan);
      await source.set(null);
    },
    /** Hears every change to a conversation's plan, with the plan as it is now (null: none). @param {(ompId: string, plan: Plan | null) => void} fn */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** @typedef {ReturnType<typeof createPlans>} Plans */

/**
 * The daemon's tools for the omps it launches (hub.js `hostTools`): the plan tool, run by the
 * plans `get` gives.
 * @param {() => Plans} get @returns {HostTools}
 */
export const planTools = (get) => ({
  tools: [PLAN_TOOL],
  call: (meta, name, args) => (name === PLAN_TOOL.name ? get().call(meta, args) : Promise.resolve(refused(`No such tool: ${name}.`))),
});
