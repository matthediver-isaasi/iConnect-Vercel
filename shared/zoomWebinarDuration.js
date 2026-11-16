// Preserve the API/database contract: a positive whole number of minutes.
export const WEBINAR_DURATION_ERROR = 'Enter a duration of at least 1 minute using whole hours and minutes (0–59).';
export function isValidWebinarDuration(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2147483647;
}
export function webinarDurationFromParts(hours, minutes) {
  if (!/^\d+$/.test(String(hours)) || !/^\d+$/.test(String(minutes))) return null;
  const h = Number(hours), m = Number(minutes);
  if (!Number.isSafeInteger(h) || !Number.isInteger(m) || m > 59) return null;
  const total = h * 60 + m;
  return isValidWebinarDuration(total) ? total : null;
}
