import { fromZonedTime } from 'date-fns-tz';

/** Convert a local wall-clock datetime using an explicit IANA timezone. */
export function localDateTimeToIso(dateTime, timezone) {
  if (!dateTime) return null;
  const value = String(dateTime);
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(value)) return new Date(value).toISOString();
  return fromZonedTime(value, timezone || 'UTC').toISOString();
}

/** Convert the agenda's local date/time using the event's canonical timezone. */
export function agendaScheduledEndAt(endDate, endTime, timezone) {
  if (!endDate || !endTime) return null;
  return localDateTimeToIso(`${endDate}T${endTime}`, timezone);
}

export function agendaScheduledEndAtWithFallback(endDate, endTime, timezone) {
  if (!endDate) return null;
  return agendaScheduledEndAt(endDate, endTime, timezone)
    || fromZonedTime(`${endDate}T23:59:59`, timezone || 'UTC').toISOString();
}