/**
 * What the OS says about processes, read with `ps` and `lsof`: every process with its parent,
 * owner, memory, CPU, start time and command line; the TCP ports some listen on and the
 * connections they hold; and their working directories. The process ledger (processes.js) is
 * built from these: what the OS saw, beside what agents said.
 *
 * Reading them takes `ps` a few tens of milliseconds and `lsof` more, so the ledger reads the
 * table often and the sockets and directories less often, only for the processes it follows.
 */

/**
 * One process as `ps` lists it: `rss` in bytes, `cpu` the percent `ps` gives (an average over
 * the last minute or so), `cpuTime` the CPU seconds it has used, `startedAt` epoch milliseconds
 * (to the second, which is all `ps` gives).
 * @typedef {{ pid: number, ppid: number, uid: number, rss: number, cpu: number, cpuTime: number, startedAt: number, command: string }} OsProcess
 */

/** The TCP ports a process listens on, and the remote ports of the connections it holds. @typedef {{ listening: number[], remotes: number[] }} Sockets */

/** The locale `ps` and `lsof` run in: their dates and numbers as parsed here. */
const C_LOCALE = { ...process.env, LC_ALL: 'C' };

/**
 * What `command` prints, whatever it exits with (`lsof` exits 1 when one of the processes
 * asked about has nothing to show).
 * @param {string[]} command
 */
async function output(command) {
  const child = Bun.spawn(command, { env: C_LOCALE, stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' });
  const text = await new Response(child.stdout).text();
  await child.exited;
  return text;
}

/** CPU time as `ps` prints it, `[[dd-]hh:]mm:ss[.ss]`, in seconds. @param {string} text */
function cpuSeconds(text) {
  const [days, clock] = text.includes('-') ? text.split('-') : ['0', text];
  return Number(days) * 86_400 + clock.split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
}

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/;

/**
 * The processes in `ps -o pid=,ppid=,uid=,rss=,%cpu=,time=,lstart=,command=` output; lines it
 * cannot read are skipped.
 * @param {string} text
 * @returns {OsProcess[]}
 */
export function parseProcesses(text) {
  /** @type {OsProcess[]} */
  const processes = [];
  for (const line of text.split('\n')) {
    const m = PS_LINE.exec(line);
    if (!m) continue;
    const startedAt = Date.parse(m[7].replace(/\s+/g, ' '));
    if (!Number.isFinite(startedAt)) continue;
    processes.push({ pid: Number(m[1]), ppid: Number(m[2]), uid: Number(m[3]), rss: Number(m[4]) * 1024, cpu: Number(m[5]), cpuTime: cpuSeconds(m[6]), startedAt, command: m[8] });
  }
  return processes;
}

/** Every process on the machine, as `ps` lists it now. */
export async function readProcesses() {
  return parseProcesses(await output(['ps', '-axww', '-o', 'pid=,ppid=,uid=,rss=,%cpu=,time=,lstart=,command=']));
}

/** The port at the end of an address (`127.0.0.1:8081`, `*:8081`, `[::1]:8081`). @param {string} address */
const portOf = (address) => Number(address.slice(address.lastIndexOf(':') + 1));

/**
 * The TCP sockets of each process in `lsof -F pnT` output: the ports it listens on, and the
 * remote ports of its established connections.
 * @param {string} text
 * @returns {Map<number, Sockets>}
 */
export function parseSockets(text) {
  /** @type {Map<number, Sockets>} */
  const sockets = new Map();
  /** @type {Sockets | null} */
  let current = null;
  /** @type {string | null} */
  let name = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) {
      current = { listening: [], remotes: [] };
      sockets.set(Number(line.slice(1)), current);
    } else if (line.startsWith('n')) name = line.slice(1);
    else if (line.startsWith('TST=') && current && name) {
      const state = line.slice(4);
      if (state === 'LISTEN') current.listening.push(portOf(name));
      else if (state === 'ESTABLISHED' && name.includes('->')) current.remotes.push(portOf(name.split('->')[1]));
    }
  }
  return sockets;
}

/** The TCP sockets of the processes `pids` (none for an empty list). @param {readonly number[]} pids */
export async function readSockets(pids) {
  if (pids.length === 0) return new Map();
  return parseSockets(await output(['lsof', '-nP', '-a', '-p', pids.join(','), '-iTCP', '-F', 'pnT']));
}

/**
 * The working directory of each process in `lsof -d cwd -F pn` output.
 * @param {string} text
 * @returns {Map<number, string>}
 */
export function parseDirectories(text) {
  /** @type {Map<number, string>} */
  const dirs = new Map();
  let pid = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid) dirs.set(pid, line.slice(1));
  }
  return dirs;
}

/** The working directories of the processes `pids`. @param {readonly number[]} pids */
export async function readDirectories(pids) {
  if (pids.length === 0) return new Map();
  return parseDirectories(await output(['lsof', '-a', '-p', pids.join(','), '-d', 'cwd', '-F', 'pn']));
}
