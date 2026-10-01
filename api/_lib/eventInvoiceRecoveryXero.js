import { EventInvoiceRecoveryError, recoveryLineAmount } from './eventInvoiceRecovery.js';
import { createDecipheriv, scryptSync } from 'node:crypto';

const day = value => {
  const xero = /^\/Date\((\d+)(?:[+-]\d{4})?\)\/$/.exec(String(value || ''));
  const date = xero ? new Date(Number(xero[1])) : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
};
const tracking = value => JSON.stringify((value || []).map(item =>
  [item.Name, item.Option]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
function credential(value) {
  if (typeof value !== 'string' || !value.includes(':')) return value;
  const secret = process.env.INTEGRATION_ENCRYPTION_KEY || process.env.SESSION_SECRET;
  if (!secret) throw new EventInvoiceRecoveryError('provider_reconnect_required');
  try {
    const [iv, encrypted] = value.split(':');
    const decipher = createDecipheriv('aes-256-cbc', scryptSync(secret, 'salt', 32), Buffer.from(iv, 'hex'));
    return decipher.update(encrypted, 'hex', 'utf8') + decipher.final('utf8');
  } catch { throw new EventInvoiceRecoveryError('provider_reconnect_required'); }
}
export function verifyRecoveryInvoiceFinancials(invoice, snapshot) {
  if (day(invoice.DateString || invoice.Date) !== snapshot.invoice.Date
    || day(invoice.DueDateString || invoice.DueDate) !== snapshot.invoice.DueDate
    || invoice.LineAmountTypes !== snapshot.invoice.LineAmountTypes
    || invoice.LineItems?.length !== snapshot.invoice.LineItems.length) return false;
  return snapshot.invoice.LineItems.every((expected, i) => {
    const actual = invoice.LineItems[i];
    const lineAmount = recoveryLineAmount(expected, snapshot.currency);
    return actual && String(actual.AccountCode) === String(expected.AccountCode)
      && actual.TaxType === expected.TaxType && Number(actual.TaxAmount) === expected.TaxAmount
      && Number(actual.UnitAmount) === Number(expected.UnitAmount)
      && Number(actual.Quantity) === Number(expected.Quantity)
      && Number(actual.LineAmount) === lineAmount
      && Number(actual.DiscountRate || 0) === Number(expected.DiscountRate || 0)
      && (expected.DiscountAmount == null || Number(actual.DiscountAmount) === Number(expected.DiscountAmount))
      && String(actual.Description || '') === String(expected.Description || '')
      && tracking(actual.Tracking) === tracking(expected.Tracking);
  });
}

/** Dedicated transport: no provider helper that silently retries writes or loses Retry-After. */
export async function createEventInvoiceRecoveryXero({
  db, row, identity, guard, deadlineAt, fetchImpl = fetch, credentialsLoader = null,
}) {
  const snapshot = row.snapshot;
  let requests = 0;
  const databaseQuery = async query => {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new EventInvoiceRecoveryError('time_budget', { retry: true });
    return typeof query.abortSignal === 'function'
      ? query.abortSignal(AbortSignal.timeout(Math.min(5000, remaining))) : query;
  };
  const request = async (url, init) => {
    await guard();
    if (++requests > 8) throw new EventInvoiceRecoveryError('request_budget', { retry: true });
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new EventInvoiceRecoveryError('time_budget', { retry: true });
    let response;
    try {
      response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(Math.min(8000, remaining)) });
    } catch {
      throw new EventInvoiceRecoveryError('transport_ambiguous', { retry: true });
    }
    if (response.status === 429) throw new EventInvoiceRecoveryError('provider_rate_limited', {
      retry: true, retryAfter: response.headers.get('retry-after'),
    });
    if (!response.ok) throw new EventInvoiceRecoveryError(
      response.status >= 500 || response.status === 408 ? 'provider_unavailable' : 'provider_rejected',
      { retry: response.status >= 500 || response.status === 408 },
    );
    let data;
    try { data = await response.json(); } catch {
      throw new EventInvoiceRecoveryError('provider_response_ambiguous', { retry: true });
    }
    if (data?.ErrorNumber || data?.HasErrors) throw new EventInvoiceRecoveryError('provider_validation');
    return data;
  };
  const active = await databaseQuery(db.from('tenant_accounting_settings').select('active_provider')
    .eq('tenant_id', row.tenant_id).maybeSingle());
  if (active.error) throw new EventInvoiceRecoveryError('provider_settings_unavailable', { retry: true });
  if (active.data?.active_provider && active.data.active_provider !== 'xero') {
    throw new EventInvoiceRecoveryError('provider_binding_changed');
  }
  const enabled = await databaseQuery(db.from('tenant_integrations').select('is_enabled,credentials')
    .eq('tenant_id', row.tenant_id).eq('integration_type', 'xero').maybeSingle());
  if (enabled.error) throw new EventInvoiceRecoveryError('provider_settings_unavailable', { retry: true });
  if (enabled.data?.is_enabled !== true) throw new EventInvoiceRecoveryError('provider_reconnect_required');
  const tokenResult = await databaseQuery(db.from('xero_token').select('*')
    .eq('app_tenant_id', row.tenant_id).eq('id', snapshot.provider.connectionId).maybeSingle());
  if (tokenResult.error) throw new EventInvoiceRecoveryError('connection_lookup_unavailable', { retry: true });
  const token = tokenResult.data;
  if (!token || token.tenant_id !== snapshot.provider.xeroTenantId) throw new EventInvoiceRecoveryError('provider_binding_changed');
  let accessToken = token.access_token;
  if (!accessToken || !(Date.parse(token.expires_at) > Date.now() + 60_000)) {
    const credentials = credentialsLoader ? await credentialsLoader(row.tenant_id) : {
      is_enabled: enabled.data.is_enabled,
      client_id: credential(enabled.data.credentials?.client_id),
      client_secret: credential(enabled.data.credentials?.client_secret),
    };
    if (!credentials?.is_enabled || !credentials.client_id || !credentials.client_secret || !token.refresh_token) {
      throw new EventInvoiceRecoveryError('provider_reconnect_required');
    }
    const auth = await request('https://identity.xero.com/connect/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${credentials.client_id}:${credentials.client_secret}`).toString('base64')}` },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refresh_token }).toString(),
    });
    if (!auth.access_token || !auth.refresh_token || !Number.isFinite(auth.expires_in)) {
      throw new EventInvoiceRecoveryError('provider_reconnect_required');
    }
    const saved = await databaseQuery(db.from('xero_token').update({
      access_token: auth.access_token, refresh_token: auth.refresh_token,
      expires_at: new Date(Date.now() + auth.expires_in * 1000).toISOString(),
    }).eq('id', token.id).eq('app_tenant_id', row.tenant_id).eq('tenant_id', token.tenant_id)
      .eq('refresh_token', token.refresh_token).select('id'));
    if (saved.error || saved.data?.length !== 1) throw new EventInvoiceRecoveryError('provider_credentials_not_saved');
    accessToken = auth.access_token;
  }
  const api = (path, method = 'GET', body = null, key = null) => request(`https://api.xero.com/api.xro/2.0/${path}`, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, 'xero-tenant-id': snapshot.provider.xeroTenantId,
      Accept: 'application/json', 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const paymentReference = `${identity}:${snapshot.settlement?.paymentIntentId || ''}`;
  const query = (field, value) => `?where=${encodeURIComponent(`${field}=="${value}"`)}`;
  const single = (data, field) => {
    if (data?.[field]?.length !== 1 || data[field][0].HasErrors || data[field][0].ValidationErrors?.length) {
      throw new EventInvoiceRecoveryError('provider_result_ambiguous', { retry: true });
    }
    return data[field][0];
  };
  return {
    async findInvoices() {
      if (row.invoice_id) {
        // Durable ID outranks every mutable human-visible field, including the
        // invoice number. A missing/deleted known invoice NEVER permits create.
        const data = await api(`Invoices/${encodeURIComponent(row.invoice_id)}`);
        if (data?.Invoices?.length !== 1 || data.Invoices[0].InvoiceID !== row.invoice_id) {
          throw new EventInvoiceRecoveryError('known_invoice_unavailable');
        }
        return data.Invoices;
      }
      // InvoiceNumber is provider-unique. Reference belongs to the purchaser's PO
      // and is mutable through existing PO tooling; never use it as the journal.
      const data = await api(`Invoices${query('InvoiceNumber', identity)}`);
      if (!Array.isArray(data?.Invoices)) throw new EventInvoiceRecoveryError('invoice_lookup_invalid', { retry: true });
      return data.Invoices;
    },
    async findPayments() {
      const data = await api(`Payments${query('Reference', paymentReference)}`);
      if (!Array.isArray(data?.Payments)) throw new EventInvoiceRecoveryError('payment_lookup_invalid', { retry: true });
      return data.Payments;
    },
    async createInvoice() {
      return single(await api('Invoices', 'POST', {
        Invoices: [{ ...snapshot.invoice, InvoiceNumber: identity }],
      }, `${identity}-invoice`), 'Invoices');
    },
    validateInvoice(invoice) {
      if (!invoice?.InvoiceID || (row.invoice_id ? invoice.InvoiceID !== row.invoice_id : invoice.InvoiceNumber !== identity)
        || invoice.Type !== 'ACCREC'
        || !(snapshot.paymentMethod === 'stripe' ? ['AUTHORISED', 'PAID']
          : [snapshot.invoice.Status, 'AUTHORISED', 'PAID']).includes(invoice.Status)
        || invoice.CurrencyCode !== snapshot.currency
        || Number(invoice.Total) !== snapshot.amount || !verifyRecoveryInvoiceFinancials(invoice, snapshot)
        || (snapshot.invoice.Contact.ContactID && invoice.Contact?.ContactID !== snapshot.invoice.Contact.ContactID)
        || (!snapshot.invoice.Contact.ContactID
          && String(invoice.Contact?.Name || '').trim() !== snapshot.invoice.Contact.Name.trim())) {
        throw new EventInvoiceRecoveryError('invoice_evidence_mismatch');
      }
    },
    async createPayment(invoice) {
      const code = snapshot.settlement.accountCode;
      if (!/^[A-Za-z0-9._ -]{1,50}$/.test(code)) throw new EventInvoiceRecoveryError('settlement_account_invalid');
      const accounts = (await api(`Accounts?where=${encodeURIComponent(`Code=="${code}"`)}`)).Accounts;
      const bank = accounts?.[0];
      if (accounts?.length !== 1 || bank.Code !== code || bank.Status !== 'ACTIVE'
        || (bank.Type !== 'BANK' && bank.EnablePaymentsToAccount !== true)
        || bank.CurrencyCode !== snapshot.currency) {
        throw new EventInvoiceRecoveryError('settlement_account_mismatch');
      }
      return single(await api('Payments', 'PUT', { Payments: [{
        Invoice: { InvoiceID: invoice.InvoiceID }, Account: { Code: code },
        Date: snapshot.settlement.paidAt.slice(0, 10), Amount: snapshot.settlement.amount,
        Reference: paymentReference,
      }] }, `${identity}-payment`), 'Payments');
    },
    validatePayment(payment, invoice) {
      if (!payment?.PaymentID || payment.Reference !== paymentReference
        || payment.Invoice?.InvoiceID !== invoice.InvoiceID
        || Number(payment.Amount) !== snapshot.settlement.amount
        || payment.Status !== 'AUTHORISED'
        || payment.Account?.Code !== snapshot.settlement.accountCode
        || day(payment.Date) !== snapshot.settlement.paidAt.slice(0, 10)
        || (payment.Invoice?.CurrencyCode && payment.Invoice.CurrencyCode !== snapshot.currency)) {
        throw new EventInvoiceRecoveryError('payment_evidence_mismatch');
      }
    },
  };
}