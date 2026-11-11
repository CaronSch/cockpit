/**
 * Restarting the daemon from the inside (`bun run restart`, scripts/restart.js), so an agent
 * working on the workbench itself can take up its own changes and carry on afterwards.
 *
 * The daemon stops as Ctrl+C stops it (every omp it runs ends), then starts its successor: the
 * same command, in the same directory, with the same environment, in the background, its output
 * in `daemon.log` in the state directory. The conversations whose agents were working as it
 * stopped (the one that asked, and any other cut short) are noted in `restart.json` first, and
 * the successor wakes each from its journal with a message saying what happened, so they go on.
 */
import { closeSync, openSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
/** @import { ConversationTarget } from './wire.js' */

/** How long the daemon waits before stopping, so the agent that asked has its answer recorded. */
export const RESTART_AFTER_MS = 1000;

/** What an interrupted agent is told as the daemon after the restart wakes it. */
export const RESUME_MESSAGE =
  'The Cockpit daemon restarted (`bun run restart`) while you were working, so your turn was cut short. Carry on where you left off.';

/** @param {string} stateDir */
const notesFile = (stateDir) => join(stateDir, 'restart.json');

/**
 * Notes the conversations whose agents the restart interrupts, for the daemon after it.
 * @param {string} stateDir @param {Array<{ sessionFile: string, cwd: string }>} conversations
 */
export async function noteInterrupted(stateDir, conversations) {
  await Bun.write(notesFile(stateDir), JSON.stringify({ version: 1, conversations }));
}

/**
 * Starts this daemon again, as it was started, in a process of its own that outlives this one;
 * its output goes to `daemon.log`. Called once this daemon has let go of its port.
 * @param {string} stateDir
 */
export function startSuccessor(stateDir) {
  const log = openSync(join(stateDir, 'daemon.log'), 'a');
  try {
    spawn(process.execPath, process.argv.slice(1), { cwd: process.cwd(), env: process.env, detached: true, stdio: ['ignore', log, log] }).unref();
  } finally {
    closeSync(log);
  }
}

/**
 * Wakes the conversations a restart interrupted (noted by `noteInterrupted`), each with
 * `RESUME_MESSAGE`; the note is used once.
 * @param {string} stateDir @param {(target: ConversationTarget, message: string) => Promise<unknown>} deliver
 */
export async function wakeInterrupted(stateDir, deliver) {
  const file = Bun.file(notesFile(stateDir));
  if (!(await file.exists())) return;
  /** @type {unknown[]} */
  let noted = [];
  try {
    const data = await file.json();
    if (Array.isArray(data?.conversations)) noted = data.conversations;
  } catch (err) {
    console.error('[daemon] could not read the conversations the restart interrupted:', err);
  }
  await rm(notesFile(stateDir), { force: true });
  for (const c of /** @type {any[]} */ (noted)) {
    if (typeof c?.sessionFile !== 'string') continue;
    const target = { sessionFile: c.sessionFile, session: null, cwd: typeof c.cwd === 'string' ? c.cwd : homedir() };
    deliver(target, RESUME_MESSAGE).catch((err) => console.error(`[daemon] could not wake ${c.sessionFile} after the restart:`, err));
  }
}
