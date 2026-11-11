#!/usr/bin/env bun
/**
 * Restarts the running daemon (`bun run restart`), so an agent working on the workbench can take
 * up its own changes: the daemon starts again as it was started, and wakes the agents it cut
 * short, this one included, with a message saying so (daemon/restart.js).
 *
 *   bun run restart [--port 4777]
 *
 * It finds the daemon as an agent's shell knows it (COCKPIT_PORT and COCKPIT_STATE_DIR, which the
 * daemon gives every omp it runs), else at the defaults: port 4777, state in ~/.cockpit.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { TOKEN_COOKIE } from '../daemon/guard.js';

const { values } = parseArgs({ options: { port: { type: 'string' } } });
const port = Number(values.port ?? process.env.COCKPIT_PORT ?? 4777);
const stateDir = process.env.COCKPIT_STATE_DIR ?? join(homedir(), '.cockpit');
const origin = `http://127.0.0.1:${port}`;

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(message);
  process.exit(1);
}

const token = (await Bun.file(join(stateDir, 'token')).text().catch(() => fail(`No daemon token in ${stateDir}: has the daemon run?`))).trim();
const res = await fetch(`${origin}/api/restart`, { method: 'POST', headers: { cookie: `${TOKEN_COOKIE}=${token}`, origin } }).catch((err) =>
  fail(`No daemon at ${origin}: ${err instanceof Error ? err.message : err}`),
);
if (!res.ok) fail(`The daemon at ${origin} refused to restart: ${res.status} ${await res.text()}`);
console.log(
  `The daemon at ${origin} restarts in a moment, ending every agent it runs, and wakes those it cuts short (this one too) once it is back. Its output goes to ${join(stateDir, 'daemon.log')}.`,
);
