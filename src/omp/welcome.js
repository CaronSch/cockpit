/**
 * What a new conversation's empty transcript shows, as omp's own TUI does in a new session: the
 * Cockpit mark and wordmark drawn in pixels, the version, and a tip picked at random, one per
 * window, about something the workbench does that is easy to miss.
 *
 * The pixels are SVG rects in the theme's colours (styles/omp.css), so the card follows the
 * theme and stays crisp at any zoom. A tip's `backticks` show as code.
 */
import { el, svg } from '../ui/dom.js';

/** Tips about the workbench, true of it as it is: keep each to one sentence or two. */
export const TIPS = [
  '`/new` starts a fresh conversation in this window and leaves this one in Sessions; `/archive` archives this one first',
  '`/fork <prompt>` opens a fork of the conversation as a new tab, or drag Send onto the grid to place one where you drop it',
  'Start a line with `!` to run it as a shell command in the session’s directory, even while the agent works',
  'Send just `.` and the agent carries on with what it was doing, no prompt needed',
  '⌘↑ and ⌘↓ (Ctrl elsewhere) jump between the agent’s responses in a long conversation',
  'Select text in a reply to Comment on it (quoted with your next prompt) or Ask about it on the side, without adding to the conversation; C and A do the same',
  'Up in an empty message box steps back through this conversation’s prompts and `!` commands',
  'Esc in the message box stops a running turn',
  'Type `@` and a path to mention a file; Tab completes it',
  'In a GitHub repository, `#` suggests pull requests to mention; PRs in the title bar opens one beside the agent',
  'Paste a screenshot or drop a file into the message box and it goes with your next prompt',
  '⌘K opens Spotlight: search every conversation, or ask in plain words where something was said',
  'Agents can schedule a check for later with their `schedule` tool; the Timeline window shows what is coming',
  'The + after a window’s title opens another agent in the same directory, as a tab',
  'Drop a window on another window’s middle to stack them as tabs; drag a tab out to split it off again',
  'A window dims once its conversation has been quiet 54 minutes: its prompt cache is about to expire',
  'Pin a conversation in Sessions (☆) to keep it at the top; Archive hides one, and View → Archived sessions brings it back',
  'The Processes window lists what your agents left running, who started each and why, and stops leftovers',
  'Tab indents in the message box, as in a code editor; Esc then Tab leaves it',
];

/** One tip, at random. @param {() => number} [random] */
export const pickTip = (random = Math.random) => TIPS[Math.floor(random() * TIPS.length)];

/**
 * The mark: the top bar's rounded square (styles/app.css `.brand-mark`) in pixels, its corners
 * cut and its colour stepping from the accent to its deeper fill along the diagonal, as the
 * gradient does there.
 */
const MARK = ['.######.', '########', '########', '########', '########', '########', '########', '.######.'];

/**
 * The wordmark's letters on a nine-row grid: rows 0–1 ascenders, 2–6 the x-height, 7–8 the
 * descender. Each row is as wide as its letter.
 * @type {Record<string, string[]>}
 */
const FONT = {
  c: ['....', '....', '.###', '#...', '#...', '#...', '.###', '....', '....'],
  o: ['....', '....', '.##.', '#..#', '#..#', '#..#', '.##.', '....', '....'],
  k: ['#...', '#...', '#..#', '#.#.', '##..', '#.#.', '#..#', '....', '....'],
  p: ['....', '....', '###.', '#..#', '#..#', '#..#', '###.', '#...', '#...'],
  i: ['#', '.', '#', '#', '#', '#', '#', '.', '.'],
  t: ['.#.', '.#.', '###', '.#.', '.#.', '.#.', '..#', '...', '...'],
};

/** @param {string[]} rows @param {number} x0 @param {number} size @param {(x: number, y: number) => Record<string, string>} attrs */
function pixels(rows, x0, size, attrs) {
  return rows.flatMap((row, y) => [...row].flatMap((c, x) => (c === '#' ? [svg('rect', { x: String(x0 + x * size), y: String(y * size), width: String(size), height: String(size), ...attrs(x, y) })] : [])));
}

function mark() {
  const size = 8;
  /** Diagonal bands two pixels wide, few enough that each step shows, as pixel art: 0 to `last`. */
  const last = MARK.length - 1;
  const icon = svg('svg', { class: 'omp-welcome-mark', viewBox: `0 0 ${MARK[0].length * size} ${MARK.length * size}`, 'shape-rendering': 'crispEdges', 'aria-hidden': 'true' });
  // Light and violet at the top left, deep and blue at the bottom right, a band at a time: the
  // accent's chroma, its lightness stepped from 10 points over it to 16 under and its hue from
  // 25° on one side of it to 25° on the other.
  /** @param {number} band */
  const shade = (band) => {
    const t = band / last;
    return `oklch(from var(--color-accent) calc(l + ${(0.1 - t * 0.26).toFixed(3)}) c calc(h + ${(25 - t * 50).toFixed(1)}))`;
  };
  icon.append(...pixels(MARK, 0, size, (x, y) => ({ style: `fill: ${shade(Math.floor((x + y) / 2))}` })));
  return icon;
}

/** @param {string} word */
function wordmark(word) {
  const size = 5;
  const gap = 1;
  /** @type {SVGElement[]} */
  const rects = [];
  let x = 0;
  for (const letter of word) {
    const rows = FONT[letter];
    rects.push(...pixels(rows, x, size, () => ({})));
    x += (rows[0].length + gap) * size;
  }
  const width = x - gap * size;
  const icon = svg('svg', { class: 'omp-welcome-word', viewBox: `0 0 ${width} ${FONT.c.length * size}`, 'shape-rendering': 'crispEdges', role: 'img', 'aria-label': 'Cockpit' });
  icon.append(...rects);
  return icon;
}

/** A tip's text, its `backticks` as code. @param {string} tip */
function tipText(tip) {
  return tip.split(/`([^`]+)`/).map((part, i) => (i % 2 ? el('code', 'omp-welcome-code', part) : document.createTextNode(part)));
}

/**
 * The card: the mark beside the wordmark and `version` (none while unknown), then `tip`.
 * @param {string} tip @param {string | null} version
 */
export function renderWelcome(tip, version) {
  const card = el('div', 'omp-welcome');
  const head = el('div', 'omp-welcome-head');
  const name = el('div', 'omp-welcome-name');
  name.append(wordmark('cockpit'));
  if (version) name.append(el('span', 'omp-welcome-version', `v${version}`));
  head.append(mark(), name);
  const line = el('p', 'omp-welcome-tip');
  line.append(el('span', 'omp-welcome-label', 'Tip:'), ' ', ...tipText(tip));
  card.append(head, line);
  return card;
}
