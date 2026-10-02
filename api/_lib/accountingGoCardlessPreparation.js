import { prepareAccountingRequestEnvelope } from './accountingRequestProviders.js';

const fail = code => { throw Object.assign(new Error(code), {
  code, permanent: true, definitelyNotWritten: true,
}); };
const text = value => typeof value === 'string' && value.trim().length > 0;
const clone = value => JSON.parse(JSON.stringify(value));
// Values are captured by the producer BEFORE enqueue, not reread from today's
// settings by the worker. Xero stores a code; only a bound account GET yields ID.
export async function resolveGoCardlessFrozenBank({ row, transport, currency }) {
  const setting = row.snapshot.payment?.bankSetting;
  const xero = row.provider === 'xero';
  const key = xero ? 'xero_gocardless_bank_account_code' : 'quickbooks_gocardless_bank_account_id';
  if (setting?.key !== key || !text(setting.value)) fail('GC_FROZEN_BANK_SETTING_REQUIRED');
  const value = setting.value.trim();
  const base = xero ? 'https://api.xero.com/api.xro/2.0'
    : `https://${row.snapshot.environment === 'sandbox' ? 'sandbox-' : ''}quickbooks.api.intuit.com/v3/company/${encodeURIComponent(row.company_id)}`;
  const url = xero ? `${base}/Accounts?where=${encodeURIComponent(`Code==${JSON.stringify(value)}`)}`
    : `${base}/account/${encodeURIComponent(value)}?minorversion=75`;
  const response = await transport.fetch(url);
  if (response.status === 429) throw Object.assign(new Error('GC_BANK_RATE_LIMITED'), {
    status: 429, retryAfter: response.headers.get('retry-after') || (!xero ? '60' : null),
    definitelyNotWritten: true,
  });
  if (!response.ok) fail('GC_BANK_LOOKUP_FAILED');
  const data = await response.json();
  const account = xero ? data.Accounts?.length === 1 && data.Accounts[0] : data.Account;
  if (xero ? !text(account?.AccountID) || account.Code !== value || account.Type !== 'BANK' || account.Status !== 'ACTIVE'
    : account?.Id !== value || account.Active !== true || account.AccountType !== 'Bank') fail('GC_BANK_ACCOUNT_INVALID');
  const accountCurrency = xero ? account.CurrencyCode : account.CurrencyRef?.value;
  if (accountCurrency && accountCurrency !== currency) fail('GC_BANK_CURRENCY_MISMATCH');
  return xero ? account.AccountID : account.Id;
}
function minor(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return NaN;
  const scaled = Number(value) * 100;
  return Number.isSafeInteger(Math.round(scaled)) && Math.abs(scaled - Math.round(scaled)) < 1e-7
    ? Math.round(scaled) : NaN;
}

// Existing invoices predate queue markers. Their authority is the immutable
// source link, exact customer/currency and a provider GET, never a search hit.
export function verifyGoCardlessExistingInvoice({ provider, existingInvoice, collection, record }) {
  const xero = provider === 'xero';
  if (!['xero', 'quickbooks'].includes(provider) || !text(existingInvoice?.id)
    || !text(existingInvoice.contactId) || existingInvoice.currency !== collection.currency
    || record?.[xero ? 'InvoiceID' : 'Id'] !== existingInvoice.id
    || (xero ? record?.Contact?.ContactID : record?.CustomerRef?.value) !== existingInvoice.contactId
    || (xero ? record?.CurrencyCode : record?.CurrencyRef?.value) !== collection.currency
    || (xero && (record.Type !== 'ACCREC' || record.Status !== 'AUTHORISED'))
    || record?.HasErrors || record?.ValidationErrors?.length
    || ['VOIDED', 'DELETED'].includes(record?.Status)) fail('GC_EXISTING_INVOICE_MISMATCH');
  const remaining = minor(xero ? record.AmountDue : record.Balance);
  const total = minor(xero ? record.Total : record.TotalAmt);
  if (!Number.isSafeInteger(collection.amountMinor) || collection.amountMinor <= 0
    || !Number.isSafeInteger(remaining) || remaining < collection.amountMinor
    || !Number.isSafeInteger(total) || total < remaining
    || (existingInvoice.requireExactRemaining === true && remaining !== collection.amountMinor)) {
    fail('GC_INVOICE_REMAINING_MISMATCH');
  }
  return { ...clone(existingInvoice), provider, invoiceId: existingInvoice.id,
    invoiceNumber: record.InvoiceNumber || record.DocNumber || null,
    verifiedRemainingMinor: remaining };
}

/**
 * Called only by adapter.prepare AFTER enqueue/claim.
 * Original snapshot:
 * {version:1, preparation:true, environment, invoice:{args}, existingInvoice?,
 *  payment:{collection:{amountMinor,currency,date,bankAccountId,reference}}, linkage}
 * existingInvoice is {id,contactId,currency,requireExactRemaining?}.
 * Returns the FULL resolved snapshot; core persists it as resolved_snapshot.
 * No source/catalogue lookups or combined payment helper replay are permitted.
 */
export async function prepareGoCardlessAccountingRequest({
  row, db, providers, transport: boundTransport,
  args: resolvedArgs, collection: resolvedCollection, existingInvoice: resolvedExistingInvoice,
}, dependencies = {}) {
  if (!text(row?.id) || !text(row.tenant_id) || !text(row.source_id)
    || row.source_type !== 'gocardless_payment' || row.snapshot?.preparation !== true
    || !providers?.preparationTransport || !providers?.assertBinding) fail('GC_DURABLE_PREPARATION_REQUIRED');
  if (row.resolved_snapshot) return clone(row.resolved_snapshot);
  const snapshot = clone(row.snapshot);
  if (resolvedCollection && ['amountMinor', 'currency', 'date', 'reference'].some(
    key => resolvedCollection[key] !== row.snapshot.payment?.collection?.[key])) fail('GC_COLLECTION_OVERRIDE_FORBIDDEN');
  if (resolvedExistingInvoice && resolvedExistingInvoice.id !== row.snapshot.existingInvoice?.id) fail('GC_INVOICE_OVERRIDE_FORBIDDEN');
  if (resolvedArgs) snapshot.invoice.args = clone(resolvedArgs);
  if (resolvedCollection) snapshot.payment.collection = clone(resolvedCollection);
  if (resolvedExistingInvoice) snapshot.existingInvoice = clone(resolvedExistingInvoice);
  const collection = snapshot.payment?.collection;
  if (!collection || !Number.isSafeInteger(collection.amountMinor) || collection.amountMinor <= 0
    || !/^[A-Z]{3}$/.test(collection.currency || '')
    || !/^\d{4}-\d{2}-\d{2}$/.test(collection.date || '')
    || !Number.isFinite(Date.parse(`${collection.date}T00:00:00Z`))
    || new Date(`${collection.date}T00:00:00Z`).toISOString().slice(0, 10) !== collection.date
    || !text(collection.reference)) fail('GC_COLLECTION_EVIDENCE_REQUIRED');
  await providers.assertBinding(row);
  const transport = boundTransport || ((!snapshot.existingInvoice || snapshot.payment.bankSetting
    || !text(row.snapshot.payment?.collection?.bankAccountId)) ? providers.preparationTransport(row) : null);
  if (snapshot.payment.bankSetting || !text(row.snapshot.payment?.collection?.bankAccountId)) {
    collection.bankAccountId = await resolveGoCardlessFrozenBank({ row, transport, currency: collection.currency });
  }
  if (!text(collection.bankAccountId)) fail('GC_FROZEN_BANK_SETTING_REQUIRED');
  const operationKey = `${row.tenant_id}:gocardless_payment:${row.source_id}:${row.operation || 'invoice'}`;
  let contactId, invoiceId;
  if (snapshot.existingInvoice) {
    const record = await providers.readExistingInvoice(row, snapshot.existingInvoice.id);
    // Historic local links contain the provider ID, not provider customer IDs.
    // Derive missing customer/currency ONLY from this bound exact-ID read.
    snapshot.existingInvoice.contactId ||= row.provider === 'xero' ? record.Contact?.ContactID : record.CustomerRef?.value;
    snapshot.existingInvoice.currency ||= row.provider === 'xero' ? record.CurrencyCode : record.CurrencyRef?.value;
    snapshot.existingInvoice = verifyGoCardlessExistingInvoice({
      provider: row.provider, existingInvoice: snapshot.existingInvoice, collection, record,
    });
    contactId = snapshot.existingInvoice.contactId;
    invoiceId = snapshot.existingInvoice.id;
  } else {
    const args = snapshot.invoice?.args;
    if (!args || args.appTenantId !== row.tenant_id || args.currency !== collection.currency
      || args.ddAccountingMigration || args.deferStripeSettlement || args.stripePaymentIntentId) {
      fail('GC_INVALID_FROZEN_MEMBERSHIP_INPUTS');
    }
    const prepare = dependencies.prepareMembership || (row.provider === 'xero'
      ? (await import('./xero.js')).createXeroMembershipInvoice
      : (await import('./quickbooks.js')).createQuickBooksMembershipInvoice);
    const tokenDependencies = transport.resolveConnection ? {
      getValidXeroAccessToken: async () => {
        const c = await transport.resolveConnection();
        return { accessToken: c.accessToken, tenantId: c.companyId };
      },
      getValidQuickBooksAccessToken: async () => {
        const c = await transport.resolveConnection();
        return { accessToken: c.accessToken, realmId: c.companyId, environment: c.environment };
      },
    } : {};
    const prepared = await prepare({ ...args, markAsPaid: true,
      transportTimeoutMs: transport.timeoutMs, deadlineAt: transport.deadlineAt,
      expectedProviderContext: row.provider === 'xero' ? { xero_tenant_id: row.company_id }
        : { quickbooks_realm_id: row.company_id, environment: snapshot.environment },
    }, {
      supabase: db, ...transport, ...tokenDependencies, prepareOnly: true,
    });
    if (prepared.companyId !== row.company_id
      || (row.provider === 'quickbooks' && prepared.environment !== snapshot.environment)) fail('GC_PREPARATION_BINDING_CHANGED');
    const payload = clone(prepared.payload);
    if (row.provider === 'xero') {
      payload.LineItems = payload.LineItems.map(line => ({ ...line, UnitAmount: Number(line.UnitAmount) }));
    }
    const fields = row.provider === 'xero'
      ? { Type: payload.Type, Status: payload.Status, LineItems: payload.LineItems }
      : { CustomerRef: payload.CustomerRef, GlobalTaxCalculation: payload.GlobalTaxCalculation, Line: payload.Line };
    contactId = prepared.contactId;
    invoiceId = '$invoice';
    snapshot.invoice.envelope = prepareAccountingRequestEnvelope({
      provider: row.provider, operationKey, environment: snapshot.environment,
      payload, expected: { contactId, currency: collection.currency, totalMinor: collection.amountMinor, fields },
    });
  }
  const amount = collection.amountMinor / 100;
  const payload = row.provider === 'xero' ? {
    Invoice: { InvoiceID: invoiceId }, Account: { AccountID: collection.bankAccountId },
    Amount: amount, Date: collection.date, Reference: collection.reference,
  } : {
    CustomerRef: { value: contactId }, CurrencyRef: { value: collection.currency },
    TotalAmt: amount, TxnDate: collection.date,
    DepositToAccountRef: { value: collection.bankAccountId },
    PrivateNote: collection.reference,
    Line: [{ Amount: amount, LinkedTxn: [{ TxnId: invoiceId, TxnType: 'Invoice' }] }],
  };
  snapshot.payment.envelope = prepareAccountingRequestEnvelope({
    provider: row.provider, operationKey, kind: 'payment', payload, environment: snapshot.environment,
    expected: { contactId, currency: collection.currency, totalMinor: collection.amountMinor,
      invoiceId, accountId: collection.bankAccountId, date: collection.date,
      // Xero Date responses use /Date(ms+0000)/, so date validation is normalized
      // at the provider boundary rather than compared as raw JSON.
      fields: row.provider === 'xero' ? { Amount: amount } : { TxnDate: collection.date, Line: payload.Line } },
  });
  snapshot.preparation = false;
  return snapshot;
}