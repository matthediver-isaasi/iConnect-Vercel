import { isValid, parseISO } from "date-fns";

// Compare event-local wall times, using the editor's existing conversion.
// The caller supplies only the current (including unsaved) session collection.
export function latestSessionStart(sessions, toLocalDatetimeStr) {
  let latest = "";
  for (const session of sessions) {
    const start = session?.start_time;
    if (!start || (typeof start === "string" && !isValid(parseISO(start)))) continue;
    const local = toLocalDatetimeStr(start);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local) || !isValid(parseISO(local))) continue;
    if (local > latest) latest = local;
  }
  return latest;
}
