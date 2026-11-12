/**
 * The gate every omp the daemon launches loads (`-e`, omp-session.js): an omp extension that has
 * the agent declare each long-running process before starting it. A `bash` call that starts a
 * named service (`name`) or a background job (`async`) runs only if its command ends with a
 * declaration in the agent's own words (process-commands.js); without one omp refuses the call and
 * tells the agent how to declare, and it runs it again. The ledger (processes.js) reads the
 * declaration from the call the daemon sees.
 *
 * A declared start goes ahead even when a process for the same project already runs the same
 * command or one of its ports: the agent is told of it then, beside the call's result, and may
 * reuse it instead (the `processes` tool). That comes from the ledger the daemon keeps on disk
 * (`processes.json` in `COCKPIT_STATE_DIR`).
 *
 * It runs inside omp, not the daemon: it reads nothing of the daemon's but that file.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { DECLARATION_FORMAT, declarationOf, duplicatesOf, withoutDeclaration } from './process-commands.js';
import { duration } from '../src/timeline/scale.js';
/** @import { ProcessRecord } from './wire.js' */

const REFUSAL = `The workbench records the long-running processes agents start. End the command with a declaration, in your own words, then run it again: ${DECLARATION_FORMAT}`;

/** The ledger's records, or none if there is no ledger to read. @returns {ProcessRecord[]} */
function ledger() {
  const dir = process.env.COCKPIT_STATE_DIR;
  if (!dir) return [];
  try {
    const records = JSON.parse(readFileSync(join(dir, 'processes.json'), 'utf8'))?.records;
    return Array.isArray(records) ? records : [];
  } catch {
    return [];
  }
}

/** `path` with its links resolved, or as it is. @param {string} path */
function real(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * What the agent of conversation `ompId` is told of a process its new one would duplicate.
 * @param {ProcessRecord} r @param {string | null} ompId
 */
function described(r, ompId) {
  const owner = r.owners[0];
  const ports = r.ports.length ? ` on port ${r.ports.join(', ')}` : '';
  const who = owner?.ompId === ompId ? 'this conversation' : `the conversation "${owner?.title ?? owner?.cwd}"`;
  const by = owner ? ` by ${who}${owner.purpose ? ` for "${owner.purpose}"` : ''}` : '';
  return `- ${r.name ?? r.command}${ports}, started ${duration(Date.now() - r.startedAt)} ago${by} (id ${r.key})`;
}

/** @param {any} pi omp's extension API */
export default function processGate(pi) {
  pi.on('tool_call', (/** @type {any} */ event, /** @type {any} */ ctx) => {
    if (event?.toolName !== 'bash') return;
    const input = event.input ?? {};
    const longRunning = (typeof input.name === 'string' && input.name.trim() !== '') || input.async === true;
    if (!longRunning || typeof input.command !== 'string') return;
    if (!declarationOf(input.command)) return { block: true, reason: REFUSAL };
    const cwd = process.cwd();
    const records = ledger().filter((r) => r.project !== null && real(r.project) === cwd);
    const duplicates = duplicatesOf(records, withoutDeclaration(input.command));
    if (duplicates.length === 0) return;
    const ompId = ctx?.sessionManager?.getSessionId?.() ?? null;
    return {
      additionalContext: `Already running in this project, started by agents (the processes tool lists them; reuse one there instead if it serves):\n${duplicates.map((r) => described(r, ompId)).join('\n')}`,
    };
  });
}
