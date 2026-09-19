import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as policy from '../../_lib/annualRenewalPolicy.js';
import { recordSucceededMembershipPaymentIntent } from '../../_lib/membershipPaymentReconciliation.js';

// Evaluate the actual handler with all imported effects supplied explicitly.
// No configured DB, Stripe account, accounting system or mailer is reachable.
const source = readFileSync(new URL('./[token].js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?$/gm, '')
  .replace(/export default async function handler/, 'async function handler')
  .replace(/export function /g, 'function ')
  .replace(/import\(([^)]+)\)/g, 'deps($1)');
const load = new Function('createClient', 'resolveEntityAnnualRenewalEligibility', 'resolveMemberFeeApproval',
  'feeTokenCommitment', 'simulationFromFeeCommitment', 'reserveRollingFeePayment', 'reserveRollingMonthlyHistory', 'deps',
  `${source}\nreturn {handler, simulationFromRenewalQuote, renewalQuoteActivationFields};`);

function setup(member, rolling = false) {
  const owner = member ? { member_id: 'owner' } : { organization_id: 'owner' };
  const token = {
    id: 'fee', token: 'bearer', tenant_id: 'tenant', ...owner, membership_year: '2099',
    expires_at: '2100-01-01', status: 'pending', currency: 'GBP', final_cost: 120,
    cost_breakdown: { totalWithVat: 144, vatAmount: 24, annualCost: 120,
      renewalQuote: { config: { id: 'config', billing_period: 'annual', online_card_payment: true },
        membershipYear: { label: '2099', start: '2099-01-01', end: '2099-12-31' },
        previousTerm: { term_start_date: '2098-01-01', term_end_date: '2098-12-31' } } },
  };
  const historyTable = member ? 'member_membership_history' : 'organisation_membership_history';
  const tables = {
    membership_fee_token: [token], [historyTable]: [],
    member: [{ id: 'owner', first_name: 'Test', tenant_id: 'tenant' }],
    organization: [{ id: 'owner', name: 'Test' }], tenant: [{ id: 'tenant', name: 'Tenant' }],
  };
  const db = { from(table) {
    let mode = 'select', payload, single = false;
    const filters = [];
    const q = {
      select() { return q; }, eq(k,v) { filters.push(r => r[k] === v); return q; },
      neq(k,v) { filters.push(r => r[k] !== v); return q; }, or() { return q; },
      in(k,v) { filters.push(r => v.includes(r[k])); return q; },
      order() { return q; }, limit() { return q; },
      update(v) { mode = 'update'; payload = v; return q; },
      insert(v) { mode = 'insert'; payload = v; return q; },
      maybeSingle() { single = true; return q; }, single() { single = true; return q; },
      then(resolve, reject) { return Promise.resolve().then(() => {
        const rows = tables[table] ||= [];
        let selected = rows.filter(r => filters.every(f => f(r)));
        if (mode === 'insert') { const row = { id: `row-${rows.length}`, ...payload }; rows.push(row); selected = [row]; }
        if (mode === 'update') selected.forEach(r => Object.assign(r, payload));
        return { data: single ? selected[0] || null : selected, error: null };
      }).then(resolve, reject); },
    };
    return q;
  }};
  const calls = [];
  const intent = { id: 'pi_test', client_secret: 'fixture', status: 'succeeded', amount: 14400,
    currency: 'gbp', metadata: { token_id: 'fee', tenant_id: 'tenant', ...owner } };
  let eligibility = { eligible: true, lifecycle: { termStart: '2099-01-01', termEnd: '2099-12-31', isEarly: true } };
  const deps = async name => {
    if (name.endsWith('membershipSimulation.js')) return {
      simulateMembershipForMember() { throw new Error('Quote must not be recalculated'); },
      simulateMembershipForOrg() { throw new Error('Quote must not be recalculated'); },
    };
    if (name.endsWith('stripeCredentials.js')) return {
      getStripeCredentials: async () => ({ secret_key: 'fixture', is_enabled: true, publishable_key: 'fixture' }),
      retrieveTenantPaymentIntent: async () => ({ paymentIntent: intent, stripe: {} }),
      findOrCreateStripeCustomer: async () => null,
    };
    if (name === 'stripe') return { default: class {
      paymentIntents = { create: async (args, options) => { calls.push({ args, options }); return intent; } };
    }};
    if (name.endsWith('monthly-card.js')) return { annualPaymentBlockedByOpenPlan: async () => null, findOpenAgreementForYear: async () => null };
    if (name.endsWith('annualRenewalPolicy.js')) return { ...policy, hasActiveMonthlyBillingAgreement: async () => false };
    if (name.endsWith('gocardlessCredentials.js')) return { getGocardlessCredentials: async () => null };
    if (name.endsWith('membershipInstalmentInvoicing.js')) return { annualInvoiceSuppressionDecision: async () => ({ suppress: false }) };
    if (name.endsWith('invoiceAddressResolver.js')) return { resolveInvoiceAddress: async () => null };
    if (name.endsWith('membershipAddons.js')) return { buildExtraLineItems: () => [] };
    if (name.endsWith('membershipNominalCode.js')) return { resolveMembershipNominalCode: async () => null };
    if (name.endsWith('accountingProvider.js')) return {
      getAccountingProvider: async () => ({
        name: 'xero', applyStripePaymentToInvoice: async () => { calls.push({ invoice: 'existing' }); return { invoice_id: 'invoice', invoice_number: 'INV-1' }; },
        createMembershipInvoice: async () => { throw new Error('Fixture accounting unavailable'); },
      }), buildInvoiceColumnUpdate: () => ({ xero_invoice_id: 'invoice' }),
    };
    if (name.endsWith('formMembershipPaymentQuote.js')) return { formPaymentActivationFields: () => ({ status: 'scheduled', term_start_date: '2099-01-01', term_end_date: '2099-12-31' }) };
    if (name.endsWith('membershipPaymentReconciliation.js')) return {
      recordSucceededMembershipPaymentIntent: async () => ({ status: 'recorded' }),
      reconcileMembershipInvoicePayment: async () => {
        tables[historyTable].forEach(row => { row.payment_status = 'paid'; });
      },
    };
    if (name.endsWith('membershipInvoiceEmail.js')) return { sendMembershipInvoiceEmail: async () => {} };
    throw new Error(`Unmocked dependency: ${name}`);
  };
  const commitment = rolling ? { term_key: 'rolling:2099', term_start_date: '2099-01-01', term_end_date: '2099-12-31' } : null;
  const api = load(() => db, async () => eligibility, async () => ({ required: false }),
    () => commitment, () => null, async () => null, async () => null, deps);
  async function request(method, body = {}) {
    const res = { code: 200, setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; }};
    await api.handler({ method, query: { token: 'bearer' }, body, headers: {} }, res);
    return res;
  }
  intent.metadata.membership_year = token.membership_year;
  return { api, request, token, tables, db, intent, historyTable, calls, setEligibility: value => { eligibility = value; }};
}

process.env.SUPABASE_URL = 'https://fixture.invalid';
process.env.SUPABASE_SERVICE_KEY = 'fixture-only';

for (const member of [true, false]) {
  test(`saved ${member ? 'member' : 'organisation'} quote drives GET and idempotent payment setup`, async () => {
    const s = setup(member);
    const get = await s.request('GET');
    assert.equal(get.code, 200);
    assert.equal(get.body.totalWithVat, 144);
    assert.equal(get.body.renewalAvailable, true);
    assert.equal(get.body.costBreakdown.renewalQuote, undefined);
    assert.equal(get.body.costBreakdown.previousTerm, undefined);
    assert.equal(get.body.poAvailable, false);
    const first = await s.request('POST', { action: 'create_payment' });
    assert.equal(first.code, 200);
    assert.equal(s.calls[0].args.amount, 14400);
    assert.equal(s.calls[0].options.idempotencyKey, 'renewal-fee-payment:tenant:fee');
    await s.request('POST', { action: 'create_payment' });
    assert.equal(s.calls.length, 1);
  });
  for (const rolling of [false, true]) test(`confirm ${member ? 'member' : 'organisation'} ${rolling ? 'rolling' : 'fixed'} schedules exact successor`, async () => {
    const s = setup(member, rolling);
    const result = await s.request('POST', { action: 'confirm_payment', paymentIntentId: 'pi_test' });
    assert.equal(result.code, 200, JSON.stringify(result.body));
    const row = s.tables[s.historyTable][0];
    assert.equal(row.status, 'scheduled');
    assert.equal(row.term_start_date, '2099-01-01');
    assert.equal(row.term_end_date, '2099-12-31');
    assert.equal(row.final_cost, 120);
    assert.equal(row.total_with_vat, 144);
    assert.equal(s.token.status, 'paid');
  });
  test(`blocked ${member ? 'member' : 'organisation'} renewal has no provider effects`, async () => {
    const s = setup(member);
    s.setEligibility({ eligible: false, message: 'Already paid', code: 'annual_renewal_already_exists' });
    const get = await s.request('GET');
    assert.equal(get.body.renewalAvailable, false);
    assert.equal(get.body.renewalMessage, 'Already paid');
    const result = await s.request('POST', { action: 'create_payment' });
    assert.equal(result.code, 409);
    assert.equal(s.calls.length, 0);
  });
  test(`${member ? 'member' : 'organisation'} reminder cannot start alternative payment methods`, async () => {
    const s = setup(member);
    Object.assign(s.token.cost_breakdown.renewalQuote.config, { card_monthly_enabled: true, dd_enabled: true });
    const get = await s.request('GET');
    assert.equal(get.body.cardMonthlyEnabled, false);
    assert.equal(get.body.ddEnabled, false);
    for (const action of ['start_direct_debit', 'start_monthly_card', 'submit_po']) {
      const result = await s.request('POST', { action, poNumber: 'PO-1' });
      assert.equal(result.code, 409);
    }
    assert.equal(s.calls.length, 0);
    assert.equal(s.token.status, 'pending');
  });
  test(`${member ? 'member' : 'organisation'} public quote projection omits internal and recipient snapshots`, async () => {
    const s = setup(member);
    s.token.cost_breakdown.previousTerm = { private_note: 'DO_NOT_DISCLOSE' };
    s.token.cost_breakdown.simulation = { invoicingSettings: { email: 'DO_NOT_DISCLOSE' } };
    s.token.cost_breakdown.renewalQuote.config.invoice_recipients = { private: 'DO_NOT_DISCLOSE' };
    const result = await s.request('GET');
    assert.doesNotMatch(JSON.stringify(result.body), /DO_NOT_DISCLOSE|renewalQuote|invoice_recipients|invoicingSettings/);
  });
  test(`${member ? 'member' : 'organisation'} ordinary Email Fees retains PO option`, async () => {
    const s = setup(member);
    delete s.token.cost_breakdown.renewalQuote;
    const result = await s.request('GET');
    assert.equal(result.body.poAvailable, true);
    assert.equal(result.body.paymentMethodsMessage, null);
  });
  test(`${member ? 'member' : 'organisation'} invoice-backed renewal reuses invoice and confirmation retry`, async () => {
    const s = setup(member);
    s.token.history_record_id = 'linked';
    s.token.xero_invoice_id = 'invoice';
    s.tables[s.historyTable].push({
      id: 'linked', tenant_id: 'tenant', ...(member ? { member_id: 'owner' } : { organization_id: 'owner' }),
      membership_year: '2099', xero_invoice_id: 'invoice', payment_status: 'unpaid',
      final_cost: 120, total_with_vat: 144,
    });
    const result = await s.request('POST', { action: 'confirm_payment', paymentIntentId: 'pi_test' });
    assert.equal(result.code, 200);
    assert.equal(s.tables[s.historyTable].length, 1);
    assert.equal(s.calls.filter(c => c.invoice).length, 1);
    const retry = await s.request('POST', { action: 'confirm_payment', paymentIntentId: 'pi_test' });
    assert.equal(retry.body.already_processed, true);
    assert.equal(s.calls.filter(c => c.invoice).length, 1);
  });
  test(`${member ? 'member' : 'organisation'} webhook wins checkout race without shortening current term`, async () => {
    const s = setup(member);
    s.tables.organization[0].tenant_id = 'tenant';
    const current = {
      id: 'current', tenant_id: 'tenant', ...(member ? { member_id: 'owner' } : { organization_id: 'owner' }),
      membership_year: '2098', term_start_date: '2098-01-01', term_end_date: '2098-12-31', payment_status: 'paid',
    };
    s.tables[s.historyTable].push(current);
    const before = structuredClone(current);
    const deps = { db: s.db, fireWorkflow: async () => ({ fired: true }) };
    const result = await recordSucceededMembershipPaymentIntent({ tenantId: 'tenant', paymentIntent: s.intent }, deps);
    assert.equal(result.status, 'recorded', result.detail);
    const row = s.tables[s.historyTable].find(r => r.membership_year === '2099');
    assert.equal(row.config_id, 'config');
    assert.equal(row.status, 'scheduled');
    assert.equal(row.term_start_date, '2099-01-01');
    assert.equal(row.term_end_date, '2099-12-31');
    assert.equal(row.payment_status, 'paid');
    assert.deepEqual(current, before);
    const retry = await s.request('POST', { action: 'confirm_payment', paymentIntentId: 'pi_test' });
    assert.equal(retry.body.already_processed, true);
    assert.equal(s.tables[s.historyTable].length, 2);
  });
}