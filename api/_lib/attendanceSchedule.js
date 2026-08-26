import { fromZonedTime } from 'date-fns-tz';

/** Convert the agenda's local date/time using the event's canonical timezone. */
export function agendaScheduledEndAt(endDate, endTime, timezone) {
  if (!endDate || !endTime) return null;
  return fromZonedTime(`${endDate}T${endTime}`, timezone || 'UTC').toISOString();
}