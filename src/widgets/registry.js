import { leaf } from '../layout/grid-model.js';
import pane from './pane.js';
import omp from './omp.js';
import sessions from './sessions.js';
import scratchpad from './scratchpad.js';
import github from './github.js';
import file from './file.js';
import setup from './setup.js';
import timeline from './timeline.js';

/**
 * Widgets the palette can add, keyed by type.
 * Contract: { type, title, glyph, description, newParams?(), mount(body, ctx) → { destroy(), paramsChanged?() } }.
 * `newParams()` gives a window its starting settings when one is created (e.g. a fresh
 * scratchpad id); windows restored from a saved layout keep theirs.
 * A window owns nothing but its settings: what must outlive it (an agent, a pad) lives with
 * the daemon, so closing a window never ends anything.
 * `ctx.params` is this window's saved settings (read it when needed: it changes after
 * mount); `ctx.setParams(patch)` merges into them and persists them with the layout.
 * `paramsChanged()` is called after they changed, whoever changed them (this window, or
 * another one showing something in it).
 * `ctx.addWidget(type, params)` opens another window beside the largest one;
 * `ctx.openBeside(type, params)` opens one on this window's right, splitting it;
 * `ctx.showWidget(type, params)` shows `params` in the window of `type` this screen used last
 * (merging them into its settings, and bringing it to the front of its stack), or opens one if
 * there is none;
 * `ctx.dragWidget(type, params, pointerdown)` lets the user drop it where they want, exactly
 * like dragging from the palette (a plain click does nothing): onto a window's middle or head,
 * it stacks there as a tab; with `into`, the middle of a window of `type` shows it instead;
 * with `target`, onto that element of the window's own instead (a bin), which then gets
 * `is-drop-armed` while the drag runs and `is-drop-over` while the pointer is over it, and
 * `onEnd` hears `onTarget`.
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
 * @typedef {{
 *   readonly params: LeafParams,
 *   setParams(patch: LeafParams): void,
 *   addWidget(type: string, params: LeafParams): void,
 *   showWidget(type: string, params: LeafParams): void,
 *   openBeside(type: string, params: LeafParams): void,
 *   dragWidget(type: string, params: LeafParams, event: PointerEvent, options?: { label?: string, into?: boolean, onEnd?: (result: DragEndResult) => void, target?: HTMLElement }): void,
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
 *   mount(body: HTMLElement, ctx: WidgetContext): { destroy(): void, paramsChanged?(): void } }} WidgetDef
 */

/** @type {readonly WidgetDef[]} */
const DEFS = [pane, omp, sessions, timeline, scratchpad, github, file, setup];

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
