/**
 * Wire contract between the daemon and the browser: session metadata, stream events and
 * HTTP payloads.
 *
 * Routes (all same-origin, authenticated by the `ac_token` cookie; see `guard.js`):
 *
 *   GET    /api/config                 → DaemonConfig
 *   GET    /api/ui                     → { version }: the UI files' version now (see `ui-files.js`)
 *   GET    /api/history?q=words&archived=1 → { sessions: PastSession[] } (unordered; with `q`, the
 *                                      ones it finds, best first, each with its `match`: see
 *                                      `search.js`; `archived=1` lists the archived sessions instead)
 *   POST   /api/history/archive        { file } → { file }: the journal (with its folder) moved from omp's
 *                                      sessions into the archive; a session writing it goes to sleep
 *                                      first, 409 while its agent works
 *   POST   /api/history/restore        { file } → { file }: an archived journal moved back where it was,
 *                                      409 if something is there now; both are 400 for a path that is
 *                                      not a journal they list, 404 for one that is gone
 *   GET    /api/conversation?file=path → Conversation: the journal's conversation (one `history` lists,
 *                                      archived or not, or one this daemon's sessions wrote), 400/404
 *                                      for any other path
 *   PUT    /api/unread/:ompId          → 204: the user marked the conversation unread (see `unread.js`)
 *   POST   /api/unread/:ompId/read     { at } → 204: the user read it as it was at `at` (daemon
 *                                      time: the `since` they were shown); a mark made after
 *                                      `at` stays. Both are 404 for an id that is not one
 *   PUT    /api/pins/:ompId            → 204: the conversation is pinned to the top of the Sessions list
 *   DELETE /api/pins/:ompId            → 204: it is not (see `pins.js`); both 404 for an id that is not one
 *   GET    /api/decisions/:ompId       → { reviews: Reviews }: the conversation's decision reviews, those
 *                                      under way included (see `decisions.js`); 404 for an id that is not one
 *   PUT    /api/settings               Partial<DaemonSettings> → DaemonSettings: the daemon's settings
 *                                      changed (see `settings.js`); 400 for anything but known keys
 *                                      with values of their type
 *   GET    /api/sessions               → { sessions: SessionMeta[] }
 *   POST   /api/sessions               { cwd, resume? | fork?, prompt? } → 201 { session: SessionMeta }
 *                                      (`cwd` relative to home, `~/…` or absolute; `resume`
 *                                      continues a journal, `fork` starts a new session from a
 *                                      copy of one, as of its last completed response while its
 *                                      agent is working, and sends it `prompt` once it is ready
 *                                      (see `forks.js`); either must be an existing file). Resuming
 *                                      a journal a running session writes answers 200 with that
 *                                      session instead: two omps never write one journal; an
 *                                      archived one is refused (409), as it is only to read
 *   DELETE /api/sessions/:id           → 204: the session goes to sleep now (closes omp's stdin,
 *                                      kills it if it lingers), as it does by itself once idle
 *                                      and unused (see `sleep.js`), or when the daemon exits
 *   POST   /api/sessions/:id/seen      → 204: a window is being used on the session: it stays awake
 *   POST   /api/sessions/:id/rpc       omp command without `id` → 202 { id }: the id the daemon gave
 *                                      the command; omp's response frame, carrying it, arrives on
 *                                      the stream
 *   POST   /api/sessions/:id/ui        omp `extension_ui_response` → 204
 *   GET    /api/files?dir=path         → DirListing: the folder `dir` names (relative to home,
 *                                      `~/…` or absolute, as `cwd` above), or 404
 *   GET    /api/file?path=path         → a file an agent's reply shows: an image (png, jpeg, gif, webp,
 *                                      avif) or a chart's data (json, csv, tsv), by extension; path
 *                                      as `dir` above; else 404
 *   GET    /api/text?path=path         → TextFile: a text file for the file window (Markdown, JSON, plain
 *                                      text, common code: src/files/file-refs.js), by extension; path as
 *                                      `dir` above; 404 for any other file, or none
 *   PUT    /api/text                   { path, text, base } → TextFile: `text` saved over that file (as
 *                                      GET, already there and `editable`), or 409 { error, current:
 *                                      TextFile } when it is no longer at version `base`; 422 when the
 *                                      file, or `text`, cannot be saved
 *   GET    /api/scratchpads            → { pads: ScratchpadSummary[] } (most recently changed first)
 *   GET    /api/scratchpads/:id        → Scratchpad (empty text for a pad never written)
 *   PUT    /api/scratchpads/:id        { text, base } → { rev }, or 409 { error, current: Scratchpad }
 *                                      when the pad is no longer at version `base`
 *   DELETE /api/scratchpads/:id        → 204 (the pad and its files)
 *   POST   /api/scratchpads/:id/assets raw file body, `x-file-name` header (URI-encoded)
 *                                      → 201 { path } for the pad's Markdown, e.g. `<id>.assets/<name>`
 *   GET    /api/scratchpads/:id/assets/:name → the file (images inline, anything else as a download)
 *   POST   /api/attachments            raw file body, `x-file-name` header (URI-encoded)
 *                                      → 201 { path }: where omp can read it, for an `@"<path>"` mention
 *   GET    /api/workspaces/:name       → Workspace (no screens for a workspace never saved)
 *   PUT    /api/workspaces/:name/screens/:id { tree, base } → { rev }, or 409 { error, current: Screen | null }
 *                                      when the screen is no longer at rev `base` (null: not stored);
 *                                      a null `tree` deletes the screen (`rev` comes back null)
 *   POST   /api/deliver                { target: ConversationTarget, message } → 202 { session }: the
 *                                      message sent to the conversation as a prompt, woken first if
 *                                      it is asleep, queued after the turn if its agent works (see
 *                                      `deliver.js`); 404 when no session holds it and it has no
 *                                      journal, 409 when it is archived
 *   GET    /api/github/pulls?cwd=dir, or ?repo=owner/name → PullList: the pull requests of the
 *                                      GitHub repository `dir` (as `cwd` above) is in, or of the one
 *                                      named, newest first, or why there are none to list (`gh`
 *                                      missing or signed out, not a GitHub repository)
 *   GET    /api/github/repos?cwd=dir   → RepoList: the repository `dir` is in and its owner's other
 *                                      repositories, most recently pushed first, or why not
 *   GET    /api/github/pull?repo=owner/name&number=n, or ?cwd=dir&number=n → Pull: pull request `n` of
 *                                      the repository named, or of the one `dir` is in; 502 with `gh`'s
 *                                      reason when it cannot be read
 *   POST   /api/github/bugbot          { repo, number, target: ConversationTarget } → 201 BugbotWatch:
 *                                      `bugbot go` commented on the pull request, and its review,
 *                                      once Bugbot posts it, sent to the conversation (see `bugbot.js`)
 *   GET    /api/stream                 Server-Sent Events, one StreamEvent per message
 *
 * Errors are `{ error: string }` with a 4xx/5xx status. The stream's SSE ids are
 * `<bootId>:<seq>`, so a reconnect resumes after the last event it saw; the first message
 * on every connection is a `hello` carrying the current boot id, the newest event's seq (the
 * events up to it that follow are a replay), session list, unread conversations, forks and UI version. `scratchpad`, `history`, `unread`, `pins`, `forks` and `decisions` events carry no id and are
 * not replayed: a reconnecting page reads GET /api/scratchpads/:id, GET /api/history and GET /api/decisions/:ompId instead,
 * and its `hello` carries the unread conversations, pins and forks.
 */
/** @import { GridNode } from '../src/layout/grid-model.js' */
/** @import { Unread } from './unread.js' */
/** @import { Pinned } from './pins.js' */
/** @import { Forks } from './forks.js' */
/** @import { DaemonSettings } from './settings.js' */
/** @import { Reviews } from '../src/omp/decisions.js' */

/** @typedef {'starting' | 'ready' | 'exited' | 'failed'} SessionStatus */

/**
 * One omp process the daemon launched, started from the journal `resume` (continuing it) or
 * `fork` (a new session copied from it), or from nothing. `sessionFile` is the journal it
 * writes, learned from omp's `get_state` answers (the resumed file until then); it changes
 * on /new or /fork. `ompId` is omp's id for the conversation it holds (`get_state`'s
 * `sessionId`, its journal header's `id`: PastSession `id`), which names it in the unread
 * marks (`unread.js`); null until omp has said.
 * @typedef {{
 *   id: string,
 *   cwd: string,
 *   resume: string | null,
 *   fork: string | null,
 *   sessionFile: string | null,
 *   status: SessionStatus,
 *   pid: number | null,
 *   exitCode: number | null,
 *   error: string | null,
 *   startedAt: number,
 *   ompId: string | null,
 * }} SessionMeta
 */

/**
 * A past omp conversation, summarised from its journal. `firstPrompt` is a one-line
 * preview; times are epoch milliseconds. Found by a search, `match` holds the passage that
 * matched best and the conversation's words the query matched.
 * @typedef {{
 *   file: string,
 *   id: string,
 *   title: string | null,
 *   cwd: string | null,
 *   createdAt: number | null,
 *   modifiedAt: number,
 *   prompts: number,
 *   firstPrompt: string | null,
 *   match?: { snippet: string, terms: string[] },
 * }} PastSession
 */

/**
 * A conversation as its journal has it, for a window to show while no omp holds it (see
 * `conversation.js`), `archived` when its journal is in the archive: `messages` as omp's `get_messages` answers once it is resumed, `model`
 * (`provider/id`) and `thinkingLevel` as the journal last recorded them, `id` as PastSession's.
 * @typedef {{
 *   file: string,
 *   id: string,
 *   cwd: string | null,
 *   title: string | null,
 *   model: string | null,
 *   thinkingLevel: string | null,
 *   messages: Record<string, any>[],
 *   archived?: boolean,
 * }} Conversation
 */

/**
 * Everything the daemon observed or did for a session, in order. `frame` is an omp stdout
 * frame exactly as omp sent it (after protocol-v2 chunk reassembly), responses included;
 * `sent` is a frame the daemon wrote to omp's stdin, its own setup commands included;
 * `garbled` is stdout the daemon could not decode (not JSON, or a broken chunk sequence),
 * kept verbatim (truncated to 64 KiB) rather than dropped.
 * @typedef {(
 *   | { kind: 'session', meta: SessionMeta }
 *   | { kind: 'frame', frame: Record<string, any> }
 *   | { kind: 'sent', command: Record<string, any> }
 *   | { kind: 'stderr', line: string }
 *   | { kind: 'garbled', line: string, error: string }
 * ) & { seq: number, at: number, session: string }} SessionEvent
 */

/**
 * `ui` is the version of the UI files being served (see `ui-files.js`): a page that loaded
 * other files is running older code than the daemon now serves. `unread` holds the
 * conversations with news their user has not read: when each became unread, by omp id.
 * `pinned` holds the pinned conversations' omp ids; `forks` every fork: the conversation it
 * came from and its title (see `forks.js`). `settings` are the daemon's (see `settings.js`).
 * `bugbot` holds the Bugbot reviews watched for (see `bugbot.js`).
 * @typedef {{ kind: 'hello', bootId: string, seq: number, sessions: SessionMeta[], unread: Unread, pinned: Pinned, forks: Forks, settings: DaemonSettings, bugbot: BugbotWatch[], ui: string }} HelloEvent
 */

/** A scratchpad's text; `rev` names this exact text (a hash of it). @typedef {{ text: string, rev: string }} Scratchpad */
/** @typedef {{ id: string, title: string, modifiedAt: number, size: number }} ScratchpadSummary */
/** Sent to every page after a pad changes (a deleted pad arrives empty). @typedef {{ kind: 'scratchpad', id: string } & Scratchpad} ScratchpadEvent */

/** Sent to every page after past sessions changed (see `history.js` `watch`). @typedef {{ kind: 'history' }} HistoryEvent */

/** Sent to every page after a conversation was marked read or unread, with all the marks. @typedef {{ kind: 'unread', unread: Unread }} UnreadEvent */

/** Sent to every page after a conversation was pinned or unpinned, with all the pins. @typedef {{ kind: 'pins', pinned: Pinned }} PinsEvent */

/** Sent to every page after a fork was started, titled or moved (a rewind), with every fork. @typedef {{ kind: 'forks', forks: Forks }} ForksEvent */

/** Sent to every page after a conversation's decision reviews changed (one started or ended), with all of them. @typedef {{ kind: 'decisions', ompId: string, reviews: Reviews }} DecisionsEvent */

/** Sent to every page after the daemon's settings changed, with all of them. @typedef {{ kind: 'settings', settings: DaemonSettings }} SettingsEvent */

/** Sent to every page after a Bugbot watch started or changed, with all of them. @typedef {{ kind: 'bugbot', watches: BugbotWatch[] }} BugbotEvent */

/** @typedef {HelloEvent | ScratchpadEvent | HistoryEvent | UnreadEvent | PinsEvent | ForksEvent | DecisionsEvent | SettingsEvent | BugbotEvent | SessionEvent} StreamEvent */

/**
 * `idleCompactAfterMs`: how long after its last request a conversation is compacted while idle
 * (see `idle-compaction.js`); an agent window dims from then (src/omp/cold.js).
 * @typedef {{ defaultCwd: string, home: string, scratchpadDir: string, idleCompactAfterMs: number }} DaemonConfig
 */

/**
 * A text file as the file window shows it: `path` resolved, its `text` (its first 2 MiB:
 * `truncated` when there is more), its `size` in bytes, when it was last changed (epoch ms), and
 * its version `rev` (a hash of `text`). `editable`: the file window may save it, being read whole
 * and plain UTF-8, so a save changes no byte that was not edited.
 * @typedef {{ path: string, text: string, size: number, truncated: boolean, editable: boolean, modifiedAt: number, rev: string }} TextFile
 */

/**
 * A folder's entries for path suggestions, by name; `dir` is the folder,
 * resolved; `truncated` when it holds more than were listed (see `files.js`).
 * @typedef {{ dir: string, entries: Array<{ name: string, isDir: boolean }>, truncated: boolean }} DirListing
 */

/**
 * One browser window's share of a workspace: its layout, and `rev`, which counts its saves
 * (see `workspace.js`).
 * @typedef {{ id: string, rev: number, tree: GridNode }} Screen
 */
/** Screens in the order they were created. @typedef {{ screens: Screen[] }} Workspace */

/**
 * omp's reply to one command (see omp's rpc docs). `success: false` is a normal answer,
 * not a transport failure.
 * @typedef {{ type: 'response', command: string, success: boolean, data?: any, error?: string, code?: string, id?: string }} RpcResponse
 */

/**
 * A conversation to send a message to: the journal that names it (null for a new one omp has
 * not named yet), the session last seen holding it, and the directory it runs in.
 * @typedef {{ sessionFile: string | null, session: string | null, cwd: string }} ConversationTarget
 */

/**
 * A pull request as GitHub lists it. `state` is GitHub's: `OPEN`, `CLOSED` or `MERGED`.
 * @typedef {{ number: number, title: string, state: string, isDraft: boolean, author: string, headRefName: string, url: string, updatedAt: string }} PullSummary
 */
/**
 * The pull requests of a repository, or why there are none to list: `reason` is `gh`'s own.
 * @typedef {{ connected: true, pulls: PullSummary[] } | { connected: false, reason: string }} PullList
 */
/** A repository (`owner/name`) and what it says it is. @typedef {{ repo: string, description: string }} RepoSummary */
/**
 * The repository a directory is in (`repo`) and its owner's repositories, `repo` among them, or
 * why there are none: `reason` is `gh`'s own.
 * @typedef {{ connected: true, repo: string, repos: RepoSummary[] } | { connected: false, reason: string }} RepoList
 */
/** @typedef {{ author: string, body: string, createdAt: string, url: string }} PullComment */
/** `id` is GitHub's node id. @typedef {{ id: string, author: string, state: string, body: string, submittedAt: string }} PullReview */
/**
 * A comment on a line of the diff: on `side` (`RIGHT`, the new file, or `LEFT`) at `line`;
 * null when the line is no longer in the diff (outdated).
 * @typedef {{ id: number, author: string, body: string, path: string, line: number | null, startLine: number | null, side: 'LEFT' | 'RIGHT', inReplyTo: number | null, createdAt: string, url: string }} ReviewComment
 */
/**
 * One pull request to review: what it is, its conversation (`comments`, `reviews`), the
 * comments on its lines, and its unified diff (`diffTruncated` when cut short: see `github.js`).
 * @typedef {PullSummary & { repo: string, body: string, baseRefName: string, additions: number, deletions: number, createdAt: string, comments: PullComment[], reviews: PullReview[], reviewComments: ReviewComment[], diff: string, diffTruncated: boolean }} Pull
 */

/**
 * A Bugbot review asked for (`bugbot go` commented at `since`, GitHub's time) on pull request
 * `number` of `repo`, for the conversation
 * `target`: `watching` until Bugbot reviews, then `delivered` (its review sent to the
 * conversation), `timed-out` when it never did, or `failed` (`error` says why). `error` while
 * watching is the last poll's failure, retried. `at`: when it last changed, epoch milliseconds.
 * @typedef {{ id: string, repo: string, number: number, url: string, since: string, target: ConversationTarget, status: 'watching' | 'delivered' | 'timed-out' | 'failed', error: string | null, at: number }} BugbotWatch
 */

export {};
