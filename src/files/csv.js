/**
 * CSV and TSV as the file window (widgets/file.js) renders them: a table, drawn as an agent
 * reply's Markdown tables are (omp/markdown-dom.js `renderTable`), so it looks and copies the same.
 *
 * Read as RFC 4180 says: fields split by the delimiter, a field in double quotes may hold the
 * delimiter, line breaks and `""` for a quote; records end at `\n` or `\r\n`. Blank lines are
 * skipped. The first record is the header. Rows shorter than the widest get empty cells, so no
 * value is dropped.
 */
/** @import { Align, Inline, TableBlock } from '../omp/markdown.js' */

/** Past this many rows a table shows only the first ones, and says so: the source has them all. */
const MAX_TABLE_ROWS = 5000;

/** The delimiter of the table file `path` names, or null for any other file. @param {string} path */
export function tableDelimiter(path) {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return ext === 'csv' ? ',' : ext === 'tsv' ? '\t' : null;
}

/**
 * The records of `text`, each a list of fields.
 * @param {string} text @param {string} delimiter one character
 * @returns {string[][]}
 */
function parseDelimited(text, delimiter) {
  /** @type {string[][]} */
  const records = [];
  /** @type {string[]} */
  let record = [];
  let field = '';
  let quoted = false;
  /** Whether the record has anything in it yet: a blank line is not a record. */
  let started = false;
  const endRecord = () => {
    if (started) records.push([...record, field]);
    record = [];
    field = '';
    started = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') field += text[i++];
      else quoted = false;
    } else if (ch === '"' && field === '') {
      quoted = started = true;
    } else if (ch === delimiter) {
      record.push(field);
      field = '';
      started = true;
    } else if (ch === '\n' || (ch === '\r' && text[i + 1] === '\n')) {
      if (ch === '\r') i++;
      endRecord();
    } else {
      field += ch;
      started = true;
    }
  }
  endRecord();
  return records;
}

/** A field as table cell content: its line breaks kept. @param {string} field @returns {Inline[]} */
const cellOf = (field) =>
  field.split(/\r?\n/).flatMap((line, i) => /** @type {Inline[]} */ (i === 0 ? [{ type: 'text', text: line }] : [{ type: 'break' }, { type: 'text', text: line }]));

/** A field as a Markdown table cell (for Copy as Markdown). @param {string} field */
const markdownCell = (field) => field.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');

const NUMBER = /^\s*[-+]?(\d[\d,_]*)?(\.\d+)?([eE][-+]?\d+)?\s*%?\s*$/;

/**
 * `text` as a table: the first record its header, at most `max` rows after it; `shown` of
 * `total` rows. A column of numbers (blank cells aside) is aligned right. Null when there is no
 * record at all.
 * @param {string} text @param {string} delimiter @param {number} [max]
 * @returns {{ block: TableBlock, shown: number, total: number } | null}
 */
export function delimitedTable(text, delimiter, max = MAX_TABLE_ROWS) {
  const records = parseDelimited(text, delimiter);
  if (!records.length) return null;
  const width = Math.max(...records.map((r) => r.length));
  const pad = (/** @type {string[]} */ r) => Array.from({ length: width }, (_, c) => r[c] ?? '');
  const [head, ...all] = records.map(pad);
  const rows = all.slice(0, max);
  /** @type {Align[]} */
  const align = head.map((_, c) => {
    const values = rows.map((r) => r[c]).filter((v) => v.trim() !== '');
    return values.length && values.every((v) => NUMBER.test(v) && /\d/.test(v)) ? 'right' : null;
  });
  const line = (/** @type {string[]} */ r) => `| ${r.map(markdownCell).join(' | ')} |`;
  const divider = `| ${align.map((a) => (a === 'right' ? '---:' : '---')).join(' | ')} |`;
  const source = [line(head), divider, ...rows.map(line)].join('\n');
  return {
    block: { type: 'table', align, head: head.map(cellOf), rows: rows.map((r) => r.map(cellOf)), source },
    shown: rows.length,
    total: all.length,
  };
}
