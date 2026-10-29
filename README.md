# Cockpit

**A modular, in-browser workbench for coding agents.**

Cockpit runs coding agents from a local daemon and shows them in your browser;
each Agent window runs [omp](https://omp.sh). Everything is a window: chats,
past sessions and notes are widgets you drag, split, stack and resize on a snapping grid,
as many as you like, side by side.

| Window | What it does |
| --- | --- |
| **Agent** | Chat with an agent in a directory: streamed replies with tables, math, diagrams (Mermaid), charts (Vega-Lite) and images (the agent is asked to say what it's doing as it goes, as in Claude Code, and told visuals are welcome and how to add them; this takes the place of any `APPEND_SYSTEM.md` you have for omp), tool calls, model and thinking level, slash commands, approvals and questions, steer or stop. The window's top bar shows the conversation's title (generated during the first turn, or set with `/rename`; its first prompt until then), and the toolbar how far the agent is through its todo list while it works. The shells and subagents running now, background ones included, show above the message box with how long each has run, and Sessions counts them per conversation. A message you've typed but not sent, with its comments and attached files, stays with its conversation: show another one in the window, or reload, and it's there when you come back. **Up** / **Down** in an empty message box recall earlier prompts, as in a shell. Start a line with `!` to run it as a shell command in the session's directory, even while the agent works (the message box turns into a shell line). Comment on or **Ask** about selected reply text (a rough selection spanning words snaps to whole ones, a path by segment; short answers, with follow-up questions, kept out of the chat); paste screenshots or drop files to attach them, or type `@` to mention files from the session's directory (`@src/`, `@../`, `@~/`; Tab completes). Copy a reply's table as Markdown, CSV or an image (**Copy**, on hover). **Rewind** (on hover over one of your prompts) puts it back in the message box to reword, dimming what sending would set aside; **Undo** or Esc puts everything back, and sending rewinds the conversation to just before it (omp goes on in a new journal; the one before, holding what was set aside, is archived). A window shows one conversation at a time, and any conversation is always there to open and carry on: idle and unused for a while, its omp goes to sleep, and the next message wakes it (a moment's "waking…"), so there is nothing to start or stop. **New**, **Fork**, **Accounts** and **Stop** sit in the window's title bar: **New** starts another conversation there (the one before carries on; once you pick its folder, the message box is ready to type in), **Fork** continues a copy of this one in a new window (its first prompt gives it a title of its own), **Accounts** connects a model provider or another account, and **Stop** stops the agent's turn. **Sign in** shows in the toolbar while the conversation's model has no account to use. Drag **Send** onto the grid to send the message in a fork instead, placed where you drop it. |
| **Sessions** | Every agent conversation in one list, most recently active first, with how each is doing while its agent is at it (working, *done*, or *needs you* while it asks something); searchable (type words or ask a question in plain words, such as "where did we find that bundle exclusivity dropped?": conversations are ranked by their prompts and the agents' replies, each with the passage that matched), sortable and narrowed to one directory if wanted. A bar at a row's left edge shows which are in an agent window (brighter for the one you used last), and hovering a row outlines its window (hovering an agent window lights its row). Click a conversation to show it in the agent window you used last (or a new one), drag it onto an agent window to show it there, or onto the grid to open it in a new window. **Archive** moves one out of omp's sessions into `~/.cockpit/archive/` (omp's own resume no longer offers it), or, for a new one nothing was sent to, simply ends it; **Archived** lists those, and **Restore** puts one back. Unread conversations (archived too) have a blue dot and a bold title, and the window's top bar counts them; right-click a row (or its **⋯**, or Shift+F10) to **Mark as unread** or **Mark as read**, or **Pin to top** to keep a conversation above the rest (in every window; the ☆ on a hovered row does the same, and ★ unpins). |
| **Notes** | Markdown notes with inline screenshots and files, stored in `~/.cockpit/scratchpads/`. |

A pane whose agent finished or asks something while you looked away gets a blue
border, and its session stays unread (in every window, across reloads and daemon
restarts, after it stops) until you hover, scroll, click or type in a window
showing it, or show it from Sessions. The marks are kept in `~/.cockpit/unread.json`. Turn
on **Notify** in the top bar for a desktop notification as well, while you are not looking at
that session; clicking it shows the session. When the workbench's files change under an open tab, the top bar offers
**Reload**. **Config** in the top bar (it opens as you point at it) holds the app's switches, kept per browser: *Only prompts and responses* hides the work in between (thinking and tool calls, keeping what the agent says as it works) in every agent window, and *Animated selection* (on) highlights whole words while you drag over a reply, gliding between them as in Google Docs. **− 100% +** in the top bar sets the text size (the percentage resets it), kept per
browser.

**Screens.** Each browser window is a screen of your workspace, like an extra
monitor: open a second window and it starts empty, with its own panes. Layouts
are kept by the daemon (`~/.cockpit/workspaces/`), so they survive a browser
restart: windows opened again get their screens back, and a reload keeps the
window's screen. The switcher in the top bar (**Screen 2 of 3**) lists every
screen and what it holds; a screen open in no window can be opened in this one
(**Open here**, without stopping its agents) or deleted (its agents keep running too). Add
`?workspace=<name>` to the address for a separate workspace (lowercase letters,
digits and dashes; the default is `main`). Windows at two different addresses at
once (say `127.0.0.1` and `localhost`) do not see which screens the other has
open.

## Install

You need two programs:

- **omp**, a standalone program installed on its own. It is **not** a
  dependency of this repo; the daemon runs the `omp` on your `PATH`.

  ```bash
  curl -fsSL https://omp.sh/install | sh   # or: brew install can1357/tap/omp
  ```

- **[Bun](https://bun.sh)** 1.3.14 or later, which runs the daemon and tests.

  ```bash
  curl -fsSL https://bun.sh/install | bash
  ```

## Quick start

```bash
bun install   # dev tools and git hooks
bun start     # daemon on http://cockpit.localhost:4777
```

1. Open the URL `bun start` prints **once**. It carries an access token, which
   the browser keeps as a cookie. Cookies and browser storage belong to one
   address, so the first visit at a new one (say `cockpit.localhost` after
   `127.0.0.1`, which still works) needs that printed URL once more.
2. **＋ Widget → Agent**, pick a directory (folders are suggested as you type, from
   your home folder; Tab completes), start chatting.
3. To connect a model provider (Anthropic/Claude, for example), press
   **Accounts** in the window's title bar (omp's `/login`).

The daemon listens on loopback only and refuses requests from other sites.

| Option | Default |
| --- | --- |
| `--port <n>` / `COCKPIT_PORT` | `4777` |
| `--omp <path>` / `COCKPIT_OMP` | `omp` on `PATH` |
| `--cwd <dir>` / `COCKPIT_CWD` (the directory a new agent window suggests) | your home directory |
| `COCKPIT_STATE_DIR` (token, notes, attachments, workspaces) | `~/.cockpit` |
| `COCKPIT_OMP_SESSIONS` (omp's session files) | `~/.omp/agent/sessions` |

Pass flags through with `bun start --port 4800 --cwd ~/code/app`.

## Develop

```bash
bunx playwright install chromium   # once per machine
bun run typecheck                  # tsc over JSDoc types
bun run test                       # unit suites + daemon against a fake omp
bun run test:e2e                   # Playwright: real app and daemon in Chromium
bun run claude-md:check            # generated part of CLAUDE.md is current
```

No build step: the UI is plain ES modules. Its runtime dependencies are Temml,
which turns agents' TeX math into MathML the browser typesets, and Mermaid, Vega
and Vega-Lite, which draw the diagrams and charts agents write (loaded only when a
reply has one). CI runs all four
checks on every push to `main` and every pull request.

- [`CLAUDE.md`](CLAUDE.md): architecture, conventions, how to add a widget.
- [`RISKS.md`](RISKS.md): deferred risks and when they bite.
