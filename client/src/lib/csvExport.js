// Self-contained client-side CSV helpers. No external dependencies.

// Escape a single CSV cell: flatten embedded line breaks to a single space
// (Excel's double-click opener often splits quoted multi-line values across
// rows), wrap in double-quotes when the value contains a comma or
// double-quote, and double any embedded quotes (RFC 4180).
function escapeCsvCell(value) {
  if (value === null || value === undefined) return "";
  const str = String(value).replace(/\r\n|[\r\n]/g, " ");
  if (/[",]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// Convert an array of row arrays into a CSV string. Each row is an array of
// cell values. A leading row of header strings can be passed as the first
// element like any other row.
export function rowsToCsv(rows) {
  return (rows || [])
    .map((row) => (row || []).map(escapeCsvCell).join(","))
    .join("\r\n");
}

// Turn an arbitrary title into a safe, lowercase, hyphenated filename stem.
// Falls back to `fallback` when the title is empty or strips to nothing.
export function slugifyFilename(title, fallback = "export") {
  const slug = String(title || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

// Trigger a browser download of `csv` text as a file named `filename`.
export function downloadCsv(csv, filename) {
  // Prepend a UTF-8 BOM so Excel reads non-ASCII characters correctly.
  const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
