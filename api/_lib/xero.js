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

export async function findOrCreateXeroContact(accessToken, xeroTenantId, contactInfo) {
  const info = typeof contactInfo === 'string'
    ? { name: contactInfo, email: null, isOrganization: true }
    : contactInfo;

  console.log(`[Xero] Finding/creating contact: ${info.name}`);

  const escapedName = info.name.replace(/"/g, '\\"');
  const contactSearchResponse = await fetch(
    `https://api.xero.com/api.xro/2.0/Contacts?where=${encodeURIComponent(`Name=="${escapedName}"`)}`,
    {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'xero-tenant-id': xeroTenantId,
        'Accept': 'application/json'
      }
    }
  );

  const contactData = await contactSearchResponse.json();
  if (contactData.Contacts && contactData.Contacts.length > 0) {
    console.log(`[Xero] Found existing contact: ${contactData.Contacts[0].ContactID}`);
    return contactData.Contacts[0].ContactID;
  }

  console.log(`[Xero] Creating new contact...`);
  const newContact = { Name: info.name };
  if (info.email) newContact.EmailAddress = info.email;

  const createContactResponse = await fetch('https://api.xero.com/api.xro/2.0/Contacts', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'xero-tenant-id': xeroTenantId,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ Contacts: [newContact] })
  });

  const newContactData = await createContactResponse.json();
  if (newContactData.Contacts && newContactData.Contacts.length > 0) {
    console.log(`[Xero] Created new contact: ${newContactData.Contacts[0].ContactID}`);
    return newContactData.Contacts[0].ContactID;
  }

  console.error(`[Xero] Failed to create contact:`, JSON.stringify(newContactData).substring(0, 500));
  throw new Error('Failed to create Xero contact');
}

export async function createXeroMembershipInvoice({ appTenantId, organizationName, membershipYear, tierLabel, finalCost, currency, reference }) {
  if (!supabase) throw new Error('Supabase not configured');
  if (!appTenantId) throw new Error('appTenantId is required');
  if (!organizationName) throw new Error('organizationName is required');

  const { accessToken, tenantId: xeroTenantId } = await getValidXeroAccessToken(appTenantId);
  const contactId = await findOrCreateXeroContact(accessToken, xeroTenantId, organizationName);

  const { data: accountCodeSetting } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('setting_key', 'xero_sales_account_code')
    .eq('tenant_id', appTenantId)
    .maybeSingle();

  const xeroAccountCode = accountCodeSetting?.setting_value || '200';

  const { data: invoiceStatusSetting } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('setting_key', 'xero_invoice_status')
    .eq('tenant_id', appTenantId)
    .maybeSingle();

  const xeroInvoiceStatus = invoiceStatusSetting?.setting_value || 'DRAFT';

  const description = `Membership subscription for ${membershipYear}.\nTier: ${tierLabel || 'Standard'}\nFee: ${currency} ${parseFloat(finalCost).toFixed(2)}`;

  const invoicePayload = {
    Invoices: [{
      Type: 'ACCREC',
      Contact: { ContactID: contactId },
      Reference: reference || `Membership ${membershipYear}`,
      Status: xeroInvoiceStatus,
      DueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      LineItems: [{
        Description: description,
        Quantity: 1,
        UnitAmount: parseFloat(finalCost).toFixed(2),
        AccountCode: xeroAccountCode
      }]
    }]
  };

  console.log(`[Xero] Creating membership invoice for ${organizationName}, ${membershipYear}, ${currency} ${finalCost}`);

  const invoiceResponse = await fetch('https://api.xero.com/api.xro/2.0/Invoices', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'xero-tenant-id': xeroTenantId,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(invoicePayload)
  });

  const invoiceData = await invoiceResponse.json();

  if (!invoiceResponse.ok || !invoiceData.Invoices || invoiceData.Invoices.length === 0) {
    console.error(`[Xero] Failed to create membership invoice:`, JSON.stringify(invoiceData).substring(0, 500));
    throw new Error(`Failed to create Xero invoice: ${JSON.stringify(invoiceData)}`);
  }

  const invoice = invoiceData.Invoices[0];
  console.log(`[Xero] Membership invoice created: ${invoice.InvoiceNumber} (${invoice.InvoiceID})`);

  return {
    invoice_id: invoice.InvoiceID,
    invoice_number: invoice.InvoiceNumber,
    total: invoice.Total,
    status: invoice.Status
  };
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
