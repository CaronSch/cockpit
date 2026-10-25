# Cockpit

An open-source, in-browser workbench for agentic development with AI coding
harnesses. v1 drives omp only.

## The point: everything is a module

The reason this project exists is to make agentic development **as modular as
possible**. Every surface is a window (a widget) that the user places, splits,
stacks, duplicates and closes: chats, terminals, notes, process views,
telemetry views. Nothing is a fixed panel. If a feature tempts you to add a
sidebar, a modal workflow, or a view that only works in one spot, make it a
widget instead.

- **Data views are modular too.** Each telemetry window shows one user-chosen
  slice: one agent or all, model calls, tool calls, processes, file writes,
  file reads, data sent to providers. Several windows can show different
  slices side by side.
- **One default layout** is suggested to new users, as a starting point. It is a
  layout like any other: editable, and never assumed by code.
- **Parity with omp in cmux.** Anything a user can do running omp inside cmux
  (manaflow-ai/cmux) must be possible here: the full omp interaction surface
  (prompts, slash commands, approvals, questions, plan mode, aborts, resume),
  plain shell terminals, split panes and workspaces, a per-workspace
  git branch/PR/cwd/listening-ports summary, "agent needs attention"
  notifications with jump-to-unread, a browser pane beside the agent, a command
  palette with project commands, session restore, and scripting.

Planned capabilities:

- **Structured agent panes**: omp sessions rendered from its event stream, not
  screen-scraped. Several open at once, side by side, each bound to a session.
- **Saved context**: pin parts of a chat into their own windows; fork a session
  into a new pane to compare.
- **Notes**: free-form notes with screenshots next to the agents, any
  number of them, each openable in several windows.
- **Terminal panes**: a real shell (and omp's own TUI, if wanted).
- **Process view**: the processes each agent runs, and their CPU, memory and I/O.
- **Telemetry**: every model call, tool call, process and file-system access,
  including reads and data sent to model providers.

## Architecture

- **Browser UI** (`src/`): the window grid and the widgets. No build step.
- **Local daemon** (`daemon/`, Bun): the only process that touches the machine.
  `bun start` runs it; it serves the UI on `127.0.0.1:4777` (`Bun.serve`), opened as
  `http://cockpit.localhost:4777/` and
  launches each omp session as `omp --mode rpc-ui` in the chosen directory
  (`Bun.spawn`), owning those processes. omp is the `omp` on PATH unless `--omp`
  says otherwise. Prefer Bun's own APIs where they make the code smaller.
  The workbench is self-contained: it shows agents it launched and does not attach
  to sessions started in other terminals. Later it also samples process trees,
  proxies model calls and observes the filesystem.
- **Wire** (`daemon/wire.js`): a JSON API for commands and one Server-Sent Events
  stream per page carrying every session's events in order: each omp stdout frame
  verbatim, each frame the daemon wrote to omp, stderr lines, undecodable stdout
  (`garbled`) and session status changes. The browser replays it on load, so a
  window shows the same history whether it was open all along or not.
  `src/daemon/client.js` is the browser side; widgets never open their own
  connections. The daemon also does omp's housekeeping once for every window: its
  setup fetches a resumed or forked session's history before the session is ready,
  and it asks for `get_state` again after anything that changes it. Windows render
  the stream and send only what their user asks for. A window showing a conversation
  no session holds reads it from its journal (`GET /api/conversation`,
  `daemon/conversation.js`, in `get_messages`' shape), without starting omp.
- **Windows keep their own settings** in `leaf.params` (e.g. which conversation an
  agent pane shows: its journal, `sessionFile`), saved with the layout.
  **Conversations are named by their journal, and asleep or awake is the daemon's
  business:** the user never starts or stops one. A window only shows one, two
  windows may show the same one, and switching or closing a window never ends it.
  The daemon puts a session to sleep (ends its omp) once it has been idle and
  unused for 30 minutes (`daemon/sleep.js`: no turn, nothing asked, nothing queued,
  no event and no `seen` from a window being used); windows keep showing the
  conversation from its journal, and the next message, or the box being focused,
  wakes it (`omp --resume`, queued until ready). After a daemon restart nothing is
  awake. A rewind moves omp onto a new journal: windows follow `get_state`'s
  `sessionFile`, and the daemon archives the old one (`onRewound`). Which conversations
  are unread is the daemon's too (`daemon/unread.js`, keyed by omp's conversation
  id, kept in `~/.cockpit/unread.json`), so every window and page agrees on what
  needs attention, and a mark outlives the session. **User data lives with the daemon**,
  not in the layout: anything that must outlive a window, a browser profile or
  a port change (the scratchpad's notes) is a file in the state directory
  (`~/.cockpit`). Closing a window must never delete it.
- **Layouts live with the daemon too.** Each browser window is one **screen** of
  a **workspace**, like an extra monitor: its own layout tree, kept in
  `~/.cockpit/workspaces/<name>.json` (`daemon/workspace.js`). The page's
  `?workspace=<name>` picks the workspace (default `main`). A window holds a Web
  Lock on its screen for as long as it is open, so two windows never show one
  screen; a reload keeps the tab's screen, and a new window takes the first saved
  screen no window shows, else a new one (`src/workspace/screen.js`). A screen is
  stored once it holds a window and deleted when it holds none. A page that
  cannot use the daemon (signed out) keeps its layout in memory only, and says so.
- **Telemetry provenance**: every recorded fact carries its source: `harness`
  (omp said so), `proxy` (seen on the wire), or `os` (seen by the kernel or the
  filesystem). The UI shows the source. The gap between what an agent claims it
  did and what the OS saw is the product, so never merge the two silently.
- **Local only, single user.** No auth beyond the loopback guard below.

## Current state

What runs today:

- The split-tree window grid: windows (widgets) are dragged, dropped, split and
  resized with magnetic snapping. Each browser window is a screen of its
  workspace, saved by the daemon; the top bar's switcher says which screen this
  window is, lists every screen with what it holds and where it is open, and opens
  one that is open nowhere in this window (a reload, so its agents keep running)
  or deletes it (asking first; the agents it showed keep running). A tab running older UI code than the daemon serves says so in the top
  bar and offers Reload (the files' version: `daemon/ui-files.js`).
- The daemon and the Agent window (the `omp` widget; "Agent" to the user, omp underneath): start omp in a directory (the Directory field
  suggests folders as the path is typed, relative to home, `~/`, `../` or absolute,
  and lists home's folders while empty or `~/`; Tab completes and opens a folder on its
  own folders, arrows move, Enter picks the folder the arrows moved to, else starts omp
  in the folder typed, Esc closes;
  a relative directory is found from home), chat with it from its
  structured event stream (streamed replies with Markdown, tables and TeX math as
  MathML, thinking,
  tool calls with output), pick model and thinking level, log in to
  providers, use slash commands, answer approval and `ask` dialogs, steer or stop
  a running turn, and carry on a conversation whatever became of its omp (asleep,
  a daemon restart). A pane shows one conversation at a time: **New**, **Fork**,
  **Accounts** and **Stop** sit in the window's title bar (`ctx.headActions`).
  **New** starts another one there, in the same directory unless the setup
  screen's Directory is changed, while the one shown before carries on. The
  toolbar keeps to one line (the directory gives way first). **Accounts** opens
  omp's providers to log in to; **Sign in** shows in the toolbar while an awake
  session's model needs a login (no model, or its provider is one omp logs in to
  and is logged out; the daemon asks omp's `get_login_providers` at setup and
  after a login). Several panes can
  show different sessions side by side, or the same one; the window's top
  bar names its conversation (omp's session title, or the first prompt while it
  has none, saved with the window, so it still shows once the session has ended).
  Sessions the daemon runs get a title during their first turn: once the first
  prompt is in a session omp has not named, the daemon sends `/rename` once and omp
  generates one while the agent works; untitled ones show their first prompt. A slash command's one-line output (such as that rename's) is a quiet
  note; output of several lines shows open. **Fork** continues
  a copy of a pane's conversation in a new pane, as a session of its own (omp's
  `--fork`: a new journal, the original runs on untouched); it stays off until
  omp has saved the conversation, which a new session does once the model has
  replied. Dragging **Send** onto the grid does the same, placed where it is
  dropped, and sends the message there instead (the box empties once the fork is
  placed; a click still sends here). The message box starts one line high, set like
  Notes text, and grows with the prompt; a plain click anywhere else in the pane
  (not on a control, in a dialog omp asked for, or ending a text selection) puts the caret
  at its end without scrolling, as in a terminal (`src/ui/click-focus.js`); Tab indents by two spaces as in a code
  editor (every selected line; Shift+Tab, or Backspace in the leading spaces, outdents; Cmd/Ctrl+Z undoes it) unless a
  suggestion list is open, and Esc then Tab leaves the box (`src/ui/indent.js`); Up
  in an empty box steps back through the conversation's prompts and `!` commands
  (Down forward), as omp's own editor does; a line starting with `!` runs
  as a shell command in the session's directory, at once even mid-turn, and while
  the draft is one the box turns into a shell line (accent-coloured, `$ shell · <dir>`,
  Run instead of Send, the cards shown as waiting for the next prompt). While a
  turn runs, the toolbar shows how far the agent is through its todo list (tasks
  done of tasks, the current one on hover), read from omp's `todo` results; work
  without a list shows none. A Running line above the message box lists the shells
  and subagents running now with how long each has run (`omp/running-work.js`): the
  calls the turn waits on, and the background jobs omp handed them off to (a
  result's `details.async`, ended by an `async-result` message or a `wait`), which
  run on after the turn and keep the session awake; Sessions counts them per row. A Markdown table in a reply has a Copy button (on
  hover) for Markdown, CSV or a PNG image drawn from its cells. Selected
  reply text can be commented on (the comment goes quoted with the next prompt)
  or asked about (omp's `btw` answers in the popup, outside the chat, where
  follow-up questions continue the same topic, one at a time; every question asks
  for an answer of at most three sentences); pasted text goes into the
  message box as typed, and pasted or dropped files are stored in
  `~/.cockpit/attachments/` and sent as omp `@"<path>"` mentions. Typing `@`
  suggests the entries of the session's directory, or of the folder the path after
  it names (`@src/`, `@../`, `@~/`, `@/abs`), filtered by what follows the last `/`;
  Tab completes (a folder opens on its contents), arrows, Enter or a click pick, and
  a file goes in as an omp file mention (quoted when its path needs it), which omp
  reads with the prompt; punctuation typed right after a finished path (`@benches/.`,
  `@app.js,`) closes the list, unless a name in that folder starts with it. **Rewind** on one of the user's own prompts puts it back
  in the box and dims what sending would set aside; nothing reaches omp until the
  box is sent (Undo or Esc puts the box back), when omp is rewound to just before
  the prompt (`branch`, matched to omp's entry by its place among the user
  messages and its text, refused when they differ) and the daemon's fresh
  `get_messages` replaces every window's transcript. A pane whose
  agent finished its turn (or asks something) while its user was not looking
  gets an electric-blue border until it is hovered, scrolled, clicked or typed
  in: its session is unread, for every window and page, across reloads and daemon
  restarts, and after it stops, until it is read there or shown from Sessions. A
  session marked unread from Sessions lights its windows too, and waits for a fresh
  hover, scroll, click or keystroke there (a pointer already resting on the window
  does not read it). **Notify** in the top bar (off until clicked, which asks the
  browser's permission; kept per browser) adds a desktop notification for the same
  moments, a second after them if the session is still unread and not shown in a
  focused tab: never for events replayed on (re)connecting (the `hello` carries the seq
  they run to), one per session (tagged with its id, so tabs replace each other's), closed
  once the session is read; a click shows it in the agent window used last. The top
  bar's Config menu (open while pointed at, or pinned by a click) holds the app's
  switches, kept per browser (`src/ui/settings.js`): *Only prompts and responses*
  shows only prompts and responses (every reply the agent finished, not only a turn's
  last) in every agent window, hiding thinking, tool calls and the narration between
  them, with one "Working…" line while a turn runs;
  *Animated selection* (on) draws a drag's selection in the transcript as Google
  Docs does, whole words gliding into place (`src/omp/drag-highlight.js`), with the
  browser's own highlight hidden under it. Snapping (`src/ui/word-snap.js`) leaves a
  selection inside one word alone and takes a long token (a path, a URL) by segment.
- The Sessions window: every omp conversation in one list (read from omp's
  session files, with the awake session holding each, and awake ones omp has not
  written yet; `src/sessions/running.js`), with how an awake one is doing
  (starting, working, idle, *done*: it finished and nobody has read it, or *needs
  you*: it asks a question or an approval), searchable across titles, directories
  and prompts, and sortable. A click on a conversation (or Enter) shows it in the
  agent window this screen used last (pressed or focused last), or a new one if
  there is none; dragging it onto the middle of an agent window shows it there, and
  onto the grid elsewhere opens a new agent window where it is dropped. Showing one
  starts no omp. A conversation shown in an agent window of this screen has a bar at
  its row's left edge (brighter for the agent window used last); pointing at a row
  outlines its windows, and pointing at an agent window lights its row (`ctx.screen`,
  `ctx.outline`; `src/sessions/links.js`). Waking a journal a session already
  holds gets that session: the daemon never starts a second omp on one. A
  directory menu (every directory with sessions, A→Z, with counts) narrows a
  window to one directory, together with its search, sort and Archived toggle; like
  those, the choice is the window's own. An untitled session is listed by its first
  prompt. Row actions show on hover or focus. A fork is listed as a
  session of its own, under the title it copied from its source. **Archive** moves a
  session's journal and its folder out of omp's sessions into
  `~/.cockpit/archive/sessions/` at the same relative path, so neither the list nor omp's
  own resume offers it; the **Archived** toggle lists archived sessions (searchable and
  sortable the same way), each with **Restore**, which moves it back and never replaces a
  file that is there now. An idle conversation's session goes to sleep before it
  moves; one whose agent works is not archived until it is done. Nothing is
  ever deleted: there is no delete. An unread conversation (archived too, which
  keeps its mark) has a blue dot and a bold title, and the window's top bar counts the
  unread ones it lists; showing a session from here reads it. Right-click on a row, its
  **⋯** button, or Shift+F10 / the ContextMenu key on a focused row opens its menu
  (`src/ui/context-menu.js`, a popover the arrow keys move through): **Mark as
  unread** or **Mark as read**, with Show and Archive / Restore.
- Notes windows (the `scratchpad` widget): each new window starts its own pad; a switcher reopens or
  deletes any pad, and two windows (or tabs) on one pad stay in sync. Pads are
  Markdown files in `~/.cockpit/scratchpads/`; pasted or dropped
  screenshots and files are stored beside them and shown inline. Tab indents pad text
  as in the message box. An edit made
  elsewhere (the file itself, another tab) is never overwritten without asking.

Not built yet: saved-context pins, terminal panes, process view,
telemetry views, cmux-parity features beyond the above.

## How we decide

- **Simple beats clever**, except where the workbench needs it: structured panes
  and the rich, modular workbench are not to be simplified away.
- **Clean and minimal, never hacky.** Write the least code that does the job
  properly, and delete what nothing uses. No workarounds, special cases or
  shortcuts that hide a problem instead of fixing it: if the clean fix is out of
  reach, stop and tell the owner.
- **Risks:** weigh each one when it comes up, decide, and tell the owner in one
  line what you decided. Fix a risk now only if it bites at the current stage
  *and* the fix costs little next to the damage. Drop small risks whose cover
  needs significant complexity. A risk that only bites at a later stage (going
  public, a second user, remote access, a new platform) goes in `RISKS.md`,
  under the threshold at which it bites.
- **At the start of every session, read `RISKS.md`.** For each threshold, decide
  from the repo's current state whether it has been crossed. If one has, tell the
  owner and propose the fix before other work. When a risk is fixed, delete its
  entry.

## Invariants (current stage)

- The daemon binds `127.0.0.1` only, checks every request's `Host` against an
  explicit list of loopback names (`127.0.0.1`, `localhost`, `cockpit.localhost`
  with its port; DNS rebinding; `*.localhost` is loopback in browsers per RFC 6761), requires the token cookie on every API request, and refuses any
  foreign `Origin` or cross-site `Sec-Fetch-Site`. The token is random, stored
  owner-only in `~/.cockpit/token`, and reaches the browser once through
  the URL the daemon prints (it becomes an HttpOnly, SameSite=Strict cookie).
  Without this, any web page open in the user's browser can reach the daemon and
  run commands on the machine. `tests/daemon.test.js` guards each check.
- Every agent the workbench shows was launched by the daemon.
- An omp event or message kind the adapter does not know is shown as an
  unrecognised entry, never dropped. Telemetry that silently loses events lies.

## Constraints

- The daemon, tests and scripts run on Bun (1.3.14+, omp's own minimum); the
  browser UI is plain ES modules with no build step (`bun start`). Dev-only
  tooling is TypeScript (type checking, never compiling), Playwright and
  `@types/bun`. Runtime dependencies are allowed only to avoid rebuilding a
  mature subsystem (terminal emulation, PTY handling), and each one is named in
  this file. Adding any other runtime dependency, dev tool, or bundler is a
  decision for the owner, not a side effect of a feature. The runtime
  dependencies, with the owner's say-so:
  - `temml` (TeX to MathML, so the browser typesets agents' math itself): its ES
    module is served at `/vendor/temml.mjs` (`VENDOR_FILES` in
    `daemon/ui-files.js`, the import map in `index.html`), loaded with the page.
- omp is not a dependency: the user installs it on its own (https://omp.sh) and
  the daemon runs the `omp` on PATH. The version the fake omp in `tests/` was
  recorded from is in `RISKS.md`; a newer installed omp means re-recording frames.
- Types are JSDoc in the `.js` files, checked by `tsc` in strict mode. No `.ts`
  files, no `@ts-ignore`/`@ts-expect-error`; `any` only for untrusted input
  (parsed JSON, storage). A type lives in the module that owns the value and is
  shared with `/** @import { … } from '…' */`.
- `src/layout/` stays pure (no DOM, no globals beyond `crypto`): it is where the
  layout logic is unit-tested.
- New windows are widgets: one module in `src/widgets/` registered in
  `src/widgets/registry.js` (contract documented there). A window owns nothing
  but its settings: closing it ends nothing.
- Every module opens with a `/** … */` comment whose first sentence says what it
  is for; the module map below is built from it.

## Working here

- Several agent sessions may share this checkout. Make changes in a worktree
  (`git worktree add ../cockpit-<topic> -b <branch> main`), never by
  switching branches or stashing in the shared tree.
- Run it: `bun install`, then `bun start`, then open the URL it prints once,
  `http://cockpit.localhost:4777/?token=…` (it carries the token; the browser
  keeps a cookie afterwards). Cookies and browser storage are per address, so a
  new address (`127.0.0.1` still works) needs the printed URL once. `--port`,
  `--omp <path>` (or `COCKPIT_OMP`), `--cwd <dir>` (or `COCKPIT_CWD`: the
  directory a new agent window suggests, home by default) and `COCKPIT_STATE_DIR`
  override the defaults.
- Before committing, all of these must pass (CI in `.github/workflows/ci.yml`
  runs the same on every push to `main` and every PR):
  - `bun run typecheck`
  - `bun run test`: `bun test` suites in `tests/`: the pure modules, plus the
    daemon end to end against `tests/fixtures/fake-omp.js`, a scripted stand-in
    for omp (plain `bun test` would also pick up `e2e/*.spec.js`)
  - `bun run test:e2e`: Playwright suites in `e2e/`, driving the real app and
    daemon (with the fake omp) in Chromium. First run on a machine needs
    `bunx playwright install chromium`.
  - `bun run claude-md:check`
- A UI behaviour change comes with an e2e test that fails without it.
- When omp changes its protocol, re-record frames from the real omp (never
  commit them: they contain local tool and MCP names) and update the fake to
  match.

## Commits & PRs

Every commit message and PR title is a [Conventional
Commit](https://gist.github.com/qoomon/5dfcdf8eec66a051ecd85625518cfd13); the
`commit-msg` hook in `.githooks/` rejects any other.

```
<type>(<optional scope>): <description>

<optional body>

<optional footer>
```

| Type | Use for |
|---|---|
| `feat` | adds, adjusts or removes a feature |
| `fix` | resolves a bug in a preceding feature commit |
| `refactor` | rewrites code without altering behavior |
| `perf` | refactor specifically targeting performance |
| `style` | formatting/whitespace only, no behavior change |
| `test` | adds or corrects tests |
| `docs` | documentation only |
| `build` | build tools, dependencies, versioning |
| `ops` | infrastructure, deployment, CI/CD, monitoring, backups |
| `chore` | maintenance: initial commit, `.gitignore`, housekeeping |

- **Description** (mandatory): imperative mood ("add", not "added"/"adds"),
  lowercase first letter, no trailing period, concise.
- **Scope** (optional): the area touched (`omp`, `daemon`, `scratchpad`, `ui`, …).
  Never an issue identifier.
- **Body** (optional): motivation, and how the behavior differs from before.
- **Footer** (optional): issue references (`Closes #123`) and breaking changes.
- **Breaking changes**: `!` before the colon, plus a `BREAKING CHANGE:` footer
  if it needs explaining.
- Merge and revert commits keep git's default message.

```
feat(omp): ask about selected reply text
fix(scratchpad): keep pasted images when the pad is renamed
refactor!: drop the Node daemon

BREAKING CHANGE: install Bun to run the daemon.
```

## Keeping this file current

The block below is generated from the code by `scripts/update-claude-md.js` and
refreshed automatically by the git pre-commit hook (`.githooks/`, enabled by
`bun install`) and by a Claude Code edit hook (`.claude/settings.json`). Do not
edit it by hand.

The sections above are hand-written. A change that alters what the app does,
its constraints, or how to work on it updates them **in the same commit**; in
particular, move a capability into "Current state" when it ships.

<!-- BEGIN GENERATED: scripts/update-claude-md.js — do not edit by hand -->

### Modules (`src/` browser, `daemon/` local daemon)

- `src/app.js` — Cockpit controller: owns the layout atom and wires rendering, interaction and widgets together.
- `src/daemon/client.js` — Browser side of the daemon connection: one event stream per page, shared by every widget.
- `src/interaction/drag-controller.js` — Pointer-driven drag & drop for moving widgets and adding new ones.
- `src/interaction/sash-controller.js` — Sash (divider) resizing with magnetic detents.
- `src/layout/compute-layout.js` — Turns a split tree into absolute pixel rects for leaves and sashes.
- `src/layout/drop-zone.js` — Drop-zone hit testing.
- `src/layout/grid-model.js` — Split-tree layout model (same shape as VS Code's GridView).
- `src/layout/neighbors.js` — Geometric neighbour lookup for keyboard moves (Alt+Shift+Arrow).
- `src/layout/snap.js` — Magnetic sash behaviour: detents pull the sash onto aligned positions, then minimum sizes clamp the result.
- `src/main.js` — Bootstrap: starts the app and shows a visible error if it cannot.
- `src/omp/activity.js` — Which omp events make a session "unread": the agent's final response, when it hands the turn back to the user, or a question it stops to ask them.
- `src/omp/composer.js` — The agent pane's message box: a draft that starts one line high and grows with its text up to half the pane, cards for what goes with the next message (comments on quoted transcript text, files), and the Send button.
- `src/omp/dialogs-view.js` — Inline dialogs for omp's extension UI requests (select, confirm, input, editor, ask); each one answers through a single `respond(payload)` call.
- `src/omp/drag-highlight.js` — The omp transcript's selection highlight, drawn as in Google Docs: while the pointer drags, it already covers whole words (ui/word-snap.js) and its edges glide from word to word.
- `src/omp/file-mention.js` — Paths typed in the agent pane, as `@` file mentions in its draft or plainly in its Directory field: the path being typed at the caret, the folder entries that match it, and the text that completes it, kept free of the DOM so they can be tested.
- `src/omp/file-suggest.js` — Path suggestions in the agent pane's text boxes (`@` file mentions in its draft, its Directory field): while the caret ends a path, the suggestion list shows the matching entries of the folder it names, and Tab, Enter or a click completes the path (see `file-mention.js`).
- `src/omp/items-view.js` — DOM for one transcript item of the agent pane (messages, tool cards, shell runs, notes, unrecognised frames), built from text nodes only.
- `src/omp/markdown-dom.js` — Renders the safe markdown tree from `markdown.js` as DOM nodes (text nodes only, never HTML).
- `src/omp/markdown.js` — Safe markdown subset for agent text: parses into a small block/inline tree, never HTML.
- `src/omp/message.js` — Builds what the agent pane sends from what the user wrote: the prompt (comments on quoted parts of earlier replies, the draft, then files), `!` shell commands, and side questions about a quote.
- `src/omp/prompt-history.js` — Up and Down in the agent pane's message box step through what was sent in its conversation, as omp's own editor and a shell do: the user's prompts and `!` commands, newest first.
- `src/omp/rewind.js` — Rewinding an omp conversation to one of the user's prompts, as omp's `/branch` does: what the rewind sets aside, and which of omp's entries the prompt is.
- `src/omp/running-work.js` — What an agent has running now, for the agent window's Running line and the Sessions list: the shells and subagents its turn is waiting on, and its background jobs (omp/transcript.js `jobs`), which go on after their tool call has returned, even once the turn has ended.
- `src/omp/selection-popup.js` — Actions on highlighted transcript text: select part of a reply and Comment and Ask buttons appear at the end of the selection.
- `src/omp/suggestions.js` — The suggestion list above the agent pane's message box (slash commands, `@` file entries), driven from the draft's keys so focus never leaves it.
- `src/omp/table-copy.js` — Copy control for a rendered Markdown table: a button whose menu copies the table as Markdown, CSV or a PNG image.
- `src/omp/table-text.js` — Plain-text forms of a parsed Markdown table: a cell's text without its formatting, and the table as CSV.
- `src/omp/todos.js` — How far along the agent is, from the todo list omp agents keep with their `todo` tool: how many of its tasks are done and which one it is on.
- `src/omp/transcript.js` — Transcript reducer for one omp session: folds the daemon's SessionEvents into display items plus derived session state, with no DOM.
- `src/omp/visibility.js` — Which transcript items an agent pane shows when it is set to only prompts and responses: what the user said and ran, and what the agent finally answered, without the work in between.
- `src/render/drop-indicator.js` — Landing preview for drag & drop, plus the sash snap guide.
- `src/render/grid-renderer.js` — Imperative, diffed DOM writer for the grid.
- `src/scratchpad/blocks.js` — A scratchpad's text as blocks to edit: runs of text, and the images and files it references, kept free of the DOM so the round trip can be tested.
- `src/scratchpad/store.js` — The page's copy of one scratchpad: every window in the page showing that pad edits this one object, so they agree as you type; it saves to the daemon after a pause and follows what other pages save.
- `src/sessions/links.js` — Which agent windows of this screen show which conversations, so the Sessions window can mark its rows and point at their windows.
- `src/sessions/notify.js` — Desktop notifications when an agent is done or needs its user, so a session can be left running while the user is elsewhere: the moments that mark a conversation unread (omp/activity.js), as they happen.
- `src/sessions/order.js` — Sorting and labels for the Sessions window, kept free of the DOM so they can be tested.
- `src/sessions/running.js` — Conversations as the Sessions window lists them, kept free of the DOM so they can be tested: every journal with the session holding it while one is awake, how each is doing, and what an agent window is given to show one.
- `src/state/atom.js` — Tiny observable cell: get/set/subscribe.
- `src/ui/autosize.js` — Grows a textarea to fit its text, up to a maximum height, after which it scrolls.
- `src/ui/click-focus.js` — Click-to-focus, as in a terminal: a plain click on a window's own surface puts the caret at the end of its main text box, while clicks on controls, in boxes of their own, and those that end a text selection do what they did before.
- `src/ui/context-menu.js` — A small menu of actions on one thing, as a right-click, the ContextMenu key, Shift+F10 or a ⋯ button opens it: a native popover at the pointer or beside the control, whose items the arrow keys move between; Enter or a click runs one, and Esc or a click elsewhere closes it.
- `src/ui/dom.js` — Element construction helpers: elements, buttons that never submit a form, and file-drag checks.
- `src/ui/format.js` — Text formatters shared across the UI: error messages, home-relative paths and JSON dumps, with no DOM.
- `src/ui/indent.js` — Tab and Shift+Tab indent and outdent text in a textarea, as in a code editor, and Backspace in a line's leading spaces takes a whole indent back; Esc then Tab leaves the field instead, so keyboard users are never trapped in it.
- `src/ui/palette.js` — "Add widget" palette.
- `src/ui/prefs.js` — Per-browser preferences in localStorage.
- `src/ui/screen-switcher.js` — The screen switcher in the top bar: which screen of its workspace this window shows, and a menu of every screen, with what it holds and where it is open, to open one here or delete it.
- `src/ui/settings.js` — App-wide settings, picked in the top bar's Config menu and kept per browser.
- `src/ui/update-notice.js` — The "updated, reload" notice in the top bar: shown while the daemon serves other UI files than this page loaded (see daemon/ui-files.js), so a tab left open never runs stale code unknowingly.
- `src/ui/word-snap.js` — Grows a selection out to whole words once it spans more than one, as Google Docs does, so a rough drag still quotes clean text, while a selection inside one word stays exactly as made.
- `src/ui/zoom.js` — Text size for the whole app, picked in the top bar (− 100% +; the percentage resets it) and kept per browser.
- `src/widgets/omp.js` — The agent pane: a conversation with an omp coding agent in a chosen directory, through the daemon, rendered from omp's structured event stream.
- `src/widgets/pane.js` — An empty window: the frame every real widget is mounted into, with nothing inside.
- `src/widgets/registry.js` — Widgets the palette can add, keyed by type.
- `src/widgets/scratchpad.js` — Notes beside the agents: text with screenshots and files in it.
- `src/widgets/sessions.js` — omp conversations, one list, searchable and sortable.
- `src/workspace/model.js` — Workspaces and their screens, kept free of the DOM and shared with the daemon: valid names and ids, which screen a new window claims, and how a screen is described.
- `src/workspace/screen.js` — This window's screen of its workspace: claimed for as long as the window is open, loaded from the daemon, and saved back as its layout changes.
- `daemon/attachments.js` — Files attached to omp prompts: stored where omp can read them, one folder per day, so a prompt can mention them as `@"<path>"` and omp attaches them itself (images to the model, text inlined; see omp's file mentions).
- `daemon/clock.js` — The daemon's clock for the times it stamps on events and unread marks: Date.now, but never the same value twice and never earlier than the last, so any two stamps are ordered, even within one millisecond.
- `daemon/conversation.js` — A conversation read from its journal, for a window to show while no omp process holds it: the messages omp's `get_messages` would answer with once resumed, so the transcript seeds from either the same way, and what the journal records about the session around them.
- `daemon/files.js` — Folder listings for path suggestions (the agent pane's `@` file mentions, its Directory field): each entry's name and whether it is a folder (a link to one counts), capped so a huge folder cannot flood the page; and how a typed path is read.
- `daemon/frame-decoder.js` — Decodes omp's stdout: newline-delimited JSON frames, with protocol-v2 `rpc_chunk` sequences reassembled into the one frame they carry.
- `daemon/guard.js` — Loopback guard: decides which requests may reach the daemon (CLAUDE.md, Invariants).
- `daemon/history.js` — Past omp sessions, read from omp's session files: one summary per conversation, searchable by title, directory and what the user asked.
- `daemon/hub.js` — The daemon's omp sessions and the single ordered event log the browser replays.
- `daemon/main.js` — Daemon entry point (`bun start`): serves the workbench on loopback and runs the omp processes it shows.
- `daemon/omp-session.js` — One omp process in RPC mode: launch, protocol setup, command/response correlation and lifecycle, with everything it does reported as session events.
- `daemon/scratchpad.js` — Scratchpads: plain Markdown files the daemon keeps, one per pad, with pasted screenshots and files stored beside them.
- `daemon/server.js` — HTTP face of the daemon: the workbench's static files, the JSON API and the event stream (routes in `wire.js`), all behind the loopback guard.
- `daemon/sleep.js` — When the daemon puts a session to sleep: ends its omp process, as nobody needs it running.
- `daemon/token.js` — The daemon's access token: random, created once, kept owner-only in the state directory so a browser stays signed in across daemon restarts.
- `daemon/ui-files.js` — The files that make up the browser UI: which ones the daemon serves, and a version that changes whenever any of them does, so an open page can tell it is running older code.
- `daemon/unread.js` — Which omp conversations have news their user has not read: kept in one small file in the state directory, so a mark outlives windows, browsers, daemon restarts and the session itself (a stopped session is a past one, still unread).
- `daemon/wire.js` — Wire contract between the daemon and the browser: session metadata, stream events and HTTP payloads.
- `daemon/workspace.js` — Workspaces: the screens of each one (a layout tree per browser window), kept by the daemon so a layout outlives a browser profile and an address change.

### Registered widgets

- `pane` — Pane: An empty window
- `omp` — Agent: Chat with a coding agent in a directory
- `sessions` — Sessions: Agent conversations: click or drag one to show it in an agent window
- `scratchpad` — Notes: Notes with screenshots and files; each new window starts a fresh page

### Scripts

- `bun run start` — `bun daemon/main.js`
- `bun run test` — `bun test`
- `bun run test:coverage` — `bun test --coverage`
- `bun run test:e2e` — `playwright test`
- `bun run typecheck` — `tsc -p .`
- `bun run claude-md` — `bun scripts/update-claude-md.js`
- `bun run claude-md:check` — `bun scripts/update-claude-md.js --check`
- `bun run prepare` — `git config core.hooksPath .githooks`

### Test suites

`tests/atom.test.js`, `tests/clock.test.js`, `tests/compute-layout.test.js`, `tests/conversation.test.js`, `tests/daemon-client.test.js`, `tests/daemon.test.js`, `tests/drag-highlight.test.js`, `tests/drop-zone.test.js`, `tests/file-mention.test.js`, `tests/frame-decoder.test.js`, `tests/grid-model.test.js`, `tests/history.test.js`, `tests/indent.test.js`, `tests/markdown.test.js`, `tests/neighbors.test.js`, `tests/omp-activity.test.js`, `tests/omp-message.test.js`, `tests/omp-rewind.test.js`, `tests/omp-running-work.test.js`, `tests/omp-transcript.test.js`, `tests/omp-visibility.test.js`, `tests/prompt-history.test.js`, `tests/scratchpad-blocks.test.js`, `tests/scratchpad-store.test.js`, `tests/scratchpad.test.js`, `tests/sessions-links.test.js`, `tests/sessions-notify.test.js`, `tests/sessions-order.test.js`, `tests/sessions-running.test.js`, `tests/settings.test.js`, `tests/sleep.test.js`, `tests/snap.test.js`, `tests/table-text.test.js`, `tests/todos.test.js`, `tests/ui-files.test.js`, `tests/unread.test.js`, `tests/word-snap.test.js`, `tests/workspace-model.test.js`, `tests/workspace.test.js`, `tests/zoom.test.js`, `e2e/grid.spec.js`, `e2e/notify.spec.js`, `e2e/omp.spec.js`, `e2e/scratchpad.spec.js`, `e2e/screens.spec.js`, `e2e/sessions.spec.js`, `e2e/sleep.spec.js`, `e2e/unread.spec.js`, `e2e/update-notice.spec.js`

<!-- END GENERATED -->
