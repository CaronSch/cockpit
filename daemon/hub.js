/**
 * The daemon's omp sessions and the single ordered event log the browser replays.
 *
 * Every event for every session gets the next sequence number. A browser that reconnects
 * asks for events after the last one it saw; a fresh page gets the whole log. The log is
 * kept in memory for the daemon's lifetime (see RISKS.md, telemetry store growth).
 *
 * A session runs until it goes to sleep (`sleep.js`: idle and unused for a while) or the
 * daemon exits: no window owns one, so closing or switching a window never ends it. Asleep,
 * its conversation is in its journal, which windows show and a message resumes. A long one
 * left idle is compacted before its prompt cache expires (`idle-compaction.js`), and stays
 * awake until then.
 *
 * Whenever a session waits on its user (its final response, or a question: omp/activity.js),
 * its conversation becomes unread (`unread.js`) until the user reads it, whether or not a
 * window was open on it.
 *
 * A rewind (`branch`) moves a session onto a new journal holding the conversation up to the
 * rewind; the one before keeps the path that was set aside. `onRewound` hears of that one
 * once the session reports its new journal, so it can be put away (archived: restorable).
 */
import { randomBytes } from 'node:crypto';
import { daemonNow } from './clock.js';
import { IDLE_COMPACT, createIdleCompaction, followIdleCompaction, idleCompactionNow } from './idle-compaction.js';
import { launchOmp } from './omp-session.js';
import { SLEEP_AFTER_MS, sleepsNow } from './sleep.js';
import { OMP_ID } from './unread.js';
import { awaitsUser } from '../src/omp/activity.js';
import { applyEvent, createTranscript } from '../src/omp/transcript.js';
/** @import { SessionEvent, SessionMeta } from './wire.js' */
/** @import { Transcript } from '../src/omp/transcript.js' */
/** @import { OmpSession, SessionEventBody } from './omp-session.js' */
/** @import { IdleCompaction, IdleCompactionOptions } from './idle-compaction.js' */
/** @import { UnreadStore } from './unread.js' */

/**
 * @typedef {{
 *   bootId: string,
 *   create(options: { cwd: string, resume: string | null, fork: string | null }): SessionMeta,
 *   get(id: string): OmpSession | null,
 *   list(): SessionMeta[],
 *   writing(file: string): SessionMeta | null,
 *   wrote(file: string): boolean,
 *   seen(id: string): void,
 *   idle(id: string): boolean,
 *   since(seq: number): SessionEvent[],
 *   latest(): number,
 *   subscribe(fn: (event: SessionEvent) => void): () => void,
 *   closeAll(): Promise<void>,
 * }} Hub
 */

/** How often the hub looks for sessions to put to sleep or compact, at most: idle compaction lapses a minute late. */
const SWEEP_MS = 30_000;

/**
 * @param {{
 *   ompPath: string, unread: Pick<UnreadStore, 'awaited'>, now?: () => number, launch?: typeof launchOmp,
 *   sleepAfterMs?: number, idleCompaction?: IdleCompactionOptions & { on(): boolean } | null, onRewound?: (file: string) => void,
 * }} options `idleCompaction`: compacts while `on()` (the user's setting); none when null
 * @returns {Hub}
 */
export function createHub({ ompPath, unread, now = daemonNow, launch = launchOmp, sleepAfterMs = SLEEP_AFTER_MS, idleCompaction = null, onRewound = () => {} }) {
  const bootId = randomBytes(6).toString('hex');
  /** @type {SessionEvent[]} */
  const log = [];
  /** @type {Map<string, OmpSession>} */
  const sessions = new Map();
  /**
   * How each session is doing (read from its events, as windows read them), when it last did
   * anything or was used, when it compacts while idle, and the journal it left in a rewind
   * until it reports its new one.
   * @type {Map<string, { transcript: Transcript, usedAt: number, compaction: IdleCompaction, rewoundFrom?: string | null }>}
   */
  const activity = new Map();
  /** @type {Set<(event: SessionEvent) => void>} */
  const listeners = new Set();

  /** @param {string} session @param {SessionEventBody} body */
  function emit(session, body) {
    const event = /** @type {SessionEvent} */ ({ ...body, seq: log.length + 1, at: now(), session });
    log.push(event);
    const seen = activity.get(session);
    if (seen) {
      const file = seen.transcript.meta?.sessionFile ?? null;
      applyEvent(seen.transcript, event);
      if (idleCompaction) followIdleCompaction(seen.compaction, event, idleCompaction);
      seen.usedAt = event.at;
      if (event.kind === 'frame' && event.frame.type === 'response' && event.frame.command === 'branch' && event.frame.success) seen.rewoundFrom = file;
      else if (event.kind === 'session' && seen.rewoundFrom && event.meta.sessionFile !== seen.rewoundFrom) {
        onRewound(seen.rewoundFrom);
        seen.rewoundFrom = null;
      }
      // A session that ended has nothing left to follow; its log stays for the windows.
      const status = seen.transcript.meta?.status;
      if (status === 'exited' || status === 'failed') activity.delete(session);
    }
    for (const fn of listeners) fn(event);
    const ompId = seen?.transcript.meta?.ompId;
    if (ompId && OMP_ID.test(ompId) && awaitsUser(event)) void unread.awaited(ompId, event.at);
  }

  const metas = () => [...sessions.values()].map((s) => s.meta());
  /** Awake with nothing under way. @param {OmpSession} session @param {Transcript} transcript */
  const idleNow = (session, transcript) => sleepsNow({ meta: session.meta(), transcript, usedAt: 0 }, 0, 0);
  const sweep = setInterval(() => {
    const at = now();
    for (const [id, session] of sessions) {
      const seen = activity.get(id);
      if (!seen) continue;
      const compaction = idleCompaction?.on() ? idleCompactionNow(seen.compaction, at) : null;
      if (compaction === 'due' && idleNow(session, seen.transcript)) {
        seen.compaction.dueAt = null;
        session.command(IDLE_COMPACT).response.catch(() => {});
      } else if (compaction !== 'waiting' && sleepsNow({ meta: session.meta(), ...seen }, at, sleepAfterMs)) {
        void session.close();
      }
    }
  }, Math.min(SWEEP_MS, sleepAfterMs, idleCompaction?.afterMs ?? SWEEP_MS));
  sweep.unref();

  return {
    bootId,
    create({ cwd, resume, fork }) {
      const id = `s_${randomBytes(4).toString('hex')}`;
      // Followed before launching: the launch reports the session's first events at once.
      activity.set(id, { transcript: createTranscript(), usedAt: now(), compaction: createIdleCompaction() });
      const session = launch({ id, cwd, resume, fork, ompPath, now, emit: (body) => emit(id, body) });
      sessions.set(id, session);
      return session.meta();
    },
    get: (id) => sessions.get(id) ?? null,
    list: metas,
    // Two omp processes must never write one journal: resuming it twice, or archiving it under one.
    writing: (file) => metas().find((m) => (m.status === 'starting' || m.status === 'ready') && m.sessionFile === file) ?? null,
    // A journal one of this daemon's sessions wrote, wherever omp keeps it, may be read back.
    wrote: (file) => metas().some((m) => m.sessionFile === file),
    seen(id) {
      const seen = activity.get(id);
      if (seen) seen.usedAt = now();
    },
    // Awake with nothing under way: it could go to sleep this moment.
    idle(id) {
      const session = sessions.get(id);
      const seen = activity.get(id);
      return Boolean(session && seen && idleNow(session, seen.transcript));
    },
    // Sequence numbers are 1-based log positions, so events after `seq` start at index `seq`.
    since: (seq) => log.slice(Math.max(0, seq)),
    latest: () => log.length,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async closeAll() {
      clearInterval(sweep);
      await Promise.all([...sessions.values()].map((s) => s.close()));
    },
  };
}
