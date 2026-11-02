/**
 * GitHub comment bodies as text to read: GitHub Markdown may hold HTML (bots write comments,
 * tags and buttons into theirs), which the workbench never renders, so it is taken out and its
 * words kept. Code, inline or fenced, is left exactly as written.
 */

/** Tags GitHub's own Markdown allows, which bots use; anything else in angle brackets (a generic type, `<path>`) is text. */
const TAG = /<\/?(?:a|img|picture|source|div|span|sup|sub|details|summary|br|p|b|i|em|strong|kbd|ins|del|h[1-6]|hr|ul|ol|li|table|thead|tbody|tr|td|th|blockquote|g-emoji)(?:\s[^<>]*)?\/?>/gi;
const COMMENT = /<!--[\s\S]*?-->/g;
const FENCE = /^(`{3,}|~{3,})/;
const INLINE_CODE = /(`+)[\s\S]*?\1/g;

/** Text outside code: comments and tags out, a line break tag kept as one. @param {string} text */
const untagged = (text) =>
  text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(TAG, '')
    .replace(/&nbsp;/g, ' ');

/** @param {string} text */
function outsideInlineCode(text) {
  let out = '';
  let at = 0;
  for (const match of text.matchAll(INLINE_CODE)) {
    out += untagged(text.slice(at, match.index)) + match[0];
    at = match.index + match[0].length;
  }
  return out + untagged(text.slice(at));
}

/**
 * `body` without its HTML comments and tags (code kept as is), and without the blank lines
 * they leave behind.
 * @param {string} body
 */
export function readableBody(body) {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  let prose = [];
  /** The fence a code block was opened with, while inside one. @type {string | null} */
  let fence = null;
  const flush = () => {
    if (prose.length) out.push(...outsideInlineCode(prose.join('\n').replace(COMMENT, '')).split('\n'));
    prose = [];
  };
  for (const line of lines) {
    const open = FENCE.exec(line.trimStart());
    if (fence !== null) {
      out.push(line);
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length && !line.trim().slice(open[1].length).trim()) fence = null;
    } else if (open) {
      flush();
      fence = open[1];
      out.push(line);
    } else {
      prose.push(line);
    }
  }
  flush();
  return out
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
