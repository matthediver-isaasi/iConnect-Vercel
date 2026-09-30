import { supabase } from './database.js';

const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0';
const CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;

export class TeamsGraphError extends Error {
  constructor(message, { status, code, retryable = false, retryAfterSeconds = null } = {}) {
    super(message);
    this.name = 'TeamsGraphError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

async function refreshToken(connection, db = supabase, fetchImpl = fetch) {
  if (!CLIENT_ID || !CLIENT_SECRET || !connection.refresh_token) {
    throw new TeamsGraphError('Microsoft connection must be reconnected to grant Teams attendance consent', {
      status: 401, code: 'consent_required',
    });
  }
  const response = await fetchImpl('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      refresh_token: connection.refresh_token, grant_type: 'refresh_token',
    }),
  });
  if (!response.ok) {
    throw new TeamsGraphError('Microsoft connection has expired or lacks Teams attendance consent', {
      status: response.status, code: 'consent_required',
    });
  }
  const tokens = await response.json();
  const expiresAt = new Date(Date.now() + Number(tokens.expires_in || 3600) * 1000).toISOString();
  const { error } = await db.from('outlook_connection').update({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || connection.refresh_token,
    token_expires_at: expiresAt,
    updated_at: new Date().toISOString(),
  }).eq('tenant_id', connection.tenant_id).eq('id', connection.id)
    .eq('microsoft_user_id', connection.microsoft_user_id);
  if (error) throw new Error(`Failed to update Microsoft connection token: ${error.message}`);
  return tokens.access_token;
}

export async function getTeamsConnection({
  tenantId, connectionId, organiserMicrosoftUserId, db = supabase, fetchImpl = fetch,
}) {
  const { data, error } = await db.from('outlook_connection').select('*')
    .eq('tenant_id', tenantId).eq('id', connectionId)
    .eq('microsoft_user_id', organiserMicrosoftUserId).eq('status', 'active').single();
  if (error || !data) {
    throw new TeamsGraphError('Active Microsoft connection not found for this tenant and organiser', {
      status: 403, code: 'connection_boundary',
    });
  }
  const scopes = new Set(String(data.scopes || '').split(/\s+/).map(scope =>
    scope.slice(scope.lastIndexOf('/') + 1).toLowerCase()));
  if (!scopes.has('onlinemeetingartifact.read.all')) {
    throw new TeamsGraphError('Microsoft administrator consent is required for Teams attendance reports', {
      status: 403, code: 'consent_required',
    });
  }
  const expiresAt = new Date(data.token_expires_at).getTime();
  const token = !Number.isFinite(expiresAt) || expiresAt <= Date.now() + 5 * 60 * 1000
    ? await refreshToken(data, db, fetchImpl)
    : data.access_token;
  return { connection: data, token };
}

const sleep = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function graphGetAll(url, token, {
  fetchImpl = fetch, maxPages = 100, maxRateLimitRetries = 3, sleepImpl = sleep,
  notFoundCode = 'report_pending',
} = {}) {
  const values = [];
  let next = url.startsWith('http') ? url : `${GRAPH_ROOT}${url}`;
  let pages = 0;
  let rateLimitRetries = 0;
  while (next) {
    if (pages >= maxPages) {
      throw new TeamsGraphError('Microsoft Graph pagination safety limit reached', {
        code: 'pagination_limit', retryable: true,
      });
    }
    const response = await fetchImpl(next, { headers: { Authorization: `Bearer ${token}` } });
    if (response.status === 429 && rateLimitRetries < maxRateLimitRetries) {
      const raw = response.headers.get('retry-after');
      const retryAfterSeconds = Math.max(1, Number.parseInt(raw || '1', 10) || 1);
      rateLimitRetries += 1;
      await sleepImpl(Math.min(retryAfterSeconds, 30) * 1000);
      continue;
    }
    if (!response.ok) {
      const message = await response.text();
      if (response.status === 404) {
        throw new TeamsGraphError(
          notFoundCode === 'report_pending'
            ? 'Teams attendance report is not available yet'
            : 'Teams online meeting not found for this organiser',
          {
            status: 404, code: notFoundCode, retryable: notFoundCode === 'report_pending',
          },
        );
      }
      if (response.status === 401 || response.status === 403) {
        throw new TeamsGraphError('Microsoft Graph permission denied; reconnect and grant attendance report consent', {
          status: response.status, code: 'consent_required',
        });
      }
      const retryAfterSeconds = Number.parseInt(response.headers.get('retry-after') || '', 10) || null;
      throw new TeamsGraphError(`Microsoft Graph request failed (${response.status}): ${message}`, {
        status: response.status,
        code: response.status === 429 ? 'rate_limited' : 'provider_error',
        retryable: response.status === 429 || response.status >= 500,
        retryAfterSeconds,
      });
    }
    const body = await response.json();
    values.push(...(body.value || []));
    next = body['@odata.nextLink'] || null;
    pages += 1;
    rateLimitRetries = 0;
  }
  return values;
}

export async function resolveOnlineMeetingId({
  token, organiserMicrosoftUserId, onlineMeetingId, joinWebUrl, fetchImpl = fetch,
  validateSuppliedId = true,
}) {
  if (onlineMeetingId) {
    const stableId = String(onlineMeetingId);
    if (validateSuppliedId) {
      const path = `/users/${encodeURIComponent(organiserMicrosoftUserId)}/onlineMeetings/${encodeURIComponent(stableId)}?$select=id`;
      try {
        // A successful collection request needs a value array, while this is a
        // singleton. Adapt its body so all retry/consent semantics remain in
        // one implementation.
        await graphGetAll(path, token, {
          fetchImpl: async (url, options) => {
            const response = await fetchImpl(url, options);
            if (!response.ok) return response;
            const meeting = await response.json();
            return {
              ok: true,
              status: response.status,
              headers: response.headers,
              json: async () => ({ value: [meeting] }),
              text: async () => '',
            };
          },
          notFoundCode: 'meeting_not_found',
          maxPages: 1,
        });
      } catch (error) {
        if (error.code === 'pagination_limit') {
          // graphGetAll has completed its one allowed page; this branch is
          // defensive and should not be reached because no nextLink exists.
          throw new TeamsGraphError('Teams online meeting validation failed', {
            code: 'meeting_not_found', status: 404,
          });
        }
        throw error;
      }
    }
    return stableId;
  }
  if (!joinWebUrl) throw new Error('onlineMeetingId or joinWebUrl is required');
  const filter = encodeURIComponent(`JoinWebUrl eq '${String(joinWebUrl).replaceAll("'", "''")}'`);
  const meetings = await graphGetAll(
    `/users/${encodeURIComponent(organiserMicrosoftUserId)}/onlineMeetings?$filter=${filter}&$select=id,joinWebUrl`,
    token, { fetchImpl, notFoundCode: 'meeting_not_found' },
  );
  if (meetings.length !== 1) {
    throw new TeamsGraphError(
      meetings.length ? 'Teams join URL resolved to multiple meetings' : 'Teams online meeting not found',
      { status: 404, code: meetings.length ? 'ambiguous_meeting' : 'meeting_not_found' },
    );
  }
  return meetings[0].id;
}

export async function fetchTeamsAttendance({
  token, organiserMicrosoftUserId, onlineMeetingId, fetchImpl = fetch, sleepImpl,
}) {
  const base = `/users/${encodeURIComponent(organiserMicrosoftUserId)}/onlineMeetings/${encodeURIComponent(onlineMeetingId)}`;
  const reports = await graphGetAll(`${base}/attendanceReports?$top=50`, token, { fetchImpl, sleepImpl });
  if (!reports.length) {
    throw new TeamsGraphError('Teams attendance report is not available yet', {
      status: 404, code: 'report_pending', retryable: true,
    });
  }
  // A replacement report supersedes older report identities. Graph's meeting
  // identity remains stable; newest report wins and atomically replaces facts.
  const report = [...reports].sort((a, b) =>
    new Date(b.meetingEndDateTime || b.meetingStartDateTime || 0)
      - new Date(a.meetingEndDateTime || a.meetingStartDateTime || 0))[0];
  const records = await graphGetAll(
    `${base}/attendanceReports/${encodeURIComponent(report.id)}/attendanceRecords?$top=100`,
    token, { fetchImpl, sleepImpl },
  );
  return { report, records };
}