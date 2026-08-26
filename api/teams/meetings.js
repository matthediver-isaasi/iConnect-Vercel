import { supabase } from '../_lib/database.js';
import { getSession } from '../_lib/session.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import {
  evaluateMicrosoftScopes,
  microsoftGraphRequest,
} from '../_lib/microsoftGraph.js';
import { localDateTimeToIso } from '../_lib/attendanceSchedule.js';

function graphErrorMessage(status) {
  if (status === 401) return { code: 'disconnected', error: 'The Microsoft organiser connection has expired. Reconnect it and try again.' };
  if (status === 403) return { code: 'missing_consent', error: 'Microsoft administrator consent is required for Teams meeting management.' };
  if (status === 404) return { code: 'unsupported_meeting', error: 'That Teams meeting was not found or is not accessible to the connected organiser.' };
  return { code: 'graph_error', error: 'Microsoft Teams could not complete the request. Please try again.' };
}

async function getConnection(req, tenantContext) {
  const result = await getSession(req);
  const session = result?.data;
  if (!session?.tenantId) return { error: 'Not authenticated', status: 401 };
  if (session.tenantId !== tenantContext.tenantId) {
    return { error: 'Tenant context mismatch', status: 403 };
  }
  const identityId = session.identityId || session.userId || session.memberId;
  if (!identityId) return { error: 'Could not determine user identity', status: 401 };
  const { data, error } = await supabase.from('outlook_connection').select('*')
    .eq('tenant_id', tenantContext.tenantId).eq('identity_id', identityId).maybeSingle();
  if (error) return { error: 'Failed to load Microsoft connection', status: 500 };
  return { connection: data, session };
}

async function readGraphJson(connection, path, options) {
  const response = await microsoftGraphRequest(connection, path, options);
  if (!response.ok) {
    const friendly = graphErrorMessage(response.status);
    const error = new Error(friendly.error);
    error.status = response.status;
    error.code = friendly.code;
    throw error;
  }
  return response.json();
}

async function organiser(connection) {
  const user = await readGraphJson(connection, '/me?$select=id,userPrincipalName,mail');
  return {
    id: user.id || connection.microsoft_user_id,
    email: user.mail || user.userPrincipalName || connection.microsoft_email,
  };
}

function meetingPayload(meeting, connection, owner) {
  return {
    teams_online_meeting_id: meeting.id,
    teams_join_web_url: meeting.joinWebUrl,
    teams_organiser_microsoft_user_id: owner.id,
    teams_organiser_email: owner.email,
    teams_outlook_connection_id: connection.id,
    teams_meeting_lifecycle: 'active',
  };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  try {
    const tenantContext = await getTenantContext(req);
    if (!tenantContext?.isAuthenticated || !tenantContext.tenantId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    if (!(await hasAdminAccess(tenantContext))) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const loaded = await getConnection(req, tenantContext);
    if (loaded.error) return res.status(loaded.status).json({ error: loaded.error });
    const { connection } = loaded;
    if (req.method === 'GET') {
      if (!connection) return res.json({ connected: false, status: 'disconnected', meetingManagementSupported: false });
      const scopeHealth = evaluateMicrosoftScopes(connection.scopes || '');
      const active = connection.status === 'active';
      return res.json({
        connected: true,
        status: connection.status,
        email: connection.microsoft_email,
        meetingManagementSupported: active && scopeHealth.teamsReady,
        healthState: connection.health_state || scopeHealth.healthState,
        message: connection.health_error || (scopeHealth.teamsReady
          ? null
          : 'Reconnect Microsoft and grant administrator consent for Teams meetings and attendance reports.'),
      });
    }
    if (!connection || connection.status !== 'active') {
      return res.status(409).json({ code: 'disconnected', error: 'Connect an active Microsoft organiser account first.' });
    }
    const scopeHealth = evaluateMicrosoftScopes(connection.scopes || '');
    if (!scopeHealth.teamsReady) {
      return res.status(403).json({ code: 'missing_consent', error: 'Reconnect Microsoft and grant consent for Teams meeting management and attendance reports.' });
    }

    const owner = await organiser(connection);
    const { action, joinUrl, subject, startDateTime, endDateTime, timezone } = req.body || {};
    let meeting;
    if (action === 'link') {
      if (!/^https:\/\/teams\.microsoft\.com\//i.test(String(joinUrl || ''))) {
        return res.status(400).json({ code: 'invalid_join_url', error: 'Enter a valid teams.microsoft.com meeting join URL.' });
      }
      const escaped = String(joinUrl).replaceAll("'", "''");
      const result = await readGraphJson(connection,
        `/me/onlineMeetings?$filter=${encodeURIComponent(`JoinWebUrl eq '${escaped}'`)}&$select=id,joinWebUrl`);
      if (!Array.isArray(result.value) || result.value.length !== 1) {
        return res.status(404).json({ code: 'unsupported_meeting', error: 'The meeting could not be accessed by this organiser. Confirm the join URL and organiser account.' });
      }
      [meeting] = result.value;
    } else if (action === 'create') {
      if (!subject || !startDateTime || !endDateTime) {
        return res.status(400).json({ error: 'A title, start time, and end time are required to create a Teams meeting.' });
      }
      meeting = await readGraphJson(connection, '/me/onlineMeetings', {
        method: 'POST',
        body: JSON.stringify({
          subject,
          startDateTime: localDateTimeToIso(startDateTime, timezone),
          endDateTime: localDateTimeToIso(endDateTime, timezone),
        }),
      });
    } else {
      return res.status(400).json({ error: 'action must be create or link' });
    }
    return res.json({ meeting: meetingPayload(meeting, connection, owner) });
  } catch (error) {
    console.error('[Teams meetings]', error.message);
    return res.status(error.status || 500).json({
      code: error.code || 'teams_error',
      error: error.message || 'Microsoft Teams request failed',
    });
  }
}