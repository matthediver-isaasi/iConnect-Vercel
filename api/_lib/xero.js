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

    if (parsedAddress) {
      try {
        const updatePayload = {
          Contacts: [{
            ContactID: existingContact.ContactID,
            Addresses: [parsedAddress]
          }]
        };
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
        await safeXeroJson(updateResponse, 'contact-address-update');
        console.log(`[Xero] Updated contact address for: ${info.name}`);
      } catch (addrErr) {
        console.warn(`[Xero] Failed to update contact address (non-fatal): ${addrErr.message}`);
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

export async function createXeroMembershipInvoice({ appTenantId, organizationName, invoicingAddress, membershipYear, tierLabel, finalCost, currency, reference, vatRate, markAsPaid, stripePaymentIntentId, invoiceDescription }) {
  if (!supabase) throw new Error('Supabase not configured');
  if (!appTenantId) throw new Error('appTenantId is required');
  if (!organizationName) throw new Error('organizationName is required');

  const { accessToken, tenantId: xeroTenantId } = await getValidXeroAccessToken(appTenantId);
  const contactId = await findOrCreateXeroContact(accessToken, xeroTenantId, {
    name: organizationName,
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

  const invoicePayload = {
    Invoices: [{
      Type: 'ACCREC',
      Contact: { ContactID: contactId },
      Reference: reference || `Membership ${membershipYear}`,
      Status: xeroInvoiceStatus,
      DueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      LineItems: [lineItem]
    }]
  };

  console.log(`[Xero] Creating membership invoice for ${organizationName}, ${membershipYear}, ${currency} ${finalCost}`);

  const invoiceResponse = await fetch('https://api.xero.com/api.xro/2.0/Invoices', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'xero-tenant-id': xeroTenantId,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
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
      const { data: stripeBankCodeSetting } = await supabase
        .from('system_settings')
        .select('setting_value')
        .eq('setting_key', 'xero_stripe_bank_account_code')
        .eq('tenant_id', appTenantId)
        .maybeSingle();

      const stripeBankAccountCode = stripeBankCodeSetting?.setting_value;

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

          const paymentResponse = await fetch('https://api.xero.com/api.xro/2.0/Payments', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'xero-tenant-id': xeroTenantId,
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            },
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
