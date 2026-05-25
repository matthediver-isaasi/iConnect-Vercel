import { supabase } from './database.js';
import { getQuickBooksCredentials, getIntuitEndpoints } from './quickbooksCredentials.js';

// ---------------------------------------------------------------------------
// HTTP helpers + error normalization
// ---------------------------------------------------------------------------

function normalizeQboFault(jsonBody) {
  // QBO error envelope: { Fault: { Error: [{ Message, Detail, code }], type } }
  const fault = jsonBody?.Fault;
  if (!fault || !Array.isArray(fault.Error) || fault.Error.length === 0) return null;
  const parts = fault.Error.map((e) => {
    const msg = e?.Message || 'Unknown';
    const detail = e?.Detail ? ` (${e.Detail})` : '';
    const code = e?.code ? ` [code ${e.code}]` : '';
    return `${msg}${code}${detail}`;
  });
  return parts.join('; ');
}

async function safeJson(response, context) {
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok) {
    if (contentType.includes('application/json')) {
      const errorData = await response.json().catch(() => null);
      const fault = normalizeQboFault(errorData);
      const detail = fault || JSON.stringify(errorData).substring(0, 500);
      throw new Error(`[QBO ${context}] HTTP ${response.status}: ${detail}`);
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

function qboHeaders(accessToken, extra = {}) {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
    ...extra,
  };
}

function companyBase(apiBaseUrl, realmId) {
  return `${apiBaseUrl}/v3/company/${encodeURIComponent(realmId)}`;
}

const MINOR_VERSION = 70;

async function qboFetch(ctx, accessToken, method, url, body) {
  const init = {
    method,
    headers: qboHeaders(accessToken, body ? { 'Content-Type': 'application/json' } : {}),
  };
  if (body) init.body = JSON.stringify(body);
  const resp = await fetch(url, init);
  return safeJson(resp, ctx);
}

async function qboQuery(accessToken, realmId, environment, query) {
  const { apiBaseUrl } = getIntuitEndpoints(environment);
  const url = `${companyBase(apiBaseUrl, realmId)}/query?minorversion=${MINOR_VERSION}&query=${encodeURIComponent(query)}`;
  const resp = await fetch(url, { headers: qboHeaders(accessToken, { 'Content-Type': 'application/text' }) });
  return safeJson(resp, 'query');
}

// ---------------------------------------------------------------------------
// Token + credentials
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Basic introspection
// ---------------------------------------------------------------------------

export async function fetchCompanyInfo(accessToken, realmId, environment) {
  const { apiBaseUrl } = getIntuitEndpoints(environment);
  const url = `${companyBase(apiBaseUrl, realmId)}/companyinfo/${encodeURIComponent(realmId)}?minorversion=${MINOR_VERSION}`;
  const data = await qboFetch('companyinfo', accessToken, 'GET', url);
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

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

async function getTenantSetting(appTenantId, key) {
  if (!supabase) return null;
  const { data } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('setting_key', key)
    .eq('tenant_id', appTenantId)
    .maybeSingle();
  return data?.setting_value || null;
}

async function resolveMembershipItemId(appTenantId) {
  const itemId =
    (await getTenantSetting(appTenantId, 'quickbooks_membership_item_id')) ||
    (await getTenantSetting(appTenantId, 'accounting_membership_item_id'));
  if (!itemId) {
    throw new Error(
      'QuickBooks membership Item not configured. Set system_settings key ' +
        '`quickbooks_membership_item_id` to the QBO Item id used for membership invoices.'
    );
  }
  return String(itemId);
}

async function resolveStripeBankAccountId(appTenantId) {
  return (
    (await getTenantSetting(appTenantId, 'quickbooks_stripe_bank_account_id')) ||
    (await getTenantSetting(appTenantId, 'accounting_stripe_bank_account_id')) ||
    null
  );
}

function parseTaxCodeRef(vatRate) {
  if (!vatRate) return { taxCodeId: null, taxLabel: null };
  try {
    const parsed = typeof vatRate === 'string' ? JSON.parse(vatRate) : vatRate;
    return {
      taxCodeId: parsed.taxType ? String(parsed.taxType) : null,
      taxLabel: parsed.name || null,
    };
  } catch {
    return { taxCodeId: String(vatRate), taxLabel: null };
  }
}

// ---------------------------------------------------------------------------
// Address parsing — mirror Xero behaviour
// ---------------------------------------------------------------------------

function parseAddressLinesQbo(addressText) {
  if (!addressText) return null;
  const lines = addressText.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const address = {};
  if (lines.length === 1) {
    address.Line1 = lines[0];
  } else if (lines.length === 2) {
    address.Line1 = lines[0];
    address.City = lines[1];
  } else if (lines.length === 3) {
    address.Line1 = lines[0];
    address.City = lines[1];
    address.PostalCode = lines[2];
  } else {
    address.Line1 = lines[0];
    address.Line2 = lines[1];
    address.City = lines[2];
    address.PostalCode = lines[3];
    if (lines[4]) address.Country = lines[4];
  }
  return address;
}

// ---------------------------------------------------------------------------
// Customer resolution
// ---------------------------------------------------------------------------

export async function findOrCreateQuickBooksCustomer(appTenantId, contactInfo) {
  const info =
    typeof contactInfo === 'string'
      ? { name: contactInfo, email: null, address: null }
      : contactInfo;
  if (!info?.name) throw new Error('Customer name is required');

  const { accessToken, realmId, environment } = await getValidQuickBooksAccessToken(appTenantId);
  const { apiBaseUrl } = getIntuitEndpoints(environment);
  const base = companyBase(apiBaseUrl, realmId);

  const escapedName = info.name.replace(/'/g, "\\'");
  const queryResp = await qboQuery(
    accessToken,
    realmId,
    environment,
    `SELECT * FROM Customer WHERE DisplayName = '${escapedName}'`
  );

  const existing = queryResp?.QueryResponse?.Customer?.[0];
  const parsedAddress = parseAddressLinesQbo(info.address);

  if (existing) {
    console.log(`[QBO] Found existing customer: ${existing.Id} (${existing.DisplayName})`);

    if (parsedAddress || info.email) {
      try {
        const updatePayload = {
          Id: existing.Id,
          SyncToken: existing.SyncToken,
          sparse: true,
        };
        if (info.email) {
          updatePayload.PrimaryEmailAddr = { Address: info.email };
        }
        if (parsedAddress) {
          updatePayload.BillAddr = parsedAddress;
        }
        const url = `${base}/customer?minorversion=${MINOR_VERSION}`;
        const updated = await qboFetch('customer-update', accessToken, 'POST', url, updatePayload);
        if (updated?.Customer?.Id) {
          console.log(`[QBO] Updated customer details for: ${info.name}`);
        }
      } catch (err) {
        console.warn(`[QBO] Failed to update customer details (non-fatal): ${err.message}`);
      }
    }

    return existing.Id;
  }

  console.log(`[QBO] Creating new customer: ${info.name}`);
  const createPayload = { DisplayName: info.name };
  if (info.email) createPayload.PrimaryEmailAddr = { Address: info.email };
  if (parsedAddress) createPayload.BillAddr = parsedAddress;

  const createUrl = `${base}/customer?minorversion=${MINOR_VERSION}`;
  const created = await qboFetch('customer-create', accessToken, 'POST', createUrl, createPayload);
  if (!created?.Customer?.Id) {
    throw new Error(`Failed to create QuickBooks customer: ${JSON.stringify(created).substring(0, 500)}`);
  }
  console.log(`[QBO] Created new customer: ${created.Customer.Id}`);
  return created.Customer.Id;
}

// ---------------------------------------------------------------------------
// Membership invoice
// ---------------------------------------------------------------------------

export async function createQuickBooksMembershipInvoice({
  appTenantId,
  organizationName,
  invoicingEmail,
  invoicingAddress,
  membershipYear,
  tierLabel,
  finalCost,
  currency,
  reference,
  vatRate,
  markAsPaid,
  stripePaymentIntentId,
  invoiceDescription,
}) {
  if (!appTenantId) throw new Error('appTenantId is required');
  if (!organizationName) throw new Error('organizationName is required');

  const { accessToken, realmId, environment } = await getValidQuickBooksAccessToken(appTenantId);
  const { apiBaseUrl } = getIntuitEndpoints(environment);
  const base = companyBase(apiBaseUrl, realmId);

  const customerId = await findOrCreateQuickBooksCustomer(appTenantId, {
    name: organizationName,
    email: invoicingEmail || null,
    address: invoicingAddress || null,
  });

  const itemId = await resolveMembershipItemId(appTenantId);
  const { taxCodeId } = parseTaxCodeRef(vatRate);

  const firstLine = invoiceDescription
    ? invoiceDescription.replace(/\{year\}/gi, membershipYear)
    : `Membership subscription for ${membershipYear}`;
  const description = `${firstLine}.\nTier: ${tierLabel || 'Standard'}\nFee: ${currency} ${parseFloat(finalCost).toFixed(2)}`;

  const lineAmount = Number(parseFloat(finalCost).toFixed(2));
  const line = {
    DetailType: 'SalesItemLineDetail',
    Amount: lineAmount,
    Description: description,
    SalesItemLineDetail: {
      ItemRef: { value: itemId },
      Qty: 1,
      UnitPrice: lineAmount,
    },
  };
  if (taxCodeId) {
    line.SalesItemLineDetail.TaxCodeRef = { value: taxCodeId };
  }

  const dueDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const invoicePayload = {
    CustomerRef: { value: customerId },
    Line: [line],
    DueDate: dueDate,
    CustomerMemo: { value: reference || `Membership ${membershipYear}` },
  };
  if (currency) invoicePayload.CurrencyRef = { value: currency };

  console.log(
    `[QBO] Creating membership invoice for ${organizationName}, ${membershipYear}, ${currency} ${finalCost}`
  );

  const url = `${base}/invoice?minorversion=${MINOR_VERSION}`;
  const invoiceResp = await qboFetch('invoice-create', accessToken, 'POST', url, invoicePayload);
  const invoice = invoiceResp?.Invoice;
  if (!invoice?.Id) {
    throw new Error(`Failed to create QuickBooks invoice: ${JSON.stringify(invoiceResp).substring(0, 500)}`);
  }
  console.log(`[QBO] Membership invoice created: ${invoice.DocNumber} (${invoice.Id})`);

  let paymentRecorded = false;
  let paymentId = null;
  if (markAsPaid) {
    try {
      const bankAccountId = await resolveStripeBankAccountId(appTenantId);
      if (bankAccountId) {
        const paymentPayload = {
          CustomerRef: { value: customerId },
          TotalAmt: Number(parseFloat(invoice.TotalAmt).toFixed(2)),
          DepositToAccountRef: { value: String(bankAccountId) },
          PaymentRefNum: stripePaymentIntentId ? `Stripe: ${stripePaymentIntentId}`.substring(0, 21) : undefined,
          PrivateNote: stripePaymentIntentId ? `Stripe charge: ${stripePaymentIntentId}` : 'Stripe payment',
          Line: [
            {
              Amount: Number(parseFloat(invoice.TotalAmt).toFixed(2)),
              LinkedTxn: [{ TxnId: invoice.Id, TxnType: 'Invoice' }],
            },
          ],
        };
        if (currency) paymentPayload.CurrencyRef = { value: currency };

        const payUrl = `${base}/payment?minorversion=${MINOR_VERSION}`;
        const payResp = await qboFetch('payment-create', accessToken, 'POST', payUrl, paymentPayload);
        if (payResp?.Payment?.Id) {
          paymentRecorded = true;
          paymentId = payResp.Payment.Id;
          console.log(`[QBO] Membership payment recorded - PaymentID: ${paymentId}`);
        }
      } else {
        console.log(
          `[QBO] quickbooks_stripe_bank_account_id not configured - invoice created but payment not recorded`
        );
      }
    } catch (payErr) {
      console.error(`[QBO] Error recording membership payment (non-fatal): ${payErr.message}`);
    }
  }

  return {
    invoice_id: invoice.Id,
    invoice_number: invoice.DocNumber || invoice.Id,
    total: invoice.TotalAmt,
    status: paymentRecorded ? 'PAID' : 'AUTHORISED',
    payment_recorded: paymentRecorded,
    payment_id: paymentId,
    online_invoice_url: null,
  };
}

// ---------------------------------------------------------------------------
// Apply Stripe payment to an existing invoice
// ---------------------------------------------------------------------------

export async function applyStripePaymentToQuickBooksInvoice({
  appTenantId,
  xeroInvoiceId,
  invoiceId,
  stripePaymentIntentId,
  amount,
  paidAt,
}) {
  if (!appTenantId) throw new Error('appTenantId is required');
  const qboInvoiceId = invoiceId || xeroInvoiceId;
  if (!qboInvoiceId) throw new Error('invoiceId is required');

  const { accessToken, realmId, environment } = await getValidQuickBooksAccessToken(appTenantId);
  const { apiBaseUrl } = getIntuitEndpoints(environment);
  const base = companyBase(apiBaseUrl, realmId);

  const invResp = await qboFetch(
    'invoice-retrieve',
    accessToken,
    'GET',
    `${base}/invoice/${encodeURIComponent(qboInvoiceId)}?minorversion=${MINOR_VERSION}`
  );
  const invoice = invResp?.Invoice;
  if (!invoice?.Id) throw new Error(`QBO invoice ${qboInvoiceId} not found`);

  const customerId = invoice.CustomerRef?.value;
  if (!customerId) throw new Error(`QBO invoice ${qboInvoiceId} has no CustomerRef`);

  const payAmount = Number(parseFloat(amount ?? invoice.TotalAmt).toFixed(2));
  let paymentRecorded = false;
  let paymentId = null;

  try {
    const bankAccountId = await resolveStripeBankAccountId(appTenantId);
    if (bankAccountId) {
      const paymentPayload = {
        CustomerRef: { value: customerId },
        TotalAmt: payAmount,
        TxnDate: (paidAt ? new Date(paidAt) : new Date()).toISOString().split('T')[0],
        DepositToAccountRef: { value: String(bankAccountId) },
        PaymentRefNum: stripePaymentIntentId ? `Stripe: ${stripePaymentIntentId}`.substring(0, 21) : undefined,
        PrivateNote: stripePaymentIntentId ? `Stripe charge: ${stripePaymentIntentId}` : 'Stripe payment',
        Line: [
          {
            Amount: payAmount,
            LinkedTxn: [{ TxnId: invoice.Id, TxnType: 'Invoice' }],
          },
        ],
      };
      if (invoice.CurrencyRef?.value) {
        paymentPayload.CurrencyRef = { value: invoice.CurrencyRef.value };
      }

      const payUrl = `${base}/payment?minorversion=${MINOR_VERSION}`;
      const payResp = await qboFetch('payment-create', accessToken, 'POST', payUrl, paymentPayload);
      if (payResp?.Payment?.Id) {
        paymentRecorded = true;
        paymentId = payResp.Payment.Id;
        console.log(`[QBO] Payment recorded against existing invoice ${invoice.DocNumber} - PaymentID: ${paymentId}`);
      }
    } else {
      console.log(`[QBO] quickbooks_stripe_bank_account_id not configured - payment not recorded`);
    }
  } catch (payErr) {
    console.error(`[QBO] Error recording payment against existing invoice (non-fatal): ${payErr.message}`);
  }

  return {
    invoice_id: invoice.Id,
    invoice_number: invoice.DocNumber || invoice.Id,
    total: invoice.TotalAmt,
    payment_recorded: paymentRecorded,
    payment_id: paymentId,
    online_invoice_url: null,
  };
}

// ---------------------------------------------------------------------------
// Credit note (CreditMemo)
// ---------------------------------------------------------------------------

export async function createQuickBooksCreditNote({
  appTenantId,
  invoiceId,
  creditAmount,
  description,
  reference,
}) {
  if (!appTenantId) throw new Error('appTenantId is required');
  if (!invoiceId) throw new Error('invoiceId is required');
  const numericAmount = Number(creditAmount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error(`creditAmount must be a positive number, got: ${creditAmount}`);
  }

  const { accessToken, realmId, environment } = await getValidQuickBooksAccessToken(appTenantId);
  const { apiBaseUrl } = getIntuitEndpoints(environment);
  const base = companyBase(apiBaseUrl, realmId);

  const invResp = await qboFetch(
    'invoice-retrieve',
    accessToken,
    'GET',
    `${base}/invoice/${encodeURIComponent(invoiceId)}?minorversion=${MINOR_VERSION}`
  );
  const invoice = invResp?.Invoice;
  if (!invoice?.Id) throw new Error(`QBO invoice ${invoiceId} not found`);

  if (invoice.Voided || invoice.PrivateNote?.includes('VOIDED')) {
    return { skipped: true, reason: 'Invoice is voided', invoiceId, invoiceNumber: invoice.DocNumber };
  }

  // Dedup by reference using PrivateNote (QBO CreditMemo has no Reference field).
  if (reference) {
    const escaped = reference.replace(/'/g, "\\'");
    const dedup = await qboQuery(
      accessToken,
      realmId,
      environment,
      `SELECT * FROM CreditMemo WHERE PrivateNote = '${escaped}'`
    );
    const existing = (dedup?.QueryResponse?.CreditMemo || []).find((cn) => !cn.Voided);
    if (existing?.Id) {
      console.log(`[QBO] Credit note already exists for reference "${reference}": ${existing.DocNumber}`);
      return {
        creditNoteId: existing.Id,
        creditNoteNumber: existing.DocNumber || existing.Id,
        amount: Number(existing.TotalAmt),
        status: 'AUTHORISED',
        allocated: false,
        invoiceId,
        invoiceNumber: invoice.DocNumber,
        alreadyExisted: true,
      };
    }
  }

  const totalAmt = Number(invoice.TotalAmt) || 0;
  const balance = Number(invoice.Balance) || 0;
  const remainingCreditable = Math.max(0, totalAmt);
  const effectiveAmount = Math.min(numericAmount, remainingCreditable);
  if (effectiveAmount <= 0) {
    return { skipped: true, reason: 'No creditable amount on invoice', invoiceId, invoiceNumber: invoice.DocNumber };
  }

  const customerId = invoice.CustomerRef?.value;
  if (!customerId) throw new Error(`QBO invoice ${invoiceId} has no CustomerRef`);

  const originalLine = (invoice.Line || []).find((l) => l.DetailType === 'SalesItemLineDetail');
  const itemId = originalLine?.SalesItemLineDetail?.ItemRef?.value;
  const taxCodeId = originalLine?.SalesItemLineDetail?.TaxCodeRef?.value;
  if (!itemId) {
    throw new Error(`Invoice ${invoiceId} has no SalesItemLineDetail line to mirror onto a credit note`);
  }

  const cmLine = {
    DetailType: 'SalesItemLineDetail',
    Amount: Number(effectiveAmount.toFixed(2)),
    Description: description || 'Credit note for cancelled booking',
    SalesItemLineDetail: {
      ItemRef: { value: itemId },
      Qty: 1,
      UnitPrice: Number(effectiveAmount.toFixed(2)),
    },
  };
  if (taxCodeId) cmLine.SalesItemLineDetail.TaxCodeRef = { value: taxCodeId };

  const cmPayload = {
    CustomerRef: { value: customerId },
    Line: [cmLine],
    TxnDate: new Date().toISOString().split('T')[0],
    PrivateNote: reference || `Credit for invoice ${invoice.DocNumber}`,
  };
  if (invoice.CurrencyRef?.value) {
    cmPayload.CurrencyRef = { value: invoice.CurrencyRef.value };
  }

  console.log(
    `[QBO] Creating credit memo for ${effectiveAmount.toFixed(2)} against invoice ${invoice.DocNumber} (requested: ${numericAmount.toFixed(2)})`
  );
  const cmUrl = `${base}/creditmemo?minorversion=${MINOR_VERSION}`;
  const cmResp = await qboFetch('creditmemo-create', accessToken, 'POST', cmUrl, cmPayload);
  const cm = cmResp?.CreditMemo;
  if (!cm?.Id) {
    throw new Error(`Failed to create QBO credit memo: ${JSON.stringify(cmResp).substring(0, 500)}`);
  }
  console.log(`[QBO] Credit memo created: ${cm.DocNumber} (${cm.Id})`);

  // Allocate the credit memo to the invoice via a zero-amount Payment with
  // both linked. This is QBO's canonical way to apply a credit memo.
  let allocated = false;
  const allocatable = Math.min(effectiveAmount, balance);
  if (allocatable > 0) {
    try {
      const allocPayload = {
        CustomerRef: { value: customerId },
        TotalAmt: 0,
        Line: [
          {
            Amount: Number(allocatable.toFixed(2)),
            LinkedTxn: [{ TxnId: invoice.Id, TxnType: 'Invoice' }],
          },
          {
            Amount: Number(allocatable.toFixed(2)),
            LinkedTxn: [{ TxnId: cm.Id, TxnType: 'CreditMemo' }],
          },
        ],
      };
      if (invoice.CurrencyRef?.value) {
        allocPayload.CurrencyRef = { value: invoice.CurrencyRef.value };
      }
      const allocUrl = `${base}/payment?minorversion=${MINOR_VERSION}`;
      const allocResp = await qboFetch('creditmemo-allocate', accessToken, 'POST', allocUrl, allocPayload);
      if (allocResp?.Payment?.Id) {
        allocated = true;
        console.log(`[QBO] Credit memo ${cm.DocNumber} allocated ${allocatable.toFixed(2)} against invoice ${invoice.DocNumber}`);
      }
    } catch (allocErr) {
      console.warn(`[QBO] Failed to allocate credit memo (non-fatal): ${allocErr.message}`);
    }
  } else {
    console.log(`[QBO] Invoice ${invoice.DocNumber} has no balance — credit memo created but not allocated`);
  }

  return {
    creditNoteId: cm.Id,
    creditNoteNumber: cm.DocNumber || cm.Id,
    amount: effectiveAmount,
    status: 'AUTHORISED',
    allocated,
    invoiceId,
    invoiceNumber: invoice.DocNumber,
  };
}

// ---------------------------------------------------------------------------
// PO push
// ---------------------------------------------------------------------------

export async function pushPurchaseOrderToQuickBooksInvoice({
  appTenantId,
  invoiceId,
  xeroInvoiceId,
  purchaseOrderNumber,
  contextLabel = 'PO sync',
}) {
  const qboInvoiceId = invoiceId || xeroInvoiceId;
  if (!qboInvoiceId) {
    console.log(`[${contextLabel}] PO saved locally but no QBO invoice id present — skipping push`);
    return { xeroUpdated: false, xeroError: null, skipped: true };
  }
  if (!appTenantId) {
    const msg = 'Cannot determine tenant for QBO token lookup';
    console.error(`[${contextLabel}] QBO PO update FAILED for invoice ${qboInvoiceId}: ${msg}`);
    return { xeroUpdated: false, xeroError: msg };
  }

  try {
    const { accessToken, realmId, environment } = await getValidQuickBooksAccessToken(appTenantId);
    const { apiBaseUrl } = getIntuitEndpoints(environment);
    const base = companyBase(apiBaseUrl, realmId);

    const invResp = await qboFetch(
      'invoice-retrieve',
      accessToken,
      'GET',
      `${base}/invoice/${encodeURIComponent(qboInvoiceId)}?minorversion=${MINOR_VERSION}`
    );
    const invoice = invResp?.Invoice;
    if (!invoice?.Id) throw new Error(`QBO invoice ${qboInvoiceId} not found`);

    const updatePayload = {
      Id: invoice.Id,
      SyncToken: invoice.SyncToken,
      sparse: true,
      CustomerMemo: { value: String(purchaseOrderNumber).trim() },
    };
    const url = `${base}/invoice?minorversion=${MINOR_VERSION}`;
    await qboFetch('invoice-update-po', accessToken, 'POST', url, updatePayload);

    console.log(
      `[${contextLabel}] QBO CustomerMemo updated for invoice ${qboInvoiceId} -> "${purchaseOrderNumber}"`
    );
    return { xeroUpdated: true, xeroError: null };
  } catch (err) {
    const errMsg = err?.message || 'Unknown QBO error';
    console.error(`[${contextLabel}] QBO PO update FAILED for invoice ${qboInvoiceId}: ${errMsg}`);
    return { xeroUpdated: false, xeroError: errMsg };
  }
}

// ---------------------------------------------------------------------------
// Update invoice reference (mirror Xero updateXeroInvoiceReference)
// ---------------------------------------------------------------------------

export async function updateQuickBooksInvoiceReference(appTenantId, invoiceId, reference) {
  if (!appTenantId) throw new Error('appTenantId is required');
  if (!invoiceId) throw new Error('invoiceId is required');
  const trimmed = typeof reference === 'string' ? reference.trim() : '';
  if (!trimmed) throw new Error('reference must be a non-empty string');

  const { accessToken, realmId, environment } = await getValidQuickBooksAccessToken(appTenantId);
  const { apiBaseUrl } = getIntuitEndpoints(environment);
  const base = companyBase(apiBaseUrl, realmId);

  const invResp = await qboFetch(
    'invoice-retrieve',
    accessToken,
    'GET',
    `${base}/invoice/${encodeURIComponent(invoiceId)}?minorversion=${MINOR_VERSION}`
  );
  const invoice = invResp?.Invoice;
  if (!invoice?.Id) throw new Error(`QBO invoice ${invoiceId} not found`);

  const payload = {
    Id: invoice.Id,
    SyncToken: invoice.SyncToken,
    sparse: true,
    CustomerMemo: { value: trimmed },
  };
  const url = `${base}/invoice?minorversion=${MINOR_VERSION}`;
  const updated = await qboFetch('invoice-update-reference', accessToken, 'POST', url, payload);
  const updatedInvoice = updated?.Invoice;
  if (!updatedInvoice?.Id) {
    throw new Error(`Failed to update QBO invoice reference: ${JSON.stringify(updated).substring(0, 500)}`);
  }
  return {
    invoiceId: updatedInvoice.Id,
    invoiceNumber: updatedInvoice.DocNumber || updatedInvoice.Id,
    reference: updatedInvoice.CustomerMemo?.value || trimmed,
  };
}

// ---------------------------------------------------------------------------
// Update invoice line description after an attendee transfer
//
// Finds line(s) whose Description contains the original attendee's name or
// email (matched line-by-line, same heuristic as the Xero helper) and
// rewrites those entries with the new attendee's name (falling back to
// email). Amount, tax, and item refs are preserved — only Description
// changes. Performs a QBO sparse Invoice update with the full Line array
// (QBO requires every Line to be re-sent even on sparse updates).
// ---------------------------------------------------------------------------

export async function updateQuickBooksInvoiceLineDescription({
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

  const originalName = [originalFirstName, originalLastName].filter(Boolean).join(' ').trim();
  const newName = [newFirstName, newLastName].filter(Boolean).join(' ').trim();
  const replacement = newName || newEmail || '';

  const { accessToken, realmId, environment } = await getValidQuickBooksAccessToken(appTenantId);
  const { apiBaseUrl } = getIntuitEndpoints(environment);
  const base = companyBase(apiBaseUrl, realmId);

  const invResp = await qboFetch(
    'invoice-retrieve',
    accessToken,
    'GET',
    `${base}/invoice/${encodeURIComponent(invoiceId)}?minorversion=${MINOR_VERSION}`
  );
  const invoice = invResp?.Invoice;
  if (!invoice?.Id) throw new Error(`QBO invoice ${invoiceId} not found`);

  const lines = Array.isArray(invoice.Line) ? invoice.Line : [];
  if (lines.length === 0) {
    console.log(`[QBO TransferInvoice] Invoice ${invoiceId} has no lines — skipping`);
    return { skipped: true, reason: 'no-lines' };
  }

  let descriptionUpdated = false;
  const updatedLines = lines.map((line) => {
    if (!line || typeof line.Description !== 'string' || !line.Description) return line;
    const updatedDescription = line.Description.split('\n').map((entry) => {
      const trimmed = entry.trim();
      if (!trimmed) return entry;
      if (originalName && trimmed === originalName) {
        descriptionUpdated = true;
        return replacement;
      }
      if (originalEmail && trimmed === originalEmail) {
        descriptionUpdated = true;
        return replacement;
      }
      return entry;
    }).join('\n');
    if (updatedDescription === line.Description) return line;
    return { ...line, Description: updatedDescription };
  });

  if (!descriptionUpdated) {
    console.log(`[QBO TransferInvoice] Original attendee not found in any line description — skipping`);
    return { skipped: true, reason: 'no-match' };
  }

  console.log(
    `[QBO TransferInvoice] Updating invoice ${invoiceId} line description: replacing "${originalName || originalEmail}" with "${replacement}"`
  );

  const payload = {
    Id: invoice.Id,
    SyncToken: invoice.SyncToken,
    sparse: true,
    Line: updatedLines,
  };
  const url = `${base}/invoice?minorversion=${MINOR_VERSION}`;
  const updated = await qboFetch('invoice-update-line-description', accessToken, 'POST', url, payload);
  const updatedInvoice = updated?.Invoice;
  if (!updatedInvoice?.Id) {
    throw new Error(`Failed to update QBO invoice line description: ${JSON.stringify(updated).substring(0, 500)}`);
  }
  return {
    invoiceId: updatedInvoice.Id,
    invoiceNumber: updatedInvoice.DocNumber || updatedInvoice.Id,
    updated: true,
  };
}

// ---------------------------------------------------------------------------
// PDF fetch
// ---------------------------------------------------------------------------

async function fetchPdf(appTenantId, entity, id) {
  const { accessToken, realmId, environment } = await getValidQuickBooksAccessToken(appTenantId);
  const { apiBaseUrl } = getIntuitEndpoints(environment);
  const url = `${companyBase(apiBaseUrl, realmId)}/${entity}/${encodeURIComponent(id)}/pdf?minorversion=${MINOR_VERSION}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/pdf' },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`[QBO ${entity}-pdf] HTTP ${resp.status}: ${text.substring(0, 300)}`);
  }
  const buf = await resp.arrayBuffer();
  return Buffer.from(buf);
}

export async function fetchQuickBooksInvoicePdf(appTenantId, invoiceId) {
  return fetchPdf(appTenantId, 'invoice', invoiceId);
}

export async function fetchQuickBooksCreditNotePdf(appTenantId, creditNoteId) {
  return fetchPdf(appTenantId, 'creditmemo', creditNoteId);
}

// ---------------------------------------------------------------------------
// Email credit note (mirror Xero behaviour)
// ---------------------------------------------------------------------------

export async function emailQuickBooksCreditNote({
  appTenantId,
  creditNoteId,
  creditNoteNumber,
  toEmail,
  tenantId,
}) {
  if (!creditNoteId) throw new Error('creditNoteId is required');
  if (!toEmail) throw new Error('toEmail is required');

  console.log(`[QBO] Fetching credit memo ${creditNoteNumber || creditNoteId} PDF to email to ${toEmail}`);
  const pdfBuffer = await fetchQuickBooksCreditNotePdf(appTenantId, creditNoteId);

  const { sendEmail } = await import('./emailService.js');
  const filename = `credit-note-${creditNoteNumber || creditNoteId}.pdf`;
  await sendEmail({
    tenantId: tenantId || appTenantId,
    to: toEmail,
    subject: `Credit Note ${creditNoteNumber || ''}`.trim(),
    html: `<p>Please find attached your credit note${creditNoteNumber ? ` (${creditNoteNumber})` : ''}.</p>`,
    attachments: [{ filename, data: pdfBuffer, contentType: 'application/pdf' }],
  });

  console.log(`[QBO] Credit memo ${creditNoteNumber || creditNoteId} emailed to ${toEmail}`);
  return { success: true, email: toEmail };
}

// ---------------------------------------------------------------------------
// Tax rate sync — produces the same shape Xero sync emits so pricing UIs work
// ---------------------------------------------------------------------------

export async function syncQuickBooksTaxRates(appTenantId) {
  if (!appTenantId) throw new Error('appTenantId is required');
  if (!supabase) throw new Error('Database not configured');

  const { accessToken, realmId, environment } = await getValidQuickBooksAccessToken(appTenantId);

  const [codesResp, ratesResp] = await Promise.all([
    qboQuery(accessToken, realmId, environment, 'SELECT * FROM TaxCode WHERE Active = true'),
    qboQuery(accessToken, realmId, environment, 'SELECT * FROM TaxRate WHERE Active = true'),
  ]);

  const taxCodes = codesResp?.QueryResponse?.TaxCode || [];
  const taxRates = ratesResp?.QueryResponse?.TaxRate || [];
  const rateById = new Map();
  for (const r of taxRates) {
    if (r?.Id != null) rateById.set(String(r.Id), Number(r.RateValue) || 0);
  }

  function effectiveRateFor(code) {
    const list = code?.SalesTaxRateList?.TaxRateDetail || [];
    if (list.length === 0) return null;
    let total = 0;
    for (const detail of list) {
      const id = detail?.TaxRateRef?.value;
      if (id != null) total += rateById.get(String(id)) || 0;
    }
    return total;
  }

  const rates = taxCodes.map((c) => ({
    name: c.Name,
    // taxType = QBO TaxCode Id so it can be written straight into
    // SalesItemLineDetail.TaxCodeRef.value when building invoices.
    taxType: String(c.Id),
    effectiveRate: effectiveRateFor(c),
    status: c.Active ? 'ACTIVE' : 'INACTIVE',
    canApplyToAssets: false,
    canApplyToEquity: false,
    canApplyToExpenses: !!c.PurchaseTaxRateList,
    canApplyToLiabilities: false,
    canApplyToRevenue: !!c.SalesTaxRateList,
  }));

  const syncData = {
    rates,
    count: rates.length,
    syncedAt: new Date().toISOString(),
    provider: 'quickbooks',
  };

  // Write to BOTH the new generic key and the legacy xero_vat_rates_{tenantId}
  // key so existing pricing readers (membership simulation, MembershipTier
  // editor, event pricing editors) work for QBO tenants with no UI rework.
  const keys = [`accounting_vat_rates_${appTenantId}`, `xero_vat_rates_${appTenantId}`];
  for (const key of keys) {
    const { data: existing } = await supabase
      .from('system_settings')
      .select('id')
      .eq('setting_key', key)
      .eq('tenant_id', appTenantId)
      .maybeSingle();
    if (existing) {
      await supabase
        .from('system_settings')
        .update({ setting_value: JSON.stringify(syncData) })
        .eq('id', existing.id);
    } else {
      await supabase.from('system_settings').insert({
        setting_key: key,
        setting_value: JSON.stringify(syncData),
        tenant_id: appTenantId,
      });
    }
  }

  return syncData;
}
