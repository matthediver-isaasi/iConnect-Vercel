// Shared server-side CSV cell escaping for streamed admin exports.
//
// Excel's double-click opener is unreliable with embedded line breaks even
// when they are correctly RFC 4180-quoted, so cell values have any embedded
// \r / \n flattened to a single space. Combined with a UTF-8 BOM and CRLF
// row endings (see CSV_BOM / CSV_ROW_SEPARATOR), this makes the exports open
// cleanly in Excel via double-click.

// UTF-8 byte-order mark — write this as the first bytes of a streamed CSV
// response so Excel decodes non-ASCII characters (accents etc.) correctly.
export const CSV_BOM = '\ufeff';

// Excel-preferred row terminator for CSV files.
export const CSV_ROW_SEPARATOR = '\r\n';

// Escape a single CSV cell value:
// 1. Flatten embedded line breaks (\r\n, \r, \n) to a single space.
// 2. Neutralise formula-injection prefixes (=, +, -, @, tab) with a leading
//    apostrophe.
// 3. Apply RFC 4180 quoting when the value contains a comma or double-quote
//    (line breaks no longer occur after flattening).
export function escapeCsvCell(value) {
  if (value === null || value === undefined) return '';
  let str = String(value).replace(/\r\n|[\r\n]/g, ' ');
  if (/^[=+\-@\t]/.test(str)) {
    str = "'" + str;
  }
  if (str.includes(',') || str.includes('"')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
