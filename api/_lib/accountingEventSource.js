import { prepareAccountingRequestEnvelope } from './accountingRequestProviders.js';
import { capturedEventSettlement } from './eventInvoiceProducer.js';
import { accountingOperationIdentity } from './accountingOperationIdentity.js';

export const isAccountingEventSource = source => ['booking', 'complex_event_booking'].includes(source);
const fail = (code, retry = false) => { throw Object.assign(new Error(code), { code, retry, permanent: !retry }); };
const minor = value => Math.round(Number(value) * 100);
const settingsKeys = ['quickbooks_event_item_id', 'quickbooks_event_tax_code_id', 'quickbooks_event_stripe_bank_account_id'];

async function rpc(db, name, args) {
  let query = db.rpc(`accounting_event_${name}`, args);
  if (typeof query.abortSignal === 'function') query = query.abortSignal(AbortSignal.timeout(5000));
  const { data, error } = await query;
  if (error) fail('ACCOUNTING_EVENT_PERSISTENCE_UNAVAILABLE', true);
  return data;
}

/** Capture only new checkout evidence; never load prices or infer historical invoices. */
export async function enqueueQuickBooksEventInvoice(input, context) {
  const { db, tenantId, source, bookingGroupReference, event, contact, buildLines, now } = input;
  const currency = String(input.currency || '').toUpperCase();
  const paymentMethod = input.paymentMethod === 'card' ? 'stripe' : 'invoice';
  const snapshot = {
    version: 1, preparation: true, environment: context.provider.environment,
    invoice: {
      amount: Number(input.amount), currency, paymentMethod, contact: structuredClone(contact),
      capturedAt: now.toISOString(), eventId: event.id, eventTitle: event.title || 'Event',
      date: now.toISOString().slice(0, 10),
      dueDate: new Date(now.getTime() + 30 * 86400000).toISOString().slice(0, 10),
      reference: input.poToFollow ? 'TBC' : (input.purchaseOrderNumber || 'TBC'),
      settings: Object.fromEntries(settingsKeys.map(key => [key, context.settings[key] || null])),
      // A QBO item is not a Xero ledger code. Preserve financial lines but do
      // not reinterpret the event's Xero account setting as an ItemRef.
      lines: buildLines('__quickbooks_event_item__'),
    },
    payment: paymentMethod === 'stripe' ? { pending: true } : null,
    linkage: { source, group: bookingGroupReference, eventId: event.id },
  };
  if (!['card', 'account', 'invoice'].includes(input.paymentMethod)) snapshot.invoice.reviewReason = 'unsupported_payment_method';
  if (paymentMethod === 'stripe') {
    try {
      snapshot.payment = capturedEventSettlement({
        paymentIntent: input.paymentIntent, paymentIntentId: input.paymentIntentId,
        amount: snapshot.invoice.amount, currency, accountCode: 'pending_event_mapping', eventId: event.id,
      });
    } catch { snapshot.invoice.reviewReason = 'original_stripe_evidence_required'; }
  }
  const row = await rpc(db, 'capture', {
    p_tenant: tenantId, p_source: source, p_group: bookingGroupReference,
    p_connection: context.provider.connectionId, p_company: context.provider.realmId, p_snapshot: snapshot,
  });
  if (!row?.id) fail('ACCOUNTING_EVENT_CAPTURE_NOT_CONFIRMED', true);
  return { status: row.state === 'complete' ? 'complete' : row.state === 'review' ? 'needs_review' : 'pending', queued: true };
}

export async function assertAccountingEventSource({ db, row }) {
  if (!isAccountingEventSource(row.source_type) || row.provider !== 'quickbooks') fail('ACCOUNTING_EVENT_SOURCE_INVALID');
  if (await rpc(db, 'guard', { p_id: row.id, p_token: row.lease_token }) !== true) fail('ACCOUNTING_EVENT_SOURCE_CHANGED');
}

export async function linkAccountingEventSource({ db, row }) {
  const result = await rpc(db, 'link', { p_id: row.id, p_token: row.lease_token });
  if (result?.linked !== true) fail('ACCOUNTING_EVENT_LINK_NOT_CONFIRMED', true);
  return result;
}

export async function reconcileQuickBooksEventInvoices({ db, deadlineAt = Date.now() + 20000, process } = {}) {
  const ids = await rpc(db, 'due', {});
  if (!Array.isArray(ids)) fail('ACCOUNTING_EVENT_DUE_UNAVAILABLE', true);
  const run = process || (await import('./accountingRequestQueue.js')).processAccountingRequest;
  for (const requestId of ids) {
    if (Date.now() >= deadlineAt - 5000) break;
    await run({ db, requestId, deadlineAt });
  }
}

/** Preparation is bounded by the shared queue fence, company and cooldown. */
export async function prepareAccountingEventSource({ db, row, transport }) {
  const snapshot = structuredClone(row.snapshot);
  const intent = snapshot.invoice;
  if (snapshot.preparation !== true || row.provider !== 'quickbooks' || intent.reviewReason
    || !intent.contact?.name || !intent.contact?.provenance
    || !Number.isFinite(intent.amount) || intent.amount <= 0 || !/^[A-Z]{3}$/.test(intent.currency)
    || !Array.isArray(intent.lines) || !intent.lines.length
    || !['invoice', 'stripe'].includes(intent.paymentMethod)) fail('ACCOUNTING_EVENT_ORIGINAL_EVIDENCE_REQUIRED');
  const settings = { ...intent.settings };
  // Missing mappings may be supplied by an administrator. Nonempty original
  // values are never replaced; the resolved envelope is immutable once saved.
  if (!settings.quickbooks_event_item_id || !settings.quickbooks_event_tax_code_id
    || (snapshot.payment && !settings.quickbooks_event_stripe_bank_account_id)) {
    const { data, error } = await db.from('system_settings').select('setting_key,setting_value')
      .eq('tenant_id', row.tenant_id).in('setting_key', settingsKeys);
    if (error) fail('ACCOUNTING_EVENT_MAPPING_UNAVAILABLE', true);
    for (const entry of data || []) if (!settings[entry.setting_key]) settings[entry.setting_key] = entry.setting_value;
  }
  if (!settings.quickbooks_event_item_id
    || (snapshot.payment && !settings.quickbooks_event_stripe_bank_account_id)) fail('ACCOUNTING_EVENT_MAPPING_REQUIRED', true);
  const base = `https://${snapshot.environment === 'sandbox' ? 'sandbox-' : ''}quickbooks.api.intuit.com/v3/company/${encodeURIComponent(row.company_id)}`;
  const request = async (path, payload = null) => {
    const response = await transport.fetch(`${base}/${path}`, {
      method: payload ? 'POST' : 'GET', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    if (!response.ok) fail('ACCOUNTING_EVENT_PREPARATION_FAILED', response.status >= 500);
    const result = await response.json();
    if (result.Fault) fail('ACCOUNTING_EVENT_PREPARATION_REJECTED');
    return result;
  };
  const read = async (kind, id) => {
    const record = (await request(`${kind.toLowerCase()}/${encodeURIComponent(id)}`))[kind];
    if (!record || String(record.Id) !== String(id) || record.Active === false) fail('ACCOUNTING_EVENT_MAPPING_INVALID');
    return record;
  };
  const item = await read('Item', settings.quickbooks_event_item_id);
  if (!['Service', 'NonInventory', 'Inventory'].includes(item.Type)) fail('ACCOUNTING_EVENT_ITEM_INVALID');
  const policies = [...new Set(intent.lines.map(line => line._invoiceLineAmountType).filter(Boolean))];
  if (policies.length !== 1 || !['Exclusive', 'Inclusive'].includes(policies[0])) fail('ACCOUNTING_EVENT_TAX_POLICY_REQUIRED');
  const inclusive = policies[0] === 'Inclusive';
  const rates = new Map();
  const lines = [];
  let totalMinor = 0;
  for (const line of intent.lines) {
    // Ticket TaxType is a Xero identifier, not a QuickBooks TaxCode ID.
    // Only the explicit QBO mapping may select a provider tax code.
    const taxId = settings.quickbooks_event_tax_code_id;
    if (!taxId) fail('ACCOUNTING_EVENT_TAX_MAPPING_REQUIRED', true);
    if (!rates.has(taxId)) {
      const tax = await read('TaxCode', taxId);
      const details = tax.SalesTaxRateList?.TaxRateDetail;
      if (tax.Taxable === false && (!details || details.length === 0)) {
        rates.set(taxId, 0);
      } else {
      if (!Array.isArray(details) || details.length !== 1 || details[0].TaxTypeApplicable === 'TaxOnTax') {
        fail('ACCOUNTING_EVENT_TAX_RATE_REQUIRES_REVIEW');
      }
      const rate = await read('TaxRate', details[0].TaxRateRef?.value);
      if (!Number.isFinite(Number(rate.RateValue)) || Number(rate.RateValue) < 0) fail('ACCOUNTING_EVENT_TAX_RATE_INVALID');
      rates.set(taxId, Number(rate.RateValue));
      }
    }
    if (!Number.isFinite(line.Quantity) || line.Quantity <= 0 || !Number.isFinite(line.UnitAmount)
      || Number(line.DiscountRate || 0) !== 0 || line.DiscountAmount != null) fail('ACCOUNTING_EVENT_LINE_REQUIRES_REVIEW');
    const amountMinor = minor(line.Quantity * line.UnitAmount);
    const rate = rates.get(taxId);
    if (line._checkoutTaxPercentage != null && rate !== line._checkoutTaxPercentage) {
      fail('ACCOUNTING_EVENT_TAX_RATE_UNMAPPED');
    }
    if (line.TaxType && line._checkoutTaxPercentage == null && line.TaxAmount == null) {
      fail('ACCOUNTING_EVENT_ORIGINAL_TAX_EVIDENCE_REQUIRED');
    }
    const taxMinor = Math.round(amountMinor * rate / (inclusive ? 100 + rate : 100));
    if (line.TaxAmount != null && minor(line.TaxAmount) !== taxMinor) fail('ACCOUNTING_EVENT_TAX_EVIDENCE_CHANGED');
    totalMinor += amountMinor + (inclusive ? 0 : taxMinor);
    lines.push({ DetailType: 'SalesItemLineDetail', Description: line.Description, Amount: amountMinor / 100,
      SalesItemLineDetail: { ItemRef: { value: String(item.Id) }, Qty: line.Quantity,
        UnitPrice: line.UnitAmount, TaxCodeRef: { value: String(taxId) } } });
  }
  if (totalMinor !== minor(intent.amount)) fail('ACCOUNTING_EVENT_CHECKOUT_TOTAL_MISMATCH');
  let account;
  if (snapshot.payment) {
    const p = snapshot.payment;
    if (p.status !== 'succeeded' || p.livemode !== true || p.amount !== intent.amount || p.currency !== intent.currency
      || !/^pi_[A-Za-z0-9]+$/.test(p.paymentIntentId || '') || !Number.isFinite(Date.parse(p.paidAt))) {
      fail('ACCOUNTING_EVENT_SETTLEMENT_AUTHORITY_REQUIRED');
    }
    if (snapshot.environment !== 'production') fail('ACCOUNTING_EVENT_LIVE_SETTLEMENT_SANDBOX_FORBIDDEN');
    account = await read('Account', settings.quickbooks_event_stripe_bank_account_id);
    if (!['Bank', 'Other Current Asset'].includes(account.AccountType)
      || (account.CurrencyRef?.value && account.CurrencyRef.value !== intent.currency)) fail('ACCOUNTING_EVENT_DEPOSIT_ACCOUNT_INVALID');
  }
  // Exact purchaser lookup; never choose the first attendee or silently update
  // an unrelated same-name customer. A deterministic customer request ID covers
  // a lost create response; invoice/payment writes are not permitted here.
  const escaped = intent.contact.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const customers = (await request(`query?query=${encodeURIComponent(`SELECT * FROM Customer WHERE DisplayName = '${escaped}' MAXRESULTS 2`)}`))
    .QueryResponse?.Customer || [];
  if (!Array.isArray(customers) || customers.length > 1) fail('ACCOUNTING_EVENT_PURCHASER_AMBIGUOUS');
  let customer = customers[0];
  if (customer && (!intent.contact.email || String(customer.PrimaryEmailAddr?.Address || '').toLowerCase() !== intent.contact.email.toLowerCase())) {
    fail('ACCOUNTING_EVENT_PURCHASER_MISMATCH');
  }
  if (!customer) {
    if (!intent.contact.email) fail('ACCOUNTING_EVENT_PURCHASER_EMAIL_REQUIRED');
    const key = accountingOperationIdentity(`${row.tenant_id}:${row.source_type}:${row.source_id}`, 'cust', 50);
    customer = (await request(`customer?requestid=${encodeURIComponent(key)}`, {
      DisplayName: intent.contact.name, PrimaryEmailAddr: { Address: intent.contact.email },
    })).Customer;
  }
  if (!customer?.Id || customer.Active === false
    || (customer.CurrencyRef?.value && customer.CurrencyRef.value !== intent.currency)) fail('ACCOUNTING_EVENT_CUSTOMER_INVALID');
  const payload = { CustomerRef: { value: String(customer.Id) }, CurrencyRef: { value: intent.currency },
    TxnDate: intent.date, DueDate: intent.dueDate, CustomerMemo: { value: intent.reference },
    GlobalTaxCalculation: inclusive ? 'TaxInclusive' : 'TaxExcluded', Line: lines };
  const operationKey = `${row.tenant_id}:${row.source_type}:${row.source_id}`;
  snapshot.invoice = { envelope: prepareAccountingRequestEnvelope({
    provider: row.provider, environment: snapshot.environment, operationKey,
    payload, expected: { contactId: String(customer.Id), currency: intent.currency, totalMinor,
      fields: { TxnDate: payload.TxnDate, DueDate: payload.DueDate, GlobalTaxCalculation: payload.GlobalTaxCalculation, Line: lines } },
  }) };
  if (snapshot.payment) {
    const date = snapshot.payment.paidAt.slice(0, 10);
    const payment = { CustomerRef: payload.CustomerRef, CurrencyRef: payload.CurrencyRef,
      DepositToAccountRef: { value: String(account.Id) }, TxnDate: date, TotalAmt: intent.amount,
      Line: [{ Amount: intent.amount, LinkedTxn: [{ TxnId: '$invoice', TxnType: 'Invoice' }] }] };
    snapshot.payment = { envelope: prepareAccountingRequestEnvelope({
      provider: row.provider, environment: snapshot.environment, operationKey, kind: 'payment', payload: payment,
      expected: { contactId: String(customer.Id), currency: intent.currency, totalMinor,
        invoiceId: '$invoice', accountId: String(account.Id), date,
        fields: { TxnDate: date, DepositToAccountRef: payment.DepositToAccountRef } },
    }) };
  }
  snapshot.resolvedEventMappings = settings;
  delete snapshot.preparation;
  return snapshot;
}
