// Training-event agenda helpers for email paths (Task #3419).
//
// - fetchTrainingAgendaData(eventId): agenda lines (+ resolved zoom join urls)
//   and a rendered {{agenda_schedule}} HTML block for confirmation/reminder emails.
// - applyAgendaPlaceholders(template, { agendaData, line }): substitutes
//   {{agenda_schedule}} plus per-line tokens ({{agenda_line_date}},
//   {{agenda_line_type}}, {{agenda_line_description}}, {{agenda_line_detail}})
//   used when a Training reminder fires for one specific agenda line.

import { supabase } from './database.js';

// Agenda values are admin-entered free text destined for HTML email bodies —
// escape everything and only allow http(s) URLs (defence against stored HTML
// injection in confirmation/reminder emails).
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function safeHttpUrl(url) {
  const s = String(url || '').trim();
  return /^https?:\/\//i.test(s) ? s : '';
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  try {
    return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
    });
  } catch {
    return dateStr;
  }
}

function formatTime(timeStr) {
  const m = String(timeStr || '').match(/^(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : '';
}

export function formatAgendaLineDates(line) {
  if (!line?.start_date) return '';
  const startTime = formatTime(line.start_time);
  const endTime = formatTime(line.end_time);
  const start = formatDate(line.start_date) + (startTime ? `, ${startTime}` : '');
  if (line.end_date && line.end_date !== line.start_date) {
    return `${start} – ${formatDate(line.end_date)}${endTime ? `, ${endTime}` : ''}`;
  }
  if (endTime) return `${start} – ${endTime}`;
  return start;
}

/** Human-readable per-line detail: location / join link / LMS link. */
export function agendaLineDetail(line) {
  if (!line) return '';
  if (line.location) return line.location;
  const join = safeHttpUrl(line.zoom_join_url);
  if (join) return `Join link: ${join}`;
  const lms = safeHttpUrl(line.lms_url);
  if (lms) return `Learning platform: ${lms}`;
  return '';
}

export async function fetchTrainingAgendaData(eventId, client = supabase) {
  if (!eventId || !client) return null;
  const { data: lines, error } = await client
    .from('event_agenda_item')
    .select('id, start_date, start_time, end_date, end_time, description, item_type, location, zoom_webinar_id, zoom_meeting_id, lms_url, sort_order')
    .eq('event_id', eventId)
    .order('start_date', { ascending: true })
    .order('start_time', { ascending: true, nullsFirst: true })
    .order('sort_order', { ascending: true });
  if (error) {
    console.error('[trainingAgenda] agenda fetch error:', error.message);
    return null;
  }
  if (!lines || lines.length === 0) return { lines: [], agendaScheduleHtml: '' };

  // Resolve zoom join urls (local PKs on the line).
  const webinarIds = [...new Set(lines.map((l) => l.zoom_webinar_id).filter(Boolean))];
  const meetingIds = [...new Set(lines.map((l) => l.zoom_meeting_id).filter(Boolean))];
  const joinByWebinar = {};
  const joinByMeeting = {};
  if (webinarIds.length > 0) {
    const { data } = await client.from('zoom_webinar').select('id, join_url, topic').in('id', webinarIds);
    for (const w of data || []) joinByWebinar[w.id] = w;
  }
  if (meetingIds.length > 0) {
    const { data } = await client.from('zoom_meeting').select('id, join_url, topic').in('id', meetingIds);
    for (const m of data || []) joinByMeeting[m.id] = m;
  }
  for (const line of lines) {
    const z = (line.zoom_webinar_id && joinByWebinar[line.zoom_webinar_id]) ||
      (line.zoom_meeting_id && joinByMeeting[line.zoom_meeting_id]) || null;
    line.zoom_join_url = z?.join_url || null;
    line.zoom_topic = z?.topic || null;
  }

  const rows = lines.map((line) => {
    const dates = escapeHtml(formatAgendaLineDates(line));
    const detail = escapeHtml(agendaLineDetail(line));
    return `<tr>
      <td style="padding:6px 12px 6px 0; vertical-align:top; white-space:nowrap;"><strong>${dates}</strong></td>
      <td style="padding:6px 12px 6px 0; vertical-align:top;">${escapeHtml(line.item_type || '')}</td>
      <td style="padding:6px 0; vertical-align:top;">${escapeHtml(line.description || '')}${detail ? `<br/><span style="color:#475569;">${detail}</span>` : ''}</td>
    </tr>`;
  }).join('');

  const agendaScheduleHtml = `<table style="border-collapse:collapse; width:100%; font-size:14px;"><tbody>${rows}</tbody></table>`;
  return { lines, agendaScheduleHtml };
}

export function applyAgendaPlaceholders(template, { agendaData, line } = {}) {
  let result = template || '';
  const scheduleHtml = agendaData?.agendaScheduleHtml || '';
  if (scheduleHtml) {
    result = result.replace(/\{\{#agenda_schedule\}\}([\s\S]*?)\{\{\/agenda_schedule\}\}/gi, '$1');
  } else {
    result = result.replace(/\{\{#agenda_schedule\}\}[\s\S]*?\{\{\/agenda_schedule\}\}/gi, '');
  }
  result = result.replace(/\{\{agenda_schedule\}\}/gi, scheduleHtml);
  result = result.replace(/\[\[agenda_schedule\]\]/gi, scheduleHtml);

  // Per-line tokens are admin-entered free text landing in HTML email bodies:
  // escape them, and use replacer functions so '$' sequences in values are
  // never treated as regex replacement patterns.
  const dates = escapeHtml(line ? formatAgendaLineDates(line) : '');
  const detail = escapeHtml(line ? agendaLineDetail(line) : '');
  const type = escapeHtml(line?.item_type || '');
  const description = escapeHtml(line?.description || '');
  result = result.replace(/\{\{agenda_line_date\}\}/gi, () => dates);
  result = result.replace(/\[\[agenda_line_date\]\]/gi, () => dates);
  result = result.replace(/\{\{agenda_line_type\}\}/gi, () => type);
  result = result.replace(/\[\[agenda_line_type\]\]/gi, () => type);
  result = result.replace(/\{\{agenda_line_description\}\}/gi, () => description);
  result = result.replace(/\[\[agenda_line_description\]\]/gi, () => description);
  result = result.replace(/\{\{agenda_line_detail\}\}/gi, () => detail);
  result = result.replace(/\[\[agenda_line_detail\]\]/gi, () => detail);
  return result;
}
