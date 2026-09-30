// Shared resolver for dynamic tokens in static field-mapping values.
//
// Used by BOTH executors that persist static mapping values into member/org
// custom fields:
//   - api/due-diligence/_stageActions.js (executeFieldMappingActions static branch)
//   - api/forms/process-application.js (all static-value call sites)
//
// Keep the two paths on this single implementation. If a new token is added
// (e.g. {now}, {today+30d}) or timezone handling changes, doing it here keeps
// both executors in sync and prevents the literal token from being stored on
// one path only (the go_live backfill class of bug).

// Resolve the dynamic {today} token in a static mapping value to the current
// UTC date as YYYY-MM-DD. Matching is trim + lowercase, so "{Today}" and
// " {TODAY} " also resolve. Any other value is returned unchanged.
export const resolveStaticTodayToken = (value) => {
  if (typeof value === 'string' && value.trim().toLowerCase() === '{today}') {
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
  return value;
};
