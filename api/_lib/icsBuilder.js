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
  const dtStart = toIcsUtc(entry.start);
  const dtEnd = toIcsUtc(entry.end);
  if (!dtStart || !dtEnd) return null;

  const lines = [
    'BEGIN:VEVENT',
    `UID:${entry.uid}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
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

  const header = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ].map(foldLine).join('\r\n');

  const footer = 'END:VCALENDAR';

  return header + '\r\n' + veventBlocks.join('\r\n') + '\r\n' + footer + '\r\n';
}

export function buildEventUid(bookingId, eventId) {
  return `booking-${bookingId || 'na'}-event-${eventId || 'na'}@${ICS_DOMAIN}`;
}

export function buildSessionUid(bookingId, sessionId) {
  return `booking-${bookingId || 'na'}-session-${sessionId || 'na'}@${ICS_DOMAIN}`;
}
