import test from 'node:test';
import assert from 'node:assert/strict';
import { postGraceActivationReady, finalizePostGraceCardInvoice, finalizePostGraceDirectDebit } from './postGraceMonthlyFinalization.js';

function fixture(provider) {
  const dates = { term_start_date: '2026-01-01', term_end_date: '2026-12-31',
    membership_renewal_date: '2027-01-01', term_duration_months: 12,
    term_anchor_date: '2026-01-01', term_key: 'rolling:2026-01-01', previous_term_id: null,
    commitment_snapshot: { amounts: { final_cost: 156 } } };
  const scope = { tenant_id: 'tenant', member_id: 'member', membership_successor_election_id: 'election' };
  const kind = provider === 'stripe' ? 'card' : 'dd';
  const agreement = { ...scope, ...dates, id: 'agreement', provider, status: 'first_payment_pending',
    gocardless_mandate_id: 'mandate',
    metadata: { [kind]: { post_grace_election_id: 'election', commitment: dates } } };
  const plan = { tenant_id: 'tenant', member_id: 'member', id: 'plan',
    billing_agreement_id: agreement.id, stripe_subscription_id: 'subscription', gocardless_subscription_id: 'subscription' };
  const journal = { id: 'reservation', tenant_id: 'tenant', member_id: 'member', election_id: 'election',
    previous_term_id: 'prior', payment_method: provider === 'stripe' ? 'monthly_card' : 'direct_debit',
    first_payment_minor: 1300, currency: 'GBP', status: 'reserved',
    created_at: '2026-01-01T00:00:00Z', grace_end_date: '2025-12-01' };
  const tables = { membership_post_grace_renewal: journal,
    member_membership_history: { ...scope, ...dates, id: 'history', billing_agreement_id: agreement.id,
      status: 'pending_payment_setup', payment_status: 'unpaid' },
    membership_billing_agreements: agreement, membership_payment_plans: plan };
  const calls = [];
  const db = { from(table) { return {
    select() { return this; }, eq() { return this; }, neq() { return this; },
    async maybeSingle() { return { data: tables[table] || null, error: null }; },
  }; }, async rpc(name, params) {
    assert.equal(name, 'apply_post_grace_record_dates');
    calls.push(params);
    journal.status = 'settled';
    const receipt = { state: 'applied', reservation_id: journal.id, tenant_id: 'tenant', member_id: 'member' };
    tables.membership_post_grace_date_application = receipt;
    return { data: receipt, error: null };
  } };
  return { db, agreement, plan, journal, calls };
}
test('mandate or checkout setup alone cannot activate a restart', async () => {
  for (const provider of ['stripe', 'gocardless']) {
    const f = fixture(provider);
    assert.equal(await postGraceActivationReady(f.db, f.agreement), false);
  }
  assert.equal(await postGraceActivationReady(null, { metadata: {} }), true);
});
test('card finalization selects earliest paid invoice, not callback arrival order', async () => {
  const f = fixture('stripe');
  const invoice = (id, date) => ({ id, status: 'paid', amount_paid: 1300, currency: 'gbp',
    status_transitions: { paid_at: Date.parse(date) / 1000 } });
  const stripe = { invoices: { list: async args => {
    assert.equal(args.subscription, 'subscription');
    return { has_more: false, data: [
      invoice('later', '2026-02-02T00:00:00Z'), invoice('first', '2026-01-02T00:00:00Z'),
    ] };
  } } };
  await finalizePostGraceCardInvoice(f.db, { ...f, stripe });
  assert.equal(f.calls[0].p_payment_id, 'first');
  assert.equal(f.calls[0].p_paid_at, '2026-01-02T00:00:00.000Z');
  assert.equal(await postGraceActivationReady(f.db, f.agreement), true);
  await finalizePostGraceCardInvoice(f.db, { ...f, stripe: null });
  assert.equal(f.calls.length, 1);
});
test('DD excludes pending collections and retains the first confirmed bank collection date', async () => {
  const f = fixture('gocardless');
  const gc = { listPaymentsPage: async () => ({ after: null, payments: [
    { id: 'unpaid', status: 'pending_submission', amount: 1300, currency: 'GBP', charge_date: '2026-01-01' },
    { id: 'second', status: 'confirmed', amount: 1300, currency: 'GBP', charge_date: '2026-02-03' },
    { id: 'first', status: 'paid_out', amount: 1300, currency: 'GBP', charge_date: '2026-01-03' },
  ] }) };
  await finalizePostGraceDirectDebit(f.db, { ...f, gc, paymentId: 'second' });
  assert.equal(f.calls[0].p_payment_id, 'first');
  assert.equal(f.calls[0].p_paid_at, '2026-01-03T00:00:00.000Z');
});
test('first DD payment can finalize before plan creation', async () => {
  const f = fixture('gocardless');
  f.agreement.metadata.gocardless_initial_payment = { id: 'initial' };
  // The scoped lookup legitimately returns no plan yet.
  const originalFrom = f.db.from;
  f.db.from = table => table === 'membership_payment_plans'
    ? { select() { return this; }, eq() { return this; }, async maybeSingle() { return { data: null }; } }
    : originalFrom(table);
  const gc = { getPayment: async id => ({ id, status: 'confirmed', amount: 1300,
    currency: 'GBP', charge_date: '2026-01-03' }) };
  await finalizePostGraceDirectDebit(f.db, { ...f, plan: null, gc, paymentId: 'initial' });
  assert.equal(f.calls[0].p_expected.plan, null);
});
