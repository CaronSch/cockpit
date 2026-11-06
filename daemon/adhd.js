/**
 * "I have ADHD" (the Config menu's switch, settings.js `adhd`): agents shape every reply for a
 * reader with ADHD, by the rules of i-have-adhd (https://github.com/ayghri/i-have-adhd, MIT):
 * the next action first, steps numbered, the state restated, one concrete next step at the end,
 * lists of five at most, no preamble, recap or closer. Its SKILL.md is kept beside this file
 * as published (commit 1ecea19), with its licence; update both together.
 *
 * The rules go in every session's system prompt, after the workbench's own
 * (omp-session.js `APPEND_SYSTEM_PROMPT`), as that project's always-on mode puts them in
 * Claude Code's and OpenCode's: on for every conversation rather than switched per
 * conversation with its `/i-have-adhd` command. omp fixes a session's system prompt as it
 * starts, so a conversation takes a change of the switch up when it next wakes, and the hub
 * puts a conversation started the other way to sleep as soon as it is idle (hub.js).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Leads the rules, as the project's omp extension leads them (its `RULES_HEADER`), saying who turned them on. */
const RULES_HEADER =
  'ADHD MODE ACTIVE. The user turned it on for every conversation; the ruleset below applies to every response. "stop adhd mode" or "normal mode" turns it off for this conversation.';

/** The SKILL.md's text without its YAML frontmatter (the project's `stripFrontmatter`). @param {string} content */
export const withoutFrontmatter = (content) => content.replace(/^---[^\S\r\n]*\r?\n[\s\S]*?\r?\n---[^\S\r\n]*(?:\r?\n|$)/, '').trim();

/** What a session's system prompt gains while the switch is on. */
export const ADHD_RULES = `${RULES_HEADER}\n\n${withoutFrontmatter(readFileSync(join(import.meta.dir, 'i-have-adhd', 'SKILL.md'), 'utf8'))}`;

/** `prompt` (appended to omp's system prompt) with the rules after it when `adhd` is on. @param {string} prompt @param {boolean} adhd */
export const withAdhdRules = (prompt, adhd) => (adhd ? `${prompt}\n\n${ADHD_RULES}` : prompt);
