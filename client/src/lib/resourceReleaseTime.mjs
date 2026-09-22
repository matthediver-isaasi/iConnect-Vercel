// datetime-local values are wall-clock times in the browser's timezone, not UTC.
export function resourceReleaseLocalValue(instant) {
  if (!instant) return '';
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function resourceReleaseInstant(localValue, previousInstant) {
  if (!localValue) return null;
  // Preserve seconds, milliseconds and the original offset in a DST overlap
  // when an input is unchanged (including an explicit same-value change).
  if (previousInstant && localValue === resourceReleaseLocalValue(previousInstant)) {
    return previousInstant;
  }
  const date = new Date(localValue);
  if (!Number.isFinite(date.getTime()) || resourceReleaseLocalValue(date) !== localValue) {
    throw new Error('Choose a valid local release date and time.');
  }
  return date.toISOString();
}