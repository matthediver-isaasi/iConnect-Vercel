// In-memory support trace only. No storage, telemetry, URLs, identifiers,
// targeting values, response bodies or error messages are retained.
const entries = [];
const stages = new Set(["resolve_tenant", "resolve_viewer", "page", "microsite", "candidates", "fields", "audience", "preferences", "design", "preference_write", "total"]);
let sequence = 0;
export const nextPopupDiagnosticId = () => ++sequence;
export const popupDiagnosticSnapshot = () => JSON.stringify(entries, null, 2);

export function popupDiagnostic(event, details = {}) {
  try {
    const entry = { atMs: Math.round(performance.now()), event };
    // These string values are internal codes only, never derived from user data.
    for (const key of ["reason", "kind", "cause"]) {
      if (typeof details[key] === "string" && /^[a-z_]{1,60}$/.test(details[key])) entry[key] = details[key];
    }
    for (const key of ["request", "instance", "status", "durationMs", "ageMs", "candidateCount", "eligibleCount"]) {
      if (Number.isFinite(details[key])) entry[key] = Math.round(details[key]);
    }
    if (details.serverTiming) {
      entry.serverMs = {};
      for (const part of String(details.serverTiming).split(",")) {
        const match = part.trim().match(/^([a-z_]+);dur=(\d+(?:\.\d+)?)$/);
        if (match && stages.has(match[1])) entry.serverMs[match[1]] = Number(match[2]);
      }
    }
    entries.push(entry);
    if (entries.length > 250) entries.shift();
    if (typeof window !== "undefined") {
      window.iconnectPopupDiagnostics = popupDiagnosticSnapshot;
      if (new URLSearchParams(window.location.search).get("popupDebug") === "1") console.info("[CMS popup]", entry);
    }
  } catch { /* Diagnostics must never affect delivery. */ }
}

export function popupRequestKind(query, method) {
  if (method === "POST") return "preference_write";
  const params = new URLSearchParams(query);
  if (params.has("id")) return params.get("revalidate") === "1" ? "content_recheck" : "selected_content";
  if (params.has("page_slug")) return "early_eligibility";
  return params.get("revalidate") === "1" ? "eligibility_recheck" : "eligibility";
}

export function popupFailureReason(error) {
  return error?.message === "Popup eligibility request timed out." ? "timeout"
    : error?.name === "AbortError" || error?.message === "Popup request cancelled." ? "cancelled" : "request_failed";
}
