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
export const recoveryInvoiceMarker = identity => `\n[Event invoice recovery: ${identity}]`;

export function verifyRecoveryInvoiceFinancials(invoice, snapshot, { legacy = false, identity = null } = {}) {
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
      && (legacy || String(actual.Description || '') === String(expected.Description || '')
        + (i === 0 && identity ? recoveryInvoiceMarker(identity) : ''))
      && tracking(actual.Tracking) === tracking(expected.Tracking);
  });
}

/** Dedicated transport: no provider helper that silently retries writes or loses Retry-After. */
export async function createEventInvoiceRecoveryXero({
  db, row, identity, guard, deadlineAt, fetchImpl = fetch, credentialsLoader = null,
}) {
  const snapshot = row.snapshot;
  const discovery = snapshot.legacyDiscovery;
  if (discovery) {
    const from = day(discovery.fromDate);
    const to = day(discovery.toDate);
    if (discovery.version !== 1 || from !== discovery.fromDate || to !== discovery.toDate
      || !from || !to || to < from || Date.parse(to) - Date.parse(from) > 366 * 86400_000
      || snapshot.invoice.Date < from || snapshot.invoice.Date > to
      || (snapshot.paymentMethod === 'stripe' && !/^pi_[A-Za-z0-9]+$/.test(snapshot.settlement?.paymentIntentId || ''))
      || (snapshot.paymentMethod !== 'stripe'
        && (!discovery.bookingReference || discovery.bookingReference !== row.booking_group_reference))) {
      throw new EventInvoiceRecoveryError('legacy_discovery_scope_invalid');
    }
  }
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
  const query = (field, value) => `?where=${encodeURIComponent(`${field}==${JSON.stringify(value)}`)}`;
  const single = (data, field) => {
    if (data?.[field]?.length !== 1 || data[field][0].HasErrors || data[field][0].ValidationErrors?.length) {
      throw new EventInvoiceRecoveryError('provider_result_ambiguous', { retry: true });
    }
    return data[field][0];
  };
  const legacyInvoiceIds = new Set();
  // Keep operation identity out of both Xero's sequential number and the buyer's
  // editable PO Reference. The exact first-line suffix survives a lost response.
  const marker = recoveryInvoiceMarker(identity);
  const marked = invoice => invoice?.LineItems?.[0]?.Description?.endsWith(marker) === true;
  let durablePayment = null;
  const legacyPaymentReference = `Stripe: ${snapshot.settlement?.paymentIntentId || ''}`;
  const hasToken = (text, token) => {
    if (!token) return false;
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}($|[^A-Za-z0-9_-])`).test(String(text || ''));
  };
  const invoiceIdentity = invoice => snapshot.paymentMethod === 'stripe'
    ? invoice.LineItems?.some(line => hasToken(line.Description, snapshot.settlement.paymentIntentId))
    : invoice.Reference === discovery.bookingReference
      || invoice.LineItems?.some(line => hasToken(line.Description, discovery.bookingReference));
  const paginated = async (path, field) => {
    const found = new Map();
    // Xero's accounting endpoint page size is 100. An empty terminal page is
    // required; a short page alone is not treated as proof of completeness.
    for (let page = 1; page <= 3; page++) {
      const data = await api(`${path}${path.includes('?') ? '&' : '?'}page=${page}&pageSize=100`);
      const items = data?.[field];
      if (!Array.isArray(items) || items.length > 100) {
        throw new EventInvoiceRecoveryError('legacy_lookup_invalid', { retry: true });
      }
      if (items.length === 0) return [...found.values()];
      for (const item of items) {
        const id = item?.[field === 'Invoices' ? 'InvoiceID' : 'PaymentID'];
        if (!id || item.HasErrors || item.ValidationErrors?.length || found.has(id)) {
          throw new EventInvoiceRecoveryError('legacy_lookup_ambiguous');
        }
        if (field === 'Invoices' && (item.Type !== 'ACCREC'
          || !day(item.DateString || item.Date) || !Array.isArray(item.LineItems)
          || item.LineItems.some(line => typeof line.Description !== 'string'))) {
          // Summary-only invoices cannot prove that the full PI is absent.
          throw new EventInvoiceRecoveryError('legacy_lookup_incomplete');
        }
        found.set(id, item);
      }
    }
    throw new EventInvoiceRecoveryError('legacy_lookup_incomplete');
  };
  const knownInvoice = async id => {
    const data = await api(`Invoices/${encodeURIComponent(id)}`);
    if (data?.Invoices?.length !== 1 || data.Invoices[0].InvoiceID !== id
      || data.Invoices[0].HasErrors || data.Invoices[0].ValidationErrors?.length) {
      throw new EventInvoiceRecoveryError('known_invoice_unavailable');
    }
    return data.Invoices[0];
  };
  const knownPayment = async () => {
    const data = await api(`Payments/${encodeURIComponent(row.payment_id)}`);
    if (data?.Payments?.length !== 1 || data.Payments[0].PaymentID !== row.payment_id
      || data.Payments[0].HasErrors || data.Payments[0].ValidationErrors?.length) {
      throw new EventInvoiceRecoveryError('known_payment_unavailable');
    }
    return data.Payments[0];
  };
  let historicalLookup = null;
  const discover = () => historicalLookup ||= (async () => {
    const invoices = new Map();
    let payments = [];
    if (row.invoice_id) {
      const invoice = await knownInvoice(row.invoice_id);
      invoices.set(invoice.InvoiceID, invoice);
      // A previously adopted invoice stays legacy after its ID is journaled.
      if (invoice.InvoiceNumber !== identity && !marked(invoice)) legacyInvoiceIds.add(invoice.InvoiceID);
    } else if (row.payment_id) {
      // A durable payment ID also supplies durable invoice identity. Do not
      // let an unrelated broad search override it or consume its request budget.
      payments = [await knownPayment()];
      const id = payments[0].Invoice?.InvoiceID;
      if (!id) throw new EventInvoiceRecoveryError('payment_without_invoice');
      const invoice = await knownInvoice(id);
      invoices.set(id, invoice);
      if (invoice.InvoiceNumber !== identity && !marked(invoice)) legacyInvoiceIds.add(id);
    } else {
      const exact = await api(`Invoices${query('InvoiceNumber', identity)}`);
      if (!Array.isArray(exact?.Invoices) || exact.Invoices.some(item => !item?.InvoiceID
        || item.InvoiceNumber !== identity || item.HasErrors || item.ValidationErrors?.length)) {
        throw new EventInvoiceRecoveryError('invoice_lookup_invalid', { retry: true });
      }
      if (exact.Invoices.length > 1) throw new EventInvoiceRecoveryError('invoice_identity_ambiguous');
      for (const invoice of exact.Invoices) invoices.set(invoice.InvoiceID, invoice);
      const where = `Type=="ACCREC"&&Date>=DateTime(${discovery.fromDate.replaceAll('-', ',')})&&Date<=DateTime(${discovery.toDate.replaceAll('-', ',')})`;
      const scanned = await paginated(`Invoices?where=${encodeURIComponent(where)}`, 'Invoices');
      for (const invoice of scanned.filter(invoice => marked(invoice) || invoiceIdentity(invoice))) {
        invoices.set(invoice.InvoiceID, invoice);
        if (invoice.InvoiceNumber !== identity && !marked(invoice)) legacyInvoiceIds.add(invoice.InvoiceID);
      }
    }
    if (snapshot.paymentMethod === 'stripe') {
      if (row.payment_id) {
        if (!payments.length) payments = [await knownPayment()];
      } else {
        const where = `Reference==${JSON.stringify(paymentReference)}||Reference==${JSON.stringify(legacyPaymentReference)}`;
        payments = await paginated(`Payments?where=${encodeURIComponent(where)}`, 'Payments');
        if (payments.some(payment => ![paymentReference, legacyPaymentReference].includes(payment.Reference))) {
          throw new EventInvoiceRecoveryError('payment_lookup_invalid');
        }
      }
      for (const payment of payments) {
        const id = payment.Invoice?.InvoiceID;
        if (!id) throw new EventInvoiceRecoveryError('payment_without_invoice');
        if (row.invoice_id && id !== row.invoice_id) throw new EventInvoiceRecoveryError('payment_evidence_mismatch');
        if (!invoices.has(id)) invoices.set(id, await knownInvoice(id));
        if (invoices.get(id).InvoiceNumber !== identity && !marked(invoices.get(id))) legacyInvoiceIds.add(id);
      }
    }
    if (invoices.size > 1) throw new EventInvoiceRecoveryError('invoice_identity_ambiguous');
    if (payments.length > 1) throw new EventInvoiceRecoveryError('payment_identity_ambiguous');
    for (const [id, invoice] of invoices) {
      if (!invoice.LineItems || !invoice.Contact || !invoice.Date && !invoice.DateString) {
        invoices.set(id, await knownInvoice(id));
      }
      const candidate = invoices.get(id);
      if (legacyInvoiceIds.has(id) && !snapshot.invoice.Contact.ContactID && !candidate.Contact?.EmailAddress) {
        if (!candidate.Contact?.ContactID) throw new EventInvoiceRecoveryError('invoice_purchaser_unavailable');
        const contact = single(await api(`Contacts/${encodeURIComponent(candidate.Contact.ContactID)}`), 'Contacts');
        if (contact.ContactID !== candidate.Contact.ContactID) throw new EventInvoiceRecoveryError('invoice_purchaser_unavailable');
        candidate.Contact = contact;
      }
    }
    return { invoices: [...invoices.values()], payments };
  })();
  return {
    async findInvoices() {
      if (discovery) return (await discover()).invoices;
      if (row.invoice_id) {
        // Durable ID outranks every mutable human-visible field, including the
        // invoice number. A missing/deleted known invoice NEVER permits create.
        return [await knownInvoice(row.invoice_id)];
      }
      if (row.payment_id) {
        durablePayment = await knownPayment();
        const id = durablePayment.Invoice?.InvoiceID;
        if (!id) throw new EventInvoiceRecoveryError('payment_without_invoice');
        return [await knownInvoice(id)];
      }
      // Xero cannot filter on line descriptions. Exhaust the bounded invoice-date
      // scope, including the old provider-unique number for pre-marker operations.
      // Incomplete/ambiguous pages stop recovery; absence after a started write
      // is NEVER permission to create again (enforced by the recovery journal).
      const date = snapshot.invoice.Date.replaceAll('-', ',');
      const where = `InvoiceNumber==${JSON.stringify(identity)}||(Type=="ACCREC"&&Date==DateTime(${date}))`;
      const invoices = await paginated(`Invoices?where=${encodeURIComponent(where)}`, 'Invoices');
      return invoices.filter(invoice => invoice.InvoiceNumber === identity || marked(invoice));
    },
    async findPayments() {
      if (discovery) return (await discover()).payments;
      if (row.payment_id) return [durablePayment || await knownPayment()];
      const data = await api(`Payments${query('Reference', paymentReference)}`);
      if (!Array.isArray(data?.Payments)) throw new EventInvoiceRecoveryError('payment_lookup_invalid', { retry: true });
      return data.Payments;
    },
    async createInvoice() {
      if (discovery && (await discover()).invoices.length) throw new EventInvoiceRecoveryError('invoice_creation_ambiguous');
      if (row.invoice_id || row.payment_id) {
        throw new EventInvoiceRecoveryError('invoice_creation_ambiguous');
      }
      return single(await api('Invoices', 'POST', {
        Invoices: [{ ...snapshot.invoice, LineItems: snapshot.invoice.LineItems.map((line, i) =>
          i === 0 ? { ...line, Description: String(line.Description || '') + marker } : { ...line }) }],
      }, `${identity}-invoice`), 'Invoices');
    },
    validateInvoice(invoice) {
      const legacy = legacyInvoiceIds.has(invoice?.InvoiceID);
      const knownId = row.invoice_id || durablePayment?.Invoice?.InvoiceID;
      if (!invoice?.InvoiceID || (knownId ? invoice.InvoiceID !== knownId
        : !legacy && invoice.InvoiceNumber !== identity && !marked(invoice))
        || invoice.Type !== 'ACCREC'
        || !(snapshot.paymentMethod === 'stripe' ? ['AUTHORISED', 'PAID']
          : [snapshot.invoice.Status, 'AUTHORISED', 'PAID']).includes(invoice.Status)
        || invoice.CurrencyCode !== snapshot.currency
        || Number(invoice.Total) !== snapshot.amount || !verifyRecoveryInvoiceFinancials(invoice, snapshot,
          { legacy, identity: marked(invoice) ? identity : null })
        || (snapshot.invoice.Contact.ContactID && invoice.Contact?.ContactID !== snapshot.invoice.Contact.ContactID)
        || (!snapshot.invoice.Contact.ContactID
          && (String(invoice.Contact?.Name || '').trim() !== snapshot.invoice.Contact.Name.trim()
            || (legacy && (!snapshot.contact?.email || String(invoice.Contact?.EmailAddress || '').trim().toLowerCase()
              !== snapshot.contact.email.trim().toLowerCase()))))) {
        throw new EventInvoiceRecoveryError('invoice_evidence_mismatch');
      }
    },
    async createPayment(invoice) {
      if (discovery && (await discover()).payments.length) throw new EventInvoiceRecoveryError('payment_creation_ambiguous');
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
      const legacyPayment = discovery && payment?.Reference === legacyPaymentReference;
      if (!payment?.PaymentID || (row.payment_id && payment.PaymentID !== row.payment_id)
        || (payment.Reference !== paymentReference
          && !legacyPayment)
        || payment.Invoice?.InvoiceID !== invoice.InvoiceID
        || Number(payment.Amount) !== snapshot.settlement.amount
        || payment.Status !== 'AUTHORISED'
        || payment.Account?.Code !== snapshot.settlement.accountCode
        || day(payment.Date) !== snapshot.settlement.paidAt.slice(0, 10)
        || (payment.Invoice?.CurrencyCode && payment.Invoice.CurrencyCode !== snapshot.currency)
        || (legacyPayment && (invoice.Status !== 'PAID'
          || Number(invoice.AmountPaid) !== snapshot.settlement.amount || Number(invoice.AmountDue) !== 0))) {
        throw new EventInvoiceRecoveryError('payment_evidence_mismatch');
      }
    },
  };
}