import { supabase } from '../_lib/database.js';
import { getQuickBooksCredentials, getIntuitEndpoints } from '../_lib/quickbooksCredentials.js';
import { fetchCompanyInfo } from '../_lib/quickbooks.js';
import { setActiveAccountingProvider } from '../_lib/accountingProvider.js';

function errorPage(res, title, message) {
  return res.send(`
    <html>
      <body style="font-family: system-ui; padding: 40px; text-align: center;">
        <h1 style="color: #dc2626;">${title}</h1>
        <p>${message}</p>
        <button onclick="window.close()" style="margin-top: 20px; padding: 10px 20px; background: #2563eb; color: white; border: none; border-radius: 6px; cursor: pointer;">Close Window</button>
      </body>
    </html>
  `);
}

export default async function handler(req, res) {
  const { code, error, state, realmId } = req.query;

  let appTenantId = null;
  let stateEnv = null;
  if (state) {
    try {
      const stateData = JSON.parse(Buffer.from(state, 'base64').toString('utf-8'));
      appTenantId = stateData.tenantId;
      stateEnv = stateData.env;
    } catch (e) {
      console.error('[QBO Callback] Failed to parse state:', e);
    }
  }

  if (error) {
    return errorPage(res, 'Authentication Error', `Failed to authenticate with QuickBooks: ${error}`);
  }
  if (!code) return res.status(400).json({ error: 'No authorization code provided' });
  if (!appTenantId) return errorPage(res, 'Authentication Error', 'Missing tenant information in state parameter');
  if (!realmId) return errorPage(res, 'Authentication Error', 'Missing realmId (QuickBooks company id) from Intuit');

  try {
    const creds = await getQuickBooksCredentials(appTenantId);
    if (!creds || !creds.client_id || !creds.client_secret) {
      return errorPage(res, 'Configuration Error', 'QuickBooks credentials not configured for this tenant');
    }
    if (!creds.is_enabled) {
      return errorPage(res, 'Integration Disabled', 'QuickBooks integration is disabled for this tenant');
    }

    const environment = stateEnv === 'sandbox' || stateEnv === 'production' ? stateEnv : creds.environment;
    const redirectUri =
      process.env.QUICKBOOKS_REDIRECT_URI ||
      `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}/api/quickbooks/callback`;

    const { tokenUrl } = getIntuitEndpoints(environment);

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
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }).toString(),
    });

    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || tokenData.error) {
      return errorPage(res, 'Token Exchange Failed', `Error: ${JSON.stringify(tokenData).substring(0, 400)}`);
    }

    const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();

    let companyName = null;
    try {
      const companyInfo = await fetchCompanyInfo(tokenData.access_token, realmId, environment);
      companyName = companyInfo?.CompanyName || companyInfo?.LegalName || null;
    } catch (companyErr) {
      console.warn('[QBO Callback] Could not fetch company info (non-fatal):', companyErr.message);
    }

    const { data: existing } = await supabase
      .from('quickbooks_token')
      .select('id')
      .eq('app_tenant_id', appTenantId)
      .maybeSingle();

    const tokenRecord = {
      app_tenant_id: appTenantId,
      realm_id: realmId,
      company_name: companyName,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      token_type: tokenData.token_type || 'bearer',
      expires_at: expiresAt,
      environment,
      updated_at: new Date().toISOString(),
    };

    let saveError;
    if (existing) {
      ({ error: saveError } = await supabase
        .from('quickbooks_token')
        .update(tokenRecord)
        .eq('id', existing.id));
    } else {
      ({ error: saveError } = await supabase.from('quickbooks_token').insert(tokenRecord));
    }

    if (saveError) {
      console.error('[QBO Callback] Failed to save token:', saveError);
      return errorPage(res, 'Database Error', `Failed to save QuickBooks token: ${saveError.message}`);
    }

    try {
      await setActiveAccountingProvider(appTenantId, 'quickbooks');
    } catch (provErr) {
      console.error('[QBO Callback] Failed to set active accounting provider (non-fatal):', provErr.message);
    }

    return res.send(`
      <html>
        <body style="font-family: system-ui; padding: 40px; text-align: center; background: linear-gradient(to br, #f8fafc, #eff6ff);">
          <h1 style="color: #16a34a;">QuickBooks Connected Successfully</h1>
          <p>Connected to: <strong>${(companyName || 'your QuickBooks company').replace(/</g, '&lt;')}</strong> (${environment})</p>
          <p style="font-size: 14px; color: #64748b;">You can now close this window.</p>
          <button onclick="window.close()" style="margin-top: 20px; padding: 12px 24px; background: #2563eb; color: white; border: none; border-radius: 6px; cursor: pointer;">Close Window</button>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('[QBO Callback] Error:', err);
    return errorPage(res, 'Authentication Error', err.message);
  }
}
