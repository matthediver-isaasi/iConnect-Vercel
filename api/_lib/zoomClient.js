import { supabase } from './database.js';
import { getSessionMember, getSessionTenantUser } from './session.js';
import crypto from 'crypto';

const ENCRYPTION_KEY = process.env.INTEGRATION_ENCRYPTION_KEY || process.env.SESSION_SECRET;

function decrypt(encryptedText) {
  if (!encryptedText) return null;
  if (!ENCRYPTION_KEY) {
    console.error('[ZoomClient] Cannot decrypt - no encryption key configured');
    return null;
  }
  try {
    const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
    const parts = encryptedText.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    console.error('[ZoomClient] Decryption error:', e.message);
    return null;
  }
}

function decryptCredentials(credentials) {
  if (!credentials) return {};
  const decrypted = {};
  for (const [key, value] of Object.entries(credentials)) {
    if (value && typeof value === 'string' && value.includes(':')) {
      decrypted[key] = decrypt(value);
    } else {
      decrypted[key] = value;
    }
  }
  return decrypted;
}

const tokenCacheByTenant = new Map();

export async function getTenantZoomCredentials(tenantId) {
  if (!supabase || !tenantId) {
    return null;
  }

  try {
    const { data: integration, error } = await supabase
      .from('tenant_integrations')
      .select('credentials, is_enabled')
      .eq('tenant_id', tenantId)
      .eq('integration_type', 'zoom')
      .single();

    if (error || !integration) {
      console.log('[ZoomClient] No Zoom integration found for tenant:', tenantId);
      return null;
    }

    if (!integration.is_enabled) {
      console.log('[ZoomClient] Zoom integration disabled for tenant:', tenantId);
      return null;
    }

    const credentials = decryptCredentials(integration.credentials);
    
    if (!credentials.account_id || !credentials.client_id || !credentials.client_secret) {
      console.log('[ZoomClient] Incomplete Zoom credentials for tenant:', tenantId);
      return null;
    }

    return credentials;
  } catch (error) {
    console.error('[ZoomClient] Error fetching credentials:', error);
    return null;
  }
}

export async function getZoomAccessTokenForTenant(tenantId) {
  if (!tenantId) {
    throw new Error('Zoom is not configured for your organisation. Please set up Zoom credentials in Admin > Integrations.');
  }

  const cached = tokenCacheByTenant.get(tenantId);
  if (cached && Date.now() < cached.expiresAt - 60000) {
    return cached.token;
  }

  const credentials = await getTenantZoomCredentials(tenantId);
  
  if (!credentials) {
    throw new Error('Zoom is not configured for your organisation. Please set up Zoom credentials in Admin > Integrations.');
  }

  return getZoomTokenWithCredentials(
    tenantId, 
    credentials.account_id, 
    credentials.client_id, 
    credentials.client_secret
  );
}

async function getZoomTokenWithCredentials(cacheKey, accountId, clientId, clientSecret) {
  const cached = tokenCacheByTenant.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt - 60000) {
    return cached.token;
  }

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await fetch('https://zoom.us/oauth/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: `grant_type=account_credentials&account_id=${accountId}`
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[ZoomClient] Token error:', errorText);
    throw new Error(`Failed to get Zoom access token: ${response.status}`);
  }

  const data = await response.json();

  tokenCacheByTenant.set(cacheKey, {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in * 1000)
  });

  return data.access_token;
}

export async function getTenantIdFromSession(req) {
  if (!req) return null;
  
  const tenantUser = await getSessionTenantUser(req);
  if (tenantUser?.tenant_id) {
    return tenantUser.tenant_id;
  }
  
  const member = await getSessionMember(req);
  if (member?.tenant_id) {
    return member.tenant_id;
  }
  
  return null;
}

export async function getZoomAccessToken(req) {
  let tenantId = null;
  
  if (req && typeof req === 'object' && (req.headers || req.method)) {
    tenantId = await getTenantIdFromSession(req);
  }
  
  if (!tenantId) {
    throw new Error('Zoom is not configured for your organisation. Please set up Zoom credentials in Admin > Integrations.');
  }

  return getZoomAccessTokenForTenant(tenantId);
}

export async function deleteZoomMeeting(tenantId, meetingId) {
  if (!meetingId) return false;
  try {
    const token = await getZoomAccessTokenForTenant(tenantId);
    const response = await fetch(`https://api.zoom.us/v2/meetings/${meetingId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (response.ok || response.status === 204) {
      console.log('[ZoomClient] Deleted Zoom meeting:', meetingId);
      return true;
    }
    console.error('[ZoomClient] Failed to delete meeting:', response.status, await response.text());
    return false;
  } catch (error) {
    console.error('[ZoomClient] Error deleting meeting:', error.message);
    return false;
  }
}

export async function cancelZoomRegistrant(tenantId, zoomWebinarId, email) {
  if (!zoomWebinarId || !email) return false;
  try {
    const token = await getZoomAccessTokenForTenant(tenantId);
    const normalizedEmail = email.toLowerCase();

    let registrant = null;
    let nextPageToken = '';
    do {
      const url = `https://api.zoom.us/v2/webinars/${zoomWebinarId}/registrants?page_size=300${nextPageToken ? `&next_page_token=${nextPageToken}` : ''}`;
      const listRes = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (!listRes.ok) {
        console.error('[ZoomClient] Failed to list registrants for cancellation:', listRes.status, await listRes.text());
        return false;
      }

      const listData = await listRes.json();
      registrant = (listData.registrants || []).find(
        r => r.email.toLowerCase() === normalizedEmail
      );
      nextPageToken = listData.next_page_token || '';
    } while (!registrant && nextPageToken);

    if (!registrant) {
      console.log(`[ZoomClient] Registrant ${email} not found in webinar ${zoomWebinarId} — may already be removed`);
      return true;
    }

    const response = await fetch(
      `https://api.zoom.us/v2/webinars/${zoomWebinarId}/registrants/status`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          action: 'cancel',
          registrants: [{ id: registrant.id, email: registrant.email }]
        })
      }
    );

    if (response.ok || response.status === 204) {
      console.log(`[ZoomClient] Cancelled Zoom registrant ${email} from webinar ${zoomWebinarId}`);
      return true;
    }

    console.error('[ZoomClient] Failed to cancel registrant:', response.status, await response.text());
    return false;
  } catch (error) {
    console.error('[ZoomClient] Error cancelling registrant:', error.message);
    return false;
  }
}

export async function registerZoomWebinarAttendee(tenantId, webinar, attendee) {
  try {
    if (!webinar.zoom_webinar_id) {
      return { success: false, error: 'Webinar not synced with Zoom' };
    }

    if (!webinar.registration_required) {
      return { success: true, skipped: true, reason: 'Registration not required' };
    }

    const token = await getZoomAccessTokenForTenant(tenantId);

    const zoomResponse = await fetch(
      `https://api.zoom.us/v2/webinars/${webinar.zoom_webinar_id}/registrants`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          first_name: attendee.first_name || 'Guest',
          last_name: attendee.last_name || 'Attendee',
          email: attendee.email,
          auto_approve: true
        })
      }
    );

    if (!zoomResponse.ok) {
      const errorData = await zoomResponse.json().catch(() => ({}));
      if (errorData.code === 3027) {
        console.log(`[ZoomClient] ${attendee.email} already registered for webinar ${webinar.zoom_webinar_id}`);
        return { success: true, already_registered: true };
      }
      console.error(`[ZoomClient] Registration error for ${attendee.email}:`, JSON.stringify(errorData));
      return { success: false, error: errorData.message || 'Zoom registration failed', code: errorData.code };
    }

    const zoomData = await zoomResponse.json();
    console.log(`[ZoomClient] Registered ${attendee.email} for webinar ${webinar.zoom_webinar_id}, join_url: ${zoomData.join_url}`);
    return { success: true, registrant_id: zoomData.registrant_id, join_url: zoomData.join_url };
  } catch (err) {
    console.error(`[ZoomClient] Registration exception for ${attendee.email}:`, err.message);
    return { success: false, error: err.message };
  }
}

function isZoomEvent(evt) {
  if (!evt.location) return false;
  const location = evt.location.toLowerCase();
  return location.includes('zoom.us') ||
    (location.startsWith('online') && location.includes('zoom'));
}

function extractZoomUrl(location) {
  if (!location) return null;
  const urlMatch = location.match(/https?:\/\/[^\s]+zoom[^\s]*/i);
  return urlMatch ? urlMatch[0] : null;
}

function extractZoomWebinarIdFromUrl(url) {
  if (!url) return null;
  const match = url.match(/\/[jw]\/(\d+)/);
  return match ? match[1] : null;
}

export async function resolveEventZoomWebinar(event) {
  if (!supabase || !event) return null;

  if (event.backstage_event_id) return null;

  if (event.zoom_webinar_id) {
    const { data: webinar, error } = await supabase
      .from('zoom_webinar')
      .select('*')
      .eq('id', event.zoom_webinar_id)
      .single();

    if (webinar && !error) {
      console.log(`[ZoomClient] Resolved webinar via direct link: ${webinar.zoom_webinar_id}`);
      return webinar;
    }
    console.log(`[ZoomClient] Failed to fetch linked webinar ${event.zoom_webinar_id}:`, error?.message);
  }

  if (!isZoomEvent(event)) return null;

  const zoomUrl = extractZoomUrl(event.location);
  if (!zoomUrl) return null;

  const eventWebinarId = extractZoomWebinarIdFromUrl(zoomUrl);

  const { data: webinars, error } = await supabase
    .from('zoom_webinar')
    .select('*');

  if (error || !webinars) return null;

  if (eventWebinarId) {
    const matchByZoomId = webinars.find(w => w.zoom_webinar_id?.toString() === eventWebinarId);
    if (matchByZoomId) {
      console.log(`[ZoomClient] Resolved webinar by Zoom ID match: ${matchByZoomId.zoom_webinar_id}`);
      return matchByZoomId;
    }

    const matchByJoinUrlId = webinars.find(w => {
      const joinUrlId = extractZoomWebinarIdFromUrl(w.join_url);
      return joinUrlId === eventWebinarId;
    });
    if (matchByJoinUrlId) {
      console.log(`[ZoomClient] Resolved webinar by join_url ID match: ${matchByJoinUrlId.zoom_webinar_id}`);
      return matchByJoinUrlId;
    }
  }

  const normalizeUrl = (url) => url.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
  const normalizedZoomUrl = normalizeUrl(zoomUrl);

  const matchByUrl = webinars.find((w) => {
    if (!w.join_url) return false;
    const normalizedJoinUrl = normalizeUrl(w.join_url);
    return normalizedZoomUrl.includes(normalizedJoinUrl) || normalizedJoinUrl.includes(normalizedZoomUrl);
  });

  if (matchByUrl) {
    console.log(`[ZoomClient] Resolved webinar by URL match: ${matchByUrl.zoom_webinar_id}`);
  }

  return matchByUrl || null;
}

export function clearTenantZoomTokenCache(tenantId) {
  tokenCacheByTenant.delete(tenantId);
}
