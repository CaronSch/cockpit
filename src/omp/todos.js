/**
 * How far along the agent is, from the todo list omp agents keep with their `todo` tool: how
 * many of its tasks are done and which one it is on.
 *
 * An abandoned task no longer counts; a task the agent adds raises the total, so progress can
 * drop when it finds more work. Work without a list has no progress to show.
 */
/** @import { Transcript } from './transcript.js' */

/** @typedef {{ content: string, status: string }} TodoTask */
/** @typedef {{ name: string, tasks: TodoTask[] }} TodoPhase */
/** @typedef {{ done: number, total: number, current: string | null }} TodoProgress */

/**
 * omp's todo phases (`get_state`'s `todoPhases`, a `todo` result's `details.phases`), or null
 * when `value` is not a list of them.
 * @param {any} value untrusted
 * @returns {TodoPhase[] | null}
 */
export function todoPhases(value) {
  if (!Array.isArray(value)) return null;
  /** @type {TodoPhase[]} */
  const phases = [];
  for (const phase of value) {
    if (typeof phase?.name !== 'string' || !Array.isArray(phase.tasks)) return null;
    /** @type {TodoTask[]} */
    const tasks = [];
    for (const task of phase.tasks) {
      if (typeof task?.content !== 'string' || typeof task.status !== 'string') return null;
      tasks.push({ content: task.content, status: task.status });
    }
    phases.push({ name: phase.name, tasks });
  }
  return phases;
}

/**
 * Tasks done out of those still meant to be done, and the one in progress; null for a list
 * with nothing to do. A status omp adds later counts as not done.
 * @param {readonly TodoPhase[]} phases @returns {TodoProgress | null}
 */
export function todoProgress(phases) {
  const tasks = phases.flatMap((phase) => phase.tasks).filter((task) => task.status !== 'abandoned');
  if (tasks.length === 0) return null;
  return {
    done: tasks.filter((task) => task.status === 'completed').length,
    total: tasks.length,
    current: tasks.find((task) => task.status === 'in_progress')?.content ?? null,
  };
}

/**
 * The progress of the turn running now, if its agent keeps a list for it. A list that was
 * already finished when the turn started belongs to earlier work, until the agent updates it.
 * @param {Pick<Transcript, 'streaming' | 'todo'>} state @returns {TodoProgress | null}
 */
export function turnProgress({ streaming, todo }) {
  if (!streaming || !todo) return null;
  const progress = todoProgress(todo.phases);
  if (!progress || (progress.done === progress.total && !todo.updatedInTurn)) return null;
  return progress;
}
