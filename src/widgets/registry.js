import { leaf } from '../layout/grid-model.js';
import omp from './omp.js';
import terminal from './terminal.js';
import sessions from './sessions.js';
import scratchpad from './scratchpad.js';
import github from './github.js';
import file from './file.js';
import setup from './setup.js';
import timeline from './timeline.js';
import processes from './processes.js';
import plan from './plan.js';

/**
 * Widgets the palette can add, keyed by type.
 * Contract: { type, title, glyph, description, newParams?(), newTab?(params), mount(body, ctx) → { destroy(), paramsChanged?(), closed?() } }.
 * `newParams()` gives a window its starting settings when one is created (e.g. a fresh
 * scratchpad id); windows restored from a saved layout keep theirs.
 * `newTab(params)`, if a widget has it, puts a + after its window's title (or its stack's tabs):
 * a click opens another window of its type as a tab beside it, with the settings `newTab` draws
 * from this window's (an agent window: the same directory).
 * A window owns nothing but its settings: what must outlive it (an agent, a pad) lives with
 * the daemon, so closing a window ends nothing, with one exception: `closed()` runs when its
 * user closes the window (its ×, or Delete on its grip or tab), never as it goes for any other
 * reason (a reload, another screen), and a terminal ends its shell there, as a terminal app's
 * tab does. `destroy()` runs every time the window goes.
 * `ctx.params` is this window's saved settings (read it when needed: it changes after
 * mount); `ctx.setParams(patch)` merges into them and persists them with the layout.
 * `paramsChanged()` is called after they changed, whoever changed them (this window, or
 * another one showing something in it).
 * `ctx.addWidget(type, params)` opens another window beside the largest one;
 * `ctx.openTab(type, params)` opens one as a tab in this window's place, shown, so nothing is
 * pushed aside (this window waits behind it, a tab of the stack);
 * `ctx.showWidget(type, params)` shows `params` in the window of `type` this screen used last
 * (merging them into its settings, and bringing it to the front of its stack), or opens one if
 * there is none;
 * `ctx.showInTab(type, params, match)` shows `params` without replacing what a window shows:
 * it brings forward the window of `type` on this screen that shows it already (`match.same`),
 * else shows it in the window of `type` used last if that shows nothing yet (`match.blank`), else
 * opens it as a new tab beside that window (a new window if there is none);
 * `ctx.dragWidget(type, params, pointerdown)` lets the user drop it where they want, exactly
 * like dragging from the palette (a plain click does nothing): onto a window's middle or head,
 * it stacks there as a tab; with `into`, the middle of a window of `type` shows it instead.
 * `ctx.setUnread(true)` lights the window's border (and its tab's dot, in a stack): it has
 * news its user has not seen.
 * `ctx.setLabel(text)` names what the window shows (e.g. the agent window's conversation) in
 * its top bar, beside its type's title (alone, on its tab); null removes the name.
 * `ctx.headActions` is where the window puts controls of its own in that bar, before its close
 * button (pressing them never drags the window); in a stack, those of the window shown.
 * `ctx.screen` tells which windows this screen has (with their settings), which one of each
 * type `showWidget` would use, and which one the pointer is over (else the focused one);
 * `ctx.outline(ids)` outlines those windows, until it is called again (with `[]` to stop).
 * `ctx.setFamily(name)` says which family of related things the window shows (an agent
 * window: the conversation its forks came from); windows of one family shown together get the
 * same colour in their top bar. Null: none.
 */
/** @import { Leaf, LeafParams } from '../layout/grid-model.js' */
/** @import { DragEndResult } from '../interaction/drag-controller.js' */
/** @import { Atom } from '../state/atom.js' */
/**
 * This screen's windows as a widget may follow them: `windows` in screen order, `used` the id
 * of the window `showWidget` would use for each widget type there is (the one used last),
 * `pointed` the window under the pointer, or else the focused one, or null.
 * @typedef {{ windows: Leaf[], used: Readonly<Record<string, string>>, pointed: string | null }} ScreenWindows
 */
/**
 * How `showInTab` finds a window for what it shows: one that shows it already (`same`), or one
 * that shows nothing yet and may take it (`blank`), each from that window's settings.
 * @typedef {{ same: (params: LeafParams) => boolean, blank: (params: LeafParams) => boolean }} TabMatch
 */
/**
 * @typedef {{
 *   readonly params: LeafParams,
 *   setParams(patch: LeafParams): void,
 *   addWidget(type: string, params: LeafParams): void,
 *   showWidget(type: string, params: LeafParams): void,
 *   showInTab(type: string, params: LeafParams, match: TabMatch): void,
 *   openTab(type: string, params: LeafParams): void,
 *   dragWidget(type: string, params: LeafParams, event: PointerEvent, options?: { label?: string, into?: boolean, onEnd?: (result: DragEndResult) => void }): void,
 *   setUnread(unread: boolean): void,
 *   setLabel(text: string | null): void,
 *   readonly headActions: HTMLElement,
 *   readonly screen: Pick<Atom<ScreenWindows>, 'get' | 'subscribe'>,
 *   outline(ids: readonly string[]): void,
 *   setFamily(family: string | null): void,
 * }} WidgetContext
 */
/**
 * @typedef {{ type: string, title: string, glyph: string, description: string,
 *   newParams?: () => LeafParams,
 *   newTab?: (params: LeafParams) => LeafParams,
 *   mount(body: HTMLElement, ctx: WidgetContext): { destroy(): void, paramsChanged?(): void, closed?(): void } }} WidgetDef
 */

/** @type {readonly WidgetDef[]} */
const DEFS = [omp, terminal, sessions, timeline, processes, plan, scratchpad, github, file, setup];

/** @type {Readonly<Record<string, WidgetDef>>} */
export const WIDGETS = Object.freeze(Object.fromEntries(DEFS.map((def) => [def.type, def])));

/**
 * A new window of `type`: with `params` if given, else the widget's own starting settings.
 * @param {string} type @param {LeafParams} [params]
 */
export function newWidgetLeaf(type, params) {
  const fresh = leaf(`w_${crypto.randomUUID().slice(0, 8)}`, type);
  const start = params ?? WIDGETS[type]?.newParams?.();
  return start ? { ...fresh, params: start } : fresh;
}
