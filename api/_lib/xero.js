import { supabase } from './database.js';

const XERO_CLIENT_ID = process.env.ZOHO_CLIENT_ID ? undefined : process.env.XERO_CLIENT_ID;
const XERO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET ? undefined : process.env.XERO_CLIENT_SECRET;

export async function getValidXeroAccessToken() {
  if (!supabase) throw new Error('Supabase not configured');
  
  const { data: tokens } = await supabase
    .from('xero_token')
    .select('*');

  if (!tokens || tokens.length === 0) {
    throw new Error('No Xero token found. Please authenticate first.');
  }

  const token = tokens[0];
  const expiresAt = new Date(token.expires_at);
  const now = new Date();
  const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000);

  if (expiresAt > fiveMinutesFromNow) {
    return { accessToken: token.access_token, tenantId: token.tenant_id };
  }

  const clientId = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;
  
  if (!clientId || !clientSecret) {
    throw new Error('Xero credentials not configured');
  }

  const tokenResponse = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
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

export async function fetchXeroInvoicePdf(invoiceId) {
  const { accessToken, tenantId } = await getValidXeroAccessToken();
  
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
