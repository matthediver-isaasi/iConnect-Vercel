import { supabase } from './database.js';
import { getQuickBooksCredentials, getIntuitEndpoints } from './quickbooksCredentials.js';
import { resolveMembershipInvoiceReference } from './membershipInvoiceReference.js';
import { accountingOperationIdentity } from './accountingOperationIdentity.js';

export function buildQuickBooksMembershipCustomerMemo(reference) {
  return { value: resolveMembershipInvoiceReference(reference) };
}

const validStripePaymentIntentId = (value) => /^pi_[A-Za-z0-9]+$/.test(String(value || ''));
const containsExactStripePaymentIntent = (value, paymentIntentId) => {
  const escaped = String(paymentIntentId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^A-Za-z0-9])${escaped}(?:$|[^A-Za-z0-9])`).test(String(value || ''));
};

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
      const error = new Error(`[QBO ${context}] HTTP ${response.status}: ${detail}`);
      error.status = response.status;
      error.statusCode = response.status;
      throw error;
    }
    const text = await response.text();
    const error = new Error(`[QBO ${context}] HTTP ${response.status}: ${text.substring(0, 300)}`);
    error.status = response.status;
    error.statusCode = response.status;
    throw error;
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

async function resolveStripeBankAccountId(appTenantId, settingKey = null, { strict = false } = {}) {
  if (settingKey) {
    const dedicated = await getTenantSetting(appTenantId, settingKey);
    if (dedicated) return dedicated;
    // strict: the caller's rail requires ITS OWN bank account setting —
    // falling back to the Stripe account would book the money to the wrong
    // account. Return null so payment_recorded=false surfaces recoverably.
    if (strict) return null;
  }
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

  // QuickBooks' BillAddr (PhysicalAddress) supports Line1–Line5, which render
  // verbatim, one per line, in the order given. Mapping each input line
  // straight to Line1…Line5 preserves exactly what the user entered. (The
  // old approach spread lines across the semantic City/PostalCode/Country
  // fields, which QBO re-orders on its own display, scrambling the address.)
  const address = {};
  const MAX_LINES = 5;
  const capped = lines.slice(0, MAX_LINES);
  capped.forEach((line, i) => {
    address[`Line${i + 1}`] = line;
  });
  // If there are more than 5 lines, fold the overflow into Line5 rather than
  // dropping data.
  if (lines.length > MAX_LINES) {
    address.Line5 = lines.slice(MAX_LINES - 1).join(', ');
  }
  return address;
}

// ---------------------------------------------------------------------------
// Customer resolution
// ---------------------------------------------------------------------------

export async function findOrCreateQuickBooksCustomer(appTenantId, contactInfo, connection = null) {
  const info =
    typeof contactInfo === 'string'
      ? { name: contactInfo, email: null, address: null }
      : contactInfo;
  if (!info?.name) throw new Error('Customer name is required');

  const resolvedConnection = connection?.accessToken
    ? connection
    : await getValidQuickBooksAccessToken(appTenantId);
  const { accessToken, realmId, environment } = resolvedConnection;
  const expectedProviderContext = connection?.expectedProviderContext;
  const expectedRealm = typeof expectedProviderContext === 'string'
    ? expectedProviderContext
    : expectedProviderContext?.quickbooks_realm_id;
  if (expectedRealm && String(expectedRealm) !== String(realmId)) {
    throw new Error('Connected QuickBooks company does not match the invoice provider context');
  }
  if (expectedProviderContext?.environment
      && String(expectedProviderContext.environment) !== String(environment)) {
    throw new Error('Connected QuickBooks environment does not match the invoice provider context');
  }
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

export async function findQuickBooksSalesCustomers(appTenantId, { name }) {
  const { accessToken, realmId, environment } = await getValidQuickBooksAccessToken(appTenantId);
  const escaped = String(name || '').replace(/'/g, "\\'");
  const data = await qboQuery(accessToken, realmId, environment,
    `SELECT * FROM Customer WHERE DisplayName = '${escaped}'`);
  return (data?.QueryResponse?.Customer || []).map((item) => ({
    id: item.Id, name: item.DisplayName, email: item.PrimaryEmailAddr?.Address || null,
  }));
}

export async function createQuickBooksSalesCustomer(appTenantId, customer) {
  return findOrCreateQuickBooksCustomer(appTenantId, customer);
}

export async function listQuickBooksSalesTaxCodes(appTenantId) {
  const { accessToken, realmId, environment } = await getValidQuickBooksAccessToken(appTenantId);
  const data = await qboQuery(accessToken, realmId, environment,
    'SELECT * FROM TaxCode WHERE Active = true MAXRESULTS 1000');
  return (data?.QueryResponse?.TaxCode || []).map((code) => ({
    id: String(code.Id), name: code.Name || String(code.Id),
  }));
}

export async function listQuickBooksSalesItems(appTenantId) {
  const { accessToken, realmId, environment } = await getValidQuickBooksAccessToken(appTenantId);
  const data = await qboQuery(accessToken, realmId, environment,
    'SELECT * FROM Item WHERE Active = true MAXRESULTS 1000');
  return (data?.QueryResponse?.Item || []).filter((item) =>
    item.Id && item.Name && item.Type !== 'Group' && item.Type !== 'Discount').map((item) => ({
    id: String(item.Id), name: item.Name,
  }));
}

export function buildQuickBooksSalesInvoicePayload(invoice) {
  const fail = (message, details = {}) => {
    const error = new Error(`QuickBooks cannot represent accepted invoice: ${message}`);
    error.code = 'ACCOUNTING_UNREPRESENTABLE';
    error.details = details;
    throw error;
  };
  const effectiveUnitPrice = (line, index) => {
    const quantity = String(line.quantity);
    const match = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.exec(quantity);
    if (!match || /^0(?:\.0*)?$/.test(quantity)) fail(`line ${index + 1} quantity is invalid`, { line: index + 1 });
    const scale = 10n ** BigInt(match[2]?.length || 0);
    const quantityUnits = BigInt(quantity.replace('.', ''));
    const netMinor = Number(line.netMinor);
    if (!Number.isSafeInteger(netMinor) || netMinor < 0) fail(`line ${index + 1} net is invalid`, { line: index + 1 });
    // QBO commercial invoices use an explicit six-decimal UnitPrice.
    const precision = 1000000n;
    const numerator = BigInt(netMinor) * scale * precision;
    const denominator = quantityUnits * 100n;
    const unitMicros = (numerator + denominator / 2n) / denominator;
    if (netMinor > 0 && unitMicros < 10000n) {
      fail(`line ${index + 1} effective UnitPrice is below one minor currency unit`, { line: index + 1 });
    }
    const representedNumerator = quantityUnits * unitMicros * 100n;
    const representedDenominator = scale * precision;
    const representedMinor = (representedNumerator + representedDenominator / 2n) / representedDenominator;
    if (representedMinor !== BigInt(netMinor)) {
      fail(`line ${index + 1} six-decimal UnitPrice does not round to accepted net`, { line: index + 1 });
    }
    return Number(unitMicros) / Number(precision);
  };
  return {
    CustomerRef: { value: invoice.customerId },
    CurrencyRef: { value: invoice.currency },
    CustomerMemo: { value: invoice.customerReference || invoice.purchaseOrderReference || '' },
    PONumber: invoice.purchaseOrderReference || undefined,
    GlobalTaxCalculation: 'TaxExcluded',
    Line: invoice.lines.map((line, index) => ({
      DetailType: 'SalesItemLineDetail', Description: line.description,
      Amount: line.netMinor / 100,
      SalesItemLineDetail: {
        ItemRef: { value: line.itemId }, Qty: Number(line.quantity),
        // Amount is the accepted, already-discounted net snapshot. QBO
        // recomputes Amount from Qty/UnitPrice, so derive the effective unit
        // price from it (including for fractional quantities) and never send
        // DiscountRate as well.
        UnitPrice: effectiveUnitPrice(line, index),
        TaxCodeRef: { value: line.taxCode },
      },
    })),
  };
}

const qboMoneyMinor = (value, label) => {
  const amount = Number(value);
  const scaled = amount * 100;
  if (!Number.isFinite(amount) || !Number.isSafeInteger(Math.round(scaled))
      || Math.abs(scaled - Math.round(scaled)) > 1e-7) {
    const error = new Error(`QuickBooks returned an invalid ${label}`);
    error.code = 'ACCOUNTING_TOTAL_MISMATCH';
    error.details = { field: label };
    throw error;
  }
  return Math.round(scaled);
};

export function verifyQuickBooksSalesInvoice(invoice, accepted) {
  const mismatch = (field, expectedMinor, actualMinor, line = null) => {
    const error = new Error(`QuickBooks invoice ${field} does not match the accepted sale`);
    error.code = 'ACCOUNTING_TOTAL_MISMATCH';
    error.details = { field, expectedMinor, actualMinor, ...(line == null ? {} : { line }) };
    throw error;
  };
  const actualLines = (invoice?.Line || []).filter((line) => line?.DetailType === 'SalesItemLineDetail');
  if (actualLines.length !== accepted.lines.length) mismatch('lineCount', accepted.lines.length, actualLines.length);
  let actualNet = 0;
  actualLines.forEach((line, index) => {
    const actual = qboMoneyMinor(line.Amount, `line ${index + 1} amount`);
    const expected = Number(accepted.lines[index].netMinor);
    if (actual !== expected) mismatch('lineNet', expected, actual, index + 1);
    actualNet += actual;
  });
  if (actualNet !== Number(accepted.netMinor)) mismatch('net', Number(accepted.netMinor), actualNet);
  if (!invoice?.TxnTaxDetail || invoice.TxnTaxDetail.TotalTax == null) {
    mismatch('tax', Number(accepted.taxMinor), null);
  }
  const actualTax = qboMoneyMinor(invoice.TxnTaxDetail.TotalTax, 'tax');
  if (actualTax !== Number(accepted.taxMinor)) mismatch('tax', Number(accepted.taxMinor), actualTax);
  const actualGross = qboMoneyMinor(invoice.TotalAmt, 'gross');
  if (actualGross !== Number(accepted.grossMinor)) mismatch('gross', Number(accepted.grossMinor), actualGross);
  return invoice;
}

export function quickBooksRequestId(value) {
  const providerKey = String(value || '');
  if (!/^[A-Za-z0-9_-]{1,50}$/.test(providerKey)) {
    throw new Error('QuickBooks invoice idempotency key must be 1-50 provider-safe characters');
  }
  return providerKey;
}

export async function createQuickBooksSalesInvoice(appTenantId, invoice, dependencies = {}) {
  const tokenResolver = dependencies.getValidQuickBooksAccessToken || getValidQuickBooksAccessToken;
  const { accessToken, realmId, environment } = await tokenResolver(appTenantId);
  const { apiBaseUrl } = getIntuitEndpoints(environment);
  const body = buildQuickBooksSalesInvoicePayload(invoice);
  const providerKey = quickBooksRequestId(invoice.idempotencyKey);
  const requestid = encodeURIComponent(providerKey);
  const url = `${companyBase(apiBaseUrl, realmId)}/invoice?minorversion=${MINOR_VERSION}&requestid=${requestid}`;
  const data = await qboFetch('sales-invoice-create', accessToken, 'POST', url, body);
  const result = data?.Invoice;
  if (!result?.Id) throw new Error('QuickBooks did not return an invoice identifier');
  // Always read back, including an idempotent requestid replay. The POST
  // response alone is not evidence that provider values match our snapshot.
  const readback = await qboFetch('sales-invoice-verify', accessToken, 'GET',
    `${companyBase(apiBaseUrl, realmId)}/invoice/${encodeURIComponent(result.Id)}?include=invoiceLink&minorversion=${MINOR_VERSION}`);
  const verified = verifyQuickBooksSalesInvoice(readback?.Invoice, invoice);
  return { id: verified.Id, number: verified.DocNumber || null, url: verified.InvoiceLink || null,
    status: Number(verified.Balance) === 0 ? 'paid' : 'open', createdAt: verified.MetaData?.CreateTime || null };
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
  deferStripeSettlement = false,
  stripePaymentIntentId,
  invoiceDescription,
  extraLineItems,
  nominalCode,
  bankAccountSettingKey,
  strictBankAccount,
  idempotencyKey,
  paymentIdempotencyKey,
  expectedProviderContext = null,
}, dependencies = {}) {
  if (!appTenantId) throw new Error('appTenantId is required');
  if (!organizationName) throw new Error('organizationName is required');
  if (stripePaymentIntentId && !validStripePaymentIntentId(stripePaymentIntentId)) {
    throw new Error('stripePaymentIntentId must be a full PaymentIntent identifier');
  }
  if (deferStripeSettlement && (!stripePaymentIntentId || !idempotencyKey)) {
    throw new Error('deferStripeSettlement requires stripePaymentIntentId and idempotencyKey');
  }

  const tokenResolver = dependencies.getValidQuickBooksAccessToken || getValidQuickBooksAccessToken;
  const customerResolver = dependencies.findOrCreateQuickBooksCustomer || findOrCreateQuickBooksCustomer;
  const { accessToken, realmId, environment } = await tokenResolver(appTenantId);
  const expectedRealm = typeof expectedProviderContext === 'string'
    ? expectedProviderContext
    : expectedProviderContext?.quickbooks_realm_id;
  if (expectedRealm && String(expectedRealm) !== String(realmId)) {
    throw new Error('Connected QuickBooks company does not match the invoice provider context');
  }
  if (expectedProviderContext?.environment
      && String(expectedProviderContext.environment) !== String(environment)) {
    throw new Error('Connected QuickBooks environment does not match the invoice provider context');
  }
  const { apiBaseUrl } = getIntuitEndpoints(environment);
  const base = companyBase(apiBaseUrl, realmId);

  const customerId = await customerResolver(appTenantId, {
    name: organizationName,
    email: invoicingEmail || null,
    address: invoicingAddress || null,
  }, {
    accessToken,
    realmId,
    environment,
    expectedProviderContext,
  });

  const itemId = await resolveMembershipItemId(appTenantId);
  let { taxCodeId } = parseTaxCodeRef(vatRate);

  if (!taxCodeId) {
    try {
      const itemResp = await qboFetch(
        'item-retrieve',
        accessToken,
        'GET',
        `${base}/item/${encodeURIComponent(itemId)}?minorversion=${MINOR_VERSION}`
      );
      taxCodeId = itemResp?.Item?.SalesTaxCodeRef?.value || null;
      if (taxCodeId) {
        console.log(`[QBO] Falling back to Item SalesTaxCodeRef ${taxCodeId} for invoice line`);
      }
    } catch (itemErr) {
      console.log(`[QBO] Item lookup for tax fallback failed (non-fatal): ${itemErr.message}`);
    }
  }
  if (!taxCodeId) {
    const defaultTaxCode = await getTenantSetting(appTenantId, 'quickbooks_default_tax_code_id');
    if (defaultTaxCode) {
      taxCodeId = String(defaultTaxCode);
      console.log(`[QBO] Falling back to tenant default tax code ${taxCodeId} for invoice line`);
    }
  }
  if (!taxCodeId) {
    throw new Error(
      'QuickBooks invoice requires a tax code, but none was provided by the membership band, ' +
        'the QuickBooks Item, or the tenant default. Either set a VAT rate on the membership band, ' +
        'configure SalesTaxCodeRef on the QuickBooks Item, or set system_settings key ' +
        '`quickbooks_default_tax_code_id`.'
    );
  }

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
  line.SalesItemLineDetail.TaxCodeRef = { value: taxCodeId };

  const invoiceLines = [line];
  // Add-on lines appended after the membership fee line. QBO invoice lines
  // reference Items rather than nominal account codes, so each add-on's
  // nominal code is resolved to a QBO Item: first an Item whose Name matches
  // the nominal code, then an Item whose IncomeAccountRef points at an
  // Account with that AcctNum. If neither resolves, the line falls back to
  // the membership Item and the nominal code is recorded in the description
  // so it is never silently dropped. VAT comes from the line's own tax code
  // when supplied, falling back to the membership line's tax code.
  const extraItemIdCache = new Map();
  const resolveExtraItemId = async (nominalCode) => {
    const key = String(nominalCode);
    if (extraItemIdCache.has(key)) return extraItemIdCache.get(key);
    let resolved = null;
    const escaped = key.replace(/'/g, "\\'");
    try {
      const byName = await qboQuery(
        accessToken, realmId, environment,
        `SELECT * FROM Item WHERE Name = '${escaped}' AND Active = true`
      );
      resolved = byName?.QueryResponse?.Item?.[0]?.Id || null;
      if (!resolved) {
        const acctResp = await qboQuery(
          accessToken, realmId, environment,
          `SELECT * FROM Account WHERE AcctNum = '${escaped}' AND Active = true`
        );
        const accountId = acctResp?.QueryResponse?.Account?.[0]?.Id || null;
        if (accountId) {
          const byAccount = await qboQuery(
            accessToken, realmId, environment,
            `SELECT * FROM Item WHERE Active = true MAXRESULTS 1000`
          );
          const items = byAccount?.QueryResponse?.Item || [];
          resolved = items.find((it) => it?.IncomeAccountRef?.value === accountId)?.Id || null;
        }
      }
    } catch (resolveErr) {
      console.log(`[QBO] Add-on Item resolution for nominal code ${key} failed (non-fatal): ${resolveErr.message}`);
    }
    if (resolved) {
      console.log(`[QBO] Resolved add-on nominal code ${key} to Item ${resolved}`);
    }
    extraItemIdCache.set(key, resolved);
    return resolved;
  };

  // An explicit main-line nominal code (e.g. the Training Fund default from
  // Membership Settings) resolves to a QBO Item the same way add-on lines do.
  // If it can't be resolved the line keeps the membership Item and the nominal
  // code is recorded in the description so it is never silently dropped.
  if (nominalCode && String(nominalCode).trim()) {
    const mainNominal = String(nominalCode).trim();
    const mainItemId = await resolveExtraItemId(mainNominal);
    if (mainItemId) {
      line.SalesItemLineDetail.ItemRef = { value: mainItemId };
    } else {
      line.Description = `${line.Description}\nNominal code: ${mainNominal}`;
    }
  }

  for (const extra of (Array.isArray(extraLineItems) ? extraLineItems : [])) {
    const qty = Number(extra.quantity) > 0 ? Number(extra.quantity) : 1;
    const unitPrice = Number(parseFloat(extra.unitCost || 0).toFixed(2));
    const { taxCodeId: extraTaxCodeId } = parseTaxCodeRef(extra.vatRate);
    const extraItemId = extra.nominalCode ? await resolveExtraItemId(extra.nominalCode) : null;
    const descParts = [extra.description || 'Additional item'];
    if (extra.nominalCode && !extraItemId) descParts.push(`Nominal code: ${extra.nominalCode}`);
    invoiceLines.push({
      DetailType: 'SalesItemLineDetail',
      Amount: Number((unitPrice * qty).toFixed(2)),
      Description: descParts.join('\n'),
      SalesItemLineDetail: {
        ItemRef: { value: extraItemId || itemId },
        Qty: qty,
        UnitPrice: unitPrice,
        TaxCodeRef: { value: extraTaxCodeId || taxCodeId },
      },
    });
  }

  const dueDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const invoicePayload = {
    CustomerRef: { value: customerId },
    Line: invoiceLines,
    DueDate: dueDate,
    CustomerMemo: buildQuickBooksMembershipCustomerMemo(reference),
    // Required by QBO when the company file has VAT/Sales-Tax enabled. Without
    // this flag QBO returns error 6000 "Make sure all your transactions have a
    // VAT rate before you save". Membership line amounts are net of VAT, so
    // TaxExcluded matches what the band stores.
    GlobalTaxCalculation: 'TaxExcluded',
  };
  if (deferStripeSettlement && stripePaymentIntentId) {
    invoicePayload.PrivateNote = `Form membership Stripe PaymentIntent: ${stripePaymentIntentId}`;
  }
  if (currency) invoicePayload.CurrencyRef = { value: currency };

  console.log(
    `[QBO] Creating membership invoice for ${organizationName}, ${membershipYear}, ${currency} ${finalCost}`
  );

  // Task #3633: provider-side idempotency — QBO replays the original
  // response for a repeated requestid instead of creating a second invoice,
  // so a crash between create and our local linkage write cannot duplicate.
  const requestIdParam = idempotencyKey
    ? `&requestid=${encodeURIComponent(deferStripeSettlement
      ? accountingOperationIdentity(idempotencyKey, 'inv', 50)
      : String(idempotencyKey).slice(0, 50))}`
    : '';
  const url = `${base}/invoice?minorversion=${MINOR_VERSION}${requestIdParam}`;
  const invoiceResp = await qboFetch('invoice-create', accessToken, 'POST', url, invoicePayload);
  const invoice = invoiceResp?.Invoice;
  if (!invoice?.Id) {
    throw new Error(`Failed to create QuickBooks invoice: ${JSON.stringify(invoiceResp).substring(0, 500)}`);
  }
  console.log(`[QBO] Membership invoice created: ${invoice.DocNumber} (${invoice.Id})`);

  let paymentRecorded = false;
  let paymentId = null;
  if (markAsPaid && !deferStripeSettlement) {
    try {
      const bankAccountId = await resolveStripeBankAccountId(appTenantId, bankAccountSettingKey || null, { strict: strictBankAccount === true });
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

        // Payment creation is a separate request — give it its own
        // idempotency requestid so a crash after the payment succeeded but
        // before our linkage write can't record a second payment on retry.
        const payRequestId = paymentIdempotencyKey
          ? `&requestid=${encodeURIComponent(String(paymentIdempotencyKey).slice(0, 50))}`
          : '';
        const payUrl = `${base}/payment?minorversion=${MINOR_VERSION}${payRequestId}`;
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

  // Best-effort fetch of the customer-facing hosted invoice URL via the
  // `?include=invoiceLink` query on the invoice GET. QBO returns it as
  // `InvoiceLink` on the Invoice object (only populated when the company
  // file allows online sharing). Any failure is non-fatal — caller behaves
  // exactly as before with `online_invoice_url: null`.
  let onlineInvoiceUrl = null;
  try {
    const linkUrl = `${base}/invoice/${encodeURIComponent(invoice.Id)}?include=invoiceLink&minorversion=${MINOR_VERSION}`;
    const linkResp = await qboFetch('invoice-link', accessToken, 'GET', linkUrl);
    onlineInvoiceUrl = linkResp?.Invoice?.InvoiceLink || null;
    if (onlineInvoiceUrl) {
      console.log(`[QBO] Online invoice link retrieved for ${invoice.DocNumber || invoice.Id}`);
    }
  } catch (linkErr) {
    console.log(`[QBO] Could not fetch online invoice link (non-fatal): ${linkErr.message}`);
  }

  return {
    invoice_id: invoice.Id,
    // Return DocNumber as-is; may be null when the company file has
    // "Custom transaction numbers" enabled. Callers must handle the
    // missing-number case rather than falling back to the internal Id.
    invoice_number: invoice.DocNumber || null,
    total: invoice.TotalAmt,
    status: paymentRecorded ? 'PAID' : 'AUTHORISED',
    payment_recorded: paymentRecorded,
    annotation_recorded: !!(deferStripeSettlement && stripePaymentIntentId),
    payment_id: paymentId,
    online_invoice_url: onlineInvoiceUrl,
    provider_context: { quickbooks_realm_id: realmId, environment },
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
  reference = null,
  bankAccountSettingKey = null,
  strictBankAccount = false,
  idempotencyKey = null,
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
    const bankAccountId = await resolveStripeBankAccountId(appTenantId, bankAccountSettingKey, { strict: strictBankAccount === true });
    if (bankAccountId) {
      const paymentPayload = {
        CustomerRef: { value: customerId },
        TotalAmt: payAmount,
        TxnDate: (paidAt ? new Date(paidAt) : new Date()).toISOString().split('T')[0],
        DepositToAccountRef: { value: String(bankAccountId) },
        PaymentRefNum: reference
          ? reference.substring(0, 21)
          : (stripePaymentIntentId ? `Stripe: ${stripePaymentIntentId}`.substring(0, 21) : undefined),
        PrivateNote: reference || (stripePaymentIntentId ? `Stripe charge: ${stripePaymentIntentId}` : 'Stripe payment'),
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

      // Idempotent payment create — QBO replays the original response for a
      // repeated requestid, so retries can't double-pay the invoice.
      const payRequestId = idempotencyKey
        ? `&requestid=${encodeURIComponent(String(idempotencyKey).slice(0, 50))}`
        : '';
      const payUrl = `${base}/payment?minorversion=${MINOR_VERSION}${payRequestId}`;
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

const qboSettlementMoney = (value, label) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0
      || Math.abs(number * 100 - Math.round(number * 100)) > 1e-7) {
    throw new Error(`${label} must be a positive major-unit amount with at most two decimals`);
  }
  return Math.round(number * 100) / 100;
};

// Intuit requestid is limited to 50 provider-safe characters. Keep readable
// operation keys where possible and deterministically compact longer keys.
export function quickBooksSettlementRequestId(operationKey, suffix) {
  return quickBooksRequestId(accountingOperationIdentity(operationKey, suffix, 50));
}

/**
 * Existing-invoice Stripe settlement for form invoices. It never chooses an
 * account, overwrites a PO/customer memo, or assumes a zero balance was caused
 * by Stripe. Provider state is inspected before and after every payment write.
 */
export async function settleFormStripeQuickBooksInvoice(args, dependencies = {}) {
  const {
    appTenantId, invoiceId, stripePaymentIntentId, amount, currency, paidAt,
    dryRun = false, annotationOnly = false, expectedAccount = null, operationKey,
  } = args || {};
  if (!appTenantId) throw new Error('appTenantId is required');
  if (!invoiceId) throw new Error('invoiceId is required');
  if (!validStripePaymentIntentId(stripePaymentIntentId)) {
    throw new Error('stripePaymentIntentId must be a full PaymentIntent identifier');
  }
  if (!/^[A-Z]{3}$/.test(String(currency || '').toUpperCase())) throw new Error('currency is required');
  const paymentRequestId = quickBooksSettlementRequestId(operationKey, 'pay');
  const annotationRequestId = quickBooksSettlementRequestId(operationKey, 'note');
  const payAmount = qboSettlementMoney(amount, 'amount');
  const tokenResolver = dependencies.getValidQuickBooksAccessToken || getValidQuickBooksAccessToken;
  const rawFetch = dependencies.fetch || fetch;
  const fetcher = (url, init = {}) => rawFetch(url, {
    ...init,
    signal: init.signal || AbortSignal.timeout(20000),
  });
  const database = dependencies.supabase || supabase;
  if (!database) throw new Error('Supabase not configured');
  const { accessToken, realmId, environment } = await tokenResolver(appTenantId);
  const expectedProviderContext = args?.expectedProviderContext;
  const expectedRealm = typeof expectedProviderContext === 'string'
    ? expectedProviderContext
    : expectedProviderContext?.quickbooks_realm_id;
  if (expectedRealm && String(expectedRealm) !== String(realmId)) {
    throw new Error('Connected QuickBooks company does not match the invoice provider context');
  }
  if (expectedProviderContext?.environment
      && String(expectedProviderContext.environment) !== String(environment)) {
    throw new Error('Connected QuickBooks environment does not match the invoice provider context');
  }
  const { apiBaseUrl } = getIntuitEndpoints(environment);
  const base = companyBase(apiBaseUrl, realmId);
  const headers = qboHeaders(accessToken);
  const readInvoice = async () => {
    const response = await fetcher(
      `${base}/invoice/${encodeURIComponent(invoiceId)}?minorversion=${MINOR_VERSION}`,
      { headers },
    );
    const data = await safeJson(response, 'form-settlement-invoice-retrieve');
    if (!data?.Invoice?.Id) throw new Error(`QBO invoice ${invoiceId} not found`);
    return data.Invoice;
  };
  const queryPayments = async (customerId) => {
    const escaped = String(customerId).replace(/'/g, "\\'");
    const payments = [];
    const pageSize = 1000;
    for (let page = 0; page < 10; page += 1) {
      const start = page * pageSize + 1;
      const query = `SELECT * FROM Payment WHERE CustomerRef = '${escaped}' STARTPOSITION ${start} MAXRESULTS ${pageSize}`;
      const response = await fetcher(
        `${base}/query?minorversion=${MINOR_VERSION}&query=${encodeURIComponent(query)}`,
        { headers: qboHeaders(accessToken, { 'Content-Type': 'application/text' }) },
      );
      const data = await safeJson(response, 'form-settlement-payment-query');
      const batch = data?.QueryResponse?.Payment || [];
      payments.push(...batch);
      if (batch.length < pageSize) return payments;
    }
    throw new Error('QuickBooks payment history exceeds the safe inspection limit; refusing settlement');
  };

  let invoice = await readInvoice();
  const invoiceTotal = qboSettlementMoney(invoice.TotalAmt, 'QuickBooks invoice total');
  if (invoice.Balance == null) throw new Error('QuickBooks invoice returned no balance');
  let balance = Math.round(Number(invoice.Balance) * 100) / 100;
  if (!Number.isFinite(balance) || balance < 0) throw new Error('QuickBooks invoice returned an invalid balance');
  const invoiceCurrency = String(invoice.CurrencyRef?.value || '').toUpperCase();
  if (invoiceTotal !== payAmount) {
    throw new Error(`Stripe amount ${payAmount.toFixed(2)} does not match QuickBooks invoice total ${invoiceTotal.toFixed(2)}`);
  }
  if (invoiceCurrency !== String(currency).toUpperCase()) {
    throw new Error(`Stripe currency ${String(currency).toUpperCase()} does not match QuickBooks invoice currency ${invoiceCurrency || '(missing)'}`);
  }
  const customerId = invoice.CustomerRef?.value;
  if (!customerId) throw new Error(`QBO invoice ${invoiceId} has no CustomerRef`);
  const trace = `Stripe PaymentIntent: ${stripePaymentIntentId}`;
  const paymentMatches = (payment) => {
    if (!containsExactStripePaymentIntent(payment?.PrivateNote, stripePaymentIntentId)) return false;
    const linked = (payment.Line || []).find((line) =>
      (line.LinkedTxn || []).some((txn) => String(txn.TxnId) === String(invoiceId)
        && txn.TxnType === 'Invoice'));
    return !!linked && qboSettlementMoney(linked.Amount, 'QuickBooks linked payment amount') === payAmount;
  };
  let matchingPayment = (await queryPayments(customerId)).find(paymentMatches) || null;

  let annotationRecorded = containsExactStripePaymentIntent(invoice.PrivateNote, stripePaymentIntentId);
  let annotationError = null;
  if (!annotationRecorded && !dryRun) {
    try {
      const existingNote = String(invoice.PrivateNote || '');
      const note = existingNote ? `${existingNote}\n${trace}` : trace;
      if (note.length > 4000) {
        throw new Error('QuickBooks PrivateNote cannot fit the Stripe PaymentIntent without overwriting existing content');
      }
      const response = await fetcher(
        `${base}/invoice?minorversion=${MINOR_VERSION}&requestid=${encodeURIComponent(annotationRequestId)}`,
        {
          method: 'POST',
          headers: qboHeaders(accessToken, { 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            Id: invoice.Id, SyncToken: invoice.SyncToken, sparse: true, PrivateNote: note,
          }),
        },
      );
      const data = await safeJson(response, 'form-settlement-invoice-annotate');
      annotationRecorded = containsExactStripePaymentIntent(data?.Invoice?.PrivateNote || note, stripePaymentIntentId);
      invoice = data?.Invoice?.Id ? data.Invoice : invoice;
    } catch (error) {
      annotationError = error.message;
      try {
        invoice = await readInvoice();
        annotationRecorded = containsExactStripePaymentIntent(invoice.PrivateNote, stripePaymentIntentId);
        if (annotationRecorded) annotationError = null;
      } catch {
        // Preserve the original actionable annotation error.
      }
    }
  }

  let account = null;
  let settlementError = null;
  let settlementState = 'retry';
  if (annotationOnly) {
    if (matchingPayment && balance === 0) {
      settlementState = annotationRecorded ? 'done' : 'retry';
    } else if (balance !== invoiceTotal) {
      settlementState = 'blocked';
      settlementError = 'Annotation recorded, but invoice is partially or manually settled';
    } else {
      settlementState = 'retry';
      settlementError = 'Annotation-only operation completed; Stripe settlement remains pending';
    }
  } else if (matchingPayment && balance === 0) {
    settlementState = annotationRecorded ? 'done' : 'retry';
  } else if (balance !== invoiceTotal) {
    settlementState = 'blocked';
    settlementError = matchingPayment
      ? 'The Stripe-linked payment does not fully settle the invoice'
      : 'Invoice has a partial or manual payment; refusing to create an excess payment';
  } else {
    const { data: primary, error: primaryError } = await database.from('system_settings')
      .select('setting_value').eq('setting_key', 'quickbooks_stripe_bank_account_id')
      .eq('tenant_id', appTenantId).maybeSingle();
    if (primaryError) throw new Error(`Failed to read QuickBooks Stripe clearing-account configuration: ${primaryError.message}`);
    let configuredId = primary?.setting_value ? String(primary.setting_value) : null;
    if (!configuredId) {
      const { data: fallback, error: fallbackError } = await database.from('system_settings')
        .select('setting_value').eq('setting_key', 'accounting_stripe_bank_account_id')
        .eq('tenant_id', appTenantId).maybeSingle();
      if (fallbackError) throw new Error(`Failed to read QuickBooks Stripe clearing-account configuration: ${fallbackError.message}`);
      configuredId = fallback?.setting_value ? String(fallback.setting_value) : null;
    }
    if (!configuredId) {
      settlementState = 'blocked';
      settlementError = 'QuickBooks Stripe clearing account is not configured (quickbooks_stripe_bank_account_id)';
    } else if (expectedAccount != null && String(expectedAccount) !== configuredId) {
      account = configuredId;
      settlementState = 'blocked';
      settlementError = `Configured QuickBooks Stripe clearing account does not match explicitly confirmed account ${expectedAccount}`;
    } else {
      account = configuredId;
      const accountResponse = await fetcher(
        `${base}/account/${encodeURIComponent(configuredId)}?minorversion=${MINOR_VERSION}`,
        { headers },
      );
      const accountData = await safeJson(accountResponse, 'form-settlement-account-retrieve');
      const bankAccount = accountData?.Account;
      if (!bankAccount?.Id || bankAccount.Active === false
          || !['Bank', 'Other Current Asset'].includes(bankAccount.AccountType)) {
        settlementState = 'blocked';
        settlementError = `Configured QuickBooks Stripe clearing account ${configuredId} is not active or deposit-capable`;
      } else if (dryRun) {
        settlementState = 'retry';
        settlementError = 'Dry run: payment and/or annotation still need to be recorded';
      } else {
        try {
          const response = await fetcher(
            `${base}/payment?minorversion=${MINOR_VERSION}&requestid=${encodeURIComponent(paymentRequestId)}`,
            {
              method: 'POST',
              headers: qboHeaders(accessToken, { 'Content-Type': 'application/json' }),
              body: JSON.stringify({
                CustomerRef: { value: String(customerId) },
                TotalAmt: payAmount,
                TxnDate: new Date(paidAt || Date.now()).toISOString().split('T')[0],
                DepositToAccountRef: { value: configuredId },
                PaymentRefNum: `Stripe: ${stripePaymentIntentId}`.slice(0, 21),
                PrivateNote: trace,
                CurrencyRef: { value: invoiceCurrency },
                Line: [{ Amount: payAmount, LinkedTxn: [{ TxnId: invoice.Id, TxnType: 'Invoice' }] }],
              }),
            },
          );
          await safeJson(response, 'form-settlement-payment-create');
        } catch (error) {
          settlementError = error.message;
        }
        // Resolve provider timeouts and requestid replays from authoritative state.
        invoice = await readInvoice();
        if (invoice.Balance == null) throw new Error('QuickBooks invoice returned no balance');
        balance = Math.round(Number(invoice.Balance) * 100) / 100;
        matchingPayment = (await queryPayments(customerId)).find(paymentMatches) || matchingPayment;
        if (matchingPayment && balance === 0) {
          settlementState = annotationRecorded ? 'done' : 'retry';
          settlementError = null;
        } else {
          settlementState = 'retry';
          settlementError ||= 'QuickBooks did not confirm the Stripe-linked payment';
        }
      }
    }
  }
  if (dryRun && settlementState === 'retry' && !settlementError) {
    settlementError = 'Dry run: invoice annotation still needs to be recorded';
  }
  const errors = [settlementError, annotationError && `Invoice annotation: ${annotationError}`].filter(Boolean);
  return {
    payment_recorded: !!matchingPayment && balance === 0,
    annotation_recorded: annotationRecorded,
    settlement_state: settlementState,
    error: errors.join('; ') || null,
    invoice_id: invoice.Id,
    invoice_number: invoice.DocNumber || null,
    balance,
    account,
    provider_context: { quickbooks_realm_id: realmId, environment },
  };
}

/**
 * Read-only, bounded recovery lookup for deferred membership invoice creation.
 * Only an exact PrivateNote PI marker is eligible; duplicates and scan caps
 * fail closed rather than guessing which invoice to link.
 */
export async function findFormStripeQuickBooksInvoice(args, dependencies = {}) {
  const {
    appTenantId, stripePaymentIntentId, createdAfter, expectedProviderContext = null,
  } = args || {};
  if (!appTenantId) throw new Error('appTenantId is required');
  if (!validStripePaymentIntentId(stripePaymentIntentId)) {
    throw new Error('stripePaymentIntentId must be a full PaymentIntent identifier');
  }
  const after = new Date(createdAfter);
  if (!createdAfter || Number.isNaN(after.getTime())) throw new Error('createdAfter must be a valid date');
  const tokenResolver = dependencies.getValidQuickBooksAccessToken || getValidQuickBooksAccessToken;
  const rawFetch = dependencies.fetch || fetch;
  const fetcher = (url, init = {}) => rawFetch(url, {
    ...init, signal: init.signal || AbortSignal.timeout(20000),
  });
  const { accessToken, realmId, environment } = await tokenResolver(appTenantId);
  const expectedRealm = typeof expectedProviderContext === 'string'
    ? expectedProviderContext
    : expectedProviderContext?.quickbooks_realm_id;
  if (expectedRealm && String(expectedRealm) !== String(realmId)) {
    throw new Error('Connected QuickBooks company does not match the invoice provider context');
  }
  if (expectedProviderContext?.environment
      && String(expectedProviderContext.environment) !== String(environment)) {
    throw new Error('Connected QuickBooks environment does not match the invoice provider context');
  }
  const { apiBaseUrl } = getIntuitEndpoints(environment);
  const base = companyBase(apiBaseUrl, realmId);
  const matches = [];
  const pageSize = 1000;
  for (let page = 0; page < 10; page += 1) {
    const start = page * pageSize + 1;
    const query = `SELECT * FROM Invoice WHERE MetaData.CreateTime >= '${after.toISOString()}' STARTPOSITION ${start} MAXRESULTS ${pageSize}`;
    const response = await fetcher(
      `${base}/query?minorversion=${MINOR_VERSION}&query=${encodeURIComponent(query)}`,
      { headers: qboHeaders(accessToken, { 'Content-Type': 'application/text' }) },
    );
    const data = await safeJson(response, 'form-invoice-discovery');
    const batch = data?.QueryResponse?.Invoice || [];
    for (const invoice of batch) {
      const created = new Date(invoice.MetaData?.CreateTime || 0);
      if (created >= after
          && String(invoice.PrivateNote || '').includes('Form membership Stripe PaymentIntent:')
          && containsExactStripePaymentIntent(invoice.PrivateNote, stripePaymentIntentId)) {
        matches.push(invoice);
      }
    }
    if (batch.length < pageSize) break;
    if (page === 9) {
      throw new Error('QuickBooks invoice discovery exceeded the safe 10,000-invoice inspection limit');
    }
  }
  if (matches.length > 1) {
    throw new Error(`Multiple QuickBooks membership invoices carry PaymentIntent ${stripePaymentIntentId}; refusing ambiguous recovery`);
  }
  const invoice = matches[0];
  if (!invoice) return null;
  if (invoice.Balance == null) throw new Error('QuickBooks discovered invoice returned no balance');
  return {
    invoice_id: invoice.Id,
    invoice_number: invoice.DocNumber || null,
    total: Number(invoice.TotalAmt),
    balance: Number(invoice.Balance),
    currency: invoice.CurrencyRef?.value || null,
    provider_context: { quickbooks_realm_id: realmId, environment },
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
  let taxCodeId = originalLine?.SalesItemLineDetail?.TaxCodeRef?.value || null;
  if (!itemId) {
    throw new Error(`Invoice ${invoiceId} has no SalesItemLineDetail line to mirror onto a credit note`);
  }
  if (!taxCodeId) {
    try {
      const itemResp = await qboFetch(
        'item-retrieve',
        accessToken,
        'GET',
        `${base}/item/${encodeURIComponent(itemId)}?minorversion=${MINOR_VERSION}`
      );
      taxCodeId = itemResp?.Item?.SalesTaxCodeRef?.value || null;
    } catch (itemErr) {
      console.log(`[QBO] Item lookup for credit note tax fallback failed (non-fatal): ${itemErr.message}`);
    }
  }
  if (!taxCodeId) {
    const defaultTaxCode = await getTenantSetting(appTenantId, 'quickbooks_default_tax_code_id');
    if (defaultTaxCode) taxCodeId = String(defaultTaxCode);
  }
  if (!taxCodeId) {
    throw new Error(
      `QuickBooks credit note requires a tax code, but invoice ${invoice.DocNumber || invoiceId} ` +
        'has no TaxCodeRef on its line and no fallback is configured. Set system_settings key ' +
        '`quickbooks_default_tax_code_id` or configure SalesTaxCodeRef on the QuickBooks Item.'
    );
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
  cmLine.SalesItemLineDetail.TaxCodeRef = { value: taxCodeId };

  const cmPayload = {
    CustomerRef: { value: customerId },
    Line: [cmLine],
    TxnDate: new Date().toISOString().split('T')[0],
    PrivateNote: reference || `Credit for invoice ${invoice.DocNumber}`,
    // QBO rejects credit memos with the same "Make sure all your transactions
    // have a VAT rate" error as invoices when GlobalTaxCalculation is missing.
    // Mirror the original invoice's value so the credit memo's tax maths match
    // the document it is crediting (inclusive vs exclusive vs no-tax). Fall
    // back to TaxExcluded — which is what membership invoices created by this
    // module use — when the source invoice did not carry the field.
    GlobalTaxCalculation: invoice.GlobalTaxCalculation || 'TaxExcluded',
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

/**
 * Fetch a QuickBooks invoice (raw API response shape).
 */
export async function getQuickBooksInvoice(appTenantId, invoiceId) {
  if (!appTenantId) throw new Error('appTenantId is required');
  if (!invoiceId) throw new Error('invoiceId is required');

  const { accessToken, realmId, environment } = await getValidQuickBooksAccessToken(appTenantId);
  const { apiBaseUrl } = getIntuitEndpoints(environment);
  const base = companyBase(apiBaseUrl, realmId);

  const resp = await qboFetch(
    'invoice-retrieve',
    accessToken,
    'GET',
    `${base}/invoice/${encodeURIComponent(invoiceId)}?minorversion=${MINOR_VERSION}`,
  );
  return resp?.Invoice || null;
}

/**
 * Returns a normalised payment-state snapshot for a QBO invoice.
 * QBO has no "PAID" status string — paid means `Balance === 0 && TotalAmt > 0`.
 */
export async function fetchQuickBooksInvoiceStatus(invoiceId, appTenantId) {
  const invoice = await getQuickBooksInvoice(appTenantId, invoiceId);
  if (!invoice) return null;

  const total = Number(parseFloat(invoice.TotalAmt ?? 0));
  const balance = Number(parseFloat(invoice.Balance ?? 0));
  const amountPaid = Math.max(0, total - balance);
  const voided = invoice.Voided === true;

  let status = 'unpaid';
  if (voided) {
    status = 'voided';
  } else if (total > 0 && balance === 0) {
    status = 'paid';
  } else if (amountPaid > 0 && balance > 0) {
    status = 'partial';
  }

  // QBO surfaces LinkedTxn payments at the invoice level; best-effort paidAt
  // is the most recent linked Payment TxnDate. Fall back to MetaData.LastUpdatedTime.
  let paidAt = null;
  if (status === 'paid') {
    const lastUpdated = invoice.MetaData?.LastUpdatedTime;
    if (lastUpdated) {
      const t = Date.parse(lastUpdated);
      if (!Number.isNaN(t)) paidAt = new Date(t).toISOString();
    }
    if (!paidAt) paidAt = new Date().toISOString();
  }

  return {
    status,
    balance,
    totalAmt: total,
    amountPaid,
    paidAt,
    voided,
    raw: invoice,
  };
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

  // Write to ALL three keys:
  //   - `accounting_vat_rates_{tenantId}`: provider-neutral, new code path.
  //   - `xero_vat_rates_{tenantId}`: legacy per-tenant key used by server-side
  //     pricing simulators in api/_lib/membershipSimulation.js.
  //   - `xero_vat_rates` (unsuffixed): the key every UI VAT-rate dropdown
  //     reader (MembershipTierManagement, event editors, etc.) expects. This
  //     is what makes the synced QBO rates actually appear in the band-level
  //     VAT picker. SystemSettings is tenant-scoped via base44, so the
  //     unsuffixed key does not collide across tenants.
  const keys = [
    `accounting_vat_rates_${appTenantId}`,
    `xero_vat_rates_${appTenantId}`,
    'xero_vat_rates',
  ];
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
