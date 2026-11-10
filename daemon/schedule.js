/**
 * Scheduled prompts: an agent sends its own conversation a prompt later, at a set time or after a
 * while, through the `schedule` tool the daemon gives every omp it launches (omp's RPC host tools:
 * omp-session.js `HostTools`). Agents use it when the user asks for something later, and instead
 * of asking the user to ping them once CI, a deploy or a review is done. When a prompt comes due
 * the daemon sends it to the conversation (deliver.js): woken from its journal if it sleeps, after
 * the turn if its agent works.
 *
 * A prompt runs only if it comes due while the daemon is up: one due while the daemon was off or
 * the Mac slept (found more than `MISSED_AFTER_MS` late) is missed, and moved to
 * `MISSED_DELAY_MS` after the daemon finds it, keeping when it was first due (`missedAt`), so its
 * user has time to see it in the timeline and decide whether it is still wanted. One whose
 * delivery fails is tried again as late, with the reason kept (`error`). One whose conversation
 * is archived waits, and is missed once it is restored; one whose conversation is gone (no
 * journal, archived or not) is dropped, as nothing can take it.
 *
 * The prompts are kept in one small file in the state directory (state-file.js), so they outlive
 * a daemon restart, and every page shows them (the timeline window).
 *
 * `<file>`: `{ version: 1, tasks: [ScheduledTask, …] }`, in the order they were scheduled.
 */
import { randomBytes } from 'node:crypto';
import { loadStateFile } from './state-file.js';
import { DeliveryRefused } from './deliver.js';
import { duration } from '../src/timeline/scale.js';
/** @import { ConversationTarget, ScheduledTask, SessionMeta } from './wire.js' */
/** @import { HostToolResult, HostTools } from './omp-session.js' */

const VERSION = 1;
/** How late a prompt may run: later than this, the daemon was off or the Mac slept when it came due. */
export const MISSED_AFTER_MS = 60_000;
/** How long after the daemon finds a missed prompt (or a failed delivery) it runs. */
export const MISSED_DELAY_MS = 10 * 60_000;
/** How often the daemon looks at the clock while prompts are scheduled, at most: after a sleep, it finds missed ones within this. */
export const SCHEDULE_TICK_MS = 30_000;
/** The longest prompt kept: a message, not a document. */
const MAX_PROMPT_CHARS = 20_000;

/** A request about a scheduled prompt that cannot be met: `status` is the HTTP status saying why. */
export class ScheduleRefused extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * The tool every omp the daemon launches is given (omp's `set_host_tools`): its description is
 * all the agent knows of it, so it says when to use it, and to ask before guessing a time.
 * Essential, so it sits in the agent's own tools rather than behind tool discovery.
 */
export const SCHEDULE_TOOL = Object.freeze({
  name: 'schedule',
  label: 'Schedule',
  description:
    'Sends a prompt to this conversation later: at a set time (`at`) or after a while (`in`), the workbench delivers `prompt` here as a new user message, waking the conversation if it sleeps, or after the current turn if you are working. ' +
    'Use it whenever something has to happen later: when the user asks for it ("in two hours, check CI", "tomorrow at 9, rerun the import"), and whenever you would otherwise ask the user to ping you or come back (CI still running, a deploy rolling out, a review pending, a long job): schedule the check yourself, then tell them when it will run. ' +
    'A time you choose yourself needs no question. A time the user gave that leaves the moment unclear (no time of day, am or pm, "next week", another time zone, a time already past) does: ask them with the ask tool before scheduling; never guess. ' +
    'Write `prompt` to stand alone: what to do and why, with the paths, links, ids and commands you will need, as the conversation may have been compacted by then. ' +
    "The answer says when it will run, in this machine's time zone. `list` shows the time now and what is scheduled in this conversation; `cancel` removes one by its id (to move one, cancel it and add it again).",
  parameters: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['add', 'list', 'cancel'], description: 'add (with prompt, and at or in), list, or cancel (with id)' },
      prompt: { type: 'string', description: 'What to send then: a message to yourself that stands alone' },
      at: { type: 'string', description: "When: a date and time, YYYY-MM-DDTHH:MM, in this machine's time zone unless it ends in Z or an offset such as +01:00" },
      in: { type: 'string', description: 'Or after how long from now: numbers with units, such as 45s, 10m, 1h 30m, 2d or 1w' },
      id: { type: 'string', description: 'The scheduled prompt to cancel, as add or list named it' },
    },
    required: ['op'],
    additionalProperties: false,
  },
  loadMode: 'essential',
});

/** @type {Readonly<Record<string, number>>} */
const UNIT_MS = { w: 7 * 86_400_000, d: 86_400_000, h: 3_600_000, min: 60_000, m: 60_000, s: 1000 };
const DELAY_PART = /(\d+(?:\.\d+)?)\s*(min|w|d|h|m|s)/g;

/**
 * How long `text` says, in milliseconds (`1h 30m`, `45s`, `2d`), or null if it is not numbers
 * with units, and nothing else.
 * @param {string} text
 */
export function parseDelay(text) {
  const parts = [...text.matchAll(DELAY_PART)];
  if (parts.length === 0 || text.replace(DELAY_PART, '').trim() !== '') return null;
  return parts.reduce((sum, [, n, unit]) => sum + Number(n) * UNIT_MS[unit], 0);
}

const AT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?$/;

/**
 * The moment `text` names (`2026-11-11T09:00`, in this machine's time zone unless it ends in `Z`
 * or an offset), epoch milliseconds, or null if it names none.
 * @param {string} text
 */
export function parseAt(text) {
  const trimmed = text.trim();
  if (!AT.test(trimmed)) return null;
  const at = Date.parse(trimmed.replace(' ', 'T'));
  return Number.isFinite(at) ? at : null;
}

const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');

/** `ms` as this machine's clock reads it: `Wed 2026-11-11 09:00 CET`. @param {number} ms */
export function localTime(ms) {
  const d = new Date(ms);
  const weekday = d.toLocaleDateString('en-GB', { weekday: 'short' });
  const zone = new Intl.DateTimeFormat('en-GB', { timeZoneName: 'short' }).formatToParts(d).find((p) => p.type === 'timeZoneName')?.value;
  return `${weekday} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}${zone ? ` ${zone}` : ''}`;
}

/** @param {any} t @returns {t is ConversationTarget} */
const isTarget = (t) => (t?.sessionFile === null || typeof t?.sessionFile === 'string') && (t.session === null || typeof t.session === 'string') && typeof t.cwd === 'string';

/** @param {any} t @returns {t is ScheduledTask} */
const isTask = (t) =>
  typeof t?.id === 'string' &&
  isTarget(t.target) &&
  typeof t.prompt === 'string' &&
  Number.isFinite(t.dueAt) &&
  Number.isFinite(t.createdAt) &&
  (t.missedAt === null || Number.isFinite(t.missedAt)) &&
  (t.error === null || typeof t.error === 'string');

/** What the agent is sent when `task` comes due. @param {ScheduledTask} task */
export const scheduledMessage = (task) => `Scheduled prompt, set ${localTime(task.createdAt)}:\n\n${task.prompt}`;

/** @param {string} message @returns {HostToolResult} */
const refused = (message) => ({ text: message, isError: true });

/**
 * Loads the prompts kept in `file` and sends each when it comes due. `deliver` sends a message
 * to a conversation (deliver.js); `archivedFrom` says whether the journal omp kept at a path has
 * been archived (history.js).
 * @param {{
 *   file: string,
 *   deliver: (target: ConversationTarget, message: string) => Promise<unknown>,
 *   archivedFrom: (file: string) => Promise<boolean>,
 *   now?: () => number,
 *   tickMs?: number,
 * }} options
 */
export async function loadSchedule({ file, deliver, archivedFrom, now = Date.now, tickMs = SCHEDULE_TICK_MS }) {
  const store = await loadStateFile({
    file,
    what: 'a schedule file',
    initial: /** @type {readonly ScheduledTask[]} */ ([]),
    read: (data) => (data?.version === VERSION && Array.isArray(data.tasks) && data.tasks.every(isTask) ? /** @type {readonly ScheduledTask[]} */ (data.tasks) : null),
    write: (tasks) => ({ version: VERSION, tasks }),
  });

  /** @param {string} id @param {Partial<ScheduledTask>} patch */
  const change = (id, patch) => store.set(store.get().map((t) => (t.id === id ? { ...t, ...patch } : t)));
  /** @param {string} id */
  const drop = (id) => store.set(store.get().filter((t) => t.id !== id));

  /** Prompts being sent now, so none is sent twice. @type {Set<string>} */
  const running = new Set();
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  let stopped = false;
  let sweeping = false;

  /** Looks at the clock again when the next prompt comes due, or a tick from now, whichever is sooner. */
  function arm() {
    clearTimeout(timer);
    timer = undefined;
    if (stopped || store.get().length === 0) return;
    const at = now();
    // Overdue ones (waiting on an archived conversation, or being sent) are looked at each tick.
    const next = Math.min(...store.get().flatMap((t) => (t.dueAt > at ? [t.dueAt - at] : [])), tickMs);
    timer = setTimeout(() => void sweep(), next);
    timer.unref();
  }

  /** @param {ScheduledTask} task */
  async function run(task) {
    running.add(task.id);
    try {
      await deliver(task.target, scheduledMessage(task));
      await drop(task.id);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (err instanceof DeliveryRefused && err.status === 404) {
        console.error(`[daemon] dropped scheduled prompt ${task.id}: ${reason}`);
        await drop(task.id);
      } else {
        await change(task.id, { dueAt: now() + MISSED_DELAY_MS, error: reason });
      }
    } finally {
      running.delete(task.id);
      arm();
    }
  }

  /** Sends the prompts due now; moves those missed. */
  async function sweep() {
    if (sweeping || stopped) return;
    sweeping = true;
    try {
      const at = now();
      for (const task of store.get()) {
        if (task.dueAt > at || running.has(task.id)) continue;
        // An archived conversation takes nothing: it waits, and is missed once restored.
        if (task.target.sessionFile && (await archivedFrom(task.target.sessionFile))) continue;
        if (at - task.dueAt > MISSED_AFTER_MS) void change(task.id, { dueAt: at + MISSED_DELAY_MS, missedAt: task.missedAt ?? task.dueAt });
        else void run(task);
      }
    } finally {
      sweeping = false;
      arm();
    }
  }

  store.subscribe(arm);
  void sweep();

  /** @param {string} id */
  function owned(id) {
    const task = store.get().find((t) => t.id === id);
    if (!task) throw new ScheduleRefused(404, 'no such scheduled prompt');
    if (running.has(id)) throw new ScheduleRefused(409, 'it is being sent now');
    return task;
  }

  /** @param {unknown} prompt */
  function promptOf(prompt) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new ScheduleRefused(400, 'the prompt is empty');
    if (prompt.length > MAX_PROMPT_CHARS) throw new ScheduleRefused(400, `the prompt is longer than ${MAX_PROMPT_CHARS} characters`);
    return prompt.trim();
  }

  /** A line about `task` for the agent. @param {ScheduledTask} task @param {number} at */
  const describe = (task, at) =>
    `- ${task.id}: ${localTime(task.dueAt)} (in ${duration(task.dueAt - at)})${task.missedAt === null ? '' : `, missed at ${localTime(task.missedAt)}`}${task.error ? `, last try failed: ${task.error}` : ''}: ${task.prompt.split('\n')[0]}`;

  /**
   * The agent of session `meta` called the schedule tool with `args` (untrusted: the model wrote them).
   * @param {SessionMeta} meta @param {Record<string, unknown>} args @returns {Promise<HostToolResult>}
   */
  async function call(meta, args) {
    const at = now();
    /** Whether `task` is for this session's conversation. @param {ScheduledTask} task */
    const here = (task) => (meta.sessionFile ? task.target.sessionFile === meta.sessionFile : task.target.session === meta.id);
    switch (args.op) {
      case 'add': {
        let prompt;
        try {
          prompt = promptOf(args.prompt);
        } catch (err) {
          return refused(`Nothing scheduled: ${/** @type {Error} */ (err).message}.`);
        }
        const hasAt = typeof args.at === 'string' && args.at.trim() !== '';
        const hasIn = typeof args.in === 'string' && args.in.trim() !== '';
        if (hasAt === hasIn) return refused('Nothing scheduled: give either `at` (a date and time) or `in` (a while from now), not both or neither.');
        const dueAt = (hasAt ? parseAt(/** @type {string} */ (args.at)) : at + (parseDelay(/** @type {string} */ (args.in)) ?? NaN)) ?? NaN;
        if (!Number.isFinite(dueAt)) {
          return refused(hasAt ? 'Nothing scheduled: `at` must read YYYY-MM-DDTHH:MM (local time), optionally with Z or an offset such as +01:00.' : 'Nothing scheduled: `in` must be numbers with units (s, m, h, d, w), such as 10m or 1h 30m.');
        }
        if (dueAt <= at) return refused(`Nothing scheduled: that time has passed. It is now ${localTime(at)}.`);
        /** @type {ScheduledTask} */
        const task = {
          id: randomBytes(4).toString('hex'),
          target: { sessionFile: meta.sessionFile, session: meta.id, cwd: meta.cwd },
          prompt,
          dueAt,
          createdAt: at,
          missedAt: null,
          error: null,
        };
        await store.set([...store.get(), task]);
        return { text: `Scheduled ${task.id}: it runs ${localTime(dueAt)}, in ${duration(dueAt - at)}. Tell the user when.`, details: { op: 'add', task } };
      }
      case 'list': {
        const tasks = store.get().filter(here).sort((a, b) => a.dueAt - b.dueAt);
        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const lines = tasks.length ? ['Scheduled in this conversation:', ...tasks.map((t) => describe(t, at))] : ['Nothing is scheduled in this conversation.'];
        return { text: [`It is now ${localTime(at)} (${zone}).`, ...lines].join('\n'), details: { op: 'list', tasks } };
      }
      case 'cancel': {
        const id = typeof args.id === 'string' ? args.id.trim() : '';
        const task = store.get().find((t) => t.id === id && here(t));
        if (!task) return refused(`No scheduled prompt ${String(args.id ?? '')} in this conversation: \`list\` shows them.`);
        if (running.has(task.id)) return refused(`${task.id} is being sent now: too late to cancel it.`);
        await drop(task.id);
        return { text: `Cancelled ${task.id}.`, details: { op: 'cancel', task } };
      }
      default:
        return refused('`op` must be add, list or cancel.');
    }
  }

  return {
    all: store.get,
    /** Hears every change, with every scheduled prompt. */
    subscribe: store.subscribe,
    call,
    /**
     * The user changed scheduled prompt `id` (its prompt, its time, or both): looked at, it is no
     * longer missed, and its last failure is history.
     * @param {string} id @param {{ prompt?: unknown, dueAt?: unknown }} patch untrusted
     * @returns {Promise<ScheduledTask>}
     */
    async edit(id, patch) {
      owned(id);
      /** @type {Partial<ScheduledTask>} */
      const next = { missedAt: null, error: null };
      if (patch.prompt !== undefined) next.prompt = promptOf(patch.prompt);
      if (patch.dueAt !== undefined) {
        if (typeof patch.dueAt !== 'number' || !Number.isFinite(patch.dueAt)) throw new ScheduleRefused(400, 'expected dueAt in epoch milliseconds');
        if (patch.dueAt <= now()) throw new ScheduleRefused(400, 'that time has passed');
        next.dueAt = patch.dueAt;
      }
      await change(id, next);
      return /** @type {ScheduledTask} */ (store.get().find((t) => t.id === id));
    },
    /** The user deleted scheduled prompt `id`. @param {string} id */
    async remove(id) {
      owned(id);
      await drop(id);
    },
    /**
     * A rewind moved a conversation from journal `from` onto `to`: its scheduled prompts go with it.
     * @param {string} from @param {string} to
     */
    moved(from, to) {
      if (!store.get().some((t) => t.target.sessionFile === from)) return Promise.resolve();
      return store.set(store.get().map((t) => (t.target.sessionFile === from ? { ...t, target: { ...t.target, sessionFile: to } } : t)));
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

/** @typedef {Awaited<ReturnType<typeof loadSchedule>>} Schedule */

/**
 * The daemon's tools for the omps it launches (hub.js `hostTools`): the schedule tool, run by the
 * schedule `get` gives (loaded after the hub, as it sends prompts through the hub's sessions).
 * @param {() => Schedule} get @returns {HostTools}
 */
export const scheduleTools = (get) => ({
  tools: [SCHEDULE_TOOL],
  call: (meta, name, args) => (name === SCHEDULE_TOOL.name ? get().call(meta, args) : Promise.resolve(refused(`No such tool: ${name}.`))),
});
