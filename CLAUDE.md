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
  (`Bun.spawn`), owning those processes, with omp settings of its own over the user's
  (`--config daemon/omp-overlay.yml`: plain titles, no title-card icon or code) and `--append-system-prompt` asking the
  agent for progress updates as it works, in Claude Code's wording, and telling it
  what the window renders, inviting visuals, and to schedule a check rather than ask its user to
  come back for it (`APPEND_SYSTEM_PROMPT`; it replaces any APPEND_SYSTEM.md the user has),
  and with the `PI_BROWSER_*` variables the Agents’ browser setting picks (`daemon/browser.js`).
  Every omp is also given the daemon's own tools (omp's RPC host tools: `set_host_tools` as it is
  set up, `host_tool_call` answered with `host_tool_result`; `HostTools` in
  `daemon/omp-session.js`): today the `schedule` tool (`daemon/schedule.js`). omp is the `omp` on PATH unless `--omp`
  says otherwise. Prefer Bun's own APIs where they make the code smaller.
  The workbench is self-contained: it shows agents it launched and does not attach
  to sessions started in other terminals. Later it also samples process trees,
  proxies model calls and observes the filesystem.
- **Wire** (`daemon/wire.js`): a JSON API for commands and one Server-Sent Events
  stream per page carrying every session's events in order: each omp stdout frame
  verbatim, each frame the daemon wrote to omp, stderr lines, undecodable stdout
  (`garbled`) and session status changes, less what no window needs any more
  (`src/omp/event-log.js`: finished streams' deltas, ended sessions). The browser replays it on load, so a
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
  wakes it (`omp --resume`, queued until ready). A conversation of 200K tokens or
  more whose last request wrote a one-hour prompt cache is instead compacted while
  idle, as Claude Code does, 54 minutes after that request (90% of the cache's life,
  while the summary still reads it from the cache), and stays awake until then
  (`daemon/idle-compaction.js`; omp's own idle compaction runs only in its TUI;
  a switch in Config, kept by the daemon in `~/.cockpit/settings.json`, turns it off:
  `daemon/settings.js`). After a daemon restart nothing is awake. A rewind moves omp onto a new journal: windows follow `get_state`'s
  `sessionFile`, and the daemon archives the old one (`onRewound`). Which conversations
  are unread is the daemon's too (`daemon/unread.js`, keyed by omp's conversation
  id, kept in `~/.cockpit/unread.json`), so every window and page agrees on what
  needs attention, and a mark outlives the session; so are pins (`daemon/pins.js`,
  `~/.cockpit/pins.json`). **User data lives with the daemon**,
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
- **Single user, local first.** No auth beyond the guard below. **Phone access**
  (a daemon setting, off by default) adds a second listener on the Mac's Tailscale
  IPv4 (`daemon/remote.js`) serving the same routes to the owner's own devices, for a
  phone page of its own (`phone.html`, `src/phone.js`): the Sessions and Agent widgets,
  one at a time, on a stream scoped to the conversations it shows (`?follow=`).

## Current state

What runs today:

- The split-tree window grid: windows (widgets) are dragged, dropped, split and
  resized with magnetic snapping. Each browser window is a screen of its
  workspace, saved by the daemon; the top bar's switcher says which screen this
  window is, lists every screen with what it holds and where it is open, and opens
  one that is open nowhere in this window (a reload, so its agents keep running)
  or deletes it (asking first; the agents it showed keep running). A tab running older UI code than the daemon serves shows a
  **Reload** button among the top bar's own (the files' version: `daemon/ui-files.js`).
- The daemon and the Agent window (the `omp` widget; "Agent" to the user, omp underneath): start omp in a directory (the Directory field
  suggests folders as the path is typed, relative to home, `~/`, `../` or absolute,
  and lists home's folders while empty or `~/`; Tab completes and opens a folder on its
  own folders, arrows move, Enter picks the folder the arrows moved to, else starts omp
  in the folder typed, Esc closes;
  a relative directory is found from home; under it, the directories of the latest
  conversations, awake or not, archived ones aside (at most five, most recently active first,
  `src/omp/recent-dirs.js`), each start omp there with one click), chat with it from its
  structured event stream (streamed replies with Markdown, tables, TeX math as
  MathML, `mermaid` diagrams and `vega-lite` charts drawn once their fence closes
  (`src/omp/visuals.js`: kept as SVG by source, live on hover; Vega's loader reads
  only local files), and images on this machine, `![alt](/abs/path.png)`; images and
  chart data are served by `/api/file`, raster and data types only, sandboxed;
  nothing remote is ever fetched, so a URL can't carry out what an agent read), thinking,
  tool calls with output), pick model and thinking level, log in to
  providers, use slash commands, answer approval and `ask` dialogs, steer or stop
  a running turn, and carry on a conversation whatever became of its omp (asleep,
  a daemon restart). A long conversation compacted while idle says so in its
  transcript while it runs ("Compacting while idle…") and once done ("Compacted while
  idle, before the prompt cache expired"), with the summary. Past that cutoff (54 minutes after
  the last request, or the user's last prompt), any conversation, however long and whether
  compaction is on or not, dims its window until it is used again (anything in it focused) or
  works again (`src/omp/cold.js`, the cutoff from `DaemonConfig`). A pane shows one conversation at a time: **New** and **Forks**
  sit in the window's title bar (`ctx.headActions`); Esc in the message box stops a turn (the phone, with no Esc, keeps a **Stop** button).
  **⌘↑** and **⌘↓** (Ctrl elsewhere, anywhere in the window, the message box; on the phone, its **↑** and **↓** buttons)
  put the agent's previous or next response (as *Only prompts and responses* counts them)
  at the top of the transcript, else its very top or its bottom, which follows new output again
  (`src/omp/response-nav.js`).
  **New** starts another one there, in the same directory unless the setup
  screen's Directory is changed, while the one shown before carries on. The
  toolbar keeps to one line (the directory gives way first). Another provider or account is
  signed in from Config's **Accounts** (`src/ui/login.js`: the daemon's `omp login`, as Setup runs it); **Sign in** shows in the toolbar while an awake
  session's model needs a login (no model, or its provider is one omp logs in to
  and is logged out; the daemon asks omp's `get_login_providers` at setup and
  after a login). Several panes can
  show different sessions side by side, or the same one; the window's top
  bar names its conversation (omp's session title, or the first prompt while it
  has none, saved with the window, so it still shows once the session has ended).
  Sessions the daemon runs get a title during their first turn: once the first
  prompt is in a session omp has not named, the daemon sends `/rename` once and omp
  generates one while the agent works; untitled ones show their first prompt. A slash command's one-line output (such as that rename's) is a quiet
  note; output of several lines shows open. omp's info notices (such as the tools it
  mounted) fold into a dim line naming their source, as the messages omp does not display
  do; its warnings and errors show. A fork continues a copy of a conversation as a
  session of its own (omp's `--fork`: a new journal, the original runs on untouched),
  started by the daemon (`daemon/forks.js`) once omp has saved the conversation (a new
  session does once the model has replied). `/fork <prompt>` (the workbench's own command,
  never sent to omp) starts one in the background with that prompt, no window of its own;
  dragging **Send** onto the grid starts one in a new window placed where it is dropped, with
  the message in the box (the box empties once the fork is placed; a click still sends here).
  Forking while the agent works copies the conversation as of its last completed response.
  A fork is named by its first prompt, not its source's title (which omp copies): the daemon
  asks omp's small model for a title (`daemon/fork-title.js`; the prompt's first line until
  it answers, or if it does not) and renames the fork with it. **Forks** lists the
  conversation it was forked from and its own forks, with a count of the latter: a click
  shows one beside the window (or points at the window already showing it) and reads it, as
  showing one from Sessions does; a drag places it. Windows of related conversations on one screen get the same colour in their top bars
  (`ctx.setFamily`, `src/omp/fork-family.js`). The message box is a card set like the transcript (Inter; code, notes,
  paths and the spend are monospace), starts one line high and grows with the prompt; a plain click anywhere else in the pane
  (not on a control, in a dialog omp asked for, or ending a text selection) puts the caret
  at its end without scrolling, as in a terminal (`src/ui/click-focus.js`); Tab indents by two spaces as in a code
  editor (every selected line; Shift+Tab, or Backspace in the leading spaces, outdents; Cmd/Ctrl+Z undoes it) unless a
  suggestion list is open, and Esc then Tab leaves the box (`src/ui/indent.js`); Up
  in an empty box steps back through the conversation's prompts and `!` commands
  (Down forward), as omp's own editor does; the box's unsent message (its text, comment
  cards and stored files) is kept per conversation and browser (`src/omp/drafts.js`,
  localStorage), so it waits while the window shows another conversation or the page
  reloads; a line starting with `!` runs
  as a shell command in the session's directory, at once even mid-turn, and while
  the draft is one the box turns into a shell line (accent-coloured, `$ shell · <dir>`,
  Run instead of Send, the cards shown as waiting for the next prompt). A message of just
  `.` (no comment cards or files) continues silently, as in omp's own editor: the pane sends
  omp's continue directive instead (`src/omp/message.js`; a steer while a turn runs), and
  since omp's RPC cannot send it hidden, every view recognises it by its text and shows no
  prompt for it (transcript, live or from a journal, Up's history, the conversation's name,
  Rewind, Sessions' first prompt, count and search), a queued one as `. (continue)`. While a
  turn runs, the toolbar shows how far the agent is through its todo list (tasks
  done of tasks, the current one on hover), read from omp's `todo` results; work
  without a list shows none. A Running line above the message box lists the shells
  and subagents running now with how long each has run (`omp/running-work.js`): the
  calls the turn waits on, and the background jobs omp handed them off to (a
  result's `details.async` and `progress`, or a subagent a message revived, ended by an `async-result` message, a `wait` or `proc://`), which
  run on after the turn and keep the session awake; Sessions counts them per row. A Scheduled
  line under it lists the prompts scheduled for the conversation (its agent's `schedule` tool,
  below), each with when it runs, the whole prompt on hover; a missed one says so. A Markdown table in a reply has a Copy button (on
  hover) for Markdown, CSV or a PNG image drawn from its cells; a code block has one for its code
  (not its language label), pinned to its corner while long lines scroll. Selected
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
  `@app.js,`) closes the list, unless a name in that folder starts with it. Typing `#`
  suggests the pull requests of the GitHub repository the session's directory is in, by
  number or by words of the title, each shown with its title; a pick goes in as GitHub's `#123`.
  Part of a repository's name after the `#` (`#k8s`) suggests that owner's other repositories
  too; picking one leaves `k8s-infra#` to go on with, listing its pull requests, and a pick of
  one goes in as GitHub's `owner/name#123`. Typed outright, `k8s-infra#859`, `owner/name#859`
  and `#k8s-infra:859` list the same (`src/omp/pr-suggest.js`, `src/github/pr-mention.js`);
  without GitHub (no `gh`, signed out, no repository) `#` is plain
  text. **Rewind** on one of the user's own prompts puts it back
  in the box and dims what sending would set aside; nothing reaches omp until the
  box is sent (Undo or Esc puts the box back), when omp is rewound to just before
  the prompt (`branch`, matched to omp's entry by its place among the user
  messages and its text, refused when they differ) and the daemon's fresh
  `get_messages` replaces every window's transcript. A pane whose
  agent finished its turn (or asks something) while its user was not in it (the last
  window they clicked, typed or put the cursor in, with the pointer over it, in a focused
  page) gets a cyan border until they click in it, type in it or move the cursor
  into it; hovering over it or scrolling it reads nothing (it keeps the session awake), nor
  does a modifier or shortcut (⌘K, ⌘-Tab) nor the focus the browser gives back as the page
  regains it: its session is unread, for every window and page, across reloads and daemon
  restarts, and after it stops, until it is read there or shown from Sessions. A
  session marked unread from Sessions lights its windows too, and waits for a fresh
  click, keystroke or cursor there. *Desktop notifications* in the top bar's Config (off until
  switched on, which asks the browser's permission; kept per browser) adds a desktop notification for the same
  moments, a second after them if the session is still unread and not shown in a
  focused tab: never for events replayed on (re)connecting (the `hello` carries the seq
  they run to), one per session (tagged with its id, so tabs replace each other's), closed
  once the session is read; a click shows it in the agent window used last. The top
  bar's Config menu (open while pointed at, or pinned by a click) holds the app's
  switches, kept per browser (`src/ui/settings.js`): *Only prompts and responses*
  shows only prompts and responses (every reply the agent finished, not only a turn's
  last) and the agent's narration between tool calls in every agent window, hiding
  thinking and tool calls, with one "Working…" line while a turn runs;
  *Animated selection* (on) draws a drag's selection in the transcript as Google
  Docs does, whole words gliding into place (`src/omp/drag-highlight.js`), with the
  browser's own highlight hidden under it. Snapping (`src/ui/word-snap.js`) leaves a
  selection inside one word alone and takes a long token (a path, a URL) by segment.
  Below those, the daemon's own switches, the same for every browser: *Compact idle
  conversations* (on), *Review decisions* (off) and *I have ADHD* (off). With *Review
  decisions* on, every turn an agent
  hands back is read by a one-shot omp (`omp -p` on omp's `smol` role, thinking off, no tools
  or session, in a temporary directory), which reads that turn only (its prompts, the agent's
  replies, thinking and tool calls, not tool output; `@` mentions defused so it opens no file)
  and lists at most five decisions the agent took without its user, a sentence each; every
  agent window shows them where the turn ends, before the next prompt, with "Reviewing
  decisions…" while it runs, the reason if it failed, and nothing when there were none. A
  turn is named by its prompt's `timestamp`, the same live and in the journal, and reviews
  are kept per conversation in `~/.cockpit/decisions/` (`daemon/decisions.js`,
  `src/omp/decisions.js`). With *I have ADHD* on, every agent's system prompt carries the
  rules of i-have-adhd (https://github.com/ayghri/i-have-adhd, MIT; its `SKILL.md` and
  licence vendored in `daemon/i-have-adhd/`, read by `daemon/adhd.js`) after the
  workbench's own: replies lead with the next action, number steps, end on one next step,
  keep lists to five and drop preamble and closers. omp fixes a system prompt as it starts,
  so the hub puts a session started the other way to sleep as soon as it is idle (at once
  when the switch changes, at the end of the turn if it is working), and the next message
  wakes it with the rules (or without them). Last, *Agents’ browser*: where an agent's `browser`
  tool opens pages. *A separate browser* (the default) launches every omp with
  `PI_BROWSER_RELAY=0`, `PI_BROWSER_CMUX=0` and `PI_BROWSER_TERN=0`, so it uses omp's own Chrome
  for Testing with a profile of its own, never the user's Chrome tab (omp's relay adopts the
  visible one) nor the cmux window a daemon started from cmux would pass on; *Your Chrome* sets
  `PI_BROWSER_RELAY=1`; *As omp is set up* sets nothing (`daemon/browser.js`). A running
  conversation takes a change up as it does the ADHD switch: the hub compares how each omp was
  launched (`launchWith`: its prompt and environment) with how one would be now.
- The Setup window (the `setup` widget): what a machine starting afresh needs before a first
  agent, checked by the daemon whenever the window asks (`GET /api/setup`, `daemon/setup.js`):
  omp runs (`omp --version`), omp has models from a provider it is signed in to (`omp models
  --json`), `gh` is signed in (`gh api user`), and Tailscale runs here (`tailscale status
  --json`, read as Phone access reads it); then the Agents’ browser choice, Phone access (its
  step offers the switch once Tailscale runs, or while it is on) and the daemon's switches, the
  same controls as Config's (`src/ui/settings.js` exports them). Only omp and a provider hold
  Setup up. Without any provider `omp --mode rpc-ui` exits at start, so an agent window cannot
  sign in from a session of its own: **Sign in…** has the daemon run omp's terminal login, `omp
  login`, which lists providers by number, opens the provider's page in the default browser and
  finishes on its local callback (or asks for a code); its output streams to every page (`login`
  events, kept in `hello`) and the window sends what is typed as lines, one login at a time.
  Once omp and a provider check out, the daemon's `setupDone` is set; until then the first
  empty screen a page opens gets a Setup window (`src/app.js` `offerSetup`), and the palette
  opens one any time. **Start an agent** opens an agent window beside it.
- The Sessions window: every omp conversation in one list (read from omp's
  session files, with the awake session holding each, and awake ones omp has not
  written yet; `src/sessions/running.js`), with how an awake one is doing
  (starting or working: a spinner and the word in the accent; *needs you*: it asks a question or
  an approval, a warm dot; *done*: it finished and nobody has read it, a cyan dot; idle: nothing).
  Searching is Spotlight's, floating over the workbench (`src/ui/spotlight.js`: ⌘K / Ctrl+K or
  the top bar's Search; a modal dialog; ranked by `daemon/search.js` across titles, directories,
  prompts and the agents' replies, so a question in plain words finds the conversation that
  answers it, best first, with the passage that matched and its words marked; **Ask** (⌘↵) hands
  the question to an agent instead, a one-shot `omp -p` with read-only tools reading an index of
  the conversations and their journals (`daemon/ask.js`), whose answer shows above the conversations
  it names; Enter shows the
  conversation as a Sessions click does). The window's title bar holds its controls: a directory
  menu and **View** (sort order, Reverse order, Archived sessions); the list follows the
  daemon, so nothing refreshes it. A click on a conversation (or Enter) shows it in the
  agent window this screen used last (pressed or focused last), or a new one if
  there is none; dragging it onto the middle of an agent window shows it there, and
  onto the grid elsewhere opens a new agent window where it is dropped. Showing one
  starts no omp. The conversation in the agent window this screen used last has its row filled,
  and one shown in another agent window here is ringed; pointing at a row
  outlines its windows, and pointing at an agent window lights its row (`ctx.screen`,
  `ctx.outline`; `src/sessions/links.js`). Waking a journal a session already
  holds gets that session: the daemon never starts a second omp on one. A
  directory menu (every directory with sessions, A→Z, with counts) narrows a
  window to one directory, together with View's choices; like
  those, the choice is the window's own. An untitled session is listed by its first
  prompt. Row actions show on hover or focus. A fork is listed as a
  session of its own, under the title its first prompt gave it (until then, the one it copied from its source). **Archive** moves a
  session's journal and its folder out of omp's sessions into
  `~/.cockpit/archive/sessions/` at the same relative path, so neither the list nor omp's
  own resume offers it; View's **Archived sessions** lists archived sessions (the label says
  *Archived*), each with **Restore**, which moves it back and never replaces a
  file that is there now. An idle conversation's session goes to sleep before it
  moves; one whose agent works is not archived until it is done. A new session
  nothing was sent to has no journal yet: Archive ends it (`DELETE /api/sessions/:id`)
  and it is gone, not archived. Nothing is ever deleted: there is no delete. An unread conversation (archived too, which
  keeps its mark) has a cyan dot and a bold title, and the window's top bar counts the
  unread ones it lists; showing a session from here reads it. Right-click on a row, its
  **⋯** button, or Shift+F10 / the ContextMenu key on a focused row opens its menu
  (`src/ui/context-menu.js`, a popover the arrow keys move through): **Mark as
  unread** or **Mark as read**, **Pin to top** or **Unpin**, with Show and Archive /
  Restore. Pinned conversations come first, in the window's order, with a ★ (a row's ☆,
  shown on hover, pins it too).
- Scheduled prompts and the Timeline window (the `timeline` widget). Every agent has a
  `schedule` tool (`daemon/schedule.js`, given to omp as an RPC host tool): it sends its own
  conversation a prompt later, at a time (`at`, this machine's time zone unless it carries an
  offset) or after a while (`in`: `1h 30m`), and `list`s or `cancel`s what it scheduled there.
  Its description tells the agent to use it when the user asks for something later and instead
  of asking them to ping it (CI, a deploy, a review), and to ask (the `ask` tool) when a time the
  user gave is unclear rather than guess. When one comes due the daemon sends it as `Scheduled
  prompt, set <when>:` and the prompt (`daemon/deliver.js`: woken from its journal if asleep,
  after the turn if the agent works), so it runs in whatever agent window shows that
  conversation; until then that window's Scheduled line shows it. One due while the daemon was off or the Mac slept (found over a minute late) is
  missed: moved to ten minutes after the daemon found it, keeping when it was first due, so its
  user can decide whether it is still wanted; a failed delivery is tried again as late, with its
  reason kept; one for an archived conversation waits (missed once restored), and one whose
  journal is gone is dropped. They are kept in `~/.cockpit/schedule.json`; every page hears them
  (`hello`, `schedule` events). The Timeline window is laid out for a wide, short window: one
  axis along its bottom. Left of now, every idle conversation not archived, by how recently it
  was active (in order, not to scale; the latest beside now; a wheel scrolls back, older ones
  fading out at the edge); at now, a band of those whose agents are busy (starting, working,
  asking, or with work running in the background), the line alone while none is; right of now
  the scheduled prompts, each where it runs on a log scale (`src/timeline/scale.js`: the next
  hour spread out, the next month squeezed in) that reaches past the furthest, however far, by
  as much as its label needs to start at its time. Each label there says the conversation and,
  under it, when; they stack in as many lanes as the window is tall enough for, a stem down to
  their time, and past that one goes on beside the one before it, its stem bent back along the
  axis; a missed one is marked so. A label is the start of its conversation's name, and pointing
  at one shows the whole (a popover over it); a conversation with news its user has not read (a
  scheduled prompt that ran, say) is ringed in blue, as an unread window is, until it is read
  anywhere. Dragged onto the grid, a label opens its conversation as a Sessions row does; while
  one is dragged a bin shows over the axis (the drag controller's `target`), which archives the
  conversation or deletes the scheduled prompt (`DELETE /api/schedule/:id`). A click on a
  conversation shows it; on a scheduled prompt it edits its prompt and time in place (`PATCH
  /api/schedule/:id`; saved, it is no longer missed). Only a failure is written under the axis.
- Notes windows (the `scratchpad` widget): each new window starts its own pad; a switcher reopens or
  deletes any pad, and two windows (or tabs) on one pad stay in sync. Pads are
  Markdown files in `~/.cockpit/scratchpads/`; pasted or dropped
  screenshots and files are stored beside them and shown inline. Tab indents pad text
  as in the message box. An edit made
  elsewhere (the file itself, another tab) is never overwritten without asking.
- Pull request windows (the `github` widget): the agent window's **PRs** (in its title bar,
  shown while its directory is in a GitHub repository) lists the repository's pull requests; a
  click opens one on the agent window's right, dragging one places it where it is dropped. A
  pull request an agent's reply (or a pull request's own text) links, in any repository, or
  refers to as `owner/name#123` or `#123` (of the conversation's, or that pull request's,
  repository) drags out the same way, and dropped on a pull request window shows there (`src/github/pr-refs.js` finds them,
  `src/omp/markdown-dom.js` marks them, `src/github/pull-window.js` drags them; a click without
  a drag, on a link or on a `#123` whose repository is known, opens it on GitHub in a new tab); one named by its repository is read with `gh -R`, wherever it is
  checked out or not at all. A pull request window opened from the palette lists a directory's
  repository's pull requests (its latest 100) to pick one: open ones and drafts in full, each
  status in its own colour, merged and closed ones dimmed, narrowed to a status (any, open or
  draft, or one of them) and an author picked above the list, the window's own choice
  (`src/github/pull-filter.js`). Showing one, it
  shows the pull request's description and conversation, and its changes (`gh pr diff`,
  parsed in `src/github/diff.js`) with the comments on their lines. Highlighted text takes a
  **Comment** or a question (**Ask**, queued here instead of answered by `btw`), each cited by
  file and lines (or the comment it is in) and kept per pull request and browser until sent;
  **Send to agent** sends them, with a note of the reviewer's own, to the conversation the
  window was opened from (else the agent window used last) as one prompt. The daemon delivers
  it (`POST /api/deliver`, `daemon/deliver.js`): woken from its journal if asleep, queued after
  the turn (omp's `followUp`) if the agent works. **Bugbot** comments `bugbot go` on the pull
  request as the user and has the daemon watch for Cursor Bugbot's review
  (`daemon/bugbot.js`, polled every 30 s, given up after an hour, kept in
  `~/.cockpit/bugbot.json` across restarts); once posted, its findings with their places go to
  the conversation the same way, and every page shows how each request is doing. GitHub is
  reached only through the user's own `gh` (`daemon/github.js`); the tests' fake `gh` finds a
  repository named outright under `$FAKE_GH_ROOT/<owner>/<name>/`.
- File windows (the `file` widget): a text file to read and edit (Markdown, JSON, plain text,
  common code: `src/files/file-refs.js` lists the extensions), through the daemon (`GET /api/text`,
  its first 2 MiB; `PUT /api/text` saves). A path to one in an agent window's transcript (absolute, `~/`,
  relative to the conversation's directory, or a bare name; in text or alone in a code span; a
  `:42` after it names a line) is marked: a click shows it in the file window this screen used
  last, or opens one on the agent window's right, and a drag places one where it is dropped, or
  shows it in the file window it is dropped on (`src/files/file-window.js`). The window shows the
  text with line numbers, the line asked for marked and scrolled to; Markdown, and CSV and TSV
  as a table (`src/files/csv.js`, drawn as a reply's tables are, with their Copy; the first 5000
  rows), show rendered unless a line is asked for, with **Source** / **Rendered** to switch;
  **Reload** reads it again,
  as showing it again does. Opened from the palette, it asks for a path. The source view is
  editable, the rendered one is not: **Save** (Cmd/Ctrl+S) writes the file in place, and only
  then; unsaved edits are kept per path for the page's life (a window showing that file again
  brings them back; leaving the page asks first). A save names the version it was edited from:
  if the file changed since (an agent wrote it), the window asks whose text stays. Only a file
  read whole and plain UTF-8 is editable (`editable`), so a save changes no byte not edited;
  `\r\n` line ends are kept.
- Phone access (`daemon/remote.js`, the `remote` setting, **Phone access** in Config and in
  Setup): while on, a second listener on the Mac's Tailscale IPv4, at the daemon's port unless
  `--remote-port`, serves the same routes behind the whois gate (Invariants), the health check
  reading `tailscale status --json` every 30 s (Tailscale stopped: the listener stops and
  Config says why; running again, or a new address: it binds again). Config and Setup show the
  sign-in QR code (`GET /api/remote`, loopback only, drawn by `uqr`), the URL and whose devices
  get in. On the tailnet `/` goes to `/phone` (`phone.html`, `src/phone.js`,
  `styles/phone.css`): the Sessions widget, then one Agent widget full screen, with a context
  of the page's own (no grid, workspace, screens or Web Locks: plain HTTP is no secure context),
  a top bar with Back, the conversation's name, **Show work** (the per-browser *Only prompts and
  responses*, on by default there) and the Agent window's Stop and ↑ ↓; it starts no agent, and
  hides what it has no use for (New, Forks, PRs, Archive, Pin, rewind, and Copy, which
  needs a secure context). Its daemon client is scoped (`useScopedDaemon`): the stream carries
  every session's status (`session` events, and the hub's `activity` summary of each awake one:
  working, asking, work running, name) but the events of only the conversations the page
  opened, each picked up where the page left it (`?follow=<id>:<seq>`); the desktop's Sessions
  window reads the same summaries instead of following every session's events. On a touch
  screen an Agent window takes a tap for reading (it focuses nothing, so it opens no keyboard
  and wakes nothing), Enter is a new line (Send sends), and a visible, focused page counts as
  reading it; a history replayed after `subscribe` (the phone's stream reopening) counts as
  history, so an old `set_editor_text` never fills the box. JSON answers of 64 KiB or more are
  gzipped for a client that accepts it.

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

- The daemon binds `127.0.0.1`, checks every request's `Host` against an
  explicit list of loopback names (`127.0.0.1`, `localhost`, `cockpit.localhost`
  with its port; DNS rebinding; `*.localhost` is loopback in browsers per RFC 6761), requires the token cookie on every API request, and refuses any
  foreign `Origin` or cross-site `Sec-Fetch-Site`. The token is random, stored
  owner-only in `~/.cockpit/token`, and reaches the browser once through
  the URL the daemon prints (it becomes an HttpOnly, SameSite=Strict cookie).
  Without this, any web page open in the user's browser can reach the daemon and
  run commands on the machine. `tests/daemon.test.js` guards each check.
- While Phone access is on, the daemon also binds the Mac's Tailscale IPv4 (never
  `0.0.0.0`), and before anything else asks `tailscale whois` who each connection
  comes from: only a device signed in as the Mac's owner, and not a tagged one, is
  answered at all (a failed or slow lookup refuses). Behind that gate the same guard
  applies, with the tailnet names (the IPv4 and the MagicDNS name) in place of the
  loopback ones, and the token cookie still required; over plain HTTP the browser sends
  no `Sec-Fetch-*`, so the cookie's SameSite=Strict and the `Origin` checks carry
  cross-site refusal there. The QR code carrying the token is served on loopback only.
  A tailnet's other users can reach the Mac's ports: the gate, not the network, keeps
  them out.
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
  - `mermaid`, `vega` and `vega-lite` (diagrams and charts agents write as fenced
    blocks, `src/omp/visuals.js`): their UMD builds are served at `/vendor/…` and
    loaded as classic scripts only when a reply first holds one.
  - `uqr` (QR codes): the daemon draws Phone access's sign-in QR code as an SVG
    (`daemon/remote.js`); the browser never loads it.
- omp is not a dependency: the user installs it on its own (https://omp.sh) and
  the daemon runs the `omp` on PATH. The version the fake omp in `tests/` was
  recorded from is in `RISKS.md`; a newer installed omp means re-recording frames. GitHub's
  CLI `gh` (https://cli.github.com) is not one either: the daemon runs the `gh` on PATH, signed
  in as the user, and the tests drive `tests/fixtures/fake-gh.js` instead.
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
  `--omp <path>` (or `COCKPIT_OMP`), `--gh <path>` (or `COCKPIT_GH`), `--cwd <dir>` (or `COCKPIT_CWD`: the
  directory a new agent window suggests, home by default) and `COCKPIT_STATE_DIR`
  override the defaults; `COCKPIT_IDLE_COMPACT_MIN_TOKENS` sets idle compaction's
  threshold (at least 100K), `COCKPIT_BUGBOT_POLL_MS` how often a Bugbot review is looked for;
  `--tailscale <path>` (or `COCKPIT_TAILSCALE`) and `--remote-port <n>` (or
  `COCKPIT_REMOTE_PORT`, the `--port` by default) are Phone access's (Setup checks the same
  `tailscale`). Tests, the e2e daemons included, drive `tests/fixtures/fake-tailscale.js`, never
  the real `tailscale`.
- Before committing, all of these must pass. CI (`.github/workflows/ci.yml`, on every push to
  `main` and every PR) runs all but the browser tests, which run only here:
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
- `src/files/csv.js` — CSV and TSV as the file window (widgets/file.js) renders them: a table, drawn as an agent reply's Markdown tables are (omp/markdown-dom.js `renderTable`), so it looks and copies the same.
- `src/files/file-refs.js` — Text files named in text the workbench shows (an agent's reply): which files the file window (widgets/file.js) shows, by extension (Markdown, JSON, plain text and common code), and the paths of such files in a run of text or a code span, with the line a `:42` after one names, kept free of the DOM so they can be tested.
- `src/files/file-window.js` — Opening a file window (widgets/file.js) from text that names a text file (marked by omp/markdown-dom.js): a click opens it in the file window this screen used last, or beside the window clicked in if there is none; a drag places a new one where it is dropped, or shows it in the file window it is dropped on.
- `src/github/bugbot.js` — Cursor Bugbot's reviews, read from GitHub as the daemon's watcher (daemon/bugbot.js) finds them, and told to the agent: which review answers a `bugbot go` comment, and its findings as one message, kept free of I/O so they can be tested.
- `src/github/diff.js` — A pull request's changes as the pull request window shows them: `gh pr diff`'s unified diff parsed into files, their hunks and each line with its numbers in the old and the new file, kept free of the DOM so it can be tested.
- `src/github/pr-mention.js` — `#` pull request mentions typed in the agent pane's message box: the one the caret ends, the pull requests and repositories that match what is typed, and the text that completes it, kept free of the DOM so they can be tested.
- `src/github/pr-refs.js` — Pull requests named in text the workbench shows (an agent's reply, a pull request's description): a link to one on GitHub (`https://github.com/owner/repo/pull/123`, any page of it), or GitHub's own references, `owner/repo#123`, and `#123`, which names a pull request of the repository the text is about.
- `src/github/pull-filter.js` — Narrowing the pull request window's list of a repository's pull requests: each one's status (a draft is its own, not an open one), the statuses and authors it can be narrowed to, and which pull requests a choice of them keeps, kept free of the DOM so they can be tested.
- `src/github/pull-window.js` — Opening a pull request window (widgets/github.js) from another window: the params that name the pull request and the conversation it is reviewed for, and dragging one out of text, where a pull request is linked or referred to as `owner/name#123` or `#123` (marked by omp/markdown-dom.js): dropped on the grid it opens a pull request window there, dropped on a pull request window it shows there.
- `src/github/review.js` — A review written in the pull request window, for its agent: comments and questions on highlighted parts of the pull request, and a note of the reviewer's own, sent to the agent's conversation as one message.
- `src/github/text.js` — GitHub comment bodies as text to read: GitHub Markdown may hold HTML (bots write comments, tags and buttons into theirs), which the workbench never renders, so it is taken out and its words kept.
- `src/interaction/drag-controller.js` — Pointer-driven drag & drop for moving widgets and adding new ones.
- `src/interaction/sash-controller.js` — Sash (divider) resizing with magnetic detents.
- `src/layout/compute-layout.js` — Turns a split tree into absolute pixel rects for leaves and sashes.
- `src/layout/drop-zone.js` — Drop-zone hit testing.
- `src/layout/grid-model.js` — Split-tree layout model (same shape as VS Code's GridView).
- `src/layout/neighbors.js` — Geometric neighbour lookup for keyboard moves (Alt+Shift+Arrow).
- `src/layout/snap.js` — Magnetic sash behaviour: detents pull the sash onto aligned positions, then minimum sizes clamp the result.
- `src/main.js` — Bootstrap: starts the app and shows a visible error if it cannot.
- `src/omp/activity.js` — Which omp events make a session "unread": the agent's final response, when it hands the turn back to the user, or a question it stops to ask them.
- `src/omp/code-copy.js` — A fenced code block as rendered Markdown shows it, with a Copy button in its top-right corner that copies the code itself (the fence's contents, not its language label).
- `src/omp/cold.js` — When an agent window dims: its conversation has been quiet past the point at which idle compaction (daemon/idle-compaction.js) compacts a long one, 54 minutes after the last model request, so its prompt cache is about to expire and the next message reads the conversation in full.
- `src/omp/composer.js` — The agent pane's message box: a draft that starts one line high and grows with its text up to half the pane, cards for what goes with the next message (comments on quoted transcript text, files), and the Send button.
- `src/omp/decisions.js` — Decisions an agent took without its user: what of a turn the reviewer reads, what it is asked and how its answer becomes at most five one-sentence decisions, and where each review shows in the transcript, kept free of the DOM and of I/O so they can be tested (the daemon runs the reviewer: daemon/decisions.js).
- `src/omp/dialogs-view.js` — Inline dialogs for omp's extension UI requests (select, confirm, input, editor, ask); each one answers through a single `respond(payload)` call.
- `src/omp/drafts.js` — Unsent messages, one per conversation: what is in an agent window's message box (its text, and its comment and file cards) waits while the window shows another conversation, or the page reloads, and is back when the conversation is shown again (in any window of this browser).
- `src/omp/drag-highlight.js` — The omp transcript's selection highlight, drawn as in Google Docs: while the pointer drags, it already covers whole words (ui/word-snap.js) and its edges glide from word to word.
- `src/omp/event-log.js` — What of a session's events a later window still needs, so the daemon's log and a page's buffers stay about as long as the conversation instead of growing with every token streamed: a message's deltas go once `message_end` carries it whole, a tool's progress once `tool_execution_end` carries its result, and a session's events once it has ended (windows then read the conversation from its journal), bar the event saying how it ended.
- `src/omp/file-mention.js` — Paths typed in the agent pane, as `@` file mentions in its draft or plainly in its Directory field: the path being typed at the caret, the folder entries that match it, and the text that completes it, kept free of the DOM so they can be tested.
- `src/omp/file-suggest.js` — Path suggestions in the agent pane's text boxes (`@` file mentions in its draft, its dialogs' answers and its comments and questions on reply text; its Directory field): while the caret ends a path, the suggestion list shows the matching entries of the folder it names, and Tab, Enter or a click completes the path (see `file-mention.js`).
- `src/omp/fork-family.js` — Reads the daemon's fork registry (daemon/forks.js: each fork's omp id → the conversation it was forked from, and its title) for one conversation: what it was forked from and its own forks, which the agent pane's Forks menu lists, and the family it belongs to, which colours the windows of related conversations alike.
- `src/omp/items-view.js` — DOM for one transcript item of the agent pane (messages, tool cards, shell runs, notes, unrecognised frames), and for a turn's decision review, built from text nodes only.
- `src/omp/markdown-dom.js` — Renders the safe markdown tree from `markdown.js` as DOM nodes (text nodes only, never HTML).
- `src/omp/markdown.js` — Safe markdown subset for agent text: parses into a small block/inline tree, never HTML.
- `src/omp/message.js` — Builds what the agent pane sends from what the user wrote: the prompt (comments on quoted parts of earlier replies, the draft, then files), `!` shell commands, `/fork <prompt>` (a prompt for a new fork of the conversation), and side questions about a quote.
- `src/omp/pr-suggest.js` — Pull request suggestions in the agent pane's message box: while the caret ends a `#` mention and the conversation's directory is in a GitHub repository, the suggestion list shows the pull requests it names, each with its title, and Tab, Enter or a click completes it as GitHub writes it (see `github/pr-mention.js`).
- `src/omp/prompt-history.js` — Up and Down in the agent pane's message box step through what was sent in its conversation, as omp's own editor and a shell do: the user's prompts and `!` commands, newest first.
- `src/omp/recent-dirs.js` — The directories an agent window's setup screen offers to start in: those of the user's conversations, most recently active first, so the few repositories they work in are a click away instead of typed again; kept free of the DOM so they can be tested.
- `src/omp/response-nav.js` — Where an agent pane's previous/next response buttons (⌘↑ / ⌘↓) scroll its transcript: the arithmetic, kept apart from the DOM.
- `src/omp/rewind.js` — Rewinding an omp conversation to one of the user's prompts, as omp's `/branch` does: what the rewind sets aside, and which of omp's entries the prompt is.
- `src/omp/running-work.js` — What an agent has running now, for the agent window's Running line and the Sessions list: the shells and subagents its turn is waiting on, and its background jobs (omp/transcript.js `jobs`), which go on after their tool call has returned, even once the turn has ended.
- `src/omp/selection-popup.js` — Actions on highlighted transcript text: select part of a reply and Comment and Ask buttons appear at the end of the selection.
- `src/omp/suggestions.js` — The suggestion list above the agent pane's message box (slash commands, `@` file entries), driven from the draft's keys so focus never leaves it.
- `src/omp/table-copy.js` — Copy control for a rendered Markdown table: a button whose menu copies the table as Markdown, CSV or a PNG image.
- `src/omp/table-text.js` — Plain-text forms of a parsed Markdown table: a cell's text without its formatting, and the table as CSV.
- `src/omp/todos.js` — How far along the agent is, from the todo list omp agents keep with their `todo` tool: how many of its tasks are done and which one it is on.
- `src/omp/transcript.js` — Transcript reducer for one omp session: folds the daemon's SessionEvents into display items plus derived session state, with no DOM.
- `src/omp/visibility.js` — Which transcript items an agent pane shows when it is set to only prompts and responses: what the user said and ran, and what the agent finally answered, without the work in between.
- `src/omp/visuals.js` — Diagrams and charts in agent replies: a closed ```mermaid fence is drawn by Mermaid, a closed ```vega-lite fence (a Vega-Lite spec, JSON) by Vega.
- `src/phone.js` — The phone page (`/phone`, phone.html): the Sessions list, then one conversation full screen, then Back, for a phone reaching the daemon over its owner's tailnet (daemon/remote.js).
- `src/render/drop-indicator.js` — Landing preview for drag & drop, plus the sash snap guide.
- `src/render/grid-renderer.js` — Imperative, diffed DOM writer for the grid.
- `src/scratchpad/blocks.js` — A scratchpad's text as blocks to edit: runs of text, and the images and files it references, kept free of the DOM so the round trip can be tested.
- `src/scratchpad/store.js` — The page's copy of one scratchpad: every window in the page showing that pad edits this one object, so they agree as you type; it saves to the daemon after a pause and follows what other pages save.
- `src/sessions/links.js` — Which agent windows of this screen show which conversations, so the Sessions window can mark its rows and point at their windows.
- `src/sessions/notify.js` — Desktop notifications when an agent is done or needs its user, so a session can be left running while the user is elsewhere: the moments that mark a conversation unread (omp/activity.js), as they happen.
- `src/sessions/order.js` — Sorting and labels for the Sessions window, kept free of the DOM so they can be tested.
- `src/sessions/running.js` — Conversations as the Sessions window lists them, kept free of the DOM so they can be tested: every journal with the session holding it while one is awake, how each is doing, and what an agent window is given to show one.
- `src/sessions/snippet.js` — The passage a search matched, as a line of DOM, shared by the Sessions window and Spotlight.
- `src/state/atom.js` — Tiny observable cell: get/set/subscribe.
- `src/timeline/scale.js` — The timeline window's arithmetic, kept free of the DOM so it can be tested: where a moment in the future sits on its log scale (the next hour spread out, next month squeezed in), how far ahead the scale reaches, the times its axis marks, how labels share lanes without covering one another, and how long until a scheduled prompt runs, and when, said briefly (the daemon's schedule tool says it the same way).
- `src/ui/autosize.js` — Grows a textarea to fit its text, up to a maximum height, after which it scrolls.
- `src/ui/click-focus.js` — Click-to-focus, as in a terminal: a plain click on a window's own surface puts the caret at the end of its main text box, while clicks on controls, in boxes of their own, and those that end a text selection do what they did before.
- `src/ui/context-menu.js` — A small menu of actions on one thing, as a right-click, the ContextMenu key, Shift+F10 or a ⋯ button opens it: a native popover at the pointer or beside the control, whose items the arrow keys move between; Enter or a click runs one, and Esc or a click elsewhere closes it.
- `src/ui/dom.js` — Element construction helpers: elements, buttons that never submit a form, text that keeps a selection, and file-drag checks.
- `src/ui/format.js` — Text formatters shared across the UI: error messages, home-relative paths and JSON dumps, with no DOM.
- `src/ui/indent.js` — Tab and Shift+Tab indent and outdent text in a textarea, as in a code editor, and Backspace in a line's leading spaces takes a whole indent back; Esc then Tab leaves the field instead, so keyboard users are never trapped in it.
- `src/ui/login.js` — Signing omp in to a model provider, or another account, without a conversation: `omp login`, run by the daemon (daemon/setup.js) and shown as it goes, its questions answered from a line here.
- `src/ui/palette.js` — "Add widget" palette.
- `src/ui/prefs.js` — Per-browser preferences in localStorage.
- `src/ui/screen-switcher.js` — The screen switcher in the top bar: which screen of its workspace this window shows, and a menu of every screen, with what it holds and where it is open, to open one here or delete it, or to open a copy of this one in a new tab.
- `src/ui/settings.js` — App-wide settings, picked in the top bar's Config menu and kept per browser.
- `src/ui/spotlight.js` — Spotlight: a floating search over every conversation, as macOS's.
- `src/ui/update-notice.js` — The "updated, reload" notice in the top bar: a Reload button among the top bar's own, shown while the daemon serves other UI files than this page loaded (see daemon/ui-files.js), so a tab left open never runs stale code unknowingly.
- `src/ui/word-snap.js` — Grows a selection out to whole words once it spans more than one, as Google Docs does, so a rough drag still quotes clean text, while a selection inside one word stays exactly as made.
- `src/ui/zoom.js` — Text size for the whole app, picked in the top bar (− 100% +; the percentage resets it) and kept per browser.
- `src/widgets/file.js` — A text file to read, and edit, beside the agents: Markdown, CSV, JSON, plain text or code (files/file-refs.js), through the daemon (`/api/text`).
- `src/widgets/github.js` — A GitHub pull request to review beside the agent that works on it: its description and conversation, and its changes with the comments on their lines.
- `src/widgets/omp.js` — The agent pane: a conversation with an omp coding agent in a chosen directory, through the daemon, rendered from omp's structured event stream.
- `src/widgets/pane.js` — An empty window: the frame every real widget is mounted into, with nothing inside.
- `src/widgets/registry.js` — Widgets the palette can add, keyed by type.
- `src/widgets/scratchpad.js` — Notes beside the agents: text with screenshots and files in it.
- `src/widgets/sessions.js` — omp conversations, one list, sortable and narrowed to a directory.
- `src/widgets/setup.js` — Setup: what this machine needs before a first agent can start, and the choices worth making first, in one window: omp installed, a model provider signed in (omp's own `omp login`, run by the daemon and shown here as it goes: daemon/setup.js), which browser agents drive, GitHub's CLI for pull request windows, the phone (optional: Phone access over Tailscale, offered once Tailscale runs here) and the daemon's switches.
- `src/widgets/timeline.js` — A timeline of the agents: on its left, idle conversations by how recently they were active (in order, not to scale), the latest beside now; at now, those whose agents are busy (starting, working, asking their user something, or running work in the background); on its right, the prompts agents scheduled for their conversations (daemon/schedule.js), each where it runs, on a log scale (timeline/scale.js) that reaches as far as the furthest one: the next hour spread out, the next month squeezed in.
- `src/workspace/model.js` — Workspaces and their screens, kept free of the DOM and shared with the daemon: valid names and ids, which screen a new window claims, and how a screen is described.
- `src/workspace/screen.js` — This window's screen of its workspace: claimed for as long as the window is open, loaded from the daemon, and saved back as its layout changes.
- `daemon/adhd.js` — "I have ADHD" (the Config menu's switch, settings.js `adhd`): agents shape every reply for a reader with ADHD, by the rules of i-have-adhd (https://github.com/ayghri/i-have-adhd, MIT): the next action first, steps numbered, the state restated, one concrete next step at the end, lists of five at most, no preamble, recap or closer.
- `daemon/ask.js` — Asking an agent where something was said: Spotlight's Ask (src/ui/spotlight.js) hands a question in plain words to a one-shot omp that reads the user's conversations and answers it, naming the conversations that do.
- `daemon/attachments.js` — Files attached to omp prompts: stored where omp can read them, one folder per day, so a prompt can mention them as `@"<path>"` and omp attaches them itself (images to the model, text inlined; see omp's file mentions).
- `daemon/browser.js` — Which browser agents drive (settings.js `browser`, picked in Setup or Config): a separate one of omp's own by default, so an agent testing a page never takes over the tab its user is reading.
- `daemon/bugbot.js` — Bugbot reviews asked for from the pull request window: `bugbot go` is commented on the pull request as the user, and the daemon watches it until Cursor Bugbot's review answers (src/github/bugbot.js), then sends the review, every finding with where it is, to the conversation the window reviews for (deliver.js).
- `daemon/clock.js` — The daemon's clock for the times it stamps on events and unread marks: Date.now, but never the same value twice and never earlier than the last, so any two stamps are ordered, even within one millisecond.
- `daemon/conversation.js` — A conversation read from its journal, for a window to show while no omp process holds it: the messages omp's `get_messages` would answer with once resumed, so the transcript seeds from either the same way, and what the journal records about the session around them.
- `daemon/decisions.js` — Decision reviews: once the user turns them on in Config, every turn an agent hands back is read by a small model, which lists the decisions the agent took without its user (at most five, a sentence each; src/omp/decisions.js), so none goes by unnoticed.
- `daemon/deliver.js` — Sends a message to a conversation from outside its agent window (the pull request window's review, a Bugbot review): as a prompt to the session holding it, woken from its journal first if it is asleep, as the agent window itself would (`omp --resume`).
- `daemon/files.js` — Folder listings for path suggestions (the agent pane's `@` file mentions, its Directory field): each entry's name and whether it is a folder (a link to one counts), capped so a huge folder cannot flood the page; how a typed path is read; and the text files the file window shows (src/files/file-refs.js), capped too, and saves when edited.
- `daemon/fork-title.js` — A fork's own title: omp copies the title of the conversation it forks, and its title model names a conversation from its opening request, so left to omp a fork keeps its source's name and two windows read the same.
- `daemon/forks.js` — Forks: conversations the workbench started from a copy of another (omp's `--fork`), which one each came from, and their own titles.
- `daemon/frame-decoder.js` — Decodes omp's stdout: newline-delimited JSON frames, with protocol-v2 `rpc_chunk` sequences reassembled into the one frame they carry.
- `daemon/github.js` — GitHub, through the user's own `gh` CLI (https://cli.github.com), signed in as they are: the pull requests of a repository, the repositories of a directory's repository's owner (for `#` mentions of another one), one pull request to review (its conversation, line comments and diff), a comment on one, and Bugbot's reviews of one (src/github/bugbot.js).
- `daemon/guard.js` — Request guard: decides which requests may reach the daemon, on each of its listeners (CLAUDE.md, Invariants).
- `daemon/history.js` — Past omp sessions, read from omp's session files: one summary per conversation, searchable (search.js, ranked) by title, directory, what the user asked and what the agent answered.
- `daemon/hub.js` — The daemon's omp sessions and the single ordered event log the browser replays.
- `daemon/idle-compaction.js` — Idle compaction, as Claude Code does it: a long conversation left idle is compacted shortly before its prompt cache expires, while the summary request can still read the conversation from the cache, so coming back later sends a summary instead of the whole conversation at full price.
- `daemon/main.js` — Daemon entry point (`bun start`): serves the workbench on loopback (and, with Phone access on, to the owner's tailnet devices: remote.js) and runs the omp processes it shows.
- `daemon/omp-session.js` — One omp process in RPC mode: launch, protocol setup, command/response correlation and lifecycle, with everything it does reported as session events.
- `daemon/pins.js` — Which omp conversations the user pinned to the top of the Sessions list: kept in one small file in the state directory, so a pin outlives windows, browsers, daemon restarts and the session itself.
- `daemon/remote.js` — Phone access (settings.js `remote`): while it is on, the daemon also serves the owner's own devices on their tailnet, through a second listener bound to the Mac's Tailscale IPv4 with the same routes as loopback (server.js), behind a whois gate.
- `daemon/schedule.js` — Scheduled prompts: an agent sends its own conversation a prompt later, at a set time or after a while, through the `schedule` tool the daemon gives every omp it launches (omp's RPC host tools: omp-session.js `HostTools`).
- `daemon/scratchpad.js` — Scratchpads: plain Markdown files the daemon keeps, one per pad, with pasted screenshots and files stored beside them.
- `daemon/search.js` — Ranked search over conversations: a question in plain words ("in which session did we find that Binance bundle exclusivity dropped…") finds the conversations that talk about it.
- `daemon/server.js` — HTTP face of the daemon: the workbench's static files, the JSON API and the event stream (routes in `wire.js`), the same on each listener: loopback, and the remote one Phone access opens on the tailnet (remote.js), whose whois gate runs before anything else; then the guard of the listener's names (guard.js) on all of them.
- `daemon/settings.js` — The daemon's settings: what the daemon does, so every page sees and changes the same ones (a page's own look is kept per browser: src/ui/settings.js).
- `daemon/setup.js` — Setup (the Setup window, src/widgets/setup.js): what this machine needs before a first agent can start, and what Phone access would need, checked whenever the window asks, and omp's own `omp login` run for the window, so a model provider can be signed in to from the browser.
- `daemon/sleep.js` — When the daemon puts a session to sleep: ends its omp process, as nobody needs it running.
- `daemon/state-file.js` — A value the daemon keeps in one small JSON file in the state directory (unread marks, pins, settings): read once as the daemon starts, written whole after every change (write-then-rename, one write at a time, so a crash mid-write leaves the old value, never half of the new one), and every change heard by its subscribers.
- `daemon/token.js` — The daemon's access token: random, created once, kept owner-only in the state directory so a browser stays signed in across daemon restarts.
- `daemon/ui-files.js` — The files that make up the browser UI: which ones the daemon serves, and a version that changes whenever any of them does, so an open page can tell it is running older code.
- `daemon/unread.js` — Which omp conversations have news their user has not read: kept in one small file in the state directory, so a mark outlives windows, browsers, daemon restarts and the session itself (a stopped session is a past one, still unread).
- `daemon/wire.js` — Wire contract between the daemon and the browser: session metadata, stream events and HTTP payloads.
- `daemon/workspace.js` — Workspaces: the screens of each one (a layout tree per browser window), kept by the daemon so a layout outlives a browser profile and an address change.

### Registered widgets

- `pane` — Pane: An empty window
- `omp` — Agent: Chat with a coding agent in a directory
- `sessions` — Sessions: Agent conversations: click or drag one to show it in an agent window
- `timeline` — Timeline: Agents by when they were last active, and the prompts they scheduled: drag one out to open it, or onto the bin to archive or delete
- `scratchpad` — Notes: Notes with screenshots and files; each new window starts a fresh page
- `github` — Pull request: Review a GitHub pull request beside its agent: comment, ask, and send it all back
- `file` — File: Read and edit a text file (Markdown, CSV, JSON, text, code); a path in an agent’s reply opens one with a click
- `setup` — Setup: What Cockpit needs on this machine (omp, a model sign-in, GitHub) and which browser agents use

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

`tests/atom.test.js`, `tests/clock.test.js`, `tests/compute-layout.test.js`, `tests/conversation.test.js`, `tests/csv.test.js`, `tests/daemon-client.test.js`, `tests/daemon.test.js`, `tests/drafts.test.js`, `tests/drag-highlight.test.js`, `tests/drop-zone.test.js`, `tests/file-mention.test.js`, `tests/file-refs.test.js`, `tests/forks.test.js`, `tests/frame-decoder.test.js`, `tests/github.test.js`, `tests/grid-model.test.js`, `tests/history.test.js`, `tests/idle-compaction.test.js`, `tests/indent.test.js`, `tests/markdown.test.js`, `tests/neighbors.test.js`, `tests/omp-activity.test.js`, `tests/omp-cold.test.js`, `tests/omp-decisions.test.js`, `tests/omp-event-log.test.js`, `tests/omp-message.test.js`, `tests/omp-recent-dirs.test.js`, `tests/omp-response-nav.test.js`, `tests/omp-rewind.test.js`, `tests/omp-running-work.test.js`, `tests/omp-transcript.test.js`, `tests/omp-visibility.test.js`, `tests/prompt-history.test.js`, `tests/pull-filter.test.js`, `tests/remote.test.js`, `tests/schedule.test.js`, `tests/scratchpad-blocks.test.js`, `tests/scratchpad-store.test.js`, `tests/scratchpad.test.js`, `tests/search.test.js`, `tests/sessions-links.test.js`, `tests/sessions-notify.test.js`, `tests/sessions-order.test.js`, `tests/sessions-running.test.js`, `tests/settings.test.js`, `tests/sleep.test.js`, `tests/snap.test.js`, `tests/table-text.test.js`, `tests/timeline-scale.test.js`, `tests/todos.test.js`, `tests/ui-files.test.js`, `tests/unread.test.js`, `tests/visuals.test.js`, `tests/word-snap.test.js`, `tests/workspace-model.test.js`, `tests/workspace.test.js`, `tests/zoom.test.js`, `e2e/adhd.spec.js`, `e2e/decisions.spec.js`, `e2e/file.spec.js`, `e2e/github.spec.js`, `e2e/grid.spec.js`, `e2e/idle-compaction.spec.js`, `e2e/notify.spec.js`, `e2e/omp.spec.js`, `e2e/phone-access.spec.js`, `e2e/phone.spec.js`, `e2e/scratchpad.spec.js`, `e2e/screens.spec.js`, `e2e/sessions.spec.js`, `e2e/setup.spec.js`, `e2e/sleep.spec.js`, `e2e/timeline.spec.js`, `e2e/unread.spec.js`, `e2e/update-notice.spec.js`

<!-- END GENERATED -->
