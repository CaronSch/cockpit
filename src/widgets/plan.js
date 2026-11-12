/**
 * An agent's plan for a large task, live beside the conversation it is for (daemon/plans.js): the
 * goal and approach the agent wrote, its steps (its todo list) ticked off as they finish, and the
 * decisions it took along the way and why, the newest first. Opened from the Plan line at the foot
 * of an agent window (a click shows it as a tab, a drag places it), or from the palette, which
 * lists every plan, most recently changed first, to pick one.
 *
 * Params (persisted with the layout): `ompId`, the conversation whose plan it shows (null: the
 * list), and `name`, the plan's title, which names the window before the plan is read.
 */
import { button, el, setText } from '../ui/dom.js';
import { errorMessage, tildeHome } from '../ui/format.js';
import { getDaemon } from '../daemon/client.js';
import { renderMarkdown } from '../omp/markdown-dom.js';
import { todoProgress } from '../omp/todos.js';
import { relativeTime } from '../sessions/order.js';
import { whenLabel } from '../timeline/scale.js';
/** @import { WidgetContext } from './registry.js' */
/** @import { DaemonClient } from '../daemon/client.js' */
/** @import { Plan, PlanEntry, PlanSummary } from '../../daemon/plans.js' */
/** @import { TodoPhase, TodoProgress } from '../omp/todos.js' */

/** How often "updated … ago" is said again while nothing changes. */
const TICK_MS = 30_000;

/** What a task's status shows as, before its text. @type {Readonly<Record<string, string>>} */
const MARKS = { completed: '✓', in_progress: '●', pending: '○', abandoned: '✕' };

export default {
  type: 'plan',
  title: 'Plan',
  glyph: '☰',
  description: 'An agent’s plan for a large task, live: its steps as they finish, and the decisions it took along the way and why',
  newParams: () => ({ ompId: null, name: null }),

  /** @param {HTMLElement} body @param {WidgetContext} ctx */
  mount(body, ctx) {
    return createPlanWindow(body, ctx, getDaemon());
  },
};

/** "3 of 7 steps done", or that there are none yet. @param {TodoProgress | null} progress */
const stepsText = (progress) => (progress ? `${progress.done} of ${progress.total} steps done` : 'No steps yet');

/** A bar filled as far as the steps are done. @param {TodoProgress | null} progress */
function progressBar(progress) {
  const bar = el('div', 'plan-bar');
  const fill = el('div', 'plan-bar-fill');
  fill.style.width = progress ? `${(100 * progress.done) / progress.total}%` : '0';
  bar.append(fill);
  return bar;
}

/** The steps: each phase of the todo list, its tasks marked by how they stand. @param {TodoPhase[]} phases */
function renderSteps(phases) {
  const list = el('ol', 'plan-phases');
  for (const phase of phases) {
    const live = phase.tasks.filter((t) => t.status !== 'abandoned');
    const done = live.filter((t) => t.status === 'completed').length;
    const item = el('li', `plan-phase${live.length && done === live.length ? ' is-done' : ''}`);
    const head = el('div', 'plan-phase-head');
    head.append(el('span', 'plan-phase-name', phase.name), el('span', 'plan-phase-count', `${done}/${live.length}`));
    const tasks = el('ul', 'plan-tasks');
    for (const task of phase.tasks) {
      const row = el('li', `plan-task is-${task.status}`);
      const mark = el('span', 'plan-task-mark', MARKS[task.status] ?? '○');
      mark.setAttribute('aria-label', task.status.replace('_', ' '));
      row.append(mark, el('span', 'plan-task-text', task.content));
      tasks.append(row);
    }
    item.append(head, tasks);
    list.append(item);
  }
  return list;
}

/** One entry of the log: a decision and why, or the plan revised and why (with the plan before, a click away). @param {PlanEntry} entry @param {number} now */
function renderEntry(entry, now) {
  const item = el('li', `plan-entry is-${entry.kind}`);
  const head = el('div', 'plan-entry-head');
  head.append(el('span', 'plan-entry-kind', entry.kind === 'decision' ? 'Decided' : 'Plan revised'), el('span', 'plan-entry-time', whenLabel(entry.at, now)));
  item.append(head);
  if (entry.kind === 'decision') item.append(el('p', 'plan-entry-text', entry.text));
  item.append(el('p', 'plan-entry-why', entry.why));
  if (entry.kind === 'revision') {
    const before = el('details', 'plan-entry-before');
    const md = el('div', 'omp-md');
    md.append(renderMarkdown(entry.text));
    before.append(el('summary', undefined, 'The plan before'), md);
    item.append(before);
  }
  return item;
}

/** @param {HTMLElement} body @param {WidgetContext} ctx @param {DaemonClient} daemon */
function createPlanWindow(body, ctx, daemon) {
  const ompId = () => (typeof ctx.params.ompId === 'string' && ctx.params.ompId ? ctx.params.ompId : null);
  const root = el('div', 'plan');
  body.append(root);
  const allBtn = button('omp-tool-btn', 'All plans', () => ctx.setParams({ ompId: null, name: null }));
  ctx.headActions.append(allBtn);

  let destroyed = false;
  let frame = 0;
  let home = '';
  /** What is drawn, so a change that leaves it the same keeps the window as it is (scroll, selection, open details). */
  let drawnKey = '';
  /** The list of plans, while the window lists them: null until read. @type {PlanSummary[] | null} */
  let listed = null;
  let listError = '';
  /** Readings of the list asked for: an answer to any but the last is old. */
  let listing = 0;
  /** Whether the list was asked for since the window last showed it. */
  let listAsked = false;
  /** The conversation whose plan was drawn last (null: the list), so showing another starts afresh, at its top. */
  let shownId = ompId();

  const scheduleDraw = () => {
    if (destroyed) return;
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      draw();
    });
  };
  daemon
    .config()
    .then((c) => {
      home = c.home;
      drawnKey = '';
      scheduleDraw();
    })
    .catch(() => {});

  /** Reads the list of plans again (while the window lists them). */
  function loadList() {
    const ask = ++listing;
    daemon
      .plans()
      .then((plans) => {
        if (ask !== listing) return;
        listed = plans;
        listError = '';
      })
      .catch((err) => {
        if (ask === listing) listError = `Could not list the plans: ${errorMessage(err)}`;
      })
      .finally(scheduleDraw);
  }

  /** @param {Plan} plan */
  function drawPlan(plan) {
    const now = Date.now();
    const progress = todoProgress(plan.todo);
    const key = JSON.stringify([plan, home, relativeTime(plan.updatedAt, now)]);
    if (key === drawnKey) return;
    drawnKey = key;
    const head = el('header', 'plan-head');
    const meta = el('div', 'plan-meta');
    meta.append(
      el('span', 'plan-steps', stepsText(progress)),
      el('span', 'plan-where', tildeHome(plan.cwd, home)),
      el('span', 'plan-when', `updated ${relativeTime(plan.updatedAt, now)}`),
    );
    head.append(el('h2', 'plan-title', plan.title), meta, progressBar(progress));
    if (progress?.current) {
      const current = el('p', 'plan-current');
      current.append(el('span', 'plan-current-label', 'Now'), el('span', 'plan-current-text', progress.current));
      head.append(current);
    }

    const approach = el('section', 'plan-section');
    const md = el('div', 'omp-md plan-body');
    md.append(renderMarkdown(plan.body));
    approach.append(el('h3', 'plan-section-title', 'Plan'), md);

    const steps = el('section', 'plan-section');
    steps.append(el('h3', 'plan-section-title', 'Steps'));
    steps.append(plan.todo.some((p) => p.tasks.length) ? renderSteps(plan.todo) : el('p', 'plan-empty', 'The agent has no todo list yet.'));

    const log = el('section', 'plan-section');
    const decided = plan.log.filter((e) => e.kind === 'decision').length;
    log.append(el('h3', 'plan-section-title', decided ? `Decisions · ${decided}` : 'Decisions'));
    if (plan.log.length) {
      const entries = el('ol', 'plan-log');
      entries.append(...plan.log.toReversed().map((e) => renderEntry(e, now)));
      log.append(entries);
    } else log.append(el('p', 'plan-empty', 'None yet: the agent records each decision it takes without you, and why.'));

    root.replaceChildren(head, approach, steps, log);
  }

  function drawList() {
    const now = Date.now();
    const key = JSON.stringify([listed, listError, home, listed?.map((p) => relativeTime(p.updatedAt, now))]);
    if (key === drawnKey) return;
    drawnKey = key;
    /** @type {HTMLElement[]} */
    const parts = [el('h2', 'plan-title', 'Plans')];
    if (listError) parts.push(el('p', 'plan-error', listError));
    else if (!listed) parts.push(el('p', 'plan-empty', 'Reading the plans…'));
    else if (!listed.length) parts.push(el('p', 'plan-empty', 'No plans yet. An agent keeps one for a large task: its steps, and the decisions it takes along the way.'));
    else {
      const list = el('ul', 'plan-list');
      for (const summary of listed) {
        const row = button('plan-list-item', undefined, () => ctx.setParams({ ompId: summary.ompId, name: summary.title }));
        const meta = el('span', 'plan-list-meta');
        meta.append(
          el('span', undefined, summary.total ? `${summary.done}/${summary.total}` : 'no steps'),
          el('span', 'plan-where', tildeHome(summary.cwd, home)),
          el('span', undefined, relativeTime(summary.updatedAt, now)),
        );
        row.append(el('span', 'plan-list-title', summary.title), meta);
        const li = el('li');
        li.append(row);
        list.append(li);
      }
      parts.push(list);
    }
    root.replaceChildren(...parts);
  }

  function draw() {
    const id = ompId();
    if (id !== shownId) {
      shownId = id;
      listed = null;
      listAsked = false;
      drawnKey = '';
      root.scrollTop = 0;
    }
    allBtn.hidden = id === null;
    if (id === null) {
      ctx.setLabel(null);
      if (!listAsked) {
        listAsked = true;
        loadList();
      }
      return drawList();
    }
    const plan = daemon.plan(id);
    const name = plan?.title ?? (typeof ctx.params.name === 'string' ? ctx.params.name : null);
    ctx.setLabel(name);
    if (plan && plan.title !== ctx.params.name) ctx.setParams({ name: plan.title });
    if (plan) return drawPlan(plan);
    const key = JSON.stringify([id, plan]);
    if (key === drawnKey) return;
    drawnKey = key;
    root.replaceChildren(el('p', 'plan-empty', plan === undefined ? 'Reading the plan…' : 'This conversation has no plan. An agent starts one for a large task.'));
  }

  const offPlans = daemon.onPlans(() => {
    // A plan changed: the list, if shown, is read again.
    if (ompId() === null) loadList();
    scheduleDraw();
  });
  // A reconnect forgets the plans heard: they are asked for again.
  const offStatus = daemon.onStatus(() => scheduleDraw());
  const tick = setInterval(scheduleDraw, TICK_MS);
  draw();

  return {
    paramsChanged: scheduleDraw,
    destroy() {
      destroyed = true;
      cancelAnimationFrame(frame);
      clearInterval(tick);
      offPlans();
      offStatus();
    },
  };
}
