import { supabase } from '../_lib/database.js';
import { getValidMicrosoftAccessToken } from '../_lib/microsoftGraph.js';

export async function createCalendarEvent(connection, eventData) {
  const accessToken = await getValidMicrosoftAccessToken(connection);
  
  const event = {
    subject: eventData.subject,
    body: {
      contentType: 'HTML',
      content: eventData.body || ''
    },
    start: {
      dateTime: eventData.startDateTime,
      timeZone: eventData.timeZone || 'UTC'
    },
    end: {
      dateTime: eventData.endDateTime,
      timeZone: eventData.timeZone || 'UTC'
    },
    attendees: eventData.attendees?.map(a => ({
      emailAddress: {
        address: a.email,
        name: a.name
      },
      type: 'required'
    })) || [],
    isOnlineMeeting: eventData.isOnlineMeeting || false,
    onlineMeetingProvider: eventData.isOnlineMeeting ? 'teamsForBusiness' : undefined
  };

  const response = await fetch('https://graph.microsoft.com/v1.0/me/events', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(event)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[Outlook Calendar] Failed to create event:', errorText);
    throw new Error('Failed to create calendar event');
  }

  return await response.json();
}

/**
 * Flag an Outlook connection as errored so the broken state is visible to
 * admins (api/outlook/status.js surfaces status + sync_error). Best-effort:
 * never throws.
 */
export async function markConnectionError(connection, status, message) {
  if (!connection?.id) return;
  try {
    const { error } = await supabase
      .from('outlook_connection')
      .update({
        status: status || 'error',
        sync_error: message,
        updated_at: new Date().toISOString()
      })
      .eq('id', connection.id);
    if (error) {
      console.error('[Outlook Calendar] Failed to flag connection error:', error.message);
    }
  } catch (e) {
    console.error('[Outlook Calendar] Failed to flag connection error:', e.message);
  }
}

// Safety cap on calendarview pagination: 20 pages x 100 events = 2000 events
// in a booking window, far beyond any realistic agent calendar.
const MAX_CALENDAR_PAGES = 20;

export async function getBusyTimes(connection, startDateTime, endDateTime, timeZone = 'UTC') {
  const accessToken = await getValidMicrosoftAccessToken(connection);
  
  const calendarViewUrl = new URL('https://graph.microsoft.com/v1.0/me/calendarview');
  calendarViewUrl.searchParams.set('startdatetime', startDateTime);
  calendarViewUrl.searchParams.set('enddatetime', endDateTime);
  calendarViewUrl.searchParams.set('$select', 'subject,start,end,showAs,isCancelled');
  calendarViewUrl.searchParams.set('$top', '100');

  const events = [];
  let nextUrl = calendarViewUrl.toString();
  let pages = 0;

  while (nextUrl && pages < MAX_CALENDAR_PAGES) {
    const response = await fetch(nextUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Prefer': `outlook.timezone="${timeZone}"`
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Outlook Calendar] Failed to get calendar view for connection ${connection.id} (identity ${connection.identity_id}):`, errorText);
      throw new Error('Failed to get calendar events');
    }

    const data = await response.json();
    events.push(...(data.value || []));
    nextUrl = data['@odata.nextLink'] || null;
    pages += 1;
  }

  if (nextUrl) {
    console.warn(`[Outlook Calendar] Calendar view pagination hit ${MAX_CALENDAR_PAGES}-page cap for connection ${connection.id}; remaining events ignored`);
  }

  const busyTimes = events
    .filter(e => !e.isCancelled && (e.showAs === 'busy' || e.showAs === 'tentative' || e.showAs === 'oof'))
    .map(e => ({
      start: e.start.dateTime,
      end: e.end.dateTime,
      timeZone: e.start.timeZone || timeZone
    }));

  return busyTimes;
}

export async function deleteCalendarEvent(connection, eventId) {
  if (!eventId) {
    console.log('[Outlook Calendar] No event ID provided, skipping deletion');
    return false;
  }

  const accessToken = await getValidMicrosoftAccessToken(connection);
  
  const response = await fetch(`https://graph.microsoft.com/v1.0/me/events/${eventId}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${accessToken}`
    }
  });

  if (!response.ok && response.status !== 404) {
    const errorText = await response.text();
    console.error('[Outlook Calendar] Failed to delete event:', errorText);
    throw new Error('Failed to delete calendar event');
  }

  console.log('[Outlook Calendar] Deleted event:', eventId);
  return true;
}

export async function getOutlookConnectionForIdentity(identityId, tenantId) {
  const { data: connection, error } = await supabase
    .from('outlook_connection')
    .select('*')
    .eq('identity_id', identityId)
    .eq('tenant_id', tenantId)
    .eq('status', 'active')
    .single();

  if (error || !connection) {
    return null;
  }

  return connection;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  return res.status(400).json({ error: 'Use specific calendar endpoints' });
}
