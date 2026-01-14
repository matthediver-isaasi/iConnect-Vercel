import { supabase } from '../_lib/database.js';

const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;

async function refreshAccessToken(connection) {
  const tokenResponse = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: MICROSOFT_CLIENT_ID,
      client_secret: MICROSOFT_CLIENT_SECRET,
      refresh_token: connection.refresh_token,
      grant_type: 'refresh_token'
    })
  });

  if (!tokenResponse.ok) {
    const errorData = await tokenResponse.text();
    console.error('[Outlook Calendar] Token refresh failed:', errorData);
    throw new Error('Token refresh failed');
  }

  const tokens = await tokenResponse.json();
  const tokenExpiresAt = new Date(Date.now() + (tokens.expires_in * 1000)).toISOString();

  await supabase
    .from('outlook_connection')
    .update({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || connection.refresh_token,
      token_expires_at: tokenExpiresAt,
      updated_at: new Date().toISOString()
    })
    .eq('id', connection.id);

  return tokens.access_token;
}

async function getValidAccessToken(connection) {
  const expiresAt = new Date(connection.token_expires_at);
  const now = new Date();
  
  if (expiresAt <= new Date(now.getTime() + 5 * 60 * 1000)) {
    console.log('[Outlook Calendar] Token expired or expiring soon, refreshing...');
    return await refreshAccessToken(connection);
  }
  
  return connection.access_token;
}

export async function createCalendarEvent(connection, eventData) {
  const accessToken = await getValidAccessToken(connection);
  
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

export async function getBusyTimes(connection, startDateTime, endDateTime, timeZone = 'UTC') {
  const accessToken = await getValidAccessToken(connection);
  
  const calendarViewUrl = new URL('https://graph.microsoft.com/v1.0/me/calendarview');
  calendarViewUrl.searchParams.set('startdatetime', startDateTime);
  calendarViewUrl.searchParams.set('enddatetime', endDateTime);
  calendarViewUrl.searchParams.set('$select', 'subject,start,end,showAs,isCancelled');
  calendarViewUrl.searchParams.set('$top', '100');

  const response = await fetch(calendarViewUrl.toString(), {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Prefer': `outlook.timezone="${timeZone}"`
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[Outlook Calendar] Failed to get calendar view:', errorText);
    throw new Error('Failed to get calendar events');
  }

  const data = await response.json();
  const events = data.value || [];

  const busyTimes = events
    .filter(e => !e.isCancelled && (e.showAs === 'busy' || e.showAs === 'tentative' || e.showAs === 'oof'))
    .map(e => ({
      start: e.start.dateTime,
      end: e.end.dateTime,
      timeZone: e.start.timeZone || timeZone
    }));

  return busyTimes;
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
