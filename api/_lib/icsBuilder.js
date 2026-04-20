const ICS_DOMAIN = 'events.tendo.app';
const PRODID = '-//Tendo//Event Confirmation//EN';

function pad(n) {
  return String(n).padStart(2, '0');
}

function toIcsUtc(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return null;
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    'T' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    'Z'
  );
}

function isValidTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function getTzOffsetMinutes(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(date).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  const hour = parts.hour === '24' ? '00' : parts.hour;
  const asUtc = Date.UTC(
    parseInt(parts.year, 10),
    parseInt(parts.month, 10) - 1,
    parseInt(parts.day, 10),
    parseInt(hour, 10),
    parseInt(parts.minute, 10),
    parseInt(parts.second, 10)
  );
  return Math.round((asUtc - date.getTime()) / 60000);
}

function formatOffsetIcs(minutes) {
  const sign = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

function toIcsLocal(value, timeZone) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return null;
  const offsetMin = getTzOffsetMinutes(d, timeZone);
  const local = new Date(d.getTime() + offsetMin * 60000);
  return (
    local.getUTCFullYear().toString() +
    pad(local.getUTCMonth() + 1) +
    pad(local.getUTCDate()) +
    'T' +
    pad(local.getUTCHours()) +
    pad(local.getUTCMinutes()) +
    pad(local.getUTCSeconds())
  );
}

function buildVTimezone(timeZone, referenceDate) {
  // Emit a minimal, conservative VTIMEZONE declaring the actual offset
  // active at the event time in the given IANA zone. We deliberately do
  // NOT emit RRULE recurrence rules because real DST transition rules
  // vary widely between zones (and over time) and we don't bundle a
  // tzdata library. Modern calendar clients (Apple, Google, Outlook)
  // recognise the TZID against their built-in IANA database and use
  // that for rendering; clients that fall back to the VTIMEZONE block
  // will still display the correct offset for this specific event.
  const ref = referenceDate instanceof Date && !isNaN(referenceDate.getTime())
    ? referenceDate
    : new Date();
  const offsetMin = getTzOffsetMinutes(ref, timeZone);
  const offsetStr = formatOffsetIcs(offsetMin);
  const localDtstart = toIcsLocal(ref, timeZone) || '19700101T000000';

  const lines = [
    'BEGIN:VTIMEZONE',
    `TZID:${timeZone}`,
    `X-LIC-LOCATION:${timeZone}`,
    'BEGIN:STANDARD',
    `DTSTART:${localDtstart}`,
    `TZOFFSETFROM:${offsetStr}`,
    `TZOFFSETTO:${offsetStr}`,
    'END:STANDARD',
    'END:VTIMEZONE',
  ];

  return lines.map(foldLine).join('\r\n');
}

function escapeText(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n/g, '\\n');
}

function stripHtml(value) {
  if (!value) return '';
  return String(value)
    .replace(/<br\s*\/?>(?=)/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function foldLine(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;

  const out = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + (start === 0 ? 75 : 74), bytes.length);
    while (end > start && (bytes[end] & 0xc0) === 0x80) {
      end--;
    }
    const chunk = bytes.slice(start, end).toString('utf8');
    out.push(start === 0 ? chunk : ' ' + chunk);
    start = end;
  }
  return out.join('\r\n');
}

function buildVEvent(entry, dtstamp) {
  const tz = entry.timeZone && isValidTimeZone(entry.timeZone) ? entry.timeZone : null;

  let dtStartLine;
  let dtEndLine;
  if (tz) {
    const ds = toIcsLocal(entry.start, tz);
    const de = toIcsLocal(entry.end, tz);
    if (!ds || !de) return null;
    dtStartLine = `DTSTART;TZID=${tz}:${ds}`;
    dtEndLine = `DTEND;TZID=${tz}:${de}`;
  } else {
    const ds = toIcsUtc(entry.start);
    const de = toIcsUtc(entry.end);
    if (!ds || !de) return null;
    dtStartLine = `DTSTART:${ds}`;
    dtEndLine = `DTEND:${de}`;
  }

  const lines = [
    'BEGIN:VEVENT',
    `UID:${entry.uid}`,
    `DTSTAMP:${dtstamp}`,
    dtStartLine,
    dtEndLine,
    `SUMMARY:${escapeText(entry.title || '')}`,
  ];

  if (entry.description) {
    lines.push(`DESCRIPTION:${escapeText(stripHtml(entry.description))}`);
  }
  if (entry.location) {
    lines.push(`LOCATION:${escapeText(entry.location)}`);
  }
  if (entry.url) {
    lines.push(`URL:${escapeText(entry.url)}`);
  }

  lines.push('STATUS:CONFIRMED');
  lines.push('TRANSP:OPAQUE');
  lines.push('END:VEVENT');

  return lines.map(foldLine).join('\r\n');
}

export function buildIcs(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;

  const dtstamp = toIcsUtc(new Date());
  const veventBlocks = entries
    .map(e => buildVEvent(e, dtstamp))
    .filter(Boolean);

  if (veventBlocks.length === 0) return null;

  const tzMap = new Map();
  for (const entry of entries) {
    if (entry.timeZone && isValidTimeZone(entry.timeZone) && !tzMap.has(entry.timeZone)) {
      const refDate = entry.start instanceof Date ? entry.start : new Date(entry.start);
      tzMap.set(entry.timeZone, isNaN(refDate.getTime()) ? new Date() : refDate);
    }
  }
  const vtimezoneBlocks = Array.from(tzMap.entries()).map(([tz, ref]) => buildVTimezone(tz, ref));

  const header = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ].map(foldLine).join('\r\n');

  const footer = 'END:VCALENDAR';

  const middle = [...vtimezoneBlocks, ...veventBlocks].join('\r\n');

  return header + '\r\n' + middle + '\r\n' + footer + '\r\n';
}

export function buildEventUid(bookingId, eventId) {
  return `booking-${bookingId || 'na'}-event-${eventId || 'na'}@${ICS_DOMAIN}`;
}

export function buildSessionUid(bookingId, sessionId) {
  return `booking-${bookingId || 'na'}-session-${sessionId || 'na'}@${ICS_DOMAIN}`;
}
