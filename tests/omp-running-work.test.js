import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { applyEvent, createTranscript } from '../src/omp/transcript.js';
import { elapsed, runningWork } from '../src/omp/running-work.js';
/** @import { SessionEvent } from '../daemon/wire.js' */

// Shaped like omp 18.12's frames for a `bash` call it backgrounds (`details.async`), the
// `async-result` message that delivers the job, and a `wait` that reports it.

let seq = 0;
/** @param {Record<string, any>} frame @param {number} [at] @returns {SessionEvent} */
const frame = (frame, at = 0) => ({ kind: 'frame', frame, seq: ++seq, at, session: 's1' });

/** @param {SessionEvent[]} events */
function run(events) {
  const state = createTranscript();
  for (const event of events) applyEvent(state, event);
  return state;
}

const start = (id = 'call_1', name = 'bash', at = 1000) =>
  frame({ type: 'tool_execution_start', toolCallId: id, toolName: name, args: { command: './deploy.sh' }, intent: 'Deploying' }, at);
/** @param {Record<string, any>} details */
const result = (details, id = 'call_1', name = 'bash') =>
  frame({ type: 'message_end', messageId: `r-${id}`, message: { role: 'toolResult', toolCallId: id, toolName: name, content: [{ type: 'text', text: 'Backgrounded as job bg_1' }], details, isError: false } }, 5000);
const backgrounded = result({ async: { state: 'running', jobId: 'bg_1', type: 'bash' }, timeoutSeconds: 900 });

describe('running work', () => {
  test('a shell the turn waits on, while the turn runs', () => {
    const state = run([frame({ type: 'agent_start' }), start()]);
    assert.deepEqual(runningWork(state), [{ key: 'call_1', kind: 'shell', label: 'Deploying', startedAt: 1000, background: false }]);
    applyEvent(state, frame({ type: 'agent_end', messages: [] }));
    assert.deepEqual(runningWork(state), [], 'a call left running when the turn ends was cut short');
  });

  test('tools other than shells and subagents are not listed', () => {
    const state = run([frame({ type: 'agent_start' }), start('call_2', 'read')]);
    assert.deepEqual(runningWork(state), []);
  });

  test('a backgrounded shell runs on after the turn, until omp delivers its result', () => {
    const state = run([frame({ type: 'agent_start' }), start(), backgrounded, frame({ type: 'agent_end', messages: [] })]);
    assert.deepEqual(runningWork(state), [{ key: 'bg_1', kind: 'shell', label: 'Deploying', startedAt: 1000, background: true }]);
    applyEvent(
      state,
      frame({ type: 'message_end', messageId: 'm9', message: { role: 'custom', customType: 'async-result', content: 'done', display: true, details: { jobs: [{ jobId: 'bg_1', status: 'completed' }] } } }),
    );
    assert.deepEqual(runningWork(state), []);
  });

  test('or until a wait reports it ended', () => {
    const state = run([start(), backgrounded]);
    const wait = (/** @type {string} */ status) => result({ op: 'wait', jobs: [{ id: 'bg_1', type: 'bash', status }] }, 'call_w', 'wait');
    applyEvent(state, wait('running'));
    assert.equal(state.jobs.size, 1, 'still running');
    applyEvent(state, wait('completed'));
    assert.equal(state.jobs.size, 0);
  });

  test('or until a read or write of proc:// reports it ended', () => {
    const state = run([start(), backgrounded]);
    const proc = (/** @type {string} */ status) => result({ proc: { op: 'cancel', jobs: [{ id: 'bg_1', type: 'bash', status }] } }, 'call_k', 'write');
    applyEvent(state, proc('running'));
    assert.equal(state.jobs.size, 1, 'still running');
    applyEvent(state, proc('cancelled'));
    assert.equal(state.jobs.size, 0);
  });

  test('a call starting several subagents runs them all, each under its own name', () => {
    const progress = [{ id: 'Timing', status: 'pending' }, { id: 'Gas', status: 'pending' }];
    const state = run([start('call_t', 'task'), result({ async: { state: 'running', jobId: 'Timing', type: 'task' }, progress }, 'call_t', 'task')]);
    assert.deepEqual(runningWork(state).map((w) => [w.key, w.kind, w.label, w.background]), [['Timing', 'subagent', 'Timing', true], ['Gas', 'subagent', 'Gas', true]]);
    applyEvent(state, result({ op: 'wait', jobs: [{ id: 'Timing', status: 'completed' }, { id: 'Gas', status: 'running' }] }, 'call_w', 'wait'));
    assert.deepEqual([...state.jobs.keys()], ['Gas']);
  });

  test('one subagent keeps the call\'s intent', () => {
    const state = run([start('call_t', 'task'), result({ async: { state: 'running', jobId: 'Blind', type: 'task' }, progress: [{ id: 'Blind' }] }, 'call_t', 'task')]);
    assert.equal(state.jobs.get('Blind')?.label, 'Deploying');
  });

  test('jobs end with their omp, and those in history are long gone', () => {
    const state = run([start(), backgrounded]);
    applyEvent(state, { kind: 'session', meta: /** @type {any} */ ({ id: 's1', status: 'exited' }), seq: ++seq, at: 0, session: 's1' });
    assert.equal(state.jobs.size, 0);

    const seeded = run([
      frame({
        type: 'response',
        command: 'get_messages',
        success: true,
        data: { messages: [{ role: 'toolResult', toolCallId: 'c', toolName: 'bash', content: [], details: { async: { state: 'running', jobId: 'bg_9', type: 'bash' } } }] },
      }),
    ]);
    assert.equal(seeded.jobs.size, 0);
  });

  test('times read short', () => {
    assert.equal(elapsed(45_000), '45s');
    assert.equal(elapsed(3 * 60_000 + 5000), '3m');
    assert.equal(elapsed(65 * 60_000), '1h 5m');
  });
});
