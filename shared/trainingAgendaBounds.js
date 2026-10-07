import { formatInTimeZone } from 'date-fns-tz';

// Agenda rows have no offset/occurrence field. Reject ambiguous minutes rather
// than guessing which occurrence the organiser intended.
export function agendaInstant(date, time, fallback, timezone) {
  const clock = time == null || time === '' ? fallback : String(time);
  if (!/^\d{2}:\d{2}(:00)?$/.test(clock)) throw new Error('Enter a valid time (hours and minutes).');
  const local = `${date}T${clock.slice(0, 5)}:00`;
  const wall = new Date(`${local}Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !Number.isFinite(wall.getTime())
    || wall.toISOString().slice(0, 19) !== local) throw new Error('Enter a valid date and time.');
  const offsets = new Set();
  for (let hours = -48; hours <= 48; hours += 6) {
    const sample = new Date(wall.getTime() + hours * 3600000);
    const zoned = formatInTimeZone(sample, timezone, "yyyy-MM-dd'T'HH:mm:ss");
    offsets.add(new Date(`${zoned}Z`).getTime() - sample.getTime());
  }
  const candidates = [...offsets].map(offset => new Date(wall.getTime() - offset).toISOString())
    .filter(iso => formatInTimeZone(iso, timezone, "yyyy-MM-dd'T'HH:mm:ss") === local);
  if (candidates.length !== 1) throw new Error(candidates.length
    ? 'This time occurs twice when the clocks change. Choose an unambiguous agenda time.'
    : 'This time does not exist when the clocks change. Choose another agenda time.');
  return candidates[0];
}

export function deriveTrainingAgendaBounds(lines, timezone) {
  const errors = [];
  try {
    if (!timezone) throw new Error();
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
  } catch {
    return { start: null, end: null, errors: ['Choose a valid event timezone.'] };
  }
  const starts = [], ends = [];
  for (const [index, line] of (lines || []).entries()) {
    try {
      const start = agendaInstant(line.start_date, line.start_time, '00:00', timezone);
      const end = agendaInstant(line.end_date || line.start_date, line.end_time, '23:59', timezone);
      if (end < start) throw new Error('The end date/time cannot be before the start date/time.');
      starts.push(start);
      ends.push(end);
    } catch (error) {
      errors.push(`Agenda line ${index + 1}: ${error.message}`);
    }
  }
  return {
    start: errors.length ? null : starts.sort()[0] || null,
    end: errors.length ? null : ends.sort().at(-1) || null,
    errors,
  };
}
