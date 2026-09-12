/**
 * CSV generation for results export.
 *
 * Two things here are security-relevant rather than cosmetic:
 *
 * 1. FORMULA INJECTION. A cell beginning with `=`, `+`, `-`, `@`, TAB or CR is
 *    executed as a formula by Excel, Google Sheets and LibreOffice when the file
 *    is opened. Since cells here contain attacker-chosen text (an IGN, an option
 *    name typed by an admin), every such cell is prefixed with an apostrophe.
 *    Without this, an IGN of `=HYPERLINK("http://evil","Click")` runs the moment
 *    an organiser opens the export.
 *
 * 2. The UTF-8 BOM. Excel on Windows assumes the local ANSI codepage without it,
 *    which mangles every non-ASCII IGN in the file.
 */

/** Characters that make a spreadsheet treat a cell as a formula. */
const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

const BOM = '﻿';

export type CsvCell = string | number | boolean | Date | null | undefined;

function stringifyCell(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/** Neutralise formula-triggering cells and quote per RFC 4180. */
export function escapeCsvCell(value: CsvCell): string {
  let text = stringifyCell(value);

  if (text.length > 0 && FORMULA_PREFIXES.some((prefix) => text.startsWith(prefix))) {
    text = `'${text}`;
  }

  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

/**
 * Build a complete CSV document from a header row and body rows.
 * CRLF line endings, because that is what RFC 4180 and Excel expect.
 */
export function toCsv(headers: readonly string[], rows: readonly CsvCell[][]): string {
  const lines = [
    headers.map(escapeCsvCell).join(','),
    ...rows.map((row) => row.map(escapeCsvCell).join(',')),
  ];

  return BOM + lines.join('\r\n') + '\r\n';
}

/**
 * Safe `Content-Disposition` filename.
 *
 * The name is derived from an admin-supplied event title, so it is reduced to a
 * conservative character set: a quote or newline here would let the title break
 * out of the header and inject one of its own.
 */
export function csvFilename(base: string, extension = 'csv'): string {
  const safe = base
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  const stamp = new Date().toISOString().slice(0, 10);

  return `${safe || 'export'}-${stamp}.${extension}`;
}
