/**
 * A scratchpad's text as blocks to edit: runs of text, and the images and files it references,
 * kept free of the DOM so the round trip can be tested.
 *
 * A file is a line of its own that is only a Markdown link to a pad asset:
 * `![name](<id>.assets/<file>)` for an image, `[name](<id>.assets/<file>)` for anything else.
 * Every other line is text. Turning blocks back into text joins them with newlines and drops
 * empty text blocks, which is what makes the empty gaps shown around images free: typing into
 * one adds it, leaving it empty adds nothing.
 */

/**
 * @typedef {{ kind: 'text', text: string }} TextBlock
 * @typedef {{ kind: 'image' | 'file', name: string, path: string }} AssetBlock
 * @typedef {TextBlock | AssetBlock} Block
 */

/** Pad ids are path segments on the daemon; nothing else gets near the filesystem. */
export const PAD_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** The pad a window shows when its params name no valid pad. */
export const DEFAULT_PAD = 'scratchpad';
/** A stored asset's file name. */
export const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Shown inline by the browser, by extension; the daemon serves anything else as a download. */
export const IMAGE_TYPES = /** @type {Record<string, string>} */ ({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
});

const ASSET_LINE = new RegExp(`^(!?)\\[([^\\]]*)\\]\\((${PAD_ID.source.slice(1, -1)}\\.assets/${ASSET_NAME.source.slice(1, -1)})\\)$`);

const TITLE_CHARS = 80;

/** A pad's name: its first line of text, without Markdown markers. @param {string} text */
export function titleOf(text) {
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || ASSET_LINE.test(line)) continue;
    const title = line.replace(/^(#+|[-*+>]|\d+[.)])\s+/, '').trim();
    if (title) return title.length > TITLE_CHARS ? `${title.slice(0, TITLE_CHARS - 1)}…` : title;
  }
  return '';
}

/** @param {string} text @returns {Block[]} */
export function parseBlocks(text) {
  /** @type {Block[]} */
  const blocks = [];
  /** @type {string[]} */
  let run = [];
  const flush = () => {
    if (run.length) blocks.push({ kind: 'text', text: run.join('\n') });
    run = [];
  };
  for (const line of text.split('\n')) {
    const asset = ASSET_LINE.exec(line);
    if (!asset) {
      run.push(line);
      continue;
    }
    flush();
    blocks.push({ kind: asset[1] ? 'image' : 'file', name: asset[2], path: asset[3] });
  }
  flush();
  return blocks;
}

/** @param {AssetBlock} block */
const assetLine = (block) => `${block.kind === 'image' ? '!' : ''}[${block.name.replace(/[[\]\n]/g, '')}](${block.path})`;

/** @param {readonly Block[]} blocks */
export const serializeBlocks = (blocks) =>
  blocks
    .filter((b) => b.kind !== 'text' || b.text !== '')
    .map((b) => (b.kind === 'text' ? b.text : assetLine(b)))
    .join('\n');

/**
 * The blocks with an empty text block wherever there is nowhere to type: before a leading
 * file, after a trailing one, between two files, and in an empty pad.
 * @param {readonly Block[]} blocks @returns {Block[]}
 */
export function withGaps(blocks) {
  /** @type {Block[]} */
  const out = [];
  for (const block of blocks) {
    const previous = out.at(-1);
    if (block.kind !== 'text' && (!previous || previous.kind !== 'text')) out.push({ kind: 'text', text: '' });
    out.push(block);
  }
  if (out.at(-1)?.kind !== 'text') out.push({ kind: 'text', text: '' });
  return out;
}

/**
 * Puts `asset` into text block `index` at `caret`, splitting the text around it.
 * @param {readonly Block[]} blocks @param {number} index @param {number} caret @param {AssetBlock} asset
 * @returns {Block[]}
 */
export function insertAsset(blocks, index, caret, asset) {
  const target = blocks[index];
  if (!target || target.kind !== 'text') return [...blocks, asset];
  // Split at the caret, dropping the newline it sits next to: the file takes a line of its own.
  const before = target.text.slice(0, caret).replace(/\n$/, '');
  const after = target.text.slice(caret).replace(/^\n/, '');
  return blocks.toSpliced(index, 1, { kind: 'text', text: before }, asset, { kind: 'text', text: after });
}

/** Where the browser loads a pad asset from. @param {string} path `<id>.assets/<file>` */
export function assetUrl(path) {
  const [dir, name] = path.split('/');
  return `/api/scratchpads/${encodeURIComponent(dir.replace(/\.assets$/, ''))}/assets/${encodeURIComponent(name)}`;
}
