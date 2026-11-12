/**
 * The process ledger: the long-running processes cockpit's agents start, each with who started it,
 * why and for how long (what the agent said), and what the OS saw of it (memory, CPU, ports,
 * connections, activity), from start to end, kept 30 days after it ends, so the owner can see
 * what is running, what was left behind, and how long anything ran.
 *
 * What it follows, found by a sweep of the OS's process table (process-table.js) every few
 * seconds:
 *
 * - **Named services** (`bash` with `name`): omp's result names the process (`details.service.pid`).
 * - **Background jobs**: a process under a session's omp that started while one of its `bash`
 *   calls ran and still runs well after the call ended (an `async` job, one omp put in the
 *   background, one started with `&`), with the call it came from. omp's own helpers are not
 *   agents'.
 * - **Orphans** (`unowned`): a process whose parent is gone (it now belongs to `launchd`) and that
 *   runs in, or from, a directory one of the daemon's conversations worked in, which the ledger
 *   did not see start.
 *
 * A service or job started with a declaration (process-commands.js, enforced by process-gate.js)
 * is owned by its conversation for the lifetime it declared; one started without is owned while
 * its conversation is awake. Another conversation may reuse it (the `processes` tool), and owns
 * it too, for the lifetime it gives. Once no owner wants it any more, it is a leftover, flagged
 * for the user to stop (the Processes window), never stopped by itself. The user may keep one,
 * which is then never flagged.
 *
 * A process is named by its pid and start time (`key`), so a reused pid is never taken for it,
 * and Stop checks both before signalling. One that ended while the daemon was not running is
 * taken to have ended when the daemon next looks. Memory, CPU and connections are kept in memory
 * only; the records, the ports they listen on and the time up to which the user has seen the
 * leftovers are kept in one file in the state directory (state-file.js), which the gate reads too.
 *
 * `<file>`: `{ version: 1, seenAt, records: [ProcessRecord, …] }`.
 */
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { daemonNow } from './clock.js';
import { loadStateFile } from './state-file.js';
import { readDirectories, readProcesses, readSockets } from './process-table.js';
import { DECLARATION_FORMAT, declarationOf, lifetimeOf, masked, withoutDeclaration } from './process-commands.js';
import { duration } from '../src/timeline/scale.js';
/** @import { ProcessList, ProcessOwner, ProcessRecord, ProcessSample, ProcessStatus, ProcessView, SessionMeta } from './wire.js' */
/** @import { Hub } from './hub.js' */
/** @import { HostToolResult, HostTools } from './omp-session.js' */
/** @import { Declaration } from './process-commands.js' */
/** @import { OsProcess, Sockets } from './process-table.js' */

const VERSION = 1;
/** How often the process table is read. */
const SWEEP_MS = 5000;
/** Every how many sweeps the followed processes' sockets are read (`lsof` is slower). */
const SOCKETS_EVERY = 3;
/** Every how many sweeps orphans are looked for. */
const ORPHANS_EVERY = 12;
/** How long after a call ended what it started and still runs counts as having outlived it. */
const SETTLED_MS = 3000;
/** A process started this close to a call (the table gives seconds) may have come from it. */
const SLACK_MS = 1000;
/** How long a call is remembered after it ended, and at most while it runs. */
const CALL_KEPT_MS = 10 * 60_000;
const CALL_RUNS_AT_MOST_MS = 86_400_000;
/** How far apart, and over how long, the samples a window charts are kept. */
const SAMPLE_MS = 30_000;
const TREND_MS = 3_600_000;
/** How long an ended process stays in the ledger. */
const KEEP_ENDED_MS = 30 * 86_400_000;
/** How long Stop waits after TERM before it KILLs what is left. */
const STOP_GRACE_MS = 3000;
/** CPU percent from which a process counts as busy. */
const BUSY_CPU = 1;
/** The usual ports of databases: Postgres, MySQL, Redis, MongoDB, ClickHouse (native and HTTP), SQL Server. */
const DB_PORTS = new Set([5432, 3306, 6379, 27017, 9000, 8123, 1433]);
/** omp's own processes (its broker and other helpers, its Python kernel, omp itself): never an agent's. */
const OMP_OWN = /__omp_worker_|omp-python-runner|@oh-my-pi\//;
/** Commands no orphan an agent left can be: the OS's and installed apps' (not a framework's `.app`, such as Python's). */
const SYSTEM_COMMAND = /^(?:\/System\/|\/usr\/(?:libexec|sbin)\/|\/Library\/|\/Applications\/)/;

/** A process the ledger cannot act on: `status` says why, as HTTP does. */
export class ProcessRefused extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * A `bash` call an agent made: when it started and ended (daemon time; `end` null while it runs),
 * its command and the declaration at its end, the intent omp gave it, and the service it named.
 * @typedef {{ id: string, session: string, start: number, end: number | null, command: string, cwd: string | null, intent: string | null, declaration: Declaration | null, name: string | null }} BashCall
 */

/** What the OS saw of a followed process lately (kept in memory only). @typedef {{ pids: number[], rss: number, cpu: number, cpuTime: number, connections: number, dbConnections: number, lastActiveAt: number | null, trend: ProcessSample[] }} Seen */

/** @param {any} data parsed untrusted JSON @returns {data is { version: 1, seenAt: number, records: ProcessRecord[] }} */
const isLedgerFile = (data) =>
  data?.version === VERSION &&
  Number.isFinite(data.seenAt) &&
  Array.isArray(data.records) &&
  data.records.every((/** @type {any} */ r) => typeof r?.key === 'string' && Number.isInteger(r.pid) && Number.isFinite(r.startedAt) && Array.isArray(r.owners) && Array.isArray(r.ports));

/** The key naming process `p`. @param {{ pid: number, startedAt: number }} p */
const keyOf = (p) => `${p.pid}-${p.startedAt}`;

/** Each process's children. @param {readonly OsProcess[]} table */
function childrenOf(table) {
  /** @type {Map<number, OsProcess[]>} */
  const children = new Map();
  for (const p of table) {
    const siblings = children.get(p.ppid);
    if (siblings) siblings.push(p);
    else children.set(p.ppid, [p]);
  }
  return children;
}

/** `root` and every process under it. @param {OsProcess} root @param {Map<number, OsProcess[]>} children */
function treeOf(root, children) {
  const tree = [root];
  for (let i = 0; i < tree.length; i++) tree.push(...(children.get(tree[i].pid) ?? []));
  return tree;
}

/**
 * The processes agents' `bash` calls left running: under each session's omp (`pid`), each process
 * that started during one of its calls (`calls`) and still runs `SETTLED_MS` after that call ended,
 * the topmost of its tree to have (what it started is part of it). A call with a declaration is
 * preferred to one without, then the latest; a process that may have come from a call still
 * running waits for it to end. omp's helpers, and what they start, are never an agent's.
 * @param {readonly OsProcess[]} table
 * @param {ReadonlyArray<{ pid: number, calls: readonly BashCall[] }>} sessions
 * @param {number} now
 * @returns {Array<{ process: OsProcess, call: BashCall }>}
 */
export function leftBehind(table, sessions, now) {
  const children = childrenOf(table);
  /** @type {Array<{ process: OsProcess, call: BashCall }>} */
  const found = [];
  for (const { pid, calls } of sessions) {
    const stack = [...(children.get(pid) ?? [])];
    while (stack.length > 0) {
      const p = /** @type {OsProcess} */ (stack.pop());
      if (OMP_OWN.test(p.command)) continue;
      const during = calls.filter((c) => p.startedAt >= Math.floor(c.start / 1000) * 1000 - SLACK_MS && p.startedAt <= (c.end ?? Infinity) + SLACK_MS);
      if (during.length === 0) {
        stack.push(...(children.get(p.pid) ?? []));
        continue;
      }
      if (during.some((c) => c.end === null || c.end > now - SETTLED_MS)) continue;
      const call = during.reduce((best, c) => (Boolean(c.declaration) !== Boolean(best.declaration) ? (c.declaration ? c : best) : c.start > best.start ? c : best));
      found.push({ process: p, call });
    }
  }
  return found;
}

/**
 * Whether `owner` still wants its process at `now`: for good, until the time it declared, or (by
 * its words, or with no declaration) while its conversation is awake.
 * @param {ProcessOwner} owner @param {number} now @param {boolean} awake
 */
function wants(owner, now, awake) {
  if (owner.lifetime === null) return awake;
  const lifetime = lifetimeOf(owner.lifetime);
  return lifetime.kind === 'forever' || (lifetime.kind === 'for' ? now < owner.since + lifetime.ms : awake);
}

/**
 * How `record` stands at `now`, `awake` saying whether a conversation (by omp's id) is.
 * @param {ProcessRecord} record @param {number} now @param {(ompId: string) => boolean} awake
 * @returns {ProcessStatus}
 */
export function statusOf(record, now, awake) {
  if (record.endedAt !== null) return 'ended';
  if (record.kept) return 'kept';
  const wanting = record.owners.filter((o) => wants(o, now, awake(o.ompId)));
  if (wanting.length === 0) return 'leftover';
  return wanting.some((o) => o.lifetime !== null) ? 'running' : 'undeclared';
}

/** Whether `path` is `dir` or inside it. @param {string} path @param {string} dir */
const inside = (path, dir) => path === dir || path.startsWith(dir.endsWith('/') ? dir : `${dir}/`);

/**
 * The directory of `dirs` an orphan runs in or from (its working directory, or a path its
 * command names), the deepest if several; null if none.
 * @param {string | null} cwd @param {string} command @param {Iterable<string>} dirs
 */
export function directoryOf(cwd, command, dirs) {
  const paths = [...(cwd ? [cwd] : []), ...command.split(/\s+/).filter((word) => word.startsWith('/'))];
  let best = null;
  for (const dir of dirs) if (paths.some((path) => inside(path, dir)) && (!best || dir.length > best.length)) best = dir;
  return best;
}

/**
 * The `processes` tool every omp the daemon launches is given (omp's `set_host_tools`). Its
 * description is all the agent knows of the ledger and of declaring, so it says both, giving no
 * example of a lifetime (process-commands.js).
 */
const PROCESSES_TOOL = Object.freeze({
  name: 'processes',
  label: 'Processes',
  description:
    "The long-running processes agents in this workbench started (named services and background jobs) that still run in this project, from the workbench's ledger. " +
    '`list` shows each with its id, what it runs, its ports, who started it, what for, and how long it has run: before starting a server, look there, as one you can use may be running. ' +
    'To use one another conversation started, `reuse` it with your own `purpose` and `lifetime` (how long you will need it): this conversation then owns it too. ' +
    '`stop` ends one that only this conversation owns, or a leftover (none of its owners wants it any more); any other is for the user to stop, in the Processes window. ' +
    `Starting a named service or a background job (\`bash\` with \`name\` or \`async\`) takes a declaration at the end of the command, in your own words: \`${DECLARATION_FORMAT}\`.`,
  parameters: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['list', 'reuse', 'stop'], description: 'list, reuse (with id, purpose and lifetime) or stop (with id)' },
      id: { type: 'string', description: 'The process, as list names it' },
      purpose: { type: 'string', description: 'What you will use it for' },
      lifetime: { type: 'string', description: 'How long you will need it' },
    },
    required: ['op'],
    additionalProperties: false,
  },
  loadMode: 'essential',
});

/** @param {string} message @returns {HostToolResult} */
const refused = (message) => ({ text: message, isError: true });

/**
 * Loads the ledger kept in `file` and starts following processes: the calls in `hub`'s events,
 * the OS's table every few seconds (`os` reads it: process-table.js, by default).
 * @param {{
 *   hub: Pick<Hub, 'subscribe' | 'list' | 'activity'>,
 *   file: string,
 *   now?: () => number,
 *   home?: string,
 *   os?: { processes: typeof readProcesses, sockets: typeof readSockets, directories: typeof readDirectories },
 *   signal?: (pid: number, signal: NodeJS.Signals) => void,
 *   sweepMs?: number,
 * }} options
 */
export async function loadProcesses({
  hub,
  file,
  now = daemonNow,
  home = homedir(),
  os = { processes: readProcesses, sockets: readSockets, directories: readDirectories },
  signal = (pid, sig) => process.kill(pid, sig),
  sweepMs = SWEEP_MS,
}) {
  const store = await loadStateFile({
    file,
    what: 'a process ledger',
    initial: { seenAt: 0, records: /** @type {ProcessRecord[]} */ ([]) },
    read: (data) => (isLedgerFile(data) ? { seenAt: data.seenAt, records: data.records } : null),
    write: (ledger) => ({ version: VERSION, ...ledger }),
  });
  /** @type {Map<string, ProcessRecord>} */
  const records = new Map(store.get().records.map((r) => [r.key, r]));
  let seenAt = store.get().seenAt;
  /** @type {Map<string, Seen>} */
  const seen = new Map();
  /** @type {Map<string, BashCall>} */
  const calls = new Map();
  /** Services omp started, by the pid it reported, until the table shows them. @type {Array<{ call: BashCall, pid: number }>} */
  let services = [];
  let sweeps = 0;
  let sweeping = false;
  let dirty = false;

  const save = () => {
    if (!dirty) return Promise.resolve();
    dirty = false;
    return store.set({ seenAt, records: [...records.values()] });
  };

  /** The conversations awake now, by omp's id. */
  const awakeIds = () => new Set(hub.list().flatMap((m) => ((m.status === 'starting' || m.status === 'ready') && m.ompId ? [m.ompId] : [])));

  const offHub = hub.subscribe((event) => {
    // An omp that exited ends the calls it was making: none of them reports its end any more.
    if (event.kind === 'session' && (event.meta.status === 'exited' || event.meta.status === 'failed')) {
      for (const call of calls.values()) if (call.session === event.session && call.end === null) call.end = event.at;
    }
    if (event.kind !== 'frame') return;
    const frame = event.frame;
    if (frame.toolName !== 'bash' || typeof frame.toolCallId !== 'string') return;
    if (frame.type === 'tool_execution_start' && typeof frame.args?.command === 'string') {
      const { command, cwd, name } = frame.args;
      calls.set(frame.toolCallId, {
        id: frame.toolCallId,
        session: event.session,
        start: event.at,
        end: null,
        command,
        cwd: typeof cwd === 'string' && cwd ? cwd : null,
        intent: typeof frame.intent === 'string' && frame.intent ? frame.intent : null,
        declaration: declarationOf(command),
        name: typeof name === 'string' && name.trim() ? name.trim() : null,
      });
    } else if (frame.type === 'tool_execution_end') {
      const call = calls.get(frame.toolCallId);
      if (!call) return;
      call.end = event.at;
      const pid = frame.result?.details?.service?.pid;
      if (!frame.isError && call.name && Number.isInteger(pid)) services.push({ call, pid });
    }
  });

  /**
   * Starts following process `p`, which `call` of a session started (a named service when it
   * named one): owned by its conversation. Not until omp has said which conversation that is.
   * @param {OsProcess} p @param {BashCall} call
   */
  function follow(p, call) {
    const key = keyOf(p);
    if (records.has(key)) return true;
    const meta = hub.list().find((m) => m.id === call.session);
    if (!meta?.ompId) return false;
    /** @type {ProcessOwner} */
    const owner = {
      ompId: meta.ompId,
      sessionFile: meta.sessionFile,
      cwd: meta.cwd,
      title: hub.activity()[meta.id]?.name ?? null,
      how: call.declaration ? 'declared' : 'undeclared',
      purpose: call.declaration?.purpose ?? call.intent,
      lifetime: call.declaration?.lifetime ?? null,
      since: call.start,
    };
    records.set(key, {
      key,
      pid: p.pid,
      startedAt: p.startedAt,
      kind: call.name ? 'service' : 'job',
      name: call.name,
      command: masked(withoutDeclaration(call.command)),
      cwd: call.cwd ? resolve(meta.cwd, call.cwd) : meta.cwd,
      project: meta.cwd,
      owners: [owner],
      ports: [],
      kept: false,
      flaggedAt: null,
      endedAt: null,
      stoppedBy: null,
    });
    dirty = true;
    return true;
  }

  /** What the OS shows of record `r`'s tree now, folded into what it saw before. @param {ProcessRecord} r @param {OsProcess[]} tree @param {number} at */
  function sample(r, tree, at) {
    const before = seen.get(r.key);
    const rss = tree.reduce((sum, p) => sum + p.rss, 0);
    const cpu = tree.reduce((sum, p) => sum + p.cpu, 0);
    const cpuTime = tree.reduce((sum, p) => sum + p.cpuTime, 0);
    const busy = cpu >= BUSY_CPU || (before !== undefined && cpuTime > before.cpuTime) || (before?.connections ?? 0) > 0;
    const trend = before?.trend.filter((s) => s.at > at - TREND_MS) ?? [];
    if (trend.length === 0 || at - trend[trend.length - 1].at >= SAMPLE_MS) trend.push({ at, rss, cpu });
    seen.set(r.key, {
      pids: tree.map((p) => p.pid),
      rss,
      cpu,
      cpuTime,
      connections: before?.connections ?? 0,
      dbConnections: before?.dbConnections ?? 0,
      lastActiveAt: busy ? at : (before?.lastActiveAt ?? null),
      trend,
    });
  }

  /** Reads which ports the followed processes listen on and which connections they hold. */
  async function readSocketsNow() {
    const running = [...records.values()].filter((r) => r.endedAt === null && seen.has(r.key));
    const sockets = await os.sockets(running.flatMap((r) => seen.get(r.key)?.pids ?? []));
    for (const r of running) {
      const s = /** @type {Seen} */ (seen.get(r.key));
      /** @type {Sockets[]} */
      const each = s.pids.flatMap((pid) => sockets.get(pid) ?? []);
      const ports = [...new Set(each.flatMap((x) => x.listening))].sort((a, b) => a - b);
      const remotes = each.flatMap((x) => x.remotes);
      s.connections = remotes.length;
      s.dbConnections = remotes.filter((port) => DB_PORTS.has(port)).length;
      if (remotes.length > 0) s.lastActiveAt = now();
      if (ports.join() !== r.ports.join()) {
        r.ports = ports;
        dirty = true;
      }
    }
  }

  /**
   * Looks for orphans in the directories the daemon's conversations worked in (home and `/` are
   * not one), as given or with their links resolved (`/tmp` is `/private/tmp` to `lsof`):
   * processes of this user whose parent is gone, not the daemon's own, not followed.
   * @param {readonly OsProcess[]} table @param {number} at
   */
  async function findOrphans(table, at) {
    const projects = new Set([...hub.list().map((m) => m.cwd), ...[...records.values()].flatMap((r) => (r.kind !== 'unowned' && r.project ? [r.project] : []))]);
    projects.delete(home);
    projects.delete('/');
    if (projects.size === 0) return;
    /** Each project by the paths that name it. @type {Map<string, string>} */
    const dirs = new Map();
    for (const project of projects) {
      dirs.set(project, project);
      try {
        dirs.set(realpathSync(project), project);
      } catch {}
    }
    const uid = process.getuid?.() ?? -1;
    // The daemon and what it runs under (a terminal multiplexer, `caffeinate`…) are never orphans to stop.
    const parents = new Map(table.map((p) => [p.pid, p.ppid]));
    const workbench = new Set();
    for (let pid = process.pid; pid > 1 && !workbench.has(pid); pid = parents.get(pid) ?? 0) workbench.add(pid);
    const candidates = table.filter(
      (p) => p.ppid === 1 && p.uid === uid && !workbench.has(p.pid) && !records.has(keyOf(p)) && !OMP_OWN.test(p.command) && !SYSTEM_COMMAND.test(p.command),
    );
    if (candidates.length === 0) return;
    const cwds = await os.directories(candidates.map((p) => p.pid));
    for (const p of candidates) {
      const cwd = cwds.get(p.pid) ?? null;
      const dir = directoryOf(cwd, p.command, dirs.keys());
      const project = dir && dirs.get(dir);
      if (!project) continue;
      records.set(keyOf(p), {
        key: keyOf(p),
        pid: p.pid,
        startedAt: p.startedAt,
        kind: 'unowned',
        name: null,
        command: masked(p.command),
        cwd: cwd && isAbsolute(cwd) ? cwd : null,
        project,
        owners: [],
        ports: [],
        kept: false,
        flaggedAt: at,
        endedAt: null,
        stoppedBy: null,
      });
      dirty = true;
    }
  }

  async function sweep() {
    if (sweeping) return;
    sweeping = true;
    try {
      const table = await os.processes();
      const at = now();
      const byPid = new Map(table.map((p) => [p.pid, p]));
      const children = childrenOf(table);
      const metas = hub.list();
      services = services.filter(({ call, pid }) => {
        const p = byPid.get(pid);
        return p ? !follow(p, call) : false;
      });
      const awakeSessions = metas.flatMap((m) => ((m.status === 'starting' || m.status === 'ready') && m.pid ? [{ pid: m.pid, calls: [...calls.values()].filter((c) => c.session === m.id) }] : []));
      for (const { process: p, call } of leftBehind(table, awakeSessions, at)) follow(p, call);
      for (const r of records.values()) {
        if (r.endedAt !== null) continue;
        const p = byPid.get(r.pid);
        if (!p || p.startedAt !== r.startedAt) {
          r.endedAt = at;
          seen.delete(r.key);
          dirty = true;
        } else sample(r, treeOf(p, children), at);
      }
      // Counted first, so a failing `lsof` is not retried on every sweep, and the rest still runs.
      const count = sweeps++;
      if (count % SOCKETS_EVERY === 0) await readSocketsNow().catch((err) => console.error('[daemon] could not read the processes\u2019 sockets:', err));
      if (count % ORPHANS_EVERY === 0) await findOrphans(table, at).catch((err) => console.error('[daemon] could not look for orphans:', err));
      const awake = awakeIds();
      const titles = new Map(metas.flatMap((m) => (m.ompId ? [[m.ompId, { title: hub.activity()[m.id]?.name ?? null, sessionFile: m.sessionFile }]] : [])));
      for (const [key, r] of records) {
        if (r.endedAt !== null) {
          if (r.endedAt < at - KEEP_ENDED_MS) {
            records.delete(key);
            dirty = true;
          }
          continue;
        }
        const leftover = statusOf(r, at, (id) => awake.has(id)) === 'leftover';
        if (leftover !== (r.flaggedAt !== null)) {
          r.flaggedAt = leftover ? at : null;
          dirty = true;
        }
        for (const owner of r.owners) {
          const latest = titles.get(owner.ompId);
          if (!latest || !awake.has(owner.ompId)) continue;
          if ((latest.title && latest.title !== owner.title) || (latest.sessionFile && latest.sessionFile !== owner.sessionFile)) {
            owner.title = latest.title ?? owner.title;
            owner.sessionFile = latest.sessionFile ?? owner.sessionFile;
            dirty = true;
          }
        }
      }
      for (const [id, call] of calls) {
        if (call.end !== null ? call.end < at - CALL_KEPT_MS : call.start < at - CALL_RUNS_AT_MOST_MS) calls.delete(id);
      }
      await save();
    } catch (err) {
      console.error('[daemon] could not read the processes:', err);
    } finally {
      sweeping = false;
    }
  }

  void sweep();
  const timer = setInterval(() => void sweep(), sweepMs);
  timer.unref();

  /** @param {string} key */
  function recordOf(key) {
    const record = records.get(key);
    if (!record) throw new ProcessRefused(404, 'no such process');
    return record;
  }

  /**
   * Stops process `key` and everything under it: TERM, then KILL for what is left after a grace
   * period. Only the process the ledger names (its pid and start time) is signalled.
   * @param {string} key @param {string} by who stops it, as the window says
   */
  async function stop(key, by) {
    const record = recordOf(key);
    if (record.endedAt !== null) throw new ProcessRefused(409, 'it has ended');
    const table = await os.processes();
    const root = table.find((p) => p.pid === record.pid && p.startedAt === record.startedAt);
    if (!root) {
      record.endedAt = now();
      seen.delete(record.key);
      dirty = true;
      await save();
      throw new ProcessRefused(409, 'it has ended');
    }
    const tree = treeOf(root, childrenOf(table));
    if (tree.some((p) => p.pid === process.pid)) throw new ProcessRefused(409, 'it runs the workbench');
    record.stoppedBy = by;
    dirty = true;
    await save();
    /** @param {readonly OsProcess[]} processes @param {NodeJS.Signals} sig */
    const send = (processes, sig) => {
      for (const p of processes) {
        try {
          signal(p.pid, sig);
        } catch {}
      }
    };
    send(tree, 'SIGTERM');
    setTimeout(async () => {
      try {
        const left = new Set((await os.processes()).map(keyOf));
        send(
          tree.filter((p) => left.has(keyOf(p))),
          'SIGKILL',
        );
      } catch (err) {
        console.error(`[daemon] could not finish stopping ${key}:`, err);
      }
      void sweep();
    }, STOP_GRACE_MS).unref();
  }

  /** @param {ProcessRecord} r @param {number} at @param {Set<string>} awake @returns {ProcessView} */
  function view(r, at, awake) {
    const s = r.endedAt === null ? seen.get(r.key) : undefined;
    return {
      ...r,
      status: statusOf(r, at, (id) => awake.has(id)),
      owners: r.owners.map((o) => ({ ...o, awake: awake.has(o.ompId) })),
      rss: s?.rss ?? null,
      cpu: s?.cpu ?? null,
      processes: s?.pids.length ?? 0,
      connections: s?.connections ?? 0,
      dbConnections: s?.dbConnections ?? 0,
      lastActiveAt: s?.lastActiveAt ?? null,
      trend: s?.trend ?? [],
    };
  }

  /**
   * What the agent of conversation `meta` is told of the processes running in its project.
   * @param {SessionMeta} meta @param {number} at @param {Set<string>} awake
   */
  function listed(meta, at, awake) {
    const running = [...records.values()].filter((r) => r.endedAt === null && r.project && (inside(r.project, meta.cwd) || inside(meta.cwd, r.project)));
    if (running.length === 0) return `Nothing agents started is running in ${meta.cwd}.`;
    return running
      .map((r) => {
        const status = statusOf(r, at, (id) => awake.has(id));
        const ports = r.ports.length ? ` · port ${r.ports.join(', ')}` : '';
        const owners = r.owners.map((o) => `${o.ompId === meta.ompId ? 'this conversation' : `"${o.title ?? o.cwd}"`}${o.purpose ? ` for "${o.purpose}"` : ''}${o.lifetime ? ` (lifetime: ${o.lifetime})` : ' (no declaration)'}`);
        return `- id ${r.key} · ${r.name ? `${r.name}: ` : ''}${r.command}${ports} · ${status} · running ${duration(at - r.startedAt)} · ${owners.length ? `owned by ${owners.join('; ')}` : 'owned by nobody'}`;
      })
      .join('\n');
  }

  /**
   * The `processes` tool's call, for conversation `meta`.
   * @param {SessionMeta} meta @param {Record<string, unknown>} args
   * @returns {Promise<HostToolResult>}
   */
  async function call(meta, args) {
    const at = now();
    const awake = awakeIds();
    if (args.op === 'list') return { text: listed(meta, at, awake) };
    if (typeof args.id !== 'string' || !meta.ompId) return refused('Name the process by its id, as list gives it.');
    const record = records.get(args.id);
    if (!record || record.endedAt !== null) return refused(`No running process has the id ${args.id}: list shows those that do.`);
    if (args.op === 'reuse') {
      const purpose = typeof args.purpose === 'string' ? args.purpose.trim() : '';
      const lifetime = typeof args.lifetime === 'string' ? args.lifetime.trim() : '';
      if (!purpose || !lifetime) return refused('Say, in your own words, what you will use it for (`purpose`) and how long you will need it (`lifetime`).');
      record.owners = [
        ...record.owners.filter((o) => o.ompId !== meta.ompId),
        { ompId: meta.ompId, sessionFile: meta.sessionFile, cwd: meta.cwd, title: hub.activity()[meta.id]?.name ?? null, how: 'reused', purpose, lifetime, since: at },
      ];
      if (record.flaggedAt !== null) record.flaggedAt = null;
      dirty = true;
      await save();
      return { text: `This conversation now owns ${record.name ?? record.command} (id ${record.key}) too.` };
    }
    if (args.op === 'stop') {
      const own = record.owners.length > 0 && record.owners.every((o) => o.ompId === meta.ompId);
      if (!own && statusOf(record, at, (id) => awake.has(id)) !== 'leftover') {
        return refused('Another conversation still wants it (or the user keeps it): only the user can stop it, in the Processes window.');
      }
      try {
        await stop(record.key, `"${hub.activity()[meta.id]?.name ?? meta.cwd}" (an agent)`);
      } catch (err) {
        return refused(err instanceof Error ? err.message : String(err));
      }
      return { text: `Stopped ${record.name ?? record.command} (id ${record.key}).` };
    }
    return refused('`op` is list, reuse or stop.');
  }

  return {
    /** Every process in the ledger, as the Processes window shows it. @returns {ProcessList} */
    list() {
      const at = now();
      const awake = awakeIds();
      return { now: at, seenAt, processes: [...records.values()].map((r) => view(r, at, awake)) };
    },
    /** Stops process `key` for the user. @param {string} key */
    stop: (key) => stop(key, 'you'),
    /** Keeps process `key` (never a leftover), or stops keeping it. @param {string} key @param {boolean} kept */
    async keep(key, kept) {
      const record = recordOf(key);
      if (record.kept === kept) return;
      record.kept = kept;
      dirty = true;
      await sweep();
      await save();
    },
    /** The user saw the leftovers flagged up to `at`. @param {number} at */
    seen(at) {
      if (at <= seenAt) return Promise.resolve();
      seenAt = at;
      dirty = true;
      return save();
    },
    /** A conversation goes on under a new id (a rewind): what it owns, it still owns. @param {string} from @param {string} to */
    moved(from, to) {
      for (const r of records.values()) {
        for (const o of r.owners) {
          if (o.ompId !== from) continue;
          o.ompId = to;
          dirty = true;
        }
      }
      void save();
    },
    /** The `processes` tool's call (processesTools). @param {SessionMeta} meta @param {Record<string, unknown>} args */
    call,
    close() {
      clearInterval(timer);
      offHub();
    },
  };
}

/** @typedef {Awaited<ReturnType<typeof loadProcesses>>} Processes */

/**
 * The `processes` tool for every omp the daemon launches (omp-session.js `HostTools`), answered by
 * the ledger `get` returns once it is loaded.
 * @param {() => Processes} get
 * @returns {HostTools}
 */
export const processesTools = (get) => ({
  tools: [PROCESSES_TOOL],
  call: (meta, name, args) => (name === PROCESSES_TOOL.name ? get().call(meta, args) : Promise.resolve(refused(`No such tool: ${name}.`))),
});
