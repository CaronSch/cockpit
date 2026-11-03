/**
 * A GitHub pull request to review beside the agent that works on it: its description and
 * conversation, and its changes with the comments on their lines. Highlighted parts take a
 * comment or a question (omp/selection-popup.js), collected with a note of the reviewer's own
 * and sent to the agent's conversation as one message (github/review.js, through the daemon,
 * which wakes the conversation if it is asleep). **Bugbot** comments `bugbot go` on the pull
 * request and has the daemon send Cursor Bugbot's review to the agent once it is posted
 * (daemon/bugbot.js).
 *
 * Params (persisted with the layout): where the pull request is, `repo` (`owner/name`) or else
 * `cwd` (a directory of its repository, where `gh` runs), its `number`, `name` (its title, for
 * the window's top bar), `tab` (`conversation` or `files`), and
 * the conversation it reviews for: `parentFile` (its journal), `parentSession` and
 * `parentCwd`, set by the agent window it was opened from. Without them, the review goes to
 * the agent window this screen used last. Without a pull request, the window lists the
 * repository's to pick one.
 */
import { button, el, setText } from '../ui/dom.js';
import { errorMessage, tildeHome } from '../ui/format.js';
import { getDaemon } from '../daemon/client.js';
import { renderMarkdown } from '../omp/markdown-dom.js';
import { attachSelectionPopup } from '../omp/selection-popup.js';
import { citeLines, lineKey, lineKeys, parseDiff } from '../github/diff.js';
import { readableBody } from '../github/text.js';
import { readReview, reviewMessage, writeReview } from '../github/review.js';
import { pullOfUrl } from '../github/pr-refs.js';
import { attachPullDrag, pullParams } from '../github/pull-window.js';
/** @import { WidgetContext } from './registry.js' */
/** @import { DaemonClient } from '../daemon/client.js' */
/** @import { BugbotWatch, ConversationTarget, Pull, PullSummary, ReviewComment } from '../../daemon/wire.js' */
/** @import { DiffFile } from '../github/diff.js' */
/** @import { Review, ReviewNote } from '../github/review.js' */

/** A file shows this many of its lines at most; the rest are on GitHub. */
const MAX_FILE_LINES = 3000;
const EXCERPT_CHARS = 120;

export default {
  type: 'github',
  title: 'Pull request',
  glyph: '⇄',
  description: 'Review a GitHub pull request beside its agent: comment, ask, and send it all back',

  /** @param {HTMLElement} body @param {WidgetContext} ctx */
  mount(body, ctx) {
    return createPullPane(body, ctx, getDaemon());
  },
};

/** @param {unknown} v @returns {string | null} */
const str = (v) => (typeof v === 'string' && v ? v : null);

/** @param {string} iso */
const when = (iso) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

/** @param {string} text */
const excerpt = (text) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > EXCERPT_CHARS ? `${line.slice(0, EXCERPT_CHARS - 1)}…` : line;
};

/** @param {string} url @returns {string | null} the repository a pull request's URL is in */
const repoOfUrl = (url) => pullOfUrl(url)?.repo ?? null;

/**
 * @param {HTMLElement} body @param {WidgetContext} ctx @param {DaemonClient} daemon
 */
function createPullPane(body, ctx, daemon) {
  const root = el('div', 'gh');
  body.append(root);
  let destroyed = false;
  /** `paramsChanged` hears every change of params, made here or by another window. @type {{ destroy(): void, paramsChanged?(): void } | null} */
  let view = null;
  /** What the view shows, so a change of params replaces it. */
  let shownKey = '';

  const params = () => ({
    repo: str(ctx.params.repo),
    cwd: str(ctx.params.cwd),
    number: Number.isInteger(ctx.params.number) ? /** @type {number} */ (ctx.params.number) : null,
    name: str(ctx.params.name),
    tab: ctx.params.tab === 'files' ? 'files' : 'conversation',
    parentFile: str(ctx.params.parentFile),
    parentSession: str(ctx.params.parentSession),
    parentCwd: str(ctx.params.parentCwd),
  });

  /**
   * The conversation the review goes to: the one this window was opened for, else the one the
   * agent window this screen used last shows.
   * @returns {ConversationTarget | null}
   */
  function target() {
    const p = params();
    if (p.parentFile || p.parentSession) return { sessionFile: p.parentFile, session: p.parentSession, cwd: p.parentCwd ?? p.cwd ?? '~' };
    const screen = ctx.screen.get();
    const agent = screen.windows.find((w) => w.id === screen.used.omp)?.params;
    const sessionFile = str(agent?.sessionFile);
    const session = str(agent?.session);
    if (!sessionFile && !session) return null;
    return { sessionFile, session, cwd: str(agent?.cwd) ?? p.cwd ?? '~' };
  }

  /** What the agent window showing `t`'s conversation calls it, if one on this screen does. @param {ConversationTarget} t */
  function targetName(t) {
    const shown = ctx.screen
      .get()
      .windows.find((w) => w.widget === 'omp' && ((t.sessionFile && w.params?.sessionFile === t.sessionFile) || (t.session && w.params?.session === t.session)));
    return str(shown?.params?.name) ?? 'the agent';
  }

  function render() {
    if (destroyed) return;
    const p = params();
    ctx.setLabel(p.name);
    const where = p.repo ?? p.cwd;
    const key = where && p.number ? `${where}#${p.number}` : `pick:${p.cwd ?? ''}`;
    if (key === shownKey) return;
    shownKey = key;
    view?.destroy();
    root.replaceChildren();
    ctx.headActions.replaceChildren();
    view = where && p.number ? reviewView(p.repo ? { repo: p.repo } : { cwd: /** @type {string} */ (p.cwd) }, p.number) : pickView(p.cwd);
  }

  // ── picking a pull request ──
  /** @param {string | null} cwd */
  function pickView(cwd) {
    const form = el('form', 'gh-pick');
    const label = el('label', 'omp-label', 'Repository directory');
    const input = el('input', 'omp-field');
    input.type = 'text';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.placeholder = '~/code/project';
    input.id = `gh-cwd-${Math.random().toString(36).slice(2)}`;
    label.htmlFor = input.id;
    const list = el('div', 'gh-pick-list');
    const go = el('button', 'btn btn-accent', 'List pull requests');
    go.type = 'submit';
    const row = el('div', 'omp-row');
    row.append(input, go);
    form.append(el('p', 'omp-setup-title', 'Review a pull request'), label, row, list);
    root.append(form);

    let asked = 0;
    /** @param {string} dir */
    function listPulls(dir) {
      const mine = ++asked;
      list.replaceChildren(el('p', 'omp-muted', 'Loading…'));
      daemon
        .pulls(dir)
        .then((found) => {
          if (mine !== asked || destroyed) return;
          if (!found.connected) return list.replaceChildren(el('p', 'omp-error', `No pull requests: ${found.reason}`));
          if (!found.pulls.length) return list.replaceChildren(el('p', 'omp-muted', 'This repository has no pull requests.'));
          list.replaceChildren(
            ...found.pulls.map((pull) => {
              const item = button('gh-pick-item');
              item.append(el('span', 'gh-number', `#${pull.number}`), el('span', 'gh-pick-title', pull.title), el('span', 'omp-muted', stateText(pull)));
              item.addEventListener('click', () => ctx.setParams(pullParams({ repo: repoOfUrl(pull.url), cwd: dir }, pull, null)));
              return item;
            }),
          );
        })
        .catch((err) => {
          if (mine === asked && !destroyed) list.replaceChildren(el('p', 'omp-error', errorMessage(err)));
        });
    }
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (input.value.trim()) listPulls(input.value.trim());
    });
    // Start from the directory of the agent the review would go to, else the daemon's default.
    const start = cwd ?? target()?.cwd ?? null;
    if (start) {
      input.value = start;
      listPulls(start);
    } else {
      daemon
        .config()
        .then((c) => {
          if (destroyed || input.value) return;
          input.value = tildeHome(c.defaultCwd, c.home);
          listPulls(c.defaultCwd);
        })
        .catch(() => {});
    }
    return { destroy() {} };
  }

  // ── reviewing one ──
  /** @param {{ repo: string } | { cwd: string }} at @param {number} number */
  function reviewView(at, number) {
    const node = el('div', 'gh-review-pane');
    const head = el('div', 'gh-head');
    const tabs = el('div', 'gh-tabs');
    tabs.setAttribute('role', 'tablist');
    const conversationTab = button('gh-tab', 'Conversation');
    const filesTab = button('gh-tab', 'Files');
    for (const t of [conversationTab, filesTab]) t.setAttribute('role', 'tab');
    tabs.append(conversationTab, filesTab);
    const bugbotLine = el('div', 'gh-bugbot');
    bugbotLine.hidden = true;
    const content = el('div', 'gh-content');
    const tray = el('div', 'gh-tray');
    node.append(head, tabs, bugbotLine, content, tray);
    root.append(node);

    const refreshBtn = button('omp-tool-btn', 'Refresh', () => load());
    refreshBtn.title = 'Read the pull request from GitHub again';
    const bugbotBtn = button('omp-tool-btn', 'Bugbot', () => askBugbot());
    ctx.headActions.replaceChildren(refreshBtn, bugbotBtn);

    /** @type {Pull | null} */
    let pull = null;
    /** Why the pull request could not be read, if it could not. @type {string | null} */
    let failed = null;
    /** Bumped by every load, so an older answer never replaces a newer one. */
    let loads = 0;
    /** A Bugbot request on its way to the daemon, or why it failed. */
    let bugbot = { asking: false, error: /** @type {string | null} */ (null) };

    // ── the review: notes on highlighted parts, and the reviewer's own note ──
    /** @type {Review} */
    let review = { notes: [], text: '' };
    const notesEl = el('div', 'gh-notes');
    const note = el('textarea', 'omp-quote-input gh-note');
    note.rows = 2;
    note.placeholder = 'Anything else for the agent about this pull request…';
    note.setAttribute('aria-label', 'Your note to the agent');
    const sendBtn = button('btn btn-accent', 'Send to agent', () => void send());
    const toEl = el('span', 'gh-to omp-muted');
    const sentEl = el('span', 'gh-sent');
    sentEl.setAttribute('role', 'status');
    const sendRow = el('div', 'omp-row gh-send');
    sendRow.append(toEl, sentEl, sendBtn);
    tray.append(notesEl, note, sendRow);
    note.addEventListener('input', () => {
      review = { ...review, text: note.value };
      keep();
    });
    note.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void send();
      }
    });

    function keep() {
      if (pull) writeReview(pull.url, review);
      drawTray();
    }

    /** @param {ReviewNote} added */
    function addNote(added) {
      review = { ...review, notes: [...review.notes, added] };
      keep();
    }

    function drawTray() {
      notesEl.replaceChildren(
        ...review.notes.map((n, i) => {
          const card = el('div', `omp-card gh-note-card is-${n.kind}`);
          const text = el('div', 'gh-note-body');
          text.append(
            el('span', 'gh-note-kind', n.kind === 'question' ? 'Question' : 'Comment'),
            ...(n.cite ? [el('span', 'gh-note-cite', n.cite)] : []),
            el('span', 'gh-note-quote', excerpt(n.quote)),
            el('span', 'gh-note-text', n.text),
          );
          const remove = button('omp-chip-remove', '×', () => {
            review = { ...review, notes: review.notes.filter((_, at) => at !== i) };
            keep();
          });
          remove.setAttribute('aria-label', `Remove ${n.kind}: ${n.text}`);
          card.append(text, remove);
          return card;
        }),
      );
      notesEl.hidden = review.notes.length === 0;
      const to = target();
      setText(toEl, to ? `To ${targetName(to)}` : 'No agent to send to: open this from an agent window');
      const message = pull ? reviewMessage(pull, review) : '';
      sendBtn.disabled = !message || !to;
      sendBtn.textContent = review.notes.length ? `Send ${review.notes.length + (review.text.trim() ? 1 : 0)} to agent` : 'Send to agent';
    }

    async function send() {
      const to = target();
      if (!pull || !to) return;
      const message = reviewMessage(pull, review);
      if (!message) return;
      const sent = review;
      sendBtn.disabled = true;
      setText(sentEl, 'Sending…');
      sentEl.className = 'gh-sent omp-muted';
      try {
        await daemon.deliver(to, message);
        // Kept until it is through: anything written meanwhile stays.
        review = { notes: review.notes.filter((n) => !sent.notes.includes(n)), text: review.text === sent.text ? '' : review.text };
        note.value = review.text;
        setText(sentEl, `Sent to ${targetName(to)}`);
        sentEl.className = 'gh-sent';
      } catch (err) {
        setText(sentEl, `Not sent: ${errorMessage(err)}`);
        sentEl.className = 'gh-sent omp-error';
      }
      keep();
    }

    // Other pull requests it links or refers to (`#123`: this repository's) drag out as windows of their own.
    const offDrag = attachPullDrag({ root: content, ctx, base: () => (pull ? { repo: pull.repo, cwd: null } : null), parent: target });

    // Comments and questions on what is highlighted join the review.
    const popup = attachSelectionPopup({
      host: node,
      transcript: content,
      onComment: (quote, text, cite) => addNote({ kind: 'comment', quote, cite, text }),
      ask: { queue: (quote, text, cite) => addNote({ kind: 'question', quote, cite, text }) },
      cite: citeOf,
    });

    /** Where a highlighted range is: a file and its lines, or the comment it is in. @param {Range} range */
    function citeOf(range) {
      const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
      const file = /** @type {HTMLElement | null} */ (start?.closest('.gh-file') ?? null);
      if (file && file.contains(range.endContainer) && !start?.closest('.gh-thread')) {
        const lines = [...file.querySelectorAll('.gh-line')]
          .filter((line) => range.intersectsNode(line))
          .map((line) => {
            const data = /** @type {HTMLElement} */ (line).dataset;
            return { old: data.old ? Number(data.old) : null, new: data.new ? Number(data.new) : null };
          });
        return citeLines(file.dataset.path ?? '', lines);
      }
      return /** @type {HTMLElement | null} */ (start?.closest('[data-cite]') ?? null)?.dataset.cite ?? null;
    }

    // ── Bugbot ──
    /** The watches for this pull request, newest last. */
    const watches = () => (pull ? daemon.bugbot().filter((w) => w.url === pull?.url) : []);

    async function askBugbot() {
      const to = target();
      if (!to || bugbot.asking) return;
      bugbot = { asking: true, error: null };
      drawBugbot();
      try {
        if (pull) await daemon.askBugbot({ repo: pull.repo, number, target: to });
        bugbot = { asking: false, error: null };
      } catch (err) {
        bugbot = { asking: false, error: errorMessage(err) };
      }
      drawBugbot();
    }

    /** @param {BugbotWatch} w */
    const watchText = (w) =>
      w.status === 'watching'
        ? `Bugbot asked at ${when(w.since)}: waiting for its review, which goes to the agent${w.error ? ` (GitHub did not answer last time: ${w.error})` : ''}`
        : w.status === 'delivered'
          ? `Bugbot’s review went to the agent (${when(new Date(w.at).toISOString())})`
          : w.status === 'timed-out'
            ? 'Bugbot posted no review within an hour; nothing was sent'
            : (w.error ?? 'Bugbot’s review did not reach the agent');

    let deliveredSeen = -1;
    function drawBugbot() {
      const latest = watches().at(-1);
      const waiting = latest?.status === 'watching';
      const to = target();
      bugbotBtn.disabled = !pull || !to || bugbot.asking || waiting;
      bugbotBtn.title = !to
        ? 'No agent to send Bugbot’s review to'
        : waiting
          ? 'Waiting for Bugbot’s review'
          : `Comment “bugbot go” on this pull request, and send Cursor Bugbot’s review to ${targetName(to)} when it comes`;
      const text = bugbot.asking ? 'Asking Bugbot…' : bugbot.error ? `Bugbot not asked: ${bugbot.error}` : latest ? watchText(latest) : '';
      setText(bugbotLine, text);
      bugbotLine.hidden = !text;
      bugbotLine.classList.toggle('is-error', Boolean(bugbot.error) || latest?.status === 'failed');
      // A review just sent on is on the pull request too: show it there.
      const delivered = watches().filter((w) => w.status === 'delivered').length;
      if (deliveredSeen >= 0 && delivered > deliveredSeen) load();
      deliveredSeen = delivered;
    }
    const offBugbot = daemon.onBugbot(drawBugbot);

    // ── drawing the pull request ──
    function drawHead() {
      head.replaceChildren();
      if (!pull) return;
      const link = el('a', 'gh-title', `#${pull.number} ${pull.title}`);
      link.href = pull.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      const meta = el('div', 'gh-meta');
      meta.append(
        el('span', `gh-state is-${pull.isDraft ? 'draft' : pull.state.toLowerCase()}`, pull.isDraft ? 'Draft' : pull.state.toLowerCase()),
        el('span', 'omp-muted', `${pull.author} · ${pull.headRefName} → ${pull.baseRefName}`),
        el('span', 'gh-adds', `+${pull.additions}`),
        el('span', 'gh-dels', `−${pull.deletions}`),
      );
      head.append(link, meta);
    }

    /** One comment or review, with who wrote it and when. @param {string} author @param {string} at @param {string} text @param {string} cite @param {string} [badge] */
    function entry(author, at, text, cite, badge) {
      const item = el('article', 'gh-item');
      item.dataset.cite = cite;
      const by = el('header', 'gh-item-head');
      by.append(el('span', 'gh-author', author), ...(badge ? [el('span', 'gh-badge', badge)] : []), el('span', 'omp-muted', when(at)));
      const bodyEl = el('div', 'gh-item-body md');
      const readable = readableBody(text);
      bodyEl.append(readable ? renderMarkdown(readable) : el('p', 'omp-muted', 'No description.'));
      item.append(by, bodyEl);
      return item;
    }

    function drawConversation() {
      if (!pull) return [];
      /** @type {{ at: string, node: HTMLElement }[]} */
      const timeline = [
        ...pull.comments.map((c) => ({ at: c.createdAt, node: entry(c.author, c.createdAt, c.body, `${c.author}'s comment`) })),
        ...pull.reviews
          .filter((r) => r.body.trim() || r.state !== 'COMMENTED')
          .map((r) => ({ at: r.submittedAt, node: entry(r.author, r.submittedAt, r.body, `${r.author}'s review`, r.state.toLowerCase().replace(/_/g, ' ')) })),
      ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      return [entry(pull.author, pull.createdAt, pull.body, 'the description'), ...timeline.map((t) => t.node)];
    }

    /** The comments on lines, threaded under the one each replies to. @param {ReviewComment[]} comments */
    function thread(comments) {
      const box = el('div', 'gh-thread');
      for (const c of comments) box.append(entry(c.author, c.createdAt, c.body, `${c.author}'s comment on ${c.path}${c.line ? `:${c.line}` : ''}`));
      return box;
    }

    /** @param {DiffFile} file @param {Map<string, ReviewComment[]>} threads keyed by path and line */
    function drawFile(file, threads) {
      const section = el('section', 'gh-file');
      section.dataset.path = file.path;
      const fileHead = el('header', 'gh-file-head');
      fileHead.append(
        el('span', `gh-file-status is-${file.status}`, file.status),
        el('span', 'gh-file-path', file.from ? `${file.from} → ${file.path}` : file.path),
        el('span', 'gh-adds', `+${file.additions}`),
        el('span', 'gh-dels', `−${file.deletions}`),
      );
      section.append(fileHead);
      const outdated = threads.get(`${file.path}\0outdated`);
      if (outdated) section.append(el('p', 'gh-outdated omp-muted', 'Comments on lines no longer in the diff'), thread(outdated));
      if (file.binary) section.append(el('p', 'omp-muted gh-binary', 'Binary file'));
      let shown = 0;
      for (const hunk of file.hunks) {
        if (shown >= MAX_FILE_LINES) break;
        section.append(el('div', 'gh-hunk', hunk.header));
        for (const line of hunk.lines) {
          if (shown++ >= MAX_FILE_LINES) break;
          const row = el('div', `gh-line is-${line.kind}`);
          if (line.old !== null) row.dataset.old = String(line.old);
          if (line.new !== null) row.dataset.new = String(line.new);
          row.append(el('span', 'gh-gutter', line.old === null ? '' : String(line.old)), el('span', 'gh-gutter', line.new === null ? '' : String(line.new)), el('span', 'gh-code', line.text || '\u200b'));
          section.append(row);
          for (const key of lineKeys(line)) {
            const on = threads.get(`${file.path}\0${key}`);
            if (on) {
              section.append(thread(on));
              threads.delete(`${file.path}\0${key}`); // an unchanged line answers to both sides: once
            }
          }
        }
      }
      const total = file.hunks.reduce((n, h) => n + h.lines.length, 0);
      if (total > MAX_FILE_LINES) section.append(el('p', 'omp-muted gh-more', `${total - MAX_FILE_LINES} more lines: see the file on GitHub`));
      return section;
    }

    function drawFiles() {
      if (!pull) return [];
      const files = parseDiff(pull.diff);
      /** @type {Map<string, ReviewComment[]>} */
      const threads = new Map();
      const byId = new Map(pull.reviewComments.map((c) => [c.id, c]));
      for (const c of pull.reviewComments) {
        // A reply sits in the thread of the comment it answers.
        let first = c;
        while (first.inReplyTo !== null && byId.has(first.inReplyTo)) first = /** @type {ReviewComment} */ (byId.get(first.inReplyTo));
        const key = `${first.path}\0${first.line === null ? 'outdated' : lineKey(first.side, first.line)}`;
        threads.set(key, [...(threads.get(key) ?? []), c]);
      }
      const nodes = files.map((f) => drawFile(f, threads));
      if (!files.length) nodes.push(el('p', 'omp-muted', 'No changes.'));
      if (pull.diffTruncated) nodes.push(el('p', 'omp-muted gh-more', 'The diff is too large to show whole: the rest is on GitHub.'));
      return nodes;
    }

    /** The tab the content shows. */
    let drawnTab = '';
    function drawContent() {
      const tab = params().tab;
      drawnTab = tab;
      conversationTab.setAttribute('aria-selected', String(tab === 'conversation'));
      filesTab.setAttribute('aria-selected', String(tab === 'files'));
      filesTab.textContent = pull ? `Files (${parseDiff(pull.diff).length})` : 'Files';
      if (failed) {
        content.replaceChildren(el('p', 'omp-error', `Could not read the pull request: ${failed}`), button('btn', 'Try again', () => load()));
        return;
      }
      if (!pull) return content.replaceChildren(el('p', 'omp-muted', 'Loading…'));
      content.replaceChildren(...(tab === 'files' ? drawFiles() : drawConversation()));
    }

    conversationTab.addEventListener('click', () => ctx.setParams({ tab: 'conversation' }));
    filesTab.addEventListener('click', () => ctx.setParams({ tab: 'files' }));

    function draw() {
      drawHead();
      drawContent();
      drawTray();
      drawBugbot();
    }

    function load() {
      const mine = ++loads;
      refreshBtn.disabled = true;
      daemon
        .pull(at, number)
        .then((read) => {
          if (mine !== loads || destroyed) return;
          const first = pull === null;
          pull = read;
          failed = null;
          if (first) {
            review = readReview(read.url);
            note.value = review.text;
          }
          const name = `#${read.number} ${read.title}`;
          if (params().name !== name) ctx.setParams({ name });
          draw();
        })
        .catch((err) => {
          if (mine !== loads || destroyed) return;
          failed = errorMessage(err);
          draw();
        })
        .finally(() => {
          if (mine === loads) refreshBtn.disabled = false;
        });
    }

    draw();
    load();
    // The agent the review goes to may change with the screen (the agent window used last).
    const offScreen = ctx.screen.subscribe(() => {
      drawTray();
      drawBugbot();
    });

    return {
      // A tab picked here or elsewhere is drawn; the rest of the params leave the content be.
      paramsChanged() {
        if (params().tab !== drawnTab) drawContent();
      },
      destroy() {
        offBugbot();
        offScreen();
        popup.destroy();
        offDrag();
      },
    };
  }

  render();
  return {
    paramsChanged() {
      render();
      view?.paramsChanged?.();
    },
    destroy() {
      destroyed = true;
      view?.destroy();
      root.remove();
    },
  };
}

/** @param {PullSummary} pull */
export const stateText = (pull) => `${pull.isDraft ? 'draft' : pull.state.toLowerCase()} · ${pull.author}`;
