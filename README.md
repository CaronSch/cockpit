# Cockpit

**A modular, in-browser workbench for coding agents.**

Cockpit runs coding agents from a local daemon and shows them in your browser;
each Agent window runs [omp](https://omp.sh). Everything is a window: chats,
past sessions, notes, pull requests and files are widgets you drag, split, stack and resize on a snapping grid,
as many as you like, side by side.

![Cockpit: an agent adds due dates to a small todo CLI; under its reply, the five decisions it took without asking; beside it, todo.js opened from a path in the reply](docs/screenshot.png)

| Window | What it does |
| --- | --- |
| **Agent** | Chat with an omp agent in a directory: streamed replies with tables, math, Mermaid diagrams, Vega-Lite charts and images; tool calls, approvals and questions; model, thinking level and slash commands; steer, stop, rewind or fork. Shows its todo progress and what it has running. `@` mentions files, `#` pull requests, `!` runs a shell command; select reply text to comment on it or **Ask** about it. **↑** / **↓** in the title bar (**⌘↑** / **⌘↓**, Ctrl elsewhere) jump to the agent's previous or next reply. With *Review decisions* on, each turn lists up to five decisions the agent took without you. Paths and pull requests in replies open with a click or drag out as windows. |
| **Sessions** | Every conversation in one list, with how each is doing (working, *done*, *needs you*); search in plain words, sort, narrow to a directory. Click or drag one into an agent window; archive, restore, pin or mark unread. |
| **Spotlight** | **⌘K** (Ctrl+K) anywhere: the same search, floating; Enter shows the conversation. |
| **Notes** | Markdown notes with inline screenshots and files, kept in `~/.cockpit/scratchpads/`. |
| **Pull request** | A GitHub pull request beside its agent: description, conversation and diff with line comments. Comment on or ask about highlighted parts and send them to the agent as one review; **Bugbot** sends it Cursor Bugbot's findings. The list colours open and draft pull requests and filters by status and author. |
| **File** | A Markdown, JSON, text or code file with line numbers, opened from a path in a reply (at the line it names); Markdown shows rendered. |

A pane whose agent finished or asks something while you looked away gets a blue
border, and its session stays unread (in every window, across reloads and daemon
restarts, after it stops) until you click or type in a window showing it, or show it
from Sessions; hovering over the window or scrolling it leaves it unread. The marks are kept in `~/.cockpit/unread.json`. Turn
on **Notify** in the top bar for a desktop notification as well, while you are not looking at
that session; clicking it shows the session. When the workbench's files change under an open tab, the top bar offers
**Reload**. **Config** in the top bar (it opens as you point at it) holds the app's switches, kept per browser: *Only prompts and responses* hides the work in between (thinking and tool calls, keeping what the agent says as it works) in every agent window, and *Animated selection* (on) highlights whole words while you drag over a reply, gliding between them as in Google Docs. Below them are the daemon's, the same in every browser: *Compact idle conversations* (on) compacts a long conversation shortly before its prompt cache expires, and *Review decisions* (off) has a small model read each turn and list the decisions the agent took without you, under its reply (one cheap model call per turn). **− 100% +** in the top bar sets the text size (the percentage resets it), kept per
browser. An agent window whose conversation has been quiet for 54 minutes since its last
request, the point at which idle compaction would compact it (on or off), dims until you use
it again: its prompt cache is about to expire.

**Screens.** Each browser window is a screen of your workspace, like an extra
monitor: open a second window and it starts empty, with its own panes. Layouts
are kept by the daemon (`~/.cockpit/workspaces/`), so they survive a browser
restart: windows opened again get their screens back, and a reload keeps the
window's screen. The switcher in the top bar (**Screen 2 of 3**) lists every
screen and what it holds; a screen open in no window can be opened in this one
(**Open here**, without stopping its agents) or deleted (its agents keep running too), and **New screen** opens a copy of this one, the same windows showing the same things, in a new tab. Add
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

Pull request windows also need GitHub's **[gh](https://cli.github.com)**, signed in (`gh auth login`);
without it, everything else works.

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
