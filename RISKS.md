# Deferred risks

Risks that do not bite at the current stage, filed under the threshold at which
they do. Policy is in `CLAUDE.md` ("How we decide"). In short: every session reads
this file and decides, from the repo as it is, whether any threshold has been
crossed. A crossed threshold is raised with the owner before other work. A fixed
risk is deleted from this file.

Each entry gives: what goes wrong, and the planned response once the threshold is reached.

## When a telemetry feature is built

- **Model-call proxy misses some traffic.** The "data sent to providers" view
  works by pointing omp's provider base URLs at the daemon's proxy. Providers
  that cannot be redirected that way (OAuth/subscription logins, hard-coded
  endpoints) would bypass it, and the view would show less than was sent.
  *Response:* check each provider omp is configured with; try `omp
  auth-gateway` (an HTTP forward proxy) as the single choke point; label a
  provider that is not covered as uncovered in the UI instead of showing it empty.
- **File-read tracking needs root.** Reads are invisible to FSEvents. On macOS
  they need `eslogger` (root plus Full Disk Access); on Linux, eBPF or fanotify.
  *Response:* a separate, minimal, opt-in helper that only streams events to the
  daemon. The daemon itself never runs as root. Read views say when the helper
  is off.
- **The telemetry store grows without bound.** Prompts, responses and file
  events add up quickly. The first such store already exists: the daemon keeps
  every event since it started in memory and each page load replays all of it.
  *Threshold detail:* the daemon passes 1 GB resident, or a page takes visibly
  long to load its history. *Response:* retention by age and size, set by the
  user; replay only what open windows need.

## When the daemon restarts start costing work

- **A daemon restart interrupts running agents.** omp runs as a child of the
  daemon, so a restart ends every session. An agent pane can resume the
  conversation (`omp --resume`), but a turn that was running is lost.
  *Response:* relaunch with `omp --restore <session.jsonl>`, which also resumes
  the interrupted turn and its subagents; supervise outside the daemon only if
  that is not enough.

## When omp is upgraded past 18.12.3

omp is installed on its own, not pinned by the workbench; the threshold is
crossed when the omp the daemon runs (on PATH, or `--omp`/`COCKPIT_OMP`)
is newer. The daemon prints its version at start.

- **The fake omp drifts from the real one.** `tests/fixtures/fake-omp.js`
  copies frame shapes recorded from omp 18.12.3: startup, setup commands,
  `get_state`, models, thinking levels, login providers, `bash`, aborts,
  builtin `/rename` (with no title, omp generates one in the background, so the
  fake answers first and reports the outcome after; that order follows 18.12.3's
  source), `/dirs` (its output shape from 18.12.3's source), the start of a `btw`, failed prompts and `--resume`. The
  frames of a turn a model actually answers (a pre-filled assistant
  `message_start`, deltas, tool calls, `ask` dialogs, `btw_delta`, follow-up `btw`
  turns, a generated title) were checked against 18.12.3's source only, because no
  model call succeeded during the recording; their recorded shapes are still 18.10.3's.
  The fake's `--fork` and the journals it writes follow omp 18.10.3's source
  (`SessionManager.forkFrom`), not a recording. Its `todo` tool frames match
  live omp 18.10.3 frames (a result's `details` carry its `op` and the whole
  `phases` list), minus fields the pane does not read.
  Tests stay green while a newer omp sends something else. *Response:*
  re-record a session with the real omp (with a working model, so those turn
  frames are recorded too), diff its frame and message types against the fake,
  update the fake and this version number.

- **Auto-titles lean on omp's `/rename` and `session_settled`.** After the first turn
  of an untitled session the daemon sends `/rename` with no title, once. That relies on
  omp generating a title for it in the background in RPC mode (and reporting it with
  `session_info_update`), and on `session_settled` following only agent activity, so
  the first one ends the first turn. A change shows up as sessions that stay untitled
  (they keep showing their first prompt) or a title asked for before the conversation
  says anything. *Response:* re-read omp's `slash-commands/builtin-lifecycle.ts`
  (`rename`) and `modes/rpc/rpc-session-settle.ts`, then update `daemon/omp-session.js`
  and the fake.

- **Idle compaction leans on omp's usage and `compact`.** `daemon/idle-compaction.js`
  (checked against 18.12.6's source) reads the cache entry from an assistant
  `message_end`'s `usage.cttl.ephemeral1h`, times it from that message's `message_start`,
  and sends RPC `compact`, whose answer carries the summary. omp runs its own idle
  compaction only in its TUI; PR can1357/oh-my-pi#14468 would move it into the session
  for RPC too. A change shows up as long sessions never compacted, or compacted twice.
  *Response:* re-read `session/cache-warmer.ts`, `modes/rpc/rpc-mode.ts` (`compact`) and,
  once omp runs idle compaction over RPC, drop the daemon's in favour of omp's.
- **Unread marks lean on omp's conversation id.** A session's mark is kept under
  `get_state`'s `sessionId`, which must be its journal header's `id` (what the Sessions
  window lists a past session by), also when resumed (`SessionManager` sets it from the
  header). A change shows up as a session that is unread while it runs but read once it
  stops, or the reverse. *Response:* re-read `session/session-manager.ts`
  (`#applyEntries`) and `modes/rpc/rpc-mode.ts` (`get_state`), then update
  `daemon/omp-session.js` and the fake.

- **The Sessions window reads omp's private journal format.** `daemon/history.js`
  parses `~/.omp/agent/sessions/<project>/*.jsonl` directly (the `title` and
  `session` records, user messages and their `attribution`); omp has no rpc for
  listing past sessions. A format change shows up as sessions with no title,
  no directory, or missing from the list. *Response:* compare a fresh journal
  with `tests/history.test.js`'s fixtures and update both.

- **An asleep conversation is read from its journal as omp would resume it.**
  `daemon/conversation.js` follows the entry tree (`id`/`parentId`) from the newest
  entry and turns the path into messages as omp 18.12.3's session context does
  (`message`, `custom_message`, `branch_summary`, `compaction`; tool results marked
  `useless` dropped). A change shows up as a window whose conversation looks
  different asleep than awake, or a rewind that misses its prompt after waking (the
  pending rewind is found again by its place and text). omp's own `get_messages`
  left out an empty aborted reply the journal holds ("Previous OMP process exited
  before completing the turn"); asleep, the window shows it. *Response:* resume a
  journal with `omp --mode rpc-ui --resume` on a copy, compare `get_messages` with
  `conversationOf`, and update `tests/conversation.test.js`. A rewind (`branch`)
  moving the session onto a new journal is omp 18.12.3's behaviour too; if it
  rewinds in place again, `onRewound` never fires and nothing is archived.

- **Archiving leans on omp's session layout, and `omp gc` cannot see the archive.**
  Archive moves `<project>/<name>.jsonl` and the `<project>/<name>/` folder beside it
  (subagent sessions, artifacts), the same pair omp's own `omp gc` archive moves; the
  inert `.<name>.jsonl.lock.os` sidecar stays. If omp starts keeping more per session
  elsewhere, an archived session leaves that behind. And `omp gc --apply` keeps only
  blobs (`blob:sha256:` references, e.g. large images) that journals in omp's sessions
  or its own archive name, so it may delete blobs a session archived here still uses:
  restored, it would show those as missing. `omp gc` never runs by itself. Archiving
  checks only the daemon's own sessions, so a session open in omp in another terminal
  can be archived; that omp then writes on into the moved file or starts a new one at
  the old path (nothing is lost, but the conversation may be split). *Response:* re-read `cli/gc-cli.ts` (`moveSessionWithArtifacts`,
  `runBlobGc`) and `session/session-storage.ts`; if blobs matter, register archived
  journals with omp or archive into omp's own `archive/sessions/`.

- **Attachments, `@` mentions, Ask, Fork, `!` commands, the responses-only view, window names and todo progress lean on omp internals.** Attachments rely on `@"<absolute path>"` mentions
  being read when a prompt starts a turn; `@` mentions typed in the draft also rely on a
  bare `@path` ending at whitespace or `@`, with quotes, brackets and sentence
  punctuation trimmed from its ends (a path that would lose any is sent quoted), and on
  relative and `~/` paths resolving against the session's directory (`resolveReadPath`). Ask relies on the `btw` / `btw_cancel`
  commands and the `btw_record` / `btw_delta` frames, and on `btw` answering from
  an ephemeral turn that leaves the session's history alone. Its follow-ups rely on
  `btw` with a `recordId` appending a turn to that topic's record (the record is the
  first turn, `followUps` the later ones, newest last), on its response carrying that
  record, on `btw_delta` streaming into the newest turn, and on omp replaying the
  topic's earlier turns as context. Fork relies on
  `omp --fork <file>` copying the journal into a new one (new id, copied title)
  without touching the source, on the forked process streaming none of the copied
  history (the daemon fetches it with `get_messages` before the session is ready, as for `--resume`), and on omp
  writing a new session's journal only once it holds a model reply (until then
  the Fork button is off). `!` commands rely on
  RPC `bash` running at once even mid-turn (it is dispatched outside the command
  queue), answering with its output, and on the `bashExecution` message omp records
  for it (after the turn, if one was running) carrying the same command text. The
  Config panel's "only prompts and responses" relies on an assistant message that
  wants tools ending with `stopReason: 'toolUse'`, on `agent_end` with `yielded`
  marking the hand-back, on messages omp injects being user messages with
  `attribution: 'agent'` (or `synthetic`), and on `bashExecution` /
  `pythonExecution` messages coming only from the user's own `!` commands (Up in
  the message box recalls those too). Window names rely on `get_state`'s
  `sessionName` and `session_info_update`'s `title`. The toolbar's progress relies
  on every `todo` tool result carrying the agent's whole list in `details.phases`
  (`details.op` is `view` for a read), on `get_state`'s `todoPhases`, and on
  `todo_auto_clear` meaning the list changed. The toolbar's Sign in relies on
  `get_login_providers` listing the providers omp logs in to with `authenticated`,
  and on omp starting with, or switching to, only a model whose provider has
  credentials (with none, `omp --mode rpc-ui` exits: "No default model selected"). A
  change shows up as files
  that reach the model only as a bare path (or, for a typed `@` mention, not at all), side answers that never arrive or turn
  up in the chat, follow-ups answered under the wrong question or without knowing
  what was asked before, a forked pane that opens empty or shows its history twice, a
  Fork button that stays off with the journal on disk (or is on without it, and the
  daemon refuses the fork: `fork is not an existing file`), `!` runs that wait for
  the turn to end or show twice, a responses-only pane that shows tool work,
  drops a final reply or never stops "Working…", windows that stay unnamed, a
  progress bar that never shows or lags the agent's list, or a Sign in button shown
  while logged in (or missing while a login is needed). *Response:* re-read
  omp's `utils/file-mentions.ts`,
  `modes/rpc/rpc-btw.ts`, `session/btw-turn.ts`, `session/btw-history.ts`,
  `modes/rpc/rpc-mode.ts` (`BACKGROUND_COMMANDS`, `bash`, `get_state`), `session/bash-runner.ts`,
  `tools/todo.ts`,
  and `main.ts` (`createSessionManager`) with `session/session-manager.ts` (`forkFrom`,
  `#shouldHaveSessionFile`) (in `packages/coding-agent/src/` of
  github.com/can1357/oh-my-pi at the installed version's tag) and `StopReason` in
  `packages/ai/src/types.ts`, then update `daemon/omp-session.js`,
  `src/omp/message.js`, `src/omp/file-mention.js`,
  `src/omp/transcript.js`, `src/omp/todos.js`,
  `src/omp/visibility.js`, `src/widgets/omp.js` and the fake.

## When running sessions start to pile up

- **Forgotten sessions keep running.** Sessions outlive their windows: one shown
  by no window keeps its omp process (and anything it started) until the user
  stops it in Sessions or the daemon exits. A session idle at its prompt costs
  memory, not model calls. *Threshold detail:* the owner finds sessions running
  that they had forgotten, or the daemon's omp processes use noticeable memory.
  *Response:* show each running session's age and memory in Sessions; offer to
  stop sessions that no window shows and that have been idle for a day.

## When the session history reaches thousands of journals

- **Listing past sessions gets slow.** The first listing after a daemon start
  reads every journal in full (28 journals, 66 MB: about 160 ms); later ones
  re-read only files whose size or mtime changed. *Threshold detail:* the first
  Sessions listing takes over a second. *Response:* read only each file's head
  and a bounded tail, or persist the summaries across restarts.

## When Cockpit is open at two addresses at the same time

- **Windows at different addresses can hold the same screen.** A window claims
  its screen with a Web Lock, and locks are per origin: a window at `127.0.0.1`
  does not see the claims of one at `localhost` (or `cockpit.localhost`), so both
  can open the same screen, and the switcher at one address can offer to open or
  delete a screen that is open at the other (deleting it ends that window's
  agents). Two windows saving one screen never lose a layout silently: the save
  the daemon refuses moves its window onto a new screen (`src/workspace/screen.js`).
  Only a change made in the last quarter second before such a window closes is
  lost, since its final save cannot move anywhere. *Threshold detail:* the owner
  keeps tabs open at two addresses. *Response:* have the daemon track which
  screens are open (each page holds a claim on the event stream), replacing the
  locks.

## When `~/.cockpit` passes 1 GB

- **Attached files are never deleted.** Every file pasted or dropped on an omp
  pane stays in `attachments/<day>/`, and a pad's files go only when the pad does.
  *Response:* prune attachment folders older than a week at daemon start. omp
  keeps sent images and inlined text in its own journal, so an old attachment is
  only needed if a steered path is still being opened. Show each pad's size in the
  switcher.

## When building the browser pane or chasing shortcut parity

- **A browser tab cannot fully match cmux.** Most external sites refuse to be
  framed (`X-Frame-Options`/CSP), so a browser pane only shows local dev servers
  reliably. A page also cannot capture browser-reserved shortcuts (⌘W, ⌘T, ⌘N).
  *Response:* wrap the same UI in Tauri; the daemon becomes its sidecar and the
  webview gets a native browser surface. Until then, limit the browser pane to
  localhost.
- **Some omp features may be TUI-only.** Anything omp does not expose over rpc
  is a parity gap for structured panes. Known: `!!cmd` (run, but keep the output
  out of the model's context) has no rpc form, since `bash` takes only a command;
  the pane runs it as the shell command `!cmd`, which fails visibly. *Response:*
  list the gaps; the terminal pane running omp's own TUI covers them until omp's
  rpc catches up.

## When a second harness is added

- **The adapter is shaped around omp.** If omp's rpc vocabulary leaks into the
  UI, a second harness means rewriting widgets. *Response:* define the daemon's
  own event vocabulary from what omp and the new harness have in common; make
  omp an adapter onto it. Do not abstract before the second harness exists.

## When the daemon is reachable from anything but loopback (LAN, remote, team)

- **No real auth.** The loopback guard (token plus Origin check) assumes one user
  on one machine. *Response:* real authentication, TLS, and per-user isolation of
  sessions and telemetry.
- **The telemetry store holds secrets.** Prompts, file contents, env values and
  tool output are stored in plain text, with the same trust as omp's own
  `~/.omp` session files. *Response:* redaction before storage or display to
  others, and encryption at rest.

## When telemetry can leave the machine (export, share, sync, OTLP)

- **Exported telemetry leaks secrets.** Same data as above, now off-machine.
  *Response:* redact on export by default, and preview before sharing.

## When announcing publicly, or publishing a package

- **Name collisions.** The project is now plain "Cockpit", which is also Red
  Hat's Linux admin UI, and the npm name `cockpit` may be taken. *Response:*
  check npm, GitHub and trademark conflicts before announcing, not after.
- **macOS only.** Process sampling and file tracing are written for macOS first.
  *Response:* state supported platforms in the README; add Linux backends when
  someone needs them.
- **Outside contributions.** No contribution guide, no security policy.
  *Response:* add CONTRIBUTING and SECURITY (how to report daemon issues) before
  inviting contributors.
