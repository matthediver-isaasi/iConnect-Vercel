import { timezoneDiscoveryKey } from './timezoneDiscovery.js';

export const EVENT_DISPLAY_TIMEZONES_KEY = 'event_display_timezones';
export const MAX_TIMEZONE_LABEL_LENGTH = 16;

export function canonicalTimezone(value) {
  if (typeof value !== 'string' || (!value.includes('/') && value !== 'UTC')) return null;
  try { return timezoneDiscoveryKey(new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone); }
  catch { return null; }
}

export function parseEventDisplayTimezones(value) {
  try {
    const entries = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(entries)) return [];
    const seen = new Set();
    return entries.flatMap(entry => {
      const timezone = typeof entry === 'string' ? entry : entry?.timezone;
      const canonical = canonicalTimezone(timezone);
      if (!canonical || seen.has(canonical)) return [];
      seen.add(canonical);
      const label = typeof entry?.label === 'string' ? entry.label.trim().slice(0, MAX_TIMEZONE_LABEL_LENGTH) : '';
      return [{ timezone, label }];
    });
  } catch { return []; }
}

// Only timestamps carrying an explicit offset establish an instant. Date-only
// agenda values and ambiguous wall clocks must never acquire invented times.
function instant(value) {
  if (value instanceof Date) return Number.isFinite(+value) ? value : null;
  if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(+date) ? date : null;
}

export function buildEventTimeRows({ start, end, timezone, settings = [] }) {
  const config = parseEventDisplayTimezones(settings?.find?.(s => s.setting_key === EVENT_DISPLAY_TIMEZONES_KEY)?.setting_value);
  const startDate = instant(start);
  const endDate = instant(end);
  const primary = timezone || 'Europe/London';
  const primaryCanonical = canonicalTimezone(primary);
  if (!config.length || !startDate || !primaryCanonical) return [];
  const use24 = settings.some(s => s.setting_key === 'event_time_format_24h' && s.setting_value === 'true');
  const dateText = (date, zone) => new Intl.DateTimeFormat('en-GB', { timeZone: zone, day: 'numeric', month: 'short', year: 'numeric' }).format(date);
  const abbreviation = (date, zone) => new Intl.DateTimeFormat(zone.startsWith('America/') ? 'en-US' : 'en-GB', { timeZone: zone, timeZoneName: 'short' }).formatToParts(date).find(p => p.type === 'timeZoneName').value;
  const time = (date, zone) => new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: use24 ? '2-digit' : 'numeric', minute: '2-digit', hourCycle: use24 ? 'h23' : 'h12' }).format(date);
  const primaryLabel = config.find(z => canonicalTimezone(z.timezone) === primaryCanonical)?.label;
  const zones = [{ timezone: primary, label: primaryLabel }, ...config.filter(z => canonicalTimezone(z.timezone) !== primaryCanonical)];
  return zones.map(({ timezone: zone, label }) => {
    const startDay = dateText(startDate, zone);
    const endDay = endDate ? dateText(endDate, zone) : startDay;
    const startAbbr = abbreviation(startDate, zone);
    const endAbbr = endDate ? abbreviation(endDate, zone) : startAbbr;
    const changesOffset = startAbbr !== endAbbr;
    return {
      timezone: zone,
      label: label || (changesOffset ? `${startAbbr} → ${endAbbr}` : startAbbr),
      time: `${time(startDate, zone)}${changesOffset ? ` ${startAbbr}` : ''}${endDate ? ` – ${time(endDate, zone)}${changesOffset ? ` ${endAbbr}` : ''}` : ''}`,
      date: startDay !== endDay ? `${startDay} – ${endDay}` : startDay !== dateText(startDate, primary) ? startDay : '',
    };
  });
}
