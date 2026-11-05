export function tenantDateTime(iso, timezone = "UTC") {
  if (!iso) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}
// Enumerate offsets rather than silently shifting nonexistent DST wall times.
// Ambiguous fall-back times require the editor to select a different minute.
export function tenantDateTimeToUtc(local, timezone = "UTC") {
  if (!local) return null;
  const wall = Date.parse(`${local}:00Z`);
  if (!Number.isFinite(wall)) throw new Error("Enter a valid schedule date.");
  const matches = [];
  for (let offset = -14 * 60; offset <= 14 * 60; offset += 15) {
    const candidate = new Date(wall + offset * 60000).toISOString();
    if (tenantDateTime(candidate, timezone) === local) matches.push(candidate);
  }
  if (matches.length !== 1) throw new Error(matches.length ? "This time occurs twice at the daylight-saving transition. Choose an unambiguous time." : "This local time does not exist in the tenant timezone.");
  return matches[0];
}
