import { supabase } from './database.js';
import { getQuickBooksCredentials, getIntuitEndpoints } from './quickbooksCredentials.js';

async function safeJson(response, context) {
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok) {
    if (contentType.includes('application/json')) {
      const errorData = await response.json();
      throw new Error(`[QBO ${context}] HTTP ${response.status}: ${JSON.stringify(errorData).substring(0, 500)}`);
    }
    const text = await response.text();
    throw new Error(`[QBO ${context}] HTTP ${response.status}: ${text.substring(0, 300)}`);
  }
  if (!contentType.includes('application/json')) {
    const text = await response.text();
    throw new Error(`[QBO ${context}] Unexpected content-type '${contentType}': ${text.substring(0, 300)}`);
  }
  return response.json();
}

export async function getQuickBooksTokenRow(appTenantId) {
  if (!supabase) throw new Error('Supabase not configured');
  if (!appTenantId) throw new Error('appTenantId is required');

  const { data, error } = await supabase
    .from('quickbooks_token')
    .select('*')
    .eq('app_tenant_id', appTenantId)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') {
    console.error('[QBO] Token lookup error:', error);
    throw new Error('Failed to lookup QuickBooks token');
  }
  return data || null;
}

export async function getValidQuickBooksAccessToken(appTenantId) {
  if (!appTenantId) throw new Error('appTenantId is required for QuickBooks token lookup');

  const token = await getQuickBooksTokenRow(appTenantId);
  if (!token) {
    throw new Error('No QuickBooks token found for this tenant. Please authenticate first.');
  }
  if (!token.realm_id) {
    throw new Error('QuickBooks authentication incomplete.');
  }

  const expiresAt = token.expires_at ? new Date(token.expires_at) : new Date(0);
  const now = new Date();
  const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000);

  if (expiresAt > fiveMinutesFromNow) {
    return {
      accessToken: token.access_token,
      realmId: token.realm_id,
      environment: token.environment || 'production',
    };
  }

  const creds = await getQuickBooksCredentials(appTenantId);
  if (!creds || !creds.client_id || !creds.client_secret) {
    throw new Error('QuickBooks credentials not configured for this tenant');
  }

  const { tokenUrl } = getIntuitEndpoints(token.environment || creds.environment);

  const tokenResponse = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      Authorization:
        'Basic ' +
        Buffer.from(`${creds.client_id}:${creds.client_secret}`).toString('base64'),
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: token.refresh_token,
    }).toString(),
  });

  const tokenData = await safeJson(tokenResponse, 'token-refresh');

  if (tokenData.error) {
    throw new Error(`Failed to refresh QuickBooks token: ${JSON.stringify(tokenData)}`);
  }

  const newExpiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();

  const { error: updateErr } = await supabase
    .from('quickbooks_token')
    .update({
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token || token.refresh_token,
      expires_at: newExpiresAt,
      token_type: tokenData.token_type || token.token_type || 'bearer',
      updated_at: new Date().toISOString(),
    })
    .eq('id', token.id);

  if (updateErr) {
    console.error('[QBO] Failed to persist refreshed token:', updateErr);
  }

  return {
    accessToken: tokenData.access_token,
    realmId: token.realm_id,
    environment: token.environment || 'production',
  };
}

export async function fetchCompanyInfo(accessToken, realmId, environment) {
  const { apiBaseUrl } = getIntuitEndpoints(environment);
  const url = `${apiBaseUrl}/v3/company/${encodeURIComponent(realmId)}/companyinfo/${encodeURIComponent(realmId)}?minorversion=70`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  const data = await safeJson(response, 'companyinfo');
  return data?.CompanyInfo || null;
}

export async function revokeQuickBooksToken(appTenantId, refreshToken) {
  try {
    const creds = await getQuickBooksCredentials(appTenantId);
    if (!creds?.client_id || !creds?.client_secret || !refreshToken) return false;

    const { revokeUrl } = getIntuitEndpoints(creds.environment);
    const response = await fetch(revokeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization:
          'Basic ' +
          Buffer.from(`${creds.client_id}:${creds.client_secret}`).toString('base64'),
      },
      body: JSON.stringify({ token: refreshToken }),
    });
    return response.ok;
  } catch (err) {
    console.error('[QBO] Revoke error (non-fatal):', err.message);
    return false;
  }
}
