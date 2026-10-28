/**
 * Wire contract between the daemon and the browser: session metadata, stream events and
 * HTTP payloads.
 *
 * Routes (all same-origin, authenticated by the `ac_token` cookie; see `guard.js`):
 *
 *   GET    /api/config                 → DaemonConfig
 *   GET    /api/ui                     → { version }: the UI files' version now (see `ui-files.js`)
 *   GET    /api/history?q=words&archived=1 → { sessions: PastSession[] } (unordered; every word must
 *                                      match; `archived=1` lists the archived sessions instead)
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
 *   PUT    /api/settings               Partial<DaemonSettings> → DaemonSettings: the daemon's settings
 *                                      changed (see `settings.js`); 400 for anything but known keys
 *                                      with values of their type
 *   GET    /api/sessions               → { sessions: SessionMeta[] }
 *   POST   /api/sessions               { cwd, resume? | fork? } → 201 { session: SessionMeta }
 *                                      (`cwd` relative to home, `~/…` or absolute; `resume`
 *                                      continues a journal, `fork` starts a new session from a
 *                                      copy of one; either must be an existing file). Resuming
 *                                      a journal a running session writes answers 200 with that
 *                                      session instead: two omps never write one journal
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
 *   GET    /api/image?path=path        → an image file (png, jpeg, gif, webp, avif by extension; path
 *                                      as `dir` above) an agent's reply shows, or 404
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
 *   GET    /api/stream                 Server-Sent Events, one StreamEvent per message
 *
 * Errors are `{ error: string }` with a 4xx/5xx status. The stream's SSE ids are
 * `<bootId>:<seq>`, so a reconnect resumes after the last event it saw; the first message
 * on every connection is a `hello` carrying the current boot id, the newest event's seq (the
 * events up to it that follow are a replay), session list, unread conversations and UI version. `scratchpad`, `history` and `unread` events carry no id and are
 * not replayed: a reconnecting page reads GET /api/scratchpads/:id and GET /api/history instead,
 * and its `hello` carries the unread conversations.
 */
/** @import { GridNode } from '../src/layout/grid-model.js' */
/** @import { Unread } from './unread.js' */
/** @import { Pinned } from './pins.js' */
/** @import { DaemonSettings } from './settings.js' */

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
 * preview; times are epoch milliseconds.
 * @typedef {{
 *   file: string,
 *   id: string,
 *   title: string | null,
 *   cwd: string | null,
 *   createdAt: number | null,
 *   modifiedAt: number,
 *   prompts: number,
 *   firstPrompt: string | null,
 * }} PastSession
 */

/**
 * A conversation as its journal has it, for a window to show while no omp holds it (see
 * `conversation.js`): `messages` as omp's `get_messages` answers once it is resumed, `model`
 * (`provider/id`) and `thinkingLevel` as the journal last recorded them, `id` as PastSession's.
 * @typedef {{
 *   file: string,
 *   id: string,
 *   cwd: string | null,
 *   title: string | null,
 *   model: string | null,
 *   thinkingLevel: string | null,
 *   messages: Record<string, any>[],
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
 * `pinned` holds the pinned conversations' omp ids. `settings` are the daemon's (see `settings.js`).
 * @typedef {{ kind: 'hello', bootId: string, seq: number, sessions: SessionMeta[], unread: Unread, pinned: Pinned, settings: DaemonSettings, ui: string }} HelloEvent
 */

/** A scratchpad's text; `rev` names this exact text (a hash of it). @typedef {{ text: string, rev: string }} Scratchpad */
/** @typedef {{ id: string, title: string, modifiedAt: number, size: number }} ScratchpadSummary */
/** Sent to every page after a pad changes (a deleted pad arrives empty). @typedef {{ kind: 'scratchpad', id: string } & Scratchpad} ScratchpadEvent */

/** Sent to every page after past sessions changed (see `history.js` `watch`). @typedef {{ kind: 'history' }} HistoryEvent */

/** Sent to every page after a conversation was marked read or unread, with all the marks. @typedef {{ kind: 'unread', unread: Unread }} UnreadEvent */

/** Sent to every page after a conversation was pinned or unpinned, with all the pins. @typedef {{ kind: 'pins', pinned: Pinned }} PinsEvent */

/** Sent to every page after the daemon's settings changed, with all of them. @typedef {{ kind: 'settings', settings: DaemonSettings }} SettingsEvent */

/** @typedef {HelloEvent | ScratchpadEvent | HistoryEvent | UnreadEvent | PinsEvent | SettingsEvent | SessionEvent} StreamEvent */

/** @typedef {{ defaultCwd: string, home: string, scratchpadDir: string }} DaemonConfig */

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

export {};
