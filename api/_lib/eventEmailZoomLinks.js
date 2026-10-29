import { getZoomAccessTokenForTenant } from './zoomClient.js';
import { readZoomRegistration, zoomRequest } from './zoomRegistration.js';
import { buildAgendaScheduleHtml } from './trainingAgenda.js';

export function personalisedZoomUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !/(^|\.)zoom\.(us|com)$/.test(url.hostname)
      || !/^\/(j|w)\/\d+/.test(url.pathname) || url.searchParams.has('zak')
      || !url.searchParams.get('tk')) return null;
    return url.href;
  } catch { return null; }
}

// Request-local cache only. Never cache a recipient's URL across deliveries.
// These are strictly reads: previews and reminders cannot register attendees.
export function createEventEmailZoomResolver(db, tenantId, email, { sample = false, getToken = getZoomAccessTokenForTenant, readSettings = readZoomRegistration, request = zoomRequest } = {}) {
  const cache = new Map();
  return async function resolve(target) {
    const webinar = Boolean(target?.zoom_webinar_id);
    const localId = target?.zoom_webinar_id || target?.zoom_meeting_id;
    if (!localId) return target?.zoom_join_url || '';
    // Sample previews must not offer a usable, non-personalised meeting URL.
    if (sample) return '';
    const kind = webinar ? 'webinars' : 'meetings';
    const key = `${kind}:${localId}`;
    if (!cache.has(key)) cache.set(key, (async () => {
      const column = webinar ? 'zoom_webinar_id' : 'zoom_meeting_id';
      const { data, error } = await db.from(webinar ? 'zoom_webinar' : 'zoom_meeting')
        .select(column).eq('tenant_id', tenantId).eq('id', localId).maybeSingle();
      if (error || !data?.[column]) throw new Error('Unable to resolve the event Zoom meeting. Email was not sent.');
      const id = data[column];
      const token = await getToken(tenantId);
      const settings = await readSettings(token, kind, id);
      if (!settings.registration_required) return settings.join_url || '';
      const normalized = String(email || '').trim().toLowerCase();
      if (!normalized) throw new Error('A confirmed attendee email is required for the personalised Zoom link.');
      let next = '';
      const seen = new Set(), matches = [];
      do {
        const query = new URLSearchParams({ status: 'approved', page_size: '300', next_page_token: next });
        const page = await request(token, `${kind}/${encodeURIComponent(id)}/registrants?${query}`);
        if (!Array.isArray(page.registrants)) throw new Error('Zoom registration lookup was incomplete. Retry the email later.');
        matches.push(...page.registrants.filter(row => String(row.email || '').trim().toLowerCase() === normalized));
        next = page.next_page_token || '';
        if (next && (seen.has(next) || seen.size >= 100)) throw new Error('Zoom registration lookup was incomplete. Retry the email later.');
        seen.add(next);
      } while (next);
      const url = matches.length === 1 ? personalisedZoomUrl(matches[0].join_url) : null;
      if (!url) throw new Error('No unique approved personalised Zoom link is available for this attendee. Check their Zoom registration, then retry. The general meeting link has not been used.');
      return url;
    })().catch(error => {
      error.code = 'ZOOM_EMAIL_LINK_UNAVAILABLE';
      throw error;
    }));
    return cache.get(key);
  };
}

export async function personaliseEmailZoomTargets(resolve, event, complexData, agendaData, renderSessions) {
  event.zoom_join_url = await resolve(event);
  for (const session of complexData?.sessions || []) session.zoom_join_url = await resolve(session);
  for (const line of agendaData?.lines || []) line.zoom_join_url = await resolve(line);
  if (agendaData) agendaData.agendaScheduleHtml = buildAgendaScheduleHtml(agendaData.lines || []);
  if (complexData && renderSessions) complexData.sessionScheduleHtml = renderSessions(complexData.sessions || [], event.timezone, { trackColours: complexData.trackColours });
}
