import { supabase } from './database.js';

const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;

export const MICROSOFT_BASE_SCOPES = [
  'openid',
  'email',
  'profile',
  'offline_access',
  'https://graph.microsoft.com/Mail.Read',
  'https://graph.microsoft.com/Mail.Send',
  'https://graph.microsoft.com/User.Read',
  'https://graph.microsoft.com/Calendars.ReadWrite'
];

export const MICROSOFT_TEAMS_SCOPES = [
  'https://graph.microsoft.com/OnlineMeetings.ReadWrite',
  'https://graph.microsoft.com/OnlineMeetingArtifact.Read.All'
];

export const MICROSOFT_SCOPES = [...MICROSOFT_BASE_SCOPES, ...MICROSOFT_TEAMS_SCOPES];
const REQUIRED_GRAPH_SCOPES = MICROSOFT_SCOPES.filter(scope =>
  scope.startsWith('https://graph.microsoft.com/')
);

export function normalizeMicrosoftScopes(scopes) {
  const values = Array.isArray(scopes) ? scopes : String(scopes || '').split(/\s+/);
  return new Set(values.filter(Boolean).map(scope => {
    const slash = scope.lastIndexOf('/');
    return (slash >= 0 ? scope.slice(slash + 1) : scope).toLowerCase();
  }));
}

export function evaluateMicrosoftScopes(scopes) {
  const granted = normalizeMicrosoftScopes(scopes);
  const missing = REQUIRED_GRAPH_SCOPES.filter(scope => {
    const name = scope.slice(scope.lastIndexOf('/') + 1).toLowerCase();
    return !granted.has(name);
  });
  const missingTeamsScopes = MICROSOFT_TEAMS_SCOPES.filter(scope => {
    const name = scope.slice(scope.lastIndexOf('/') + 1).toLowerCase();
    return !granted.has(name);
  });
  const missingBaseScopes = missing.filter(scope => !MICROSOFT_TEAMS_SCOPES.includes(scope));

  return {
    missingScopes: missing,
    missingTeamsScopes,
    mailCalendarReady: MICROSOFT_BASE_SCOPES
      .filter(scope => scope.startsWith('https://graph.microsoft.com/'))
      .every(scope => granted.has(scope.slice(scope.lastIndexOf('/') + 1).toLowerCase())),
    teamsReady: missingTeamsScopes.length === 0,
    healthState: missing.length === 0
      ? 'healthy'
      : missingBaseScopes.length > 0
        ? 'reconnect_required'
        : 'admin_consent_required'
  };
}

export async function markMicrosoftConnectionHealth(connection, healthState, message = null) {
  if (!connection?.id) return;
  const updates = {
    health_state: healthState,
    health_error: message,
    health_checked_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  if (healthState === 'reconnect_required') updates.status = 'expired';
  const { error } = await supabase.from('outlook_connection').update(updates).eq('id', connection.id);
  if (error) console.error('[Microsoft Graph] Failed to persist connection health:', error.message);
}

export async function refreshMicrosoftAccessToken(connection) {
  const tokenResponse = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: MICROSOFT_CLIENT_ID,
      client_secret: MICROSOFT_CLIENT_SECRET,
      refresh_token: connection.refresh_token,
      grant_type: 'refresh_token',
      // Do not force new Teams scopes during a background refresh. Legacy
      // mail/calendar grants must keep working until an admin interactively
      // approves the authorization upgrade.
      scope: connection.scopes || MICROSOFT_BASE_SCOPES.join(' ')
    })
  });

  if (!tokenResponse.ok) {
    const detail = await tokenResponse.text();
    console.error(`[Microsoft Graph] Token refresh failed for connection ${connection.id}:`, detail);
    const adminConsent = /consent|AADSTS65001|AADSTS65004/i.test(detail);
    await markMicrosoftConnectionHealth(
      connection,
      adminConsent ? 'admin_consent_required' : 'reconnect_required',
      adminConsent ? 'Microsoft administrator consent is required' : 'Microsoft authorization expired; reconnect required'
    );
    throw new Error(adminConsent ? 'Microsoft administrator consent is required' : 'Microsoft connection expired. Please reconnect.');
  }

  const tokens = await tokenResponse.json();
  const grantedScopes = tokens.scope || connection.scopes || '';
  const scopeHealth = evaluateMicrosoftScopes(grantedScopes);
  const updates = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || connection.refresh_token,
    token_expires_at: new Date(Date.now() + (tokens.expires_in * 1000)).toISOString(),
    scopes: grantedScopes,
    health_state: scopeHealth.healthState,
    health_error: scopeHealth.missingScopes.length
      ? `Missing Microsoft permissions: ${scopeHealth.missingScopes.join(', ')}`
      : null,
    health_checked_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  await supabase.from('outlook_connection').update(updates).eq('id', connection.id);
  return tokens.access_token;
}

export async function getValidMicrosoftAccessToken(connection) {
  const expiresAt = new Date(connection.token_expires_at);
  if (!connection.access_token || Number.isNaN(expiresAt.getTime()) ||
      expiresAt <= new Date(Date.now() + 5 * 60 * 1000)) {
    return refreshMicrosoftAccessToken(connection);
  }
  return connection.access_token;
}

export async function microsoftGraphRequest(connection, path, options = {}) {
  const accessToken = await getValidMicrosoftAccessToken(connection);
  const response = await fetch(path.startsWith('http') ? path : `https://graph.microsoft.com/v1.0${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers
    }
  });
  if (response.status === 401) {
    await markMicrosoftConnectionHealth(connection, 'reconnect_required', 'Microsoft authorization expired; reconnect required');
  } else if (response.status === 403) {
    await markMicrosoftConnectionHealth(connection, 'admin_consent_required', 'Microsoft administrator consent is required for Teams');
  }
  return response;
}