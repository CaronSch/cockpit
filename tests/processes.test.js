import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { directoryOf, leftBehind, statusOf } from '../daemon/processes.js';
import { declarationOf, lifetimeOf, masked, withoutDeclaration } from '../daemon/process-commands.js';
import { parseProcesses, parseSockets } from '../daemon/process-table.js';
/** @import { ProcessOwner, ProcessRecord } from '../daemon/wire.js' */
/** @import { OsProcess } from '../daemon/process-table.js' */
/** @import { BashCall } from '../daemon/processes.js' */

const HOUR = 3_600_000;
const T0 = Date.parse('2026-11-11T10:00:00Z');

/** @param {Partial<ProcessOwner>} owner @returns {ProcessOwner} */
const owner = (owner) => ({ ompId: 'a', sessionFile: null, cwd: '/p', title: null, how: 'declared', purpose: 'dev server', lifetime: null, since: T0, ...owner });

/** @param {Partial<ProcessRecord>} record @returns {ProcessRecord} */
const record = (record) => ({
  key: '1-0',
  pid: 1,
  startedAt: T0,
  kind: 'job',
  name: null,
  command: 'npm run dev',
  cwd: '/p',
  project: '/p',
  owners: [],
  ports: [],
  kept: false,
  flaggedAt: null,
  endedAt: null,
  stoppedBy: null,
  ...record,
});

/** @param {...string} ids */
const awake = (...ids) => (/** @type {string} */ id) => ids.includes(id);

describe('statusOf: when a process is left over', () => {
  test('a lifetime of a length of time runs out then, whether or not its conversation is awake', () => {
    const r = record({ owners: [owner({ lifetime: '2 hours' })] });
    assert.equal(statusOf(r, T0 + HOUR, awake()), 'running');
    assert.equal(statusOf(r, T0 + 2 * HOUR + 1, awake('a')), 'leftover');
  });

  test('"forever" never runs out; words that name no time last while the conversation is awake', () => {
    assert.equal(statusOf(record({ owners: [owner({ lifetime: 'forever' })] }), T0 + 1000 * HOUR, awake()), 'running');
    const r = record({ owners: [owner({ lifetime: 'until the tests pass' })] });
    assert.equal(statusOf(r, T0 + HOUR, awake('a')), 'running');
    assert.equal(statusOf(r, T0 + HOUR, awake()), 'leftover');
  });

  test('one started without a declaration is undeclared while its conversation is awake, a leftover once it sleeps', () => {
    const r = record({ owners: [owner({ how: 'undeclared', lifetime: null })] });
    assert.equal(statusOf(r, T0, awake('a')), 'undeclared');
    assert.equal(statusOf(r, T0, awake()), 'leftover');
  });

  test('with several owners, it is a leftover only once none wants it', () => {
    const r = record({ owners: [owner({ lifetime: '1h' }), owner({ ompId: 'b', how: 'reused', lifetime: 'while I test', since: T0 + HOUR })] });
    assert.equal(statusOf(r, T0 + 2 * HOUR, awake('b')), 'running');
    assert.equal(statusOf(r, T0 + 2 * HOUR, awake()), 'leftover');
  });

  test('an orphan nobody owns is a leftover; a kept or ended process is never one', () => {
    assert.equal(statusOf(record({ kind: 'unowned' }), T0, awake()), 'leftover');
    assert.equal(statusOf(record({ kept: true }), T0, awake()), 'kept');
    assert.equal(statusOf(record({ endedAt: T0, kept: true }), T0, awake()), 'ended');
  });
});

describe('leftBehind: what agents\u2019 bash calls left running', () => {
  const OMP = 100;
  /** @param {Partial<OsProcess>} p @returns {OsProcess} */
  const proc = (p) => ({ pid: 0, ppid: OMP, uid: 501, rss: 0, cpu: 0, cpuTime: 0, startedAt: T0, command: 'node server.js', ...p });
  /** @param {Partial<BashCall>} c @returns {BashCall} */
  const call = (c) => ({ id: 'c1', session: 's', start: T0, end: T0 + 2000, command: 'node server.js &', cwd: null, intent: null, declaration: null, name: null, ...c });
  const NOW = T0 + 60_000;

  test('the topmost process under omp started during a call that ended is found once, with that call', () => {
    const server = proc({ pid: 1, startedAt: T0 + 1000 });
    const worker = proc({ pid: 2, ppid: 1, startedAt: T0 + 1000 });
    const found = leftBehind([server, worker], [{ pid: OMP, calls: [call({})] }], NOW);
    assert.deepEqual(found.map((f) => [f.process.pid, f.call.id]), [[1, 'c1']]);
  });

  test('ps gives seconds: a process started in the second a call began counts, one started before it does not', () => {
    const calls = [call({ start: T0 + 1500, end: T0 + 1800 })];
    assert.equal(leftBehind([proc({ pid: 1, startedAt: T0 + 1000 })], [{ pid: OMP, calls }], NOW).length, 1);
    assert.equal(leftBehind([proc({ pid: 1, startedAt: T0 - 2000 })], [{ pid: OMP, calls }], NOW).length, 0);
  });

  test('what omp itself runs (MCP servers, its helpers, its Python kernel) is not an agent\u2019s, but what a call starts under one of them is', () => {
    const mcp = proc({ pid: 1, startedAt: T0 - HOUR, command: 'mcp-server' });
    const helper = proc({ pid: 2, startedAt: T0 + 1000, command: 'bun cli.js __omp_worker_daemon_broker' });
    const kernel = proc({ pid: 4, startedAt: T0 + 1000, command: 'python3 -u /tmp/omp-python-runner-501/runner.py' });
    const underShell = proc({ pid: 3, ppid: 1, startedAt: T0 + 1000 });
    const found = leftBehind([mcp, helper, kernel, underShell], [{ pid: OMP, calls: [call({})] }], NOW);
    assert.deepEqual(found.map((f) => f.process.pid), [3]);
  });

  test('nothing is taken from a call still running or just ended, and a declared call wins over an undeclared one', () => {
    const p = proc({ pid: 1, startedAt: T0 + 1000 });
    assert.equal(leftBehind([p], [{ pid: OMP, calls: [call({ end: null })] }], NOW).length, 0);
    assert.equal(leftBehind([p], [{ pid: OMP, calls: [call({ end: NOW - 1000 })] }], NOW).length, 0);
    const declared = call({ id: 'c2', start: T0 + 500, declaration: { purpose: 'api', lifetime: '1h' } });
    assert.equal(leftBehind([p], [{ pid: OMP, calls: [call({ start: T0 + 900 }), declared] }], NOW)[0].call.id, 'c2');
  });
});

describe('declarations', () => {
  test('a trailing comment declares purpose and lifetime in the agent\u2019s words; the command runs without it', () => {
    const command = 'cd web && npm run dev -- -p 8081 # purpose: preview the sign-in page ; lifetime: until the review is done';
    assert.deepEqual(declarationOf(command), { purpose: 'preview the sign-in page', lifetime: 'until the review is done' });
    assert.equal(withoutDeclaration(command), 'cd web && npm run dev -- -p 8081');
    assert.equal(declarationOf('npm run dev # dev server'), null);
    assert.equal(declarationOf('npm run dev # purpose: ; lifetime: 1h'), null);
  });

  test('a lifetime is read as for good, a length of time, or the conversation', () => {
    assert.deepEqual(lifetimeOf('Forever'), { kind: 'forever' });
    assert.deepEqual(lifetimeOf('until it is stopped'), { kind: 'forever' });
    assert.deepEqual(lifetimeOf('1h 30m'), { kind: 'for', ms: 1.5 * HOUR });
    assert.deepEqual(lifetimeOf('about 90 minutes'), { kind: 'for', ms: 1.5 * HOUR });
    assert.deepEqual(lifetimeOf('an hour'), { kind: 'for', ms: HOUR });
    assert.deepEqual(lifetimeOf('2 days'), { kind: 'for', ms: 48 * HOUR });
    assert.deepEqual(lifetimeOf('5 more minutes'), { kind: 'for', ms: 5 * 60_000 });
    assert.deepEqual(lifetimeOf('until this session ends'), { kind: 'conversation' });
  });
});

test('masked: secret-looking values never reach the window', () => {
  assert.equal(masked('serve --api-key s3cr3t --port 8081'), 'serve --api-key … --port 8081');
  assert.equal(masked('GITHUB_TOKEN=ghp_abc DEBUG=1 node x.js'), 'GITHUB_TOKEN=… DEBUG=1 node x.js');
  assert.equal(masked('psql postgres://app:hunter2@localhost/db'), 'psql postgres://app:…@localhost/db');
  assert.equal(masked('curl -H x 0123456789abcdef0123456789abcdef01'), 'curl -H x …');
  assert.equal(masked('serve --token "two words" --port 1'), 'serve --token … --port 1');
  assert.equal(masked('curl -u admin:hunter2 https://x'), 'curl -u admin:… https://x');
  assert.equal(masked("curl -H 'Authorization: Bearer abc.def' https://x"), "curl -H 'Authorization: Bearer …' https://x");
  assert.equal(masked('mysql -h db -P 3306 -uroot -phunter2 app'), 'mysql -h db -P 3306 -uroot -p… app');
  assert.equal(masked('redis-cli -a hunter2 ping'), 'redis-cli -a … ping');
  assert.equal(masked('sshpass -p hunter2 ssh box'), 'sshpass -p … ssh box');
});

test('directoryOf: an orphan belongs to the deepest directory it runs in or from, else to none', () => {
  const dirs = ['/w/app', '/w/app/web', '/w/other'];
  assert.equal(directoryOf('/w/app/web/src', 'node server.js', dirs), '/w/app/web');
  assert.equal(directoryOf('/', 'node /w/other/bin/serve.ts', dirs), '/w/other');
  assert.equal(directoryOf('/w/apple', 'node /w/application/x.js', dirs), null);
});

describe('reading the OS', () => {
  test('parseProcesses reads ps lines, a padded day in the start date included', () => {
    const [p] = parseProcesses('  4242     1   501  10240   1.5 1:02.50 Wed Nov  4 09:05:01 2026 node /w/app/server.js --port 8081\n');
    assert.deepEqual(p, { pid: 4242, ppid: 1, uid: 501, rss: 10_240 * 1024, cpu: 1.5, cpuTime: 62.5, startedAt: new Date(2026, 10, 4, 9, 5, 1).getTime(), command: 'node /w/app/server.js --port 8081' });
  });

  test('parseSockets reads the ports a process listens on and its connections\u2019 remote ports', () => {
    const text = ['p4242', 'f20', 'n*:8081', 'TST=LISTEN', 'f21', 'n[::1]:8081', 'TST=LISTEN', 'f22', 'n127.0.0.1:52000->127.0.0.1:5432', 'TST=ESTABLISHED', 'p7', 'f3', 'n127.0.0.1:8081->127.0.0.1:52001', 'TST=CLOSE_WAIT'].join('\n');
    const sockets = parseSockets(text);
    assert.deepEqual(sockets.get(4242), { listening: [8081, 8081], remotes: [5432] });
    assert.deepEqual(sockets.get(7), { listening: [], remotes: [] });
  });
});
