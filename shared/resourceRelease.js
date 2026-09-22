// release_date is a nullable timestamp. Empty legacy client values mean no
// schedule; invalid non-empty dates fail closed.
export function isResourceReleased(resource, now = Date.now()) {
  if (!resource) return false;
  const value = resource.release_date;
  if (value == null || (typeof value === 'string' && value.trim() === '')) return true;
  if (typeof value !== 'string') return false;
  const releaseAt = Date.parse(value);
  const instant = new Date(now).getTime();
  return Number.isFinite(releaseAt) && Number.isFinite(instant) && releaseAt <= instant;
}

export function resourceReleaseFilter(now = Date.now()) {
  // Do not compare a timestamp column to ''; PostgreSQL rejects that literal.
  return `release_date.is.null,release_date.lte.${new Date(now).toISOString()}`;
}

export function applyResourceReleaseFilter(query, now = Date.now()) {
  return query.or(resourceReleaseFilter(now));
}