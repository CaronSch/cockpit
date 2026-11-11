/**
 * The processes cockpit's agents left running: the named services and background jobs they
 * started, and orphans found in their directories, with who owns each and why, for how long, and
 * what it costs; leftovers can be stopped or kept, and the last 30 days are listed below them.
 *
 * Running ones are grouped by project (orphans last, as Unowned), leftovers first, then those
 * started without a declaration, those running, those kept; the oldest first in each. Ended ones
 * follow, newest first, behind a toggle this window keeps in its settings.
 *
 * Provenance shows: a purpose and lifetime are what the agent says (marked as such), the age,
 * memory, CPU, ports and connections are what the OS saw. A click on a row shows its full
 * command, pid, directory, start and an hour of memory and CPU. The list is asked for every 5 s.
 *
 * A leftover flagged since the user last looked lights the window's border; coming into the
 * window (a click, a key, focus) tells the daemon they have been seen.
 */
import { button, el, svg } from '../ui/dom.js';
import { errorMessage, tildeHome } from '../ui/format.js';
import { getDaemon } from '../daemon/client.js';
import { relativeTime } from '../sessions/order.js';
import { conversationMatch, showConversation } from '../sessions/running.js';
import { duration } from '../timeline/scale.js';
/** @import { WidgetContext } from './registry.js' */
/** @import { DaemonClient } from '../daemon/client.js' */
/** @import { ProcessList, ProcessStatus, ProcessView } from '../../daemon/wire.js' */
/** @typedef {ProcessView['owners'][number]} Owner */
/** One line of the list: a group's header, the Ended toggle or a process. @typedef {{ key: string, signature: string, render: () => HTMLElement }} Entry */

const POLL_MS = 5000;

/** Running processes in a group, in this order (ended ones are listed apart). @type {Record<ProcessStatus, number>} */
const STATUS_ORDER = { leftover: 0, undeclared: 1, running: 2, kept: 3, ended: 4 };

/** The words a status chip says; running needs none. @type {Partial<Record<ProcessStatus, string>>} */
const CHIPS = { leftover: 'leftover', undeclared: 'undeclared', kept: 'kept' };

export default {
  type: 'processes',
  title: 'Processes',
  glyph: '◎',
  description: 'What your agents left running: who started each and why, for how long, what it costs; stop leftovers',

  /** @param {HTMLElement} body @param {WidgetContext} ctx */
  mount(body, ctx) {
    return createProcessesWindow(body, ctx, getDaemon());
  },
};

/** Resident memory, short: `340 MB`, `1.2 GB`. @param {number} bytes */
function memory(bytes) {
  const mb = bytes / 1_048_576;
  return mb < 1024 ? `${Math.round(mb)} MB` : `${(mb / 1024).toFixed(1)} GB`;
}

/** CPU percent, short: `0.4%`, `37%`. @param {number} cpu */
const percent = (cpu) => `${cpu < 10 ? cpu.toFixed(1) : Math.round(cpu)}%`;

/** `n thing` or `n things`. @param {number} n @param {string} thing */
const count = (n, thing) => `${n} ${thing}${n === 1 ? '' : 's'}`;

/** Its service name, else its command (a program named by its path by its file name), shortened. @param {ProcessView} p */
function nameOf(p) {
  if (p.name) return p.name;
  const command = p.command.trim().replace(/^\/\S*\/(\S+)/, '$1');
  return command.length > 80 ? `${command.slice(0, 79)}…` : command;
}

/** Whether `p` became a leftover since the user last saw the leftovers. @param {ProcessView} p @param {number} seenAt */
const isNew = (p, seenAt) => p.status === 'leftover' && p.flaggedAt !== null && p.flaggedAt > seenAt;

/**
 * A sparkline of `values` over `at`, scaled to its own maximum, no axes.
 * @param {number[]} at @param {number[]} values @param {string} label
 */
function sparkline(at, values, label) {
  const w = 120;
  const h = 24;
  const max = Math.max(...values) || 1;
  const first = at[0] ?? 0;
  const span = (at[at.length - 1] ?? first) - first || 1;
  const points = values.map((v, i) => `${(((at[i] ?? first) - first) / span) * w},${h - (v / max) * (h - 2) - 1}`).join(' ');
  const chart = svg('svg', { class: 'processes-spark', viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': label });
  chart.append(svg('polyline', { points, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.25', 'vector-effect': 'non-scaling-stroke' }));
  return chart;
}

/** @param {HTMLElement} body @param {WidgetContext} ctx @param {DaemonClient} daemon */
function createProcessesWindow(body, ctx, daemon) {
  const root = el('div', 'processes');
  body.append(root);
  // Loading, failing, empty, or why an action failed: said once, above the list.
  const status = el('p', 'processes-status');
  status.setAttribute('aria-live', 'polite');
  const list = el('ul', 'processes-list');
  list.setAttribute('aria-label', 'Processes');
  root.append(status, list);

  /** @type {ProcessList | null} */
  let listed = null;
  /** @type {string | null} */
  let error = null;
  /** Why the last Stop or Keep failed, until the next one. @type {string | null} */
  let actionError = null;
  let requestSeq = 0;
  /** The leftovers seen here up to then (daemon time), until the daemon's answer says so too. */
  let seenHere = 0;
  /** @type {string | null} */
  let home = null;
  /** Rows showing their details, by key. @type {Set<string>} */
  const expanded = new Set();
  /** The row asking whether to stop it. @type {string | null} */
  let confirming = null;
  /** Rows with a Stop or Keep under way. @type {Set<string>} */
  const busy = new Set();
  /** Each line of the list, by key, as last drawn. @type {Map<string, { signature: string, node: HTMLElement }>} */
  const rows = new Map();
  /** The processes shown, by key. @type {Map<string, ProcessView>} */
  let shown = new Map();
  let frame = 0;
  /** Set once the window closes: answers still on their way then change nothing. */
  let destroyed = false;
  /** Redraws once per frame however many reasons arrive. */
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
      scheduleDraw();
    })
    .catch(() => {});

  async function load() {
    if (destroyed) return;
    const seq = ++requestSeq;
    try {
      const next = await daemon.processes();
      if (seq !== requestSeq || destroyed) return;
      listed = next;
      error = null;
    } catch (err) {
      if (seq !== requestSeq || destroyed) return;
      error = errorMessage(err);
    }
    scheduleDraw();
  }

  const seenAt = () => Math.max(listed?.seenAt ?? 0, seenHere);
  const tilde = (/** @type {string} */ path) => tildeHome(path, home);
  const showEnded = () => ctx.params.ended === true;

  /** What an owner's conversation is called: its title, else its directory. @param {Owner} o */
  const ownerName = (o) => o.title ?? tilde(o.cwd);

  /** The agent window settings that show an owner's conversation, or null when there is none to show. @param {Owner} o */
  function ownerParams(o) {
    const meta = daemon.sessions().find((m) => m.ompId === o.ompId) ?? null;
    if (!o.sessionFile && !meta) return null;
    return showConversation({ file: o.sessionFile, meta, cwd: o.cwd, name: o.title });
  }

  /** How an owner holds it, in the agent's words where they are its own. @param {Owner} o */
  function ownerWords(o) {
    const says = [o.purpose, o.lifetime && `lifetime: ${o.lifetime}`].filter(Boolean).join(' · ');
    const how = o.how === 'undeclared' ? 'started it without a declaration' : o.how === 'reused' ? 'reuses it' : says ? '' : 'declared it';
    const words = el('span', 'processes-says');
    if (how) words.append(el('span', 'processes-how', how));
    if (says) words.append(...(how ? [' · '] : []), el('span', 'processes-says-label', 'agent says:'), ` ${says}`);
    return words;
  }

  /** A row's owners, each opening its conversation, or where an orphan was found. @param {ProcessView} p */
  function ownersLine(p) {
    const line = el('div', 'processes-owners');
    if (p.kind === 'unowned' || p.owners.length === 0) {
      const where = p.project ?? p.cwd;
      line.append(el('span', 'processes-how', `nobody owns it${where ? ` · found in ${tilde(where)}` : ''}`));
      return line;
    }
    p.owners.forEach((o, i) => {
      const owner = el('span', 'processes-owner');
      const params = ownerParams(o);
      if (params) {
        const open = button('processes-open', ownerName(o));
        open.dataset.action = 'open';
        open.dataset.owner = String(i);
        owner.append(open);
      } else owner.append(el('span', 'processes-open is-gone', ownerName(o)));
      if (!o.awake) owner.append(' ', el('span', 'processes-asleep', 'asleep'));
      owner.append(' ', ownerWords(o));
      line.append(owner);
    });
    return line;
  }

  /** What the OS saw of a running process, each fact on its own. @param {ProcessView} p @param {number} now */
  function runningFacts(p, now) {
    const facts = [duration(now - p.startedAt)];
    if (p.rss !== null) facts.push(memory(p.rss));
    if (p.cpu !== null) facts.push(percent(p.cpu));
    if (p.ports.length) facts.push(p.ports.map((port) => `:${port}`).join(' '));
    if (p.connections) facts.push(`${p.connections} conn${p.dbConnections ? ` · ${p.dbConnections} db` : ''}`);
    if (p.lastActiveAt !== null) facts.push(`active ${relativeTime(p.lastActiveAt, now)}`);
    return facts;
  }

  /** What an ended process did, and who stopped it. @param {ProcessView} p @param {number} now */
  function endedFacts(p, now) {
    if (p.endedAt === null) return [];
    return [`ran ${duration(p.endedAt - p.startedAt)}`, `ended ${relativeTime(p.endedAt, now)}`, ...(p.stoppedBy ? [`stopped by ${p.stoppedBy}`] : [])];
  }

  /** The row's full command, pid, directory, start and, while running, its last hour. @param {ProcessView} p */
  function details(p) {
    const box = el('div', 'processes-detail');
    box.append(el('code', 'processes-command', p.command));
    const facts = el('dl', 'processes-detail-facts');
    /** @param {string} term @param {string} value */
    const fact = (term, value) => facts.append(el('dt', '', term), el('dd', '', value));
    fact('pid', String(p.pid) + (p.processes > 1 ? ` (and ${count(p.processes - 1, 'process')} it started)` : ''));
    if (p.cwd) fact('in', tilde(p.cwd));
    fact('started', new Date(p.startedAt).toLocaleString());
    if (p.endedAt !== null) fact('ended', new Date(p.endedAt).toLocaleString());
    fact('source', 'the numbers are what the OS saw; purpose and lifetime, what the agent says');
    box.append(facts);
    if (p.trend.length > 1) {
      const at = p.trend.map((s) => s.at);
      const rss = p.trend.map((s) => s.rss);
      const cpu = p.trend.map((s) => s.cpu);
      const charts = el('div', 'processes-trend');
      charts.append(
        el('span', 'processes-trend-label', `memory, up to ${memory(Math.max(...rss))}`),
        sparkline(at, rss, 'Memory over the last hour'),
        el('span', 'processes-trend-label', `CPU, up to ${percent(Math.max(...cpu))}`),
        sparkline(at, cpu, 'CPU over the last hour'),
      );
      box.append(charts);
    }
    return box;
  }

  /** Stop's question: who else loses it, and what it has open. @param {ProcessView} p */
  function stopQuestion(p) {
    const parts = [`Stop ${nameOf(p)}?`];
    if (p.owners.length > 1) parts.push(`${p.owners.map(ownerName).join(', ')} use it.`);
    if (p.connections) parts.push(`It has ${count(p.connections, 'open connection')}.`);
    return parts.join(' ');
  }

  /** A running row's Stop and Keep, or Stop's confirmation. @param {ProcessView} p */
  function actions(p) {
    const box = el('div', 'processes-actions');
    const pending = busy.has(p.key);
    if (confirming === p.key) {
      box.classList.add('is-confirming');
      const yes = button('btn btn-danger processes-action', 'Stop');
      yes.dataset.action = 'stop-confirm';
      const no = button('btn processes-action', 'Cancel');
      no.dataset.action = 'stop-cancel';
      yes.disabled = no.disabled = pending;
      box.append(el('span', 'processes-confirm', stopQuestion(p)), yes, no);
      return box;
    }
    const stop = button('btn processes-action', 'Stop');
    stop.dataset.action = 'stop';
    const keep = button('btn processes-action', p.kept ? 'Unkeep' : 'Keep');
    keep.dataset.action = p.kept ? 'unkeep' : 'keep';
    stop.disabled = keep.disabled = pending;
    box.append(keep, stop);
    return box;
  }

  /** @param {ProcessView} p @param {number} now @param {number} seen */
  function renderRow(p, now, seen) {
    const ended = p.status === 'ended';
    const open = expanded.has(p.key);
    const row = el('li', `processes-item is-${p.status}${isNew(p, seen) ? ' is-new' : ''}${open ? ' is-expanded' : ''}`);
    row.tabIndex = 0;
    row.dataset.key = p.key;
    row.setAttribute('aria-expanded', String(open));
    const head = el('div', 'processes-line');
    const name = el('span', 'processes-name', nameOf(p));
    head.append(name);
    const chip = CHIPS[p.status];
    if (chip) head.append(' ', el('span', 'processes-chip', chip));
    const facts = el('span', 'processes-facts');
    (ended ? endedFacts(p, now) : runningFacts(p, now)).forEach((fact, i) => facts.append(...(i ? [' '] : []), el('span', 'processes-fact', fact)));
    head.append(' ', facts);
    if (!ended) head.append(actions(p));
    row.append(head, ownersLine(p));
    if (open) row.append(details(p));
    return row;
  }

  /** @param {string} key @param {string} text */
  const groupEntry = (key, text) => ({ key: `group:${key}`, signature: text, render: () => el('li', 'processes-group', text) });

  /** The list's lines, in order: each project's running processes under its name, then the ended ones. @param {ProcessList} l @returns {Entry[]} */
  function entries(l) {
    const seen = seenAt();
    /** @param {ProcessView} p @returns {Entry} */
    const rowEntry = (p) => ({
      key: p.key,
      signature: JSON.stringify([
        p.status,
        p.name,
        p.command,
        p.kept,
        isNew(p, seen),
        p.owners.map((o) => [o.title, o.awake, o.how, o.purpose, o.lifetime, o.sessionFile]),
        (p.status === 'ended' ? endedFacts : runningFacts)(p, l.now),
        expanded.has(p.key) && [p.trend.length, p.trend[p.trend.length - 1]?.at, p.processes],
        confirming === p.key,
        busy.has(p.key),
        home,
      ]),
      render: () => renderRow(p, l.now, seen),
    });
    const running = l.processes.filter((p) => p.status !== 'ended');
    const ended = l.processes.filter((p) => p.status === 'ended').sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
    /** @type {Map<string, ProcessView[]>} */
    const groups = new Map();
    for (const p of running) {
      const group = p.kind === 'unowned' ? '' : (p.project ?? '?');
      groups.set(group, [...(groups.get(group) ?? []), p]);
    }
    const names = [...groups.keys()].filter((g) => g !== '').sort((a, b) => tilde(a).localeCompare(tilde(b)));
    if (groups.has('')) names.push('');
    /** @type {Entry[]} */
    const out = [];
    for (const group of names) {
      const members = (groups.get(group) ?? []).sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.startedAt - b.startedAt);
      out.push(groupEntry(group, group === '' ? 'Unowned' : group === '?' ? 'Unknown project' : tilde(group)), ...members.map(rowEntry));
    }
    if (ended.length) {
      const text = `Ended (${ended.length})`;
      out.push({
        key: 'ended',
        signature: JSON.stringify([text, showEnded()]),
        render: () => {
          const li = el('li', 'processes-group processes-ended-head');
          const toggle = button('processes-toggle', text);
          toggle.dataset.action = 'ended';
          toggle.setAttribute('aria-expanded', String(showEnded()));
          li.append(toggle);
          return li;
        },
      });
      if (showEnded()) out.push(...ended.map(rowEntry));
    }
    return out;
  }

  function drawStatus() {
    const running = listed?.processes.some((p) => p.status !== 'ended') ?? false;
    status.classList.toggle('is-error', error !== null || actionError !== null);
    if (error) status.textContent = `Could not list processes: ${error}`;
    else if (actionError) status.textContent = actionError;
    else if (!listed) status.textContent = 'Loading processes…';
    else if (!running) status.textContent = 'Nothing your agents started is running.';
    else status.textContent = '';
    status.hidden = status.textContent === '';
  }

  function draw() {
    drawStatus();
    const lines = listed ? entries(listed) : [];
    shown = new Map((listed?.processes ?? []).map((p) => [p.key, p]));
    // Lines are rebuilt only when what they show changed, so a redraw keeps focus and selections.
    const live = new Set();
    lines.forEach((line, i) => {
      live.add(line.key);
      let entry = rows.get(line.key);
      if (!entry || entry.signature !== line.signature) {
        const node = line.render();
        if (entry) {
          const active = document.activeElement;
          if (entry.node.contains(active)) {
            const action = active instanceof HTMLElement ? active.dataset.action : undefined;
            entry.node.replaceWith(node);
            /** @type {HTMLElement | null} */ ((action && node.querySelector(`[data-action="${action}"]`)) || (node.tabIndex >= 0 ? node : null))?.focus();
          } else entry.node.replaceWith(node);
        }
        entry = { signature: line.signature, node };
        rows.set(line.key, entry);
      }
      const at = list.children[i];
      if (at !== entry.node) list.insertBefore(entry.node, at ?? null);
    });
    for (const [key, entry] of rows) {
      if (!live.has(key)) {
        entry.node.remove();
        rows.delete(key);
      }
    }
    const processes = listed?.processes ?? [];
    const leftovers = processes.filter((p) => p.status === 'leftover').length;
    ctx.setLabel(leftovers ? count(leftovers, 'leftover') : null);
    ctx.setUnread(processes.some((p) => isNew(p, seenAt())));
  }

  /**
   * Stops `p`, or keeps it or not, then lists again.
   * @param {ProcessView} p @param {'stop' | 'keep' | 'unkeep'} what
   */
  async function act(p, what) {
    busy.add(p.key);
    actionError = null;
    draw();
    try {
      if (what === 'stop') await daemon.stopProcess(p.key);
      else await daemon.keepProcess(p.key, what === 'keep');
    } catch (err) {
      actionError = `Could not ${what} ${nameOf(p)}: ${errorMessage(err)}`;
    }
    if (what === 'stop' && confirming === p.key) confirming = null;
    busy.delete(p.key);
    await load();
  }

  /** @param {EventTarget | null} target @returns {HTMLElement | null} */
  const rowAt = (target) => /** @type {HTMLElement | null} */ (/** @type {Element} */ (target)?.closest?.('.processes-item'));

  /** @param {HTMLElement} row */
  function toggleRow(row) {
    const key = row.dataset.key ?? '';
    if (!expanded.delete(key)) expanded.add(key);
    draw();
  }

  root.addEventListener('click', (event) => {
    const target = /** @type {Element} */ (event.target);
    const control = /** @type {HTMLElement | null} */ (target.closest('[data-action]'));
    const row = rowAt(target);
    const p = row ? (shown.get(row.dataset.key ?? '') ?? null) : null;
    const action = control?.dataset.action;
    if (action === 'ended') {
      ctx.setParams({ ended: !showEnded() });
      draw();
    } else if (action === 'open' && p) {
      const owner = p.owners[Number(control?.dataset.owner)];
      const params = owner && ownerParams(owner);
      if (params) ctx.showInTab('omp', params, conversationMatch(params));
    } else if (action === 'stop' && p) {
      confirming = p.key;
      draw();
      /** @type {HTMLElement | null} */ (rows.get(p.key)?.node.querySelector('[data-action="stop-confirm"]') ?? null)?.focus();
    } else if (action === 'stop-cancel') {
      confirming = null;
      draw();
    } else if (action === 'stop-confirm' && p) void act(p, 'stop');
    else if ((action === 'keep' || action === 'unkeep') && p) void act(p, action);
    else if (row && !control && !target.closest('button, .processes-detail') && !window.getSelection()?.toString()) toggleRow(row);
  });
  root.addEventListener('keydown', (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    if (event.key === 'Escape' && confirming !== null) {
      const key = confirming;
      confirming = null;
      draw();
      rows.get(key)?.node.focus();
    } else if (target.classList?.contains('processes-item') && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      toggleRow(target);
    } else if (target.classList?.contains('processes-item') && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      const items = [...root.querySelectorAll('.processes-item')];
      const next = items[items.indexOf(target) + (event.key === 'ArrowDown' ? 1 : -1)];
      /** @type {HTMLElement | undefined} */ (next)?.focus();
    }
  });

  // Coming into the window (a click, a key that types, focus) sees the leftovers flagged so far.
  function seeLeftovers() {
    if (!listed || !listed.processes.some((p) => isNew(p, seenAt()))) return;
    const at = listed.now;
    seenHere = Math.max(seenHere, at);
    ctx.setUnread(false);
    scheduleDraw();
    daemon.processesSeen(at).catch((err) => {
      actionError = `Could not mark the leftovers seen: ${errorMessage(err)}`;
      scheduleDraw();
    });
  }
  /** @param {KeyboardEvent} event */
  const onKey = (event) => {
    if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key !== 'Shift') seeLeftovers();
  };
  body.addEventListener('pointerdown', seeLeftovers, { passive: true });
  body.addEventListener('keydown', onKey);
  body.addEventListener('focusin', seeLeftovers);

  const offStatus = daemon.onStatus((s) => {
    if (s === 'open') void load();
  });
  const poll = setInterval(() => void load(), POLL_MS);

  draw();
  void load();

  return {
    paramsChanged: scheduleDraw,
    destroy() {
      clearInterval(poll);
      cancelAnimationFrame(frame);
      destroyed = true;
      offStatus();
      body.removeEventListener('pointerdown', seeLeftovers);
      body.removeEventListener('keydown', onKey);
      body.removeEventListener('focusin', seeLeftovers);
      root.remove();
    },
  };
}
