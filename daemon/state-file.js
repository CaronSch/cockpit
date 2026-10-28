/**
 * A value the daemon keeps in one small JSON file in the state directory (unread marks, pins,
 * settings): read once as the daemon starts, written whole after every change
 * (write-then-rename, one write at a time, so a crash mid-write leaves the old value, never
 * half of the new one), and every change heard by its subscribers. A file that cannot be read
 * as one stops the daemon from starting, naming the file, rather than being replaced.
 */
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * @template T
 * @param {{ file: string, what: string, initial: T, read: (data: any) => T | null, write: (value: T) => object }} options
 *   `what` names the kind of file in the error ("an unread file"); `read` takes the parsed
 *   file (untrusted JSON) to the value, or null if it is not one; `write` the value to the file's JSON
 */
export async function loadStateFile({ file, what, initial, read, write }) {
  let value = initial;
  const stored = Bun.file(file);
  if (await stored.exists()) {
    /** @type {any} */
    let data;
    try {
      data = JSON.parse(await stored.text());
    } catch {}
    const parsed = read(data);
    if (parsed === null) throw new Error(`${file} is not ${what} this daemon can read; fix it or move it away`);
    value = parsed;
  }
  /** @type {Set<(value: T) => void>} */
  const listeners = new Set();
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();
  let tmpSeq = 0;

  async function store() {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
    await writeFile(tmp, `${JSON.stringify(write(value), null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
  }

  return {
    /** @returns {T} */
    get: () => value,
    /**
     * Keeps `next` (nothing changes if it is the value kept); resolves once it is written.
     * @param {T} next
     */
    set(next) {
      if (next === value) return queue;
      value = next;
      for (const fn of listeners) fn(value);
      // Each write stores the value as it is when it runs, so the last one leaves the newest.
      queue = queue.then(store).catch((err) => console.error(`[daemon] could not save ${file}:`, err));
      return queue;
    },
    /** Hears every change, with the whole value. @param {(value: T) => void} fn */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
