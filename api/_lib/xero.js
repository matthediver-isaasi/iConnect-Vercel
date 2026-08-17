import { supabase } from './database.js';
import { getXeroCredentials } from './xeroCredentials.js';

async function safeXeroJson(response, context) {
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok) {
    if (contentType.includes('application/json')) {
      const errorData = await response.json();
      throw new Error(`[Xero ${context}] HTTP ${response.status}: ${JSON.stringify(errorData).substring(0, 500)}`);
    }
    const text = await response.text();
    throw new Error(`[Xero ${context}] HTTP ${response.status} (non-JSON response): ${text.substring(0, 300)}`);
  }
  if (!contentType.includes('application/json')) {
    const text = await response.text();
    throw new Error(`[Xero ${context}] Unexpected content-type '${contentType}': ${text.substring(0, 300)}`);
  }
  return response.json();
}

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

  const tokenData = await safeXeroJson(tokenResponse, 'token-refresh');

  if (tokenData.error) {
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

function parseAddressLines(addressText) {
  if (!addressText) return null;
  const lines = addressText.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const address = { AddressType: 'POBOX' };
  if (lines.length === 1) {
    address.AddressLine1 = lines[0];
  } else if (lines.length === 2) {
    address.AddressLine1 = lines[0];
    address.City = lines[1];
  } else if (lines.length === 3) {
    address.AddressLine1 = lines[0];
    address.City = lines[1];
    address.PostalCode = lines[2];
  } else {
    address.AddressLine1 = lines[0];
    address.AddressLine2 = lines[1];
    address.City = lines[2];
    address.PostalCode = lines[3];
    if (lines[4]) address.Country = lines[4];
  }
  return address;
}

export async function findOrCreateXeroContact(accessToken, xeroTenantId, contactInfo) {
  const info = typeof contactInfo === 'string'
    ? { name: contactInfo, email: null, isOrganization: true, address: null }
    : contactInfo;

  console.log(`[Xero] Finding/creating contact: ${info.name}`);

  const parsedAddress = parseAddressLines(info.address);

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

  const contactData = await safeXeroJson(contactSearchResponse, 'contact-search');
  if (contactData.Contacts && contactData.Contacts.length > 0) {
    const existingContact = contactData.Contacts[0];
    console.log(`[Xero] Found existing contact: ${existingContact.ContactID}`);

    if (parsedAddress || info.email) {
      try {
        const updateContact = { ContactID: existingContact.ContactID };
        if (parsedAddress) updateContact.Addresses = [parsedAddress];
        if (info.email) updateContact.EmailAddress = info.email;
        const updatePayload = { Contacts: [updateContact] };
        const updateResponse = await fetch('https://api.xero.com/api.xro/2.0/Contacts', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'xero-tenant-id': xeroTenantId,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify(updatePayload)
        });
        await safeXeroJson(updateResponse, 'contact-update');
        console.log(`[Xero] Updated contact details for: ${info.name}`);
      } catch (addrErr) {
        console.warn(`[Xero] Failed to update contact details (non-fatal): ${addrErr.message}`);
      }
    }

    return existingContact.ContactID;
  }

  console.log(`[Xero] Creating new contact...`);
  const newContact = { Name: info.name };
  if (info.email) newContact.EmailAddress = info.email;
  if (parsedAddress) newContact.Addresses = [parsedAddress];

  const createContactResponse = await fetch('https://api.xero.com/api.xro/2.0/Contacts', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'xero-tenant-id': xeroTenantId,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({ Contacts: [newContact] })
  });

  const newContactData = await safeXeroJson(createContactResponse, 'contact-create');
  if (newContactData.Contacts && newContactData.Contacts.length > 0) {
    console.log(`[Xero] Created new contact: ${newContactData.Contacts[0].ContactID}`);
    return newContactData.Contacts[0].ContactID;
  }

  console.error(`[Xero] Failed to create contact:`, JSON.stringify(newContactData).substring(0, 500));
  throw new Error('Failed to create Xero contact');
}

export async function createXeroMembershipInvoice({ appTenantId, organizationName, invoicingEmail, invoicingAddress, membershipYear, tierLabel, finalCost, currency, reference, vatRate, markAsPaid, stripePaymentIntentId, invoiceDescription, extraLineItems, nominalCode, bankAccountSettingKey, strictBankAccount, idempotencyKey, paymentIdempotencyKey }) {
  if (!supabase) throw new Error('Supabase not configured');
  if (!appTenantId) throw new Error('appTenantId is required');
  if (!organizationName) throw new Error('organizationName is required');

  const { accessToken, tenantId: xeroTenantId } = await getValidXeroAccessToken(appTenantId);
  const contactId = await findOrCreateXeroContact(accessToken, xeroTenantId, {
    name: organizationName,
    email: invoicingEmail || null,
    address: invoicingAddress || null,
  });

  const { data: membershipLedgerSetting } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('setting_key', 'membership_nominal_ledger')
    .eq('tenant_id', appTenantId)
    .maybeSingle();

  let xeroAccountCode = membershipLedgerSetting?.setting_value;
  if (!xeroAccountCode) {
    const { data: accountCodeSetting } = await supabase
      .from('system_settings')
      .select('setting_value')
      .eq('setting_key', 'xero_sales_account_code')
      .eq('tenant_id', appTenantId)
      .maybeSingle();
    xeroAccountCode = accountCodeSetting?.setting_value || '200';
  }
  // An explicit nominal code (e.g. the Training Fund default from Membership
  // Settings) overrides the membership ledger for the main invoice line.
  if (nominalCode && String(nominalCode).trim()) {
    xeroAccountCode = String(nominalCode).trim();
  }

  const { data: invoiceStatusSetting } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('setting_key', 'xero_invoice_status')
    .eq('tenant_id', appTenantId)
    .maybeSingle();

  const configuredInvoiceStatus = invoiceStatusSetting?.setting_value || 'DRAFT';
  const xeroInvoiceStatus = markAsPaid ? 'AUTHORISED' : configuredInvoiceStatus;

  let taxType = null;
  let taxLabel = null;
  if (vatRate) {
    try {
      const parsed = typeof vatRate === 'string' ? JSON.parse(vatRate) : vatRate;
      taxType = parsed.taxType || null;
      taxLabel = parsed.name || null;
    } catch {
      taxType = vatRate;
    }
  }

  const firstLine = invoiceDescription
    ? invoiceDescription.replace(/\{year\}/gi, membershipYear)
    : `Membership subscription for ${membershipYear}`;
  const description = `${firstLine}.\nTier: ${tierLabel || 'Standard'}\nFee: ${currency} ${parseFloat(finalCost).toFixed(2)}`;

  const lineItem = {
    Description: description,
    Quantity: 1,
    UnitAmount: parseFloat(finalCost).toFixed(2),
    AccountCode: xeroAccountCode
  };
  if (taxType) {
    lineItem.TaxType = taxType;
  }

  const lineItems = [lineItem];
  // Add-on lines (e.g. Training Fund top-up, free-form extras) appended after
  // the membership fee line. Each carries its own nominal code + VAT type.
  for (const extra of (Array.isArray(extraLineItems) ? extraLineItems : [])) {
    const extraLine = {
      Description: extra.description || 'Additional item',
      Quantity: Number(extra.quantity) > 0 ? Number(extra.quantity) : 1,
      UnitAmount: (Number(extra.unitCost) || 0).toFixed(2),
      AccountCode: extra.nominalCode || xeroAccountCode,
    };
    const extraTaxType = extra.vatRate?.taxType || (typeof extra.vatRate === 'string' ? extra.vatRate : null);
    if (extraTaxType) extraLine.TaxType = extraTaxType;
    lineItems.push(extraLine);
  }

  const invoicePayload = {
    Invoices: [{
      Type: 'ACCREC',
      Contact: { ContactID: contactId },
      Reference: reference || `Membership ${membershipYear}`,
      Status: xeroInvoiceStatus,
      DueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      LineItems: lineItems
    }]
  };

  console.log(`[Xero] Creating membership invoice for ${organizationName}, ${membershipYear}, ${currency} ${finalCost}`);

  const createHeaders = {
    'Authorization': `Bearer ${accessToken}`,
    'xero-tenant-id': xeroTenantId,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };
  // Task #3633: provider-side idempotency — Xero replays the original
  // response for a repeated Idempotency-Key instead of creating a second
  // invoice, so a crash between create and our local linkage write cannot
  // duplicate on retry.
  if (idempotencyKey) createHeaders['Idempotency-Key'] = String(idempotencyKey).slice(0, 128);
  const invoiceResponse = await fetch('https://api.xero.com/api.xro/2.0/Invoices', {
    method: 'POST',
    headers: createHeaders,
    body: JSON.stringify(invoicePayload)
  });

  const invoiceData = await safeXeroJson(invoiceResponse, 'invoice-create');

  if (!invoiceData.Invoices || invoiceData.Invoices.length === 0) {
    console.error(`[Xero] Failed to create membership invoice:`, JSON.stringify(invoiceData).substring(0, 500));
    throw new Error(`Failed to create Xero invoice: ${JSON.stringify(invoiceData)}`);
  }

  const invoice = invoiceData.Invoices[0];
  console.log(`[Xero] Membership invoice created: ${invoice.InvoiceNumber} (${invoice.InvoiceID}) - Status: ${invoice.Status}`);

  let paymentRecorded = false;
  let paymentId = null;

  if (markAsPaid && invoice.InvoiceID && invoice.Status === 'AUTHORISED') {
    try {
      // Task #3633: callers may name a dedicated bank-account setting (e.g.
      // the GoCardless one for DD instalment invoices); fall back to the
      // Stripe bank account setting when unset — unless strictBankAccount,
      // where the caller's rail requires its OWN account (falling back would
      // book the money to the wrong account) and payment_recorded=false must
      // surface recoverably instead.
      let stripeBankAccountCode = null;
      if (bankAccountSettingKey && bankAccountSettingKey !== 'xero_stripe_bank_account_code') {
        const { data: dedicated } = await supabase
          .from('system_settings')
          .select('setting_value')
          .eq('setting_key', bankAccountSettingKey)
          .eq('tenant_id', appTenantId)
          .maybeSingle();
        stripeBankAccountCode = dedicated?.setting_value || null;
      }
      const strictDedicated = strictBankAccount === true
        && bankAccountSettingKey && bankAccountSettingKey !== 'xero_stripe_bank_account_code';
      if (!stripeBankAccountCode && !strictDedicated) {
        const { data: stripeBankCodeSetting } = await supabase
          .from('system_settings')
          .select('setting_value')
          .eq('setting_key', 'xero_stripe_bank_account_code')
          .eq('tenant_id', appTenantId)
          .maybeSingle();
        stripeBankAccountCode = stripeBankCodeSetting?.setting_value;
      }

      if (stripeBankAccountCode) {
        const accountsResponse = await fetch(`https://api.xero.com/api.xro/2.0/Accounts?where=Code=="${stripeBankAccountCode}"`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'xero-tenant-id': xeroTenantId,
            'Accept': 'application/json'
          }
        });

        const accountsData = await safeXeroJson(accountsResponse, 'accounts-lookup');
        const bankAccount = accountsData?.Accounts?.[0];

        if (bankAccount?.AccountID) {
          const paymentPayload = {
            Invoice: { InvoiceID: invoice.InvoiceID },
            Account: { AccountID: bankAccount.AccountID },
            Date: new Date().toISOString().split('T')[0],
            Amount: parseFloat(invoice.Total),
            Reference: stripePaymentIntentId ? `Stripe: ${stripePaymentIntentId}` : 'Stripe payment'
          };

          console.log(`[Xero] Recording Stripe payment for membership invoice ${invoice.InvoiceNumber} - Amount: ${parseFloat(invoice.Total).toFixed(2)}, Bank Account: ${stripeBankAccountCode}`);

          // Payment creation is a separate request — give it its own
          // Idempotency-Key so a crash after the payment succeeded but
          // before our linkage write can't record a second payment on retry.
          const payHeaders = {
            'Authorization': `Bearer ${accessToken}`,
            'xero-tenant-id': xeroTenantId,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          };
          if (paymentIdempotencyKey) payHeaders['Idempotency-Key'] = String(paymentIdempotencyKey).slice(0, 128);
          const paymentResponse = await fetch('https://api.xero.com/api.xro/2.0/Payments', {
            method: 'POST',
            headers: payHeaders,
            body: JSON.stringify({ Payments: [paymentPayload] })
          });

          const paymentData = await safeXeroJson(paymentResponse, 'payment-create');

          if (paymentData?.Payments?.[0]?.PaymentID) {
            paymentRecorded = true;
            paymentId = paymentData.Payments[0].PaymentID;
            console.log(`[Xero] Membership payment recorded - PaymentID: ${paymentId}`);
          } else {
            console.error(`[Xero] Failed to record membership payment: ${JSON.stringify(paymentData).substring(0, 500)}`);
          }
        } else {
          console.warn(`[Xero] Bank account not found for code: ${stripeBankAccountCode} - invoice created but payment not recorded`);
        }
      } else {
        console.log(`[Xero] xero_stripe_bank_account_code not configured - membership invoice created as AUTHORISED but payment not recorded`);
      }
    } catch (paymentError) {
      console.error(`[Xero] Error recording membership payment (non-fatal): ${paymentError.message}`);
    }
  }

  let onlineInvoiceUrl = null;
  if (invoice.InvoiceID && invoice.Status !== 'DRAFT') {
    try {
      const onlineResponse = await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${invoice.InvoiceID}/OnlineInvoice`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'xero-tenant-id': xeroTenantId,
          'Accept': 'application/json'
        }
      });
      const onlineData = await safeXeroJson(onlineResponse, 'online-invoice-url');
      onlineInvoiceUrl = onlineData?.OnlineInvoices?.[0]?.OnlineInvoiceUrl || null;
      if (onlineInvoiceUrl) {
        console.log(`[Xero] Online invoice URL retrieved for ${invoice.InvoiceNumber}`);
      }
    } catch (urlErr) {
      console.warn(`[Xero] Could not fetch online invoice URL (non-fatal): ${urlErr.message}`);
    }
  }

  return {
    invoice_id: invoice.InvoiceID,
    invoice_number: invoice.InvoiceNumber,
    total: invoice.Total,
    status: paymentRecorded ? 'PAID' : invoice.Status,
    payment_recorded: paymentRecorded,
    payment_id: paymentId,
    online_invoice_url: onlineInvoiceUrl
  };
}

export async function updateXeroInvoiceReference(appTenantId, invoiceId, reference) {
  if (!appTenantId) throw new Error('appTenantId is required');
  if (!invoiceId) throw new Error('invoiceId is required');

  const trimmedReference = typeof reference === 'string' ? reference.trim() : '';
  if (!trimmedReference) {
    throw new Error('reference must be a non-empty string');
  }

  const { accessToken, tenantId: xeroTenantId } = await getValidXeroAccessToken(appTenantId);

  const updatePayload = {
    Invoices: [{
      InvoiceID: invoiceId,
      Reference: trimmedReference
    }]
  };

  const response = await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${invoiceId}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'xero-tenant-id': xeroTenantId,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(updatePayload)
  });

  const data = await safeXeroJson(response, 'invoice-update-reference');
  const updatedInvoice = data?.Invoices?.[0];

  if (!updatedInvoice?.InvoiceID) {
    throw new Error(`Failed to update Xero invoice reference: ${JSON.stringify(data).substring(0, 500)}`);
  }

  return {
    invoiceId: updatedInvoice.InvoiceID,
    invoiceNumber: updatedInvoice.InvoiceNumber,
    reference: updatedInvoice.Reference
  };
}

/**
 * Update a Xero invoice's line-item descriptions after an attendee transfer.
 *
 * Walks each LineItem.Description line-by-line and replaces any line whose
 * trimmed text exactly matches the original attendee's full name or email
 * with the new attendee's full name (falling back to their email).
 *
 * Skips silently (returns { skipped: true, reason }) when:
 *   - the invoice has no line items
 *   - the invoice is PAID or VOIDED (cannot be edited)
 *   - no description line matches the original attendee
 */
export async function updateXeroInvoiceLineAttendeeDescription({
  appTenantId,
  invoiceId,
  originalFirstName,
  originalLastName,
  originalEmail,
  newFirstName,
  newLastName,
  newEmail,
}) {
  if (!appTenantId) throw new Error('appTenantId is required');
  if (!invoiceId) throw new Error('invoiceId is required');

  const { accessToken, tenantId: xeroTenantId } = await getValidXeroAccessToken(appTenantId);
  if (!accessToken || !xeroTenantId) {
    throw new Error('Missing Xero token or tenant ID');
  }

  const invoiceResponse = await fetch(
    `https://api.xero.com/api.xro/2.0/Invoices/${invoiceId}`,
    {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'xero-tenant-id': xeroTenantId,
        'Accept': 'application/json',
      },
    },
  );

  if (!invoiceResponse.ok) {
    const errText = await invoiceResponse.text();
    throw new Error(`Failed to fetch Xero invoice ${invoiceId}: ${invoiceResponse.status} ${errText.substring(0, 300)}`);
  }

  const invoiceData = await invoiceResponse.json();
  const invoice = invoiceData?.Invoices?.[0];

  if (!invoice || !invoice.LineItems || invoice.LineItems.length === 0) {
    return { skipped: true, reason: 'no-lines' };
  }
  if (invoice.Status === 'PAID' || invoice.Status === 'VOIDED') {
    return { skipped: true, reason: `status-${invoice.Status}` };
  }

  const originalName = [originalFirstName, originalLastName].filter(Boolean).join(' ').trim();
  const newName = [newFirstName, newLastName].filter(Boolean).join(' ').trim();
  const replacement = newName || newEmail || '';

  let descriptionUpdated = false;
  const updatedLineItems = invoice.LineItems.map((item) => {
    if (!item.Description) return item;
    const updatedDescription = item.Description.split('\n').map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (originalName && trimmed === originalName) {
        descriptionUpdated = true;
        return replacement;
      }
      if (originalEmail && trimmed === originalEmail) {
        descriptionUpdated = true;
        return replacement;
      }
      return line;
    }).join('\n');
    if (updatedDescription === item.Description) return item;
    return { ...item, Description: updatedDescription };
  });

  if (!descriptionUpdated) {
    return { skipped: true, reason: 'no-match' };
  }

  const updatePayload = {
    Invoices: [{
      InvoiceID: invoiceId,
      LineItems: updatedLineItems.map((li) => ({
        LineItemID: li.LineItemID,
        Description: li.Description,
        Quantity: li.Quantity,
        UnitAmount: li.UnitAmount,
        AccountCode: li.AccountCode,
        TaxType: li.TaxType,
        Tracking: li.Tracking,
      })),
    }],
  };

  const updateResponse = await fetch('https://api.xero.com/api.xro/2.0/Invoices', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'xero-tenant-id': xeroTenantId,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(updatePayload),
  });

  if (!updateResponse.ok) {
    const errText = await updateResponse.text();
    throw new Error(`Failed to update Xero invoice ${invoiceId}: ${updateResponse.status} ${errText.substring(0, 300)}`);
  }

  const updateData = await updateResponse.json();
  const updatedInvoice = updateData?.Invoices?.[0];
  return {
    invoiceId: updatedInvoice?.InvoiceID || invoiceId,
    invoiceNumber: updatedInvoice?.InvoiceNumber || null,
    updated: true,
  };
}

/**
 * Push a PO number into the matching Xero invoice's Reference field, swallow
 * any Xero failure (so the local database update is not undone), and return
 * a uniform shape every PO entry point can forward back to the client.
 *
 * @param {Object} args
 * @param {string} args.appTenantId          Application tenant id used to look up the Xero token.
 * @param {string|null} args.xeroInvoiceId   Xero invoice id (skipped when falsy).
 * @param {string} args.purchaseOrderNumber  Trimmed PO number to push.
 * @param {string} [args.contextLabel]       Logging label.
 * @returns {Promise<{xeroUpdated: boolean, xeroError: string|null, skipped?: boolean}>}
 */
export async function pushPurchaseOrderToXero({
  appTenantId,
  xeroInvoiceId,
  purchaseOrderNumber,
  contextLabel = 'PO sync'
}) {
  if (!xeroInvoiceId) {
    console.log(`[${contextLabel}] PO saved locally but no xero_invoice_id present — skipping Xero push`);
    return { xeroUpdated: false, xeroError: null, skipped: true };
  }

  if (!appTenantId) {
    const msg = 'Cannot determine tenant for Xero token lookup';
    console.error(`[${contextLabel}] Xero reference update FAILED for invoice ${xeroInvoiceId}: ${msg}`);
    return { xeroUpdated: false, xeroError: msg };
  }

  try {
    await updateXeroInvoiceReference(appTenantId, xeroInvoiceId, purchaseOrderNumber);
    console.log(`[${contextLabel}] Xero reference updated for invoice ${xeroInvoiceId} -> "${purchaseOrderNumber}"`);
    return { xeroUpdated: true, xeroError: null };
  } catch (xeroErr) {
    const errMsg = xeroErr?.message || 'Unknown Xero error';
    console.error(`[${contextLabel}] Xero reference update FAILED for invoice ${xeroInvoiceId}: ${errMsg}`);
    return { xeroUpdated: false, xeroError: errMsg };
  }
}

/**
 * Apply a Stripe payment to an *existing* Xero invoice (created earlier by
 * the auto-renewal cron). Used when a membership_fee_token already carries a
 * xero_invoice_id — we must not create a second invoice for the same year.
 *
 * If the invoice is currently DRAFT, it is first promoted to AUTHORISED.
 * Payment is recorded against the tenant's configured Stripe bank account
 * (system setting `xero_stripe_bank_account_code`). The current online
 * invoice URL is fetched and returned for display on the payer's confirmation
 * screen.
 */
export async function applyStripePaymentToXeroInvoice({
  appTenantId,
  xeroInvoiceId,
  stripePaymentIntentId,
  amount = null,
  reference = null,
  bankAccountSettingKey = 'xero_stripe_bank_account_code',
  strictBankAccount = false,
  idempotencyKey = null,
}) {
  if (!appTenantId) throw new Error('appTenantId is required');
  if (!xeroInvoiceId) throw new Error('xeroInvoiceId is required');

  const { accessToken, tenantId: xeroTenantId } = await getValidXeroAccessToken(appTenantId);

  const invResp = await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${xeroInvoiceId}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'xero-tenant-id': xeroTenantId,
      'Accept': 'application/json',
    },
  });
  const invData = await safeXeroJson(invResp, 'invoice-retrieve');
  const invoice = invData?.Invoices?.[0];
  if (!invoice) throw new Error(`Xero invoice ${xeroInvoiceId} not found`);

  if (invoice.Status === 'DRAFT' || invoice.Status === 'SUBMITTED') {
    const authResp = await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${xeroInvoiceId}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'xero-tenant-id': xeroTenantId,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ Invoices: [{ InvoiceID: xeroInvoiceId, Status: 'AUTHORISED' }] }),
    });
    await safeXeroJson(authResp, 'invoice-authorise');
  }

  let paymentRecorded = false;
  let paymentId = null;
  try {
    const { data: stripeBankCodeSetting } = await supabase
      .from('system_settings')
      .select('setting_value')
      .eq('setting_key', bankAccountSettingKey)
      .eq('tenant_id', appTenantId)
      .maybeSingle();
    let bankCode = stripeBankCodeSetting?.setting_value;
    if (!bankCode && bankAccountSettingKey !== 'xero_stripe_bank_account_code' && strictBankAccount !== true) {
      // Fall back to the Stripe bank code when a dedicated one isn't set
      // (never in strict mode — the caller's rail requires its own account).
      const { data: fallbackSetting } = await supabase
        .from('system_settings')
        .select('setting_value')
        .eq('setting_key', 'xero_stripe_bank_account_code')
        .eq('tenant_id', appTenantId)
        .maybeSingle();
      bankCode = fallbackSetting?.setting_value;
    }
    if (bankCode) {
      const accountsResp = await fetch(`https://api.xero.com/api.xro/2.0/Accounts?where=Code=="${bankCode}"`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'xero-tenant-id': xeroTenantId, 'Accept': 'application/json' },
      });
      const accountsData = await safeXeroJson(accountsResp, 'accounts-lookup');
      const bankAccount = accountsData?.Accounts?.[0];
      if (bankAccount?.AccountID) {
        const paymentPayload = {
          Invoice: { InvoiceID: xeroInvoiceId },
          Account: { AccountID: bankAccount.AccountID },
          Date: new Date().toISOString().split('T')[0],
          Amount: amount != null ? Number(parseFloat(amount).toFixed(2)) : parseFloat(invoice.Total),
          Reference: reference || (stripePaymentIntentId ? `Stripe: ${stripePaymentIntentId}` : 'Stripe payment'),
        };
        // Idempotent payment create — Xero replays the original response for
        // a repeated Idempotency-Key, so retries can't double-pay the invoice.
        const payHeaders = {
          'Authorization': `Bearer ${accessToken}`,
          'xero-tenant-id': xeroTenantId,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        };
        if (idempotencyKey) payHeaders['Idempotency-Key'] = String(idempotencyKey).slice(0, 128);
        const payResp = await fetch('https://api.xero.com/api.xro/2.0/Payments', {
          method: 'POST',
          headers: payHeaders,
          body: JSON.stringify({ Payments: [paymentPayload] }),
        });
        const payData = await safeXeroJson(payResp, 'payment-create');
        if (payData?.Payments?.[0]?.PaymentID) {
          paymentRecorded = true;
          paymentId = payData.Payments[0].PaymentID;
          console.log(`[Xero] Payment recorded against existing invoice ${invoice.InvoiceNumber} - PaymentID: ${paymentId}`);
        }
      } else {
        console.warn(`[Xero] Bank account not found for code ${bankCode} - invoice authorised but payment not recorded`);
      }
    } else {
      console.log(`[Xero] xero_stripe_bank_account_code not configured - invoice authorised but payment not recorded`);
    }
  } catch (payErr) {
    console.error(`[Xero] Error recording payment against existing invoice (non-fatal): ${payErr.message}`);
  }

  let onlineInvoiceUrl = null;
  try {
    const onlineResp = await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${xeroInvoiceId}/OnlineInvoice`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'xero-tenant-id': xeroTenantId, 'Accept': 'application/json' },
    });
    const onlineData = await safeXeroJson(onlineResp, 'online-invoice-url');
    onlineInvoiceUrl = onlineData?.OnlineInvoices?.[0]?.OnlineInvoiceUrl || null;
  } catch (urlErr) {
    console.warn(`[Xero] Could not fetch online invoice URL (non-fatal): ${urlErr.message}`);
  }

  return {
    invoice_id: xeroInvoiceId,
    invoice_number: invoice.InvoiceNumber,
    total: invoice.Total,
    payment_recorded: paymentRecorded,
    payment_id: paymentId,
    online_invoice_url: onlineInvoiceUrl,
  };
}

/**
 * Fetch a Xero invoice (raw API response shape).
 * Used by the reconciliation helper and as a building block for any
 * status/PDF/line-edit code that needs the latest server-side invoice.
 */
export async function getXeroInvoice(invoiceId, appTenantId) {
  if (!appTenantId) throw new Error('appTenantId is required');
  if (!invoiceId) throw new Error('invoiceId is required');

  const { accessToken, tenantId: xeroTenantId } = await getValidXeroAccessToken(appTenantId);

  const response = await fetch(
    `https://api.xero.com/api.xro/2.0/Invoices/${invoiceId}`,
    {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'xero-tenant-id': xeroTenantId,
        'Accept': 'application/json',
      },
    },
  );

  const data = await safeXeroJson(response, 'invoice-retrieve');
  return data?.Invoices?.[0] || null;
}

/**
 * Returns a normalised payment-state snapshot for a Xero invoice.
 *   status     — 'paid' | 'voided' | 'partial' | 'unpaid'
 *   balance    — outstanding balance
 *   totalAmt   — invoice total
 *   amountPaid — total paid so far
 *   paidAt     — ISO timestamp of the last payment (best-effort)
 *   voided     — boolean
 *   raw        — original Xero invoice object (for debugging)
 */
export async function fetchXeroInvoiceStatus(invoiceId, appTenantId) {
  const invoice = await getXeroInvoice(invoiceId, appTenantId);
  if (!invoice) return null;

  const xStatus = invoice.Status || '';
  const total = parseFloat(invoice.Total || 0);
  const balance = parseFloat(invoice.AmountDue ?? invoice.amountDue ?? 0);
  const amountPaid = parseFloat(invoice.AmountPaid ?? invoice.amountPaid ?? 0);

  let status = 'unpaid';
  if (xStatus === 'PAID' || (total > 0 && balance === 0 && amountPaid >= total)) {
    status = 'paid';
  } else if (xStatus === 'VOIDED' || xStatus === 'DELETED') {
    status = 'voided';
  } else if (amountPaid > 0 && balance > 0) {
    status = 'partial';
  }

  // Best-effort: most recent payment date from the Payments[] sub-array.
  let paidAt = null;
  if (status === 'paid' && Array.isArray(invoice.Payments) && invoice.Payments.length > 0) {
    const dates = invoice.Payments
      .map((p) => p?.Date)
      .filter(Boolean)
      .map((d) => parseXeroDate(d))
      .filter(Boolean)
      .sort((a, b) => b - a);
    if (dates.length > 0) paidAt = new Date(dates[0]).toISOString();
  }
  if (status === 'paid' && !paidAt && invoice.FullyPaidOnDate) {
    const t = parseXeroDate(invoice.FullyPaidOnDate);
    if (t) paidAt = new Date(t).toISOString();
  }
  if (status === 'paid' && !paidAt) {
    paidAt = new Date().toISOString();
  }

  return {
    status,
    balance,
    totalAmt: total,
    amountPaid,
    paidAt,
    voided: xStatus === 'VOIDED' || xStatus === 'DELETED',
    raw: invoice,
  };
}

// Xero serialises dates as "/Date(1700000000000+0000)/" — extract the millis.
function parseXeroDate(value) {
  if (!value) return null;
  if (typeof value === 'number') return value;
  const m = String(value).match(/\/Date\((-?\d+)/);
  if (m) return Number(m[1]);
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
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

export async function fetchXeroCreditNotePdf(creditNoteId, appTenantId) {
  const { accessToken, tenantId } = await getValidXeroAccessToken(appTenantId);

  const pdfResponse = await fetch(`https://api.xero.com/api.xro/2.0/CreditNotes/${creditNoteId}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'xero-tenant-id': tenantId,
      'Accept': 'application/pdf'
    }
  });

  if (!pdfResponse.ok) {
    throw new Error(`Failed to fetch credit note PDF from Xero: ${pdfResponse.status}`);
  }

  const pdfBuffer = await pdfResponse.arrayBuffer();
  return Buffer.from(pdfBuffer);
}

export async function emailXeroCreditNote({ appTenantId, creditNoteId, creditNoteNumber, toEmail, tenantId }) {
  if (!creditNoteId) throw new Error('creditNoteId is required');
  if (!toEmail) throw new Error('toEmail is required');

  console.log(`[Xero] Fetching credit note ${creditNoteNumber || creditNoteId} PDF to email to ${toEmail}`);
  const pdfBuffer = await fetchXeroCreditNotePdf(creditNoteId, appTenantId);

  const { sendEmail } = await import('./emailService.js');

  const filename = `credit-note-${creditNoteNumber || creditNoteId}.pdf`;
  await sendEmail({
    tenantId: tenantId || appTenantId,
    to: toEmail,
    subject: `Credit Note ${creditNoteNumber || ''}`.trim(),
    html: `<p>Please find attached your credit note${creditNoteNumber ? ` (${creditNoteNumber})` : ''}.</p>`,
    attachments: [{
      filename,
      data: pdfBuffer,
      contentType: 'application/pdf',
    }],
  });

  console.log(`[Xero] Credit note ${creditNoteNumber || creditNoteId} emailed to ${toEmail}`);
  return { success: true, email: toEmail };
}

export async function createXeroCreditNote({ appTenantId, invoiceId, creditAmount, description, reference }) {
  if (!appTenantId) throw new Error('appTenantId is required');
  if (!invoiceId) throw new Error('invoiceId is required');

  const numericAmount = Number(creditAmount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error(`creditAmount must be a positive number, got: ${creditAmount}`);
  }

  const { accessToken, tenantId: xeroTenantId } = await getValidXeroAccessToken(appTenantId);

  console.log(`[Xero] Retrieving invoice ${invoiceId} for credit note creation`);
  const invoiceResponse = await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${invoiceId}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'xero-tenant-id': xeroTenantId,
      'Accept': 'application/json'
    }
  });

  const invoiceData = await safeXeroJson(invoiceResponse, 'invoice-retrieve');
  const invoice = invoiceData?.Invoices?.[0];

  if (!invoice) {
    throw new Error(`Invoice ${invoiceId} not found in Xero`);
  }

  if (invoice.Status === 'VOIDED') {
    return { skipped: true, reason: 'Invoice is voided', invoiceId, invoiceNumber: invoice.InvoiceNumber };
  }

  if (invoice.Status === 'DRAFT') {
    return { skipped: true, reason: 'Invoice is in draft status — credit note cannot be allocated against drafts', invoiceId, invoiceNumber: invoice.InvoiceNumber };
  }

  const amountDue = Number(invoice.AmountDue) || 0;
  const amountCredited = Number(invoice.AmountCredited) || 0;
  const invoiceTotal = Number(invoice.Total) || 0;
  const remainingCreditable = Math.max(0, invoiceTotal - amountCredited);

  if (remainingCreditable <= 0) {
    return { skipped: true, reason: 'Invoice already fully credited', invoiceId, invoiceNumber: invoice.InvoiceNumber };
  }

  const effectiveAmount = Math.min(numericAmount, remainingCreditable);

  if (reference) {
    const existingResponse = await fetch(`https://api.xero.com/api.xro/2.0/CreditNotes?where=Reference=="${encodeURIComponent(reference)}"`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'xero-tenant-id': xeroTenantId,
        'Accept': 'application/json'
      }
    });
    const existingData = await safeXeroJson(existingResponse, 'creditnote-dedup-check');
    const existingCreditNotes = existingData?.CreditNotes || [];
    const matchingCN = existingCreditNotes.find(cn => cn.Status !== 'DELETED' && cn.Status !== 'VOIDED');
    if (matchingCN) {
      console.log(`[Xero] Credit note already exists for reference "${reference}": ${matchingCN.CreditNoteNumber}`);
      return {
        creditNoteId: matchingCN.CreditNoteID,
        creditNoteNumber: matchingCN.CreditNoteNumber,
        amount: Number(matchingCN.Total),
        status: matchingCN.Status,
        allocated: (Number(matchingCN.Total) - Number(matchingCN.RemainingCredit || 0)) > 0,
        invoiceId,
        invoiceNumber: invoice.InvoiceNumber,
        alreadyExisted: true,
      };
    }
  }

  const contactId = invoice.Contact?.ContactID;
  if (!contactId) {
    throw new Error(`Invoice ${invoiceId} has no associated contact in Xero`);
  }

  const originalLineItem = invoice.LineItems?.[0];
  const accountCode = originalLineItem?.AccountCode || '200';
  const taxType = originalLineItem?.TaxType || null;

  const lineItem = {
    Description: description || `Credit note for cancelled booking`,
    Quantity: 1,
    UnitAmount: Number(effectiveAmount.toFixed(2)),
    AccountCode: accountCode,
  };
  if (taxType) {
    lineItem.TaxType = taxType;
  }

  const creditNotePayload = {
    CreditNotes: [{
      Type: 'ACCRECCREDIT',
      Contact: { ContactID: contactId, Addresses: invoice.Contact?.Addresses || [] },
      Date: new Date().toISOString().split('T')[0],
      Reference: reference || '',
      Status: 'AUTHORISED',
      LineItems: [lineItem],
    }]
  };

  console.log(`[Xero] Creating credit note for £${effectiveAmount.toFixed(2)} against invoice ${invoice.InvoiceNumber} (requested: £${numericAmount.toFixed(2)}, creditable: £${remainingCreditable.toFixed(2)})`);
  const creditNoteResponse = await fetch('https://api.xero.com/api.xro/2.0/CreditNotes', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'xero-tenant-id': xeroTenantId,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(creditNotePayload)
  });

  const creditNoteData = await safeXeroJson(creditNoteResponse, 'creditnote-create');
  const creditNote = creditNoteData?.CreditNotes?.[0];

  if (!creditNote?.CreditNoteID) {
    throw new Error(`Failed to create Xero credit note: ${JSON.stringify(creditNoteData).substring(0, 500)}`);
  }

  console.log(`[Xero] Credit note created: ${creditNote.CreditNoteNumber} (${creditNote.CreditNoteID})`);

  let allocated = false;
  const allocatableAmount = Math.min(effectiveAmount, amountDue);
  if (allocatableAmount > 0) {
    try {
      const allocationPayload = {
        Allocations: [{
          Invoice: { InvoiceID: invoiceId },
          Amount: Number(allocatableAmount.toFixed(2)),
          Date: new Date().toISOString().split('T')[0],
        }]
      };

      const allocationResponse = await fetch(`https://api.xero.com/api.xro/2.0/CreditNotes/${creditNote.CreditNoteID}/Allocations`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'xero-tenant-id': xeroTenantId,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(allocationPayload)
      });

      const allocationData = await safeXeroJson(allocationResponse, 'creditnote-allocate');
      if (allocationData?.Allocations?.length > 0) {
        allocated = true;
        console.log(`[Xero] Credit note ${creditNote.CreditNoteNumber} allocated £${allocatableAmount.toFixed(2)} against invoice ${invoice.InvoiceNumber}`);
      }
    } catch (allocErr) {
      console.warn(`[Xero] Failed to allocate credit note (non-fatal): ${allocErr.message}`);
    }
  } else {
    console.log(`[Xero] Invoice ${invoice.InvoiceNumber} has no amount due — credit note created but not allocated`);
  }

  return {
    creditNoteId: creditNote.CreditNoteID,
    creditNoteNumber: creditNote.CreditNoteNumber,
    amount: effectiveAmount,
    status: creditNote.Status,
    allocated,
    invoiceId,
    invoiceNumber: invoice.InvoiceNumber,
  };
}
