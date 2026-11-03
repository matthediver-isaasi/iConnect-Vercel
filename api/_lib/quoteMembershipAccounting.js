// Accounting-only continuation for saved, paid member quotes. Never collects
// money, activates membership, sends mail, or infers terms from current prices.
import { enqueueAccountingRequest, processAccountingRequest } from './accountingRequestQueue.js';
import { resolveAccountingQueueBinding } from './accountingQueueIntegration.js';
import { freezeMembershipPreparation, prepareMembershipSourceRequest } from './accountingSourcePreparation.js';
import { prepareAccountingRequestEnvelope } from './accountingRequestProviders.js';
import { loadFormMembershipPaymentQuote } from './formMembershipPaymentQuote.js';
import { resolveMembershipNominalCode } from './membershipNominalCode.js';
import { stripeInvoiceAddressFromSnapshot } from './stripeInvoiceAddress.js';

export const QUOTE_ACCOUNTING_SOURCE = 'stripe_member_quote';
const fail = code => { throw Object.assign(new Error(code), { code, permanent: true, definitelyNotWritten: true }); };
async function one(query) {
  const { data, error } = await query.maybeSingle();
  if (error || !data) fail('QUOTE_ACCOUNTING_EVIDENCE_UNAVAILABLE');
  return data;
}
export function verifyQuotePayment(history, pi) {
  if (pi?.status !== 'succeeded' || pi.livemode !== true
    || pi.metadata?.source !== 'form-membership-payment'
    || pi.metadata.organization_id || history.billing_agreement_id
    || history.payment_status !== 'paid' || history.status === 'expired_checkout'
    || history.member_id !== pi.metadata.member_id || history.tenant_id !== pi.metadata.tenant_id
    || history.membership_payment_quote_id !== pi.metadata.membership_quote_id
    || history.stripe_payment_intent_id !== pi.id
    || !Number.isSafeInteger(pi.amount_received) || pi.amount_received <= 0
    || Math.round(Number(history.total_with_vat) * 100) !== pi.amount_received
    || history.currency?.toLowerCase() !== pi.currency) fail('QUOTE_ACCOUNTING_PAYMENT_MISMATCH');
}
export async function assertQuoteAccountingSource({ db, row }) {
  const h = await one(db.from('member_membership_history').select('*')
    .eq('tenant_id', row.tenant_id).eq('id', row.source_id));
  verifyQuotePayment(h, row.snapshot.evidence.payment);
  const quote = await one(db.from('membership_payment_quote').select('id,stripe_payment_intent_id')
    .eq('tenant_id', row.tenant_id).eq('member_id', h.member_id).eq('id', h.membership_payment_quote_id));
  if (quote.stripe_payment_intent_id !== h.stripe_payment_intent_id
    || row.provider !== 'xero'
    || [h.accounting_invoice_id, h.xero_invoice_id].some(id => id && id !== row.invoice_result?.id)) {
    fail('QUOTE_ACCOUNTING_AUTHORITY_CHANGED');
  }
  return h;
}
export async function enqueueQuoteAccounting({ db, history, paymentIntent: pi, stripe }, { enqueue = enqueueAccountingRequest } = {}) {
  verifyQuotePayment(history, pi);
  const { data: existing, error } = await db.from('accounting_request_queue').select('*')
    .eq('tenant_id', history.tenant_id).eq('source_type', QUOTE_ACCOUNTING_SOURCE)
    .eq('source_id', history.id).eq('operation', 'invoice').maybeSingle();
  if (error) throw error;
  if (existing) {
    await assertQuoteAccountingSource({ db, row: existing });
    return existing;
  }
  if (history.accounting_invoice_id || history.xero_invoice_id) fail('QUOTE_ACCOUNTING_ALREADY_LINKED');
  const saved = await loadFormMembershipPaymentQuote(db, pi);
  const sim = saved?.simResult;
  if (!sim?.success || saved.organizationId
    || Math.round(Number(sim.totalWithVat ?? sim.finalCost) * 100) !== pi.amount_received
    || (sim.currency || 'GBP').toLowerCase() !== pi.currency) fail('QUOTE_ACCOUNTING_SAVED_TOTAL_MISMATCH');
  const member = await one(db.from('member').select('id,first_name,last_name,email')
    .eq('tenant_id', history.tenant_id).eq('id', history.member_id));
  if (!member.email || (member.first_name === 'Deleted' && member.last_name === 'Member')) fail('QUOTE_ACCOUNTING_MEMBER_UNAVAILABLE');
  const name = [member.first_name, member.last_name].filter(Boolean).join(' ').trim();
  if (sim.member?.id !== member.id
    || sim.member.email?.trim().toLowerCase() !== member.email.trim().toLowerCase()
    || sim.member.name?.trim() !== name) fail('QUOTE_ACCOUNTING_PURCHASER_CHANGED_REVIEW_REQUIRED');
  const binding = await resolveAccountingQueueBinding({ db, tenantId: history.tenant_id, provider: 'xero' });
  // Read captured charge evidence without refreshing a Stripe Customer or any
  // other provider object. This continuation is accounting-only.
  const chargeId = typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge?.id;
  if (!chargeId) fail('QUOTE_ACCOUNTING_CHARGE_REQUIRED');
  const charge = await stripe.charges.retrieve(chargeId);
  const chargePayment = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
  if (chargePayment !== pi.id || charge.paid !== true || charge.amount_refunded
    || charge.amount_captured !== pi.amount_received || charge.currency !== pi.currency
    || !Number.isInteger(charge.created)) fail('QUOTE_ACCOUNTING_CAPTURE_MISMATCH');
  const address = charge.billing_details?.address;
  let vatRate = sim.taxType || sim.matchedBand?.vat_rate || null;
  // Legacy zero-tax purchases can lack a provider code. Use the schedule's
  // explicit provider mapping only as a candidate; preparation verifies its
  // actual rate against the captured total before any invoice can be written.
  if (!vatRate && Math.round(Number(sim.finalCost) * 100) === pi.amount_received && history.config_id) {
    const config = await one(db.from('membership_tier_config').select('flat_vat_rate')
      .eq('tenant_id', history.tenant_id).eq('id', history.config_id));
    vatRate = config.flat_vat_rate;
  }
  if (!vatRate) fail('QUOTE_ACCOUNTING_EXPLICIT_TAX_CODE_REQUIRED');
  const args = {
    appTenantId: history.tenant_id, organizationName: name,
    invoicingEmail: member.email, invoicingAddress: stripeInvoiceAddressFromSnapshot(address),
    membershipYear: pi.metadata.membership_year, tierLabel: sim.tierLabel,
    finalCost: sim.finalCost, currency: (sim.currency || 'GBP').toUpperCase(),
    reference: `Membership ${pi.metadata.membership_year}`,
    vatRate,
    nominalCode: await resolveMembershipNominalCode(db, history.tenant_id, sim),
    xeroProjectCode: sim.xeroProjectCode || null, invoiceDescription: sim.config?.invoice_description || null,
  };
  const invoice = await freezeMembershipPreparation({ db, args, totalMinor: pi.amount_received });
  // Paid invoices must be authorised before their existing Stripe receipt is allocated.
  invoice.settings.xero_invoice_status = 'AUTHORISED';
  const bank = await one(db.from('system_settings').select('setting_value')
    .eq('tenant_id', history.tenant_id).eq('setting_key', 'xero_stripe_bank_account_code'));
  if (!bank.setting_value) fail('QUOTE_ACCOUNTING_STRIPE_BANK_REQUIRED');
  const payment = { id: pi.id, status: pi.status, livemode: pi.livemode, amount_received: pi.amount_received,
    currency: pi.currency, metadata: { source: pi.metadata.source, member_id: pi.metadata.member_id,
      tenant_id: pi.metadata.tenant_id, membership_quote_id: pi.metadata.membership_quote_id } };
  return enqueue({ db, tenantId: history.tenant_id, provider: 'xero',
    connectionId: binding.connectionId, companyId: binding.companyId, sourceType: QUOTE_ACCOUNTING_SOURCE,
    sourceId: history.id, snapshot: { version: 1, preparation: true, environment: null, invoice,
      payment: { bankCode: bank.setting_value, date: new Date(charge.created * 1000).toISOString().slice(0, 10) },
      linkage: { recordId: history.id, ownerId: history.member_id }, evidence: { payment } } });
}
export async function prepareQuoteAccounting({ db, row, transport }, dependencies = {}) {
  await assertQuoteAccountingSource({ db, row });
  const prepared = await (dependencies.prepare || prepareMembershipSourceRequest)({ row, transport });
  const envelope = prepared.invoice.envelope;
  const get = async path => {
    const response = await transport.fetch(`https://api.xero.com/api.xro/2.0/${path}`);
    if (!response.ok) throw new Error('QUOTE_ACCOUNTING_PROVIDER_READ_FAILED');
    return response.json();
  };
  const rates = (await get('TaxRates')).TaxRates;
  const lines = envelope.payload?.LineItems;
  if (!Array.isArray(rates) || !Array.isArray(lines) || lines.length !== 1) fail('QUOTE_ACCOUNTING_TAX_UNVERIFIED');
  const rate = rates.find(r => r.TaxType === lines[0].TaxType && r.Status === 'ACTIVE');
  const effectiveRate = Number(rate?.EffectiveRate);
  if (!rate || rate.EffectiveRate == null || !Number.isFinite(effectiveRate) || rate.CanApplyToRevenue === false
    || Math.round(Number(lines[0].UnitAmount) * Number(lines[0].Quantity) * (1 + effectiveRate / 100) * 100)
      !== envelope.expected.totalMinor) fail('QUOTE_ACCOUNTING_PURCHASED_TAX_MISMATCH');
  // Legacy browser writes may have succeeded without local linkage. Never
  // infer that absence of a local invoice means permission to create another.
  for (let page = 1; page <= 100; page++) {
    const where = `Contact.ContactID==Guid("${envelope.expected.contactId}")`;
    const data = await get(`Invoices?page=${page}&where=${encodeURIComponent(where)}`);
    if (!Array.isArray(data.Invoices)) fail('QUOTE_ACCOUNTING_INVOICE_DISCOVERY_INCOMPLETE');
    if (data.Invoices.some(i => !['VOIDED', 'DELETED'].includes(i.Status)
      && i.CurrencyCode === envelope.expected.currency
      && Math.round(Number(i.Total) * 100) === envelope.expected.totalMinor
      && (!i.DateString || String(i.DateString).slice(0, 10) >= row.snapshot.payment.date))) {
      fail('QUOTE_ACCOUNTING_EXISTING_INVOICE_REQUIRES_REVIEW');
    }
    if (data.Invoices.length < 100) break;
    if (page === 100) fail('QUOTE_ACCOUNTING_INVOICE_DISCOVERY_INCOMPLETE');
  }
  const where = `Code==${JSON.stringify(String(row.snapshot.payment.bankCode))}`;
  const accounts = (await get(`Accounts?where=${encodeURIComponent(where)}`)).Accounts;
  const bank = accounts?.length === 1 && accounts[0];
  if (!bank?.AccountID || bank.Type !== 'BANK' || bank.Status !== 'ACTIVE'
    || (bank.CurrencyCode && bank.CurrencyCode !== envelope.expected.currency)) fail('QUOTE_ACCOUNTING_BANK_INVALID');
  const amount = envelope.expected.totalMinor / 100;
  prepared.payment = { envelope: prepareAccountingRequestEnvelope({
    provider: 'xero', kind: 'payment', operationKey: `${row.tenant_id}:${QUOTE_ACCOUNTING_SOURCE}:${row.source_id}:payment`,
    payload: { Invoice: { InvoiceID: '$invoice' }, Account: { AccountID: bank.AccountID },
      Amount: amount, Date: row.snapshot.payment.date, Reference: `Stripe ${row.snapshot.evidence.payment.id}` },
    expected: { contactId: envelope.expected.contactId, currency: envelope.expected.currency,
      totalMinor: envelope.expected.totalMinor, invoiceId: '$invoice', accountId: bank.AccountID,
      fields: { Amount: amount, Account: { AccountID: bank.AccountID } } },
  }) };
  return prepared;
}
export async function linkQuoteAccounting({ db, row }) {
  const history = await assertQuoteAccountingSource({ db, row });
  if (!row.invoice_result?.id || !row.invoice_result.invoiceNumber
    || row.payment_status !== 'done' || !row.payment_result?.id || row.payment_result?.payment_recorded !== true) {
    fail('QUOTE_ACCOUNTING_SETTLEMENT_UNVERIFIED');
  }
  const patch = { accounting_provider: 'xero', accounting_invoice_id: row.invoice_result.id,
    xero_invoice_id: row.invoice_result.id, accounting_invoice_number: row.invoice_result.invoiceNumber,
    xero_invoice_number: row.invoice_result.invoiceNumber, accounting_sync_status: null, accounting_sync_error: null };
  let update = db.from('member_membership_history').update(patch).eq('tenant_id', row.tenant_id)
    .eq('id', history.id).eq('stripe_payment_intent_id', history.stripe_payment_intent_id);
  update = history.accounting_invoice_id ? update.eq('accounting_invoice_id', history.accounting_invoice_id)
    : update.is('accounting_invoice_id', null);
  const { data, error } = await update.select('id');
  if (error || data?.length !== 1) fail('QUOTE_ACCOUNTING_LINK_FAILED');
  return { linked: true, invoiceId: row.invoice_result.id };
}
export async function sweepQuoteAccounting(db, { deadlineAt = Date.now() + 15000 } = {}) {
  const candidates = (columns, options) => db.from('member_membership_history').select(columns, options)
    .eq('payment_status', 'paid').not('membership_payment_quote_id', 'is', null)
    .is('billing_agreement_id', null)
    .is('accounting_invoice_id', null).is('xero_invoice_id', null)
    .not('stripe_payment_intent_id', 'is', null);
  const counted = await candidates('id', { count: 'exact', head: true });
  if (counted.error || !Number.isSafeInteger(counted.count)) throw new Error('QUOTE_ACCOUNTING_DISCOVERY_UNAVAILABLE');
  if (!counted.count) return [];
  // Rotate the first candidate independently of successful processing. An old
  // blocked/slow record must not permanently starve later paid memberships.
  const offset = Math.floor(Date.now() / 60000) % counted.count;
  const { data, error } = await candidates('*').order('id').range(offset, offset + 19);
  if (error) throw error;
  const results = [];
  for (const history of data || []) {
    if (Date.now() >= deadlineAt) break;
    try {
      const { retrieveTenantPaymentIntent } = await import('./stripeCredentials.js');
      const verified = await retrieveTenantPaymentIntent(history.tenant_id, 'membership', history.stripe_payment_intent_id);
      const queued = await enqueueQuoteAccounting({ db, history, ...verified });
      const result = await processAccountingRequest({ db, requestId: queued.id, deadlineAt });
      results.push({ id: history.id, state: result?.state || queued.state });
    } catch (error) {
      results.push({ id: history.id, error: error.code || 'QUOTE_ACCOUNTING_RECOVERY_FAILED' });
    }
  }
  return results;
}
