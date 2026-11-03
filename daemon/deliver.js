/**
 * Sends a message to a conversation from outside its agent window (the pull request window's
 * review, a Bugbot review): as a prompt to the session holding it, woken from its journal
 * first if it is asleep, as the agent window itself would (`omp --resume`). Sent while the agent
 * works, it waits for the turn to end (omp's `followUp`) instead of interrupting it.
 *
 * Every agent window showing the conversation follows the session that takes it, as it does
 * when another window wakes it.
 */
import { homedir } from 'node:os';
/** @import { ConversationTarget } from './wire.js' */
/** @import { Hub } from './hub.js' */

/** The conversation cannot take the message: `status` is the HTTP status saying why. */
export class DeliveryRefused extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** @param {import('./wire.js').SessionMeta | null | undefined} meta */
const awake = (meta) => meta?.status === 'starting' || meta?.status === 'ready';

/**
 * @param {{ hub: Hub, isArchived: (file: string) => boolean }} options
 */
export function createDelivery({ hub, isArchived }) {
  /** Resolves once session `id` is ready; rejects if it ends first. @param {string} id @returns {Promise<void>} */
  const untilReady = (id) =>
    new Promise((resolve, reject) => {
      let off = () => {};
      const check = () => {
        const meta = hub.get(id)?.meta();
        if (meta?.status === 'starting') return;
        off();
        if (meta?.status === 'ready') resolve();
        else reject(new DeliveryRefused(409, `the agent did not start: ${meta?.error ?? 'it exited'}`));
      };
      off = hub.subscribe((event) => {
        if (event.session === id && event.kind === 'session') check();
      });
      check();
    });

  /**
   * The session holding `target`'s conversation: the one awake on it, else a new one resuming
   * its journal.
   * @param {ConversationTarget} target @returns {Promise<string>}
   */
  async function holder(target) {
    const own = target.session ? hub.get(target.session)?.meta() : null;
    // The session the window last saw holds the conversation still, unless it moved onto another journal.
    if (own && awake(own) && (!target.sessionFile || own.sessionFile === target.sessionFile)) return own.id;
    const file = target.sessionFile;
    const writing = file ? hub.writing(file) : null;
    if (writing) return writing.id;
    if (!file || !(await Bun.file(file).exists())) throw new DeliveryRefused(404, 'the conversation is gone: nothing was said in it, or its journal was moved');
    if (isArchived(file)) throw new DeliveryRefused(409, 'the conversation is archived: restore it to carry it on');
    const dir = await Bun.file(target.cwd).stat().catch(() => null);
    return hub.create({ cwd: dir?.isDirectory() ? target.cwd : homedir(), resume: file, fork: null }).id;
  }

  return {
    /**
     * Sends `message` to `target`'s conversation, waking it if need be: the session that took it.
     * @param {ConversationTarget} target @param {string} message @returns {Promise<string>}
     */
    async deliver(target, message) {
      const id = await holder(target);
      await untilReady(id);
      const session = hub.get(id);
      if (!session) throw new DeliveryRefused(409, 'the agent exited before it took the message');
      const res = await session.command({ type: 'prompt', message, streamingBehavior: 'followUp' }).response;
      if (!res.success) throw new DeliveryRefused(409, `the agent did not take the message: ${res.error ?? 'refused'}`);
      return id;
    },
  };
}

/** @typedef {ReturnType<typeof createDelivery>} Delivery */
