#!/usr/bin/env bun
/**
 * Daemon entry point (`bun start`): serves the workbench on loopback (and, with Phone access on,
 * to the owner's tailnet devices: remote.js) and runs the omp processes and shells it shows.
 *
 *   bun daemon/main.js [--port 4777] [--omp <path to omp>] [--gh <path to gh>] [--cwd <dir>]
 *                      [--tailscale <path to tailscale>] [--remote-port <n>]
 *
 * omp defaults to the `omp` on PATH (install it from https://omp.sh), and the GitHub CLI to the
 * `gh` on PATH (https://cli.github.com; without it, pull requests are not offered). `--cwd` is the
 * directory a new agent window suggests, the home directory unless given. Phone access runs the
 * `tailscale` on PATH unless `--tailscale` says otherwise, and listens on the Mac's Tailscale
 * address at `--remote-port`, the daemon's port unless given.
 * Environment: COCKPIT_PORT, COCKPIT_OMP, COCKPIT_GH, COCKPIT_CWD, COCKPIT_TAILSCALE, COCKPIT_REMOTE_PORT, COCKPIT_STATE_DIR (default ~/.cockpit; holds the
 * access token, unread.json (which conversations have news not read yet), pins.json (which are pinned), forks.json
 * (which conversation each fork came from), settings.json, bugbot.json (the Bugbot reviews watched for), schedule.json
 * (the prompts agents scheduled), decisions/
 * (each conversation's decision reviews), plans/ (each conversation's plan), fork-sources/ (journals forked mid-turn, cut to their last response, while
 * their fork starts), scratchpads/, attachments/, workspaces/ and archive/sessions/, the archived omp sessions), COCKPIT_OMP_SESSIONS (omp's session journals; default
 * `$PI_CODING_AGENT_DIR/sessions`, i.e. ~/.omp/agent/sessions), COCKPIT_SLEEP_AFTER_MS (how long
 * an idle, unused session stays awake; default 30 minutes, shorter for tests),
 * COCKPIT_IDLE_COMPACT_MIN_TOKENS (from what size idle compaction applies, see
 * idle-compaction.js; default 200000, at least 100000),
 * COCKPIT_IDLE_COMPACT_AFTER_MS (how long after its last request; default 54 minutes, shorter
 * for tests) and COCKPIT_BUGBOT_POLL_MS (how often a Bugbot review is looked for; default 30 seconds).
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { JournalRefused, createHistory } from './history.js';
import { loadBugbot, BUGBOT_POLL_MS } from './bugbot.js';
import { loadSchedule, scheduleTools } from './schedule.js';
import { askReviewer, createDecisionReviews } from './decisions.js';
import { createPlans, planTools } from './plans.js';
import { createAnnotations } from './annotations.js';
import { askAgent } from './ask.js';
import { createDelivery } from './deliver.js';
import { createGithub } from './github.js';
import { createHub } from './hub.js';
import { withAdhdRules } from './adhd.js';
import { browserEnv } from './browser.js';
import { APPEND_SYSTEM_PROMPT, allHostTools } from './omp-session.js';
import { IDLE_COMPACT_AFTER_MS, IDLE_COMPACT_MIN_TOKENS, IDLE_COMPACT_TOKENS_FLOOR } from './idle-compaction.js';
import { createAttachments } from './attachments.js';
import { createScratchpads } from './scratchpad.js';
import { createDaemon, loopbackListener } from './server.js';
import { createRemoteAccess } from './remote.js';
import { createWorkspaces } from './workspace.js';
import { loadToken } from './token.js';
import { loadUnread } from './unread.js';
import { loadPins } from './pins.js';
import { createForker, loadForks } from './forks.js';
import { nameFork } from './fork-title.js';
import { loadSettings } from './settings.js';
import { createSetup, ompVersion } from './setup.js';
import { createTerminals } from './terminals.js';
import { RESTART_AFTER_MS, noteInterrupted, startSuccessor, wakeInterrupted } from './restart.js';
import { createUpdates } from './updates.js';
import pkg from '../package.json' with { type: 'json' };

const ROOT = resolve(import.meta.dir, '..');

const { values } = parseArgs({
  options: { port: { type: 'string' }, omp: { type: 'string' }, gh: { type: 'string' }, cwd: { type: 'string' }, tailscale: { type: 'string' }, 'remote-port': { type: 'string' } },
});
const port = Number(values.port ?? process.env.COCKPIT_PORT ?? 4777);
const ompOption = values.omp ?? process.env.COCKPIT_OMP ?? 'omp';
// A path (not a bare command name) must not depend on each session's cwd.
const ompPath = ompOption.includes('/') ? resolve(ompOption) : ompOption;
const ghOption = values.gh ?? process.env.COCKPIT_GH ?? 'gh';
// gh runs in the directory of the repository asked about: a path must not depend on it.
const ghPath = ghOption.includes('/') ? resolve(ghOption) : ghOption;
const tailscaleOption = values.tailscale ?? process.env.COCKPIT_TAILSCALE ?? 'tailscale';
const tailscalePath = tailscaleOption.includes('/') ? resolve(tailscaleOption) : tailscaleOption;
const remotePort = Number(values['remote-port'] ?? process.env.COCKPIT_REMOTE_PORT ?? port);
const defaultCwd = resolve(values.cwd ?? process.env.COCKPIT_CWD ?? homedir());
const stateDir = process.env.COCKPIT_STATE_DIR ?? join(homedir(), '.cockpit');
const ompSessions =
  process.env.COCKPIT_OMP_SESSIONS ?? join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.omp', 'agent'), 'sessions');

const token = await loadToken(stateDir);
/** @param {unknown} err @returns {never} */
const unreadable = (err) => {
  console.error(`[daemon] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
};
const unread = await loadUnread({ file: join(stateDir, 'unread.json') }).catch(unreadable);
const pins = await loadPins({ file: join(stateDir, 'pins.json') }).catch(unreadable);
const forks = await loadForks({ file: join(stateDir, 'forks.json') }).catch(unreadable);
const settings = await loadSettings({ file: join(stateDir, 'settings.json') }).catch(unreadable);
const history = createHistory({ root: ompSessions, archive: join(stateDir, 'archive', 'sessions') });
const sleepAfter = Number(process.env.COCKPIT_SLEEP_AFTER_MS);
const compactAfter = Number(process.env.COCKPIT_IDLE_COMPACT_AFTER_MS);
const idleCompactAfterMs = compactAfter > 0 ? compactAfter : IDLE_COMPACT_AFTER_MS;
const compactFrom = Number(process.env.COCKPIT_IDLE_COMPACT_MIN_TOKENS);
const decisions = createDecisionReviews({
  dir: join(stateDir, 'decisions'),
  on: () => settings.all().decisionReview,
  ask: (turn) => askReviewer(turn, { ompPath }),
});
const plans = createPlans({ dir: join(stateDir, 'plans') });
const annotations = createAnnotations({ dir: join(stateDir, 'annotations') });
const hub = createHub({
  ompPath,
  unread,
  ...(sleepAfter > 0 ? { sleepAfterMs: sleepAfter } : {}),
  idleCompaction: {
    on: () => settings.all().idleCompaction,
    afterMs: idleCompactAfterMs,
    minTokens: compactFrom > 0 ? Math.max(IDLE_COMPACT_TOKENS_FLOOR, compactFrom) : IDLE_COMPACT_MIN_TOKENS,
  },
  // The journal a rewind left keeps what was set aside: archived, out of the list, restorable.
  // One outside omp's sessions (400) is not listed, so there is nothing to put away. What is
  // scheduled for the conversation goes on with it.
  onRewound: (file, next) => {
    if (next) void schedule.moved(file, next);
    void history.archive(file).catch((err) => {
      if (!(err instanceof JournalRefused && err.status === 400)) console.error(`[daemon] could not archive the journal a rewind left (${file}):`, err);
    });
  },
  // A rewound conversation goes on under a new id: its forks are still its forks, its plan its plan, its annotations its annotations.
  onRewoundId: (from, to) => {
    void forks.moved(from, to);
    void plans.moved(from, to).catch((err) => console.error(`[daemon] could not move the plan of conversation ${from}:`, err));
    void annotations.moved(from, to).catch((err) => console.error(`[daemon] could not move the annotations of conversation ${from}:`, err));
  },
  onTurnEnded: decisions.turnEnded,
  onTodo: (ompId, phases) => void plans.todo(ompId, phases).catch((err) => console.error(`[daemon] could not follow the todo list of conversation ${ompId}:`, err)),
  // "I have ADHD" adds its rules to every agent's system prompt; the browser choice, its environment.
  // An agent's shell also knows which daemon it runs under, so `bun run restart` reaches it.
  launchWith: () => ({
    appendSystemPrompt: withAdhdRules(APPEND_SYSTEM_PROMPT, settings.all().adhd),
    env: { ...browserEnv(settings.all().browser), COCKPIT_PORT: String(port), COCKPIT_STATE_DIR: stateDir },
  }),
  // Every agent may schedule prompts for its own conversation and keep a plan for it.
  hostTools: allHostTools(
    scheduleTools(() => schedule),
    planTools(() => plans),
  ),
});
// Switched, a setting reaches a conversation as it next wakes: idle ones go to sleep now.
settings.subscribe(() => hub.launchChanged());
const forker = createForker({ hub, forks, scratchDir: join(stateDir, 'fork-sources'), nameFork: (prompt, sourceTitle) => nameFork(prompt, sourceTitle, { ompPath }) });
const delivery = createDelivery({ hub, isArchived: (file) => history.isArchived(file) });
const bugbotPoll = Number(process.env.COCKPIT_BUGBOT_POLL_MS);
const github = createGithub({ ghPath });
const bugbot = await loadBugbot({
  file: join(stateDir, 'bugbot.json'),
  github,
  delivery,
  pollMs: bugbotPoll > 0 ? bugbotPoll : BUGBOT_POLL_MS,
}).catch(unreadable);
const schedule = await loadSchedule({
  file: join(stateDir, 'schedule.json'),
  deliver: delivery.deliver,
  archivedFrom: (file) => history.archivedFrom(file),
}).catch(unreadable);
const scratchpadDir = join(stateDir, 'scratchpads');
const setup = createSetup({ ompPath, ghPath, tailscalePath });
// Phone access serves the same routes on the tailnet: `daemon` is there by the time it is switched on.
const remote = createRemoteAccess({ tailscale: tailscalePath, port: remotePort, token, settings, serve: (listener) => daemon.serve(listener) });
remote.subscribe((state) => {
  const info = remote.info();
  if (state.state === 'on') console.log(`Phone: ${info.url} (only ${info.login}'s devices)`);
  else if (state.state === 'error') console.error(`[daemon] Phone access: ${state.error}`);
});
const terminals = createTerminals();
// Whether this checkout is behind the newest `main`, and taking it from the top bar.
const updates = createUpdates({ root: ROOT, restart });
const daemon = createDaemon({
  hub,
  history,
  scratchpads: createScratchpads({ dir: scratchpadDir }),
  attachments: createAttachments({ dir: join(stateDir, 'attachments') }),
  workspaces: createWorkspaces({ dir: join(stateDir, 'workspaces') }),
  unread,
  pins,
  forks,
  forker,
  decisions,
  plans,
  annotations,
  settings,
  github,
  delivery,
  bugbot,
  schedule,
  setup,
  remote,
  terminals,
  ask: (question) => askAgent(question, { ompPath, history }),
  restart,
  updates,
  token,
  root: ROOT,
  config: {
    defaultCwd,
    home: homedir(),
    scratchpadDir,
    idleCompactAfterMs,
    version: pkg.version,
  },
});
/** @type {ReturnType<typeof daemon.serve>} */
let server;
try {
  server = daemon.serve(loopbackListener(port));
} catch (err) {
  const code = /** @type {{ code?: string }} */ (err).code;
  console.error(code === 'EADDRINUSE' ? `[daemon] port ${port} is in use; pass --port <n>` : `[daemon] ${err}`);
  process.exit(1);
}

console.log(`Cockpit daemon on http://127.0.0.1:${port}`);
console.log(`Open: http://cockpit.localhost:${port}/?token=${token}`);
// Asked after the server is up: starting omp just to read its version takes most of a second.
ompVersion(ompPath).then((version) =>
  console.log(
    version ? `omp: ${version}` : `omp: not found at "${ompPath}": install it (https://omp.sh), then follow Setup in the workbench`,
  ),
);
// The agents a restart (`bun run restart`) cut short carry on.
void wakeInterrupted(stateDir, delivery.deliver);
// Every hour (and now): is there a newer Cockpit on GitHub?
updates.start();

let stopping = false;
/** Stops the daemon, as Ctrl+C does; with `successor`, starts it again once stopped (restart.js). */
async function shutdown(successor = false) {
  if (stopping) return process.exit(1); // second Ctrl+C: stop waiting
  stopping = true;
  void server.stop(true);
  updates.stop();
  void remote.stop();
  setup.login.cancel();
  await Promise.all([hub.closeAll(), terminals.closeAll()]);
  if (successor) startSuccessor(stateDir);
  process.exit(0);
}
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());

/** Restarts the daemon (`POST /api/restart`), noting the agents it cuts short so they carry on after. */
function restart() {
  if (stopping) return;
  setTimeout(async () => {
    const working = hub.list().flatMap((m) => (m.sessionFile && hub.working(m.id) ? [{ sessionFile: m.sessionFile, cwd: m.cwd }] : []));
    await noteInterrupted(stateDir, working).catch((err) => console.error('[daemon] could not note the agents the restart interrupts:', err));
    console.log(`Restarting; the daemon's output goes to ${join(stateDir, 'daemon.log')} from now on`);
    await shutdown(true);
  }, RESTART_AFTER_MS);
}
