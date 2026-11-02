/**
 * Plain-text forms of a parsed Markdown table: a cell's text without its formatting, and the table as CSV.
 */
/** @import { Inline, TableBlock } from './markdown.js' */

/**
 * The text a reader sees in `inlines`: formatting dropped, line breaks kept as `\n`.
 * @param {Inline[]} inlines @returns {string}
 */
export function inlineText(inlines) {
  return inlines
    .map((node) => {
      if (node.type === 'text' || node.type === 'code') return node.text;
      if (node.type === 'break') return '\n';
      if (node.type === 'math') return node.tex; // its TeX, the closest plain text there is
      if (node.type === 'image') return node.alt;
      return inlineText(node.children);
    })
    .join('');
}

/**
 * One CSV field, quoted per RFC 4180 when it holds a comma, quote or line break, or
 * starts or ends with whitespace (which spreadsheet imports would otherwise trim).
 * @param {string} field
 */
const csvField = (field) => (/[",\r\n]|^\s|\s$/.test(field) ? `"${field.replaceAll('"', '""')}"` : field);

/** The table as CSV, header first, records separated by `\n`. @param {TableBlock} table */
export function tableCsv(table) {
  return [table.head, ...table.rows].map((row) => row.map((cell) => csvField(inlineText(cell))).join(',')).join('\n');
}
