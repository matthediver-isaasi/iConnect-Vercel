import { supabase } from './database.js';
import { getXeroCredentials } from './xeroCredentials.js';

export async function getValidXeroAccessToken(appTenantId) {
  if (!supabase) throw new Error('Supabase not configured');
  
  if (!appTenantId) {
    throw new Error('appTenantId is required for Xero token lookup');
  }
  
  const { data: tokens, error } = await supabase
    .from('xero_token')
    .select('*')
    .eq('app_tenant_id', appTenantId);

  if (error) {
    console.error('[Xero] Token lookup error:', error);
    throw new Error('Failed to lookup Xero token');
  }

  if (!tokens || tokens.length === 0) {
    throw new Error('No Xero token found for this tenant. Please authenticate first.');
  }

  const token = tokens[0];
  
  if (token.tenant_id === 'PENDING_SELECTION') {
    throw new Error('Xero authentication incomplete. Please select a Xero organization.');
  }
  
  const expiresAt = new Date(token.expires_at);
  const now = new Date();
  const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000);

  if (expiresAt > fiveMinutesFromNow) {
    return { accessToken: token.access_token, tenantId: token.tenant_id };
  }

  const xeroCredentials = await getXeroCredentials(appTenantId);
  
  if (!xeroCredentials || !xeroCredentials.client_id || !xeroCredentials.client_secret) {
    throw new Error('Xero credentials not configured for this tenant');
  }

  const tokenResponse = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${xeroCredentials.client_id}:${xeroCredentials.client_secret}`).toString('base64')
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: token.refresh_token,
    }).toString(),
  });

  const tokenData = await tokenResponse.json();

  if (!tokenResponse.ok || tokenData.error) {
    throw new Error(`Failed to refresh Xero token: ${JSON.stringify(tokenData)}`);
  }

  const newExpiresAt = new Date(Date.now() + (tokenData.expires_in * 1000)).toISOString();

  await supabase
    .from('xero_token')
    .update({
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: newExpiresAt,
    })
    .eq('id', token.id);

  return { accessToken: tokenData.access_token, tenantId: token.tenant_id };
}

export async function fetchXeroInvoicePdf(invoiceId, appTenantId) {
  const { accessToken, tenantId } = await getValidXeroAccessToken(appTenantId);
  
  const pdfResponse = await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${invoiceId}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'xero-tenant-id': tenantId,
      'Accept': 'application/pdf'
    }
  });

  if (!pdfResponse.ok) {
    throw new Error(`Failed to fetch invoice PDF from Xero: ${pdfResponse.status}`);
  }

  const pdfBuffer = await pdfResponse.arrayBuffer();
  return Buffer.from(pdfBuffer);
}
