export const PUBLICATION_IMPORT_ENDPOINT = "/api/article-briefs/publication-import";
export const MAX_WORKBOOK_BYTES = 1024 * 1024;

export function validateWorkbook(file) {
  if (!file) return "Choose an XLSX workbook.";
  if (!/\.xlsx$/i.test(file.name)) return "Use an .xlsx workbook. Download the template to get started.";
  if (!file.size) return "The workbook is empty. Save your spreadsheet and try again.";
  if (file.size > MAX_WORKBOOK_BYTES) return "The workbook exceeds 1 MB. Split it into smaller workbooks with no more than 100 rows each.";
  return null;
}

export function canApplyPreview(preview) {
  return Boolean(preview?.planId && preview.canApply === true &&
    !preview.needsSheetSelection && Array.isArray(preview.rows) &&
    preview.rows.length > 0 && preview.rows.length <= 100 &&
    preview.rows.every(row => ["create", "skip"].includes(row.action) && !(row.errors?.length)));
}

export function displayImportValue(value) {
  if (value == null || value === "") return "Not set";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.length ? value.map(displayImportValue).join("; ") : "None";
  if (typeof value === "object") {
    return Object.entries(value).map(([key, item]) => `${fieldLabel(key)}: ${displayImportValue(item)}`).join(" · ") || "Not set";
  }
  return String(value);
}

export function fieldLabel(key) {
  return String(key).replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, c => c.toUpperCase());
}

// A receipt must account for every row. Never turn a truncated/malformed 2xx
// response into a reassuring zero-count success; keep its plan retryable.
export function validateImportReceipt(data, expectedRows) {
  if (!data || typeof data.done !== "boolean" ||
    !["created", "skipped", "failed"].every(key => Number.isSafeInteger(data[key]) && data[key] >= 0) ||
    !Array.isArray(data.rows) || !data.rows.every(row => row && typeof row === "object" &&
      !Array.isArray(row) && Number.isSafeInteger(row.row) && row.row > 0)) return false;
  const processed = data.created + data.skipped + data.failed;
  return processed <= expectedRows && data.rows.length === processed &&
    new Set(data.rows.map(row => row.row)).size === data.rows.length &&
    (!data.done || processed === expectedRows);
}

export async function postPublicationImport(body) {
  const response = await fetch(PUBLICATION_IMPORT_ENDPOINT, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(typeof data.error === "string" ? data.error : data.error?.message || data.message || `Import request failed (${response.status}).`);
    error.status = response.status;
    // Timeouts/rate limits, 5xx errors and transport failures have an unknown
    // outcome. Explicit validation/auth/expired/stale rejections allow repreview.
    error.definitive = [400, 401, 403, 404, 409, 410, 413, 415, 422].includes(response.status);
    throw error;
  }
  return data;
}
