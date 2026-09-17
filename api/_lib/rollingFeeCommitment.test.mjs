import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildRollingCommitment } from './rollingMembershipCommitment.js';
import {
  feeTokenCommitment, simulationFromFeeCommitment, reserveRollingFeePayment,
  reserveRollingMonthlyHistory, snapshotRollingFeeQuote,
  workflowRollingCommitment, hasRollingMonthlyArrangement,
} from './rollingFeeCommitment.js';

const config = { id: 'config-a', structure_scope_type: 'member', start_mode: 'immediate', billing_period: 'annual', currency: 'GBP', flat_cost: 240 };
const amounts = { annual_cost: 240, final_cost: 240, vat_amount: 48, total_with_vat: 288, currency: 'GBP' };
function commitment(method = 'stripe', period = 'annual') {
  return buildRollingCommitment({
    config: { ...config, billing_period: period },
    startDate: '2026-09-15', paymentMethod: method,
    paymentFrequency: ['direct_debit', 'card_monthly'].includes(method) ? 'monthly' : 'upfront',
    amounts, pricingSnapshot: { band: { id: 'band-a' }, tier_label: 'Standard', vat_rate_percent: 20 },
  });
}
function token(method = 'stripe') {
  return {
    id: 'fee-a', tenant_id: 'tenant-a', member_id: 'member-a',
    membership_year: 'rolling:2026-09-15', final_cost: 240, currency: 'GBP',
    cost_breakdown: { commitment: commitment(method), totalWithVat: 288, vatAmount: 48 },
  };
}
function database(results = []) {
  const calls = [];
  return {
    calls,
    from(table) {
      const call = { table, filters: [] };
      calls.push(call);
      return {
        insert(row) { call.insert = row; return this; },
        select() { return this; },
        eq(...filter) { call.filters.push(filter); return this; },
        in(...filter) { call.filters.push(filter); return this; },
        limit() { return this; },
        then(resolve, reject) { return Promise.resolve(results.shift() || {}).then(resolve, reject); },
        async maybeSingle() { return results.shift() || {}; },
      };
    },
  };
}

test('fee link preserves purchased price, structure and dates after source changes', () => {
  const fee = token();
  const sim = simulationFromFeeCommitment(fee);
  fee.cost_breakdown.commitment.commitment_snapshot.config.flat_cost = 999;
  assert.equal(sim.config.flat_cost, 240);
  assert.equal(sim.totalWithVat, 288);
  assert.equal(sim.membershipYear.label, 'rolling:2026-09-15');
  assert.equal(sim.commitment.membership_renewal_date, '2027-09-15');
  assert.equal(sim.existingRecord, false);
});

test('legacy fixed-cycle link stays legacy; incomplete rolling links cannot silently re-price', () => {
  assert.equal(feeTokenCommitment({ membership_year: '2026/2027' }), null);
  assert.throws(() => feeTokenCommitment({ membership_year: 'rolling:2026-09-15' }), /verified/);
  assert.throws(() => feeTokenCommitment({ ...token(), membership_year: 'rolling:2026-10-15' }), /does not match/);
});

test('rolling upfront reservation stores net/VAT/gross and pending status before payment', async () => {
  const db = database([{ data: { id: 'reserved' } }]);
  const result = await reserveRollingFeePayment(db, token());
  assert.equal(result.id, 'reserved');
  const saved = db.calls[0].insert;
  assert.equal(saved.payment_status, 'unpaid');
  assert.equal(saved.status, 'pending_payment_setup');
  assert.equal(saved.term_start_date, '2026-09-15');
  assert.equal(saved.membership_renewal_date, '2027-09-15');
  assert.equal(saved.final_cost, 240);
  assert.equal(saved.vat_amount, 48);
  assert.equal(saved.total_with_vat, 288);
});

test('rolling upfront duplicate reservation resumes only its own unpaid quote', async () => {
  const fee = token();
  const existing = {
    id: 'reserved', ...commitment(), payment_method: 'stripe', payment_status: 'unpaid',
    total_with_vat: 288, notes: `Rolling fee quote: ${fee.id}`,
  };
  const db = database([{ error: { code: '23505' } }, { data: existing }]);
  assert.equal((await reserveRollingFeePayment(db, fee)).id, existing.id);
  assert.deepEqual(db.calls[1].filters.slice(0, 2), [['tenant_id', fee.tenant_id], ['member_id', fee.member_id]]);
  for (const patch of [{ payment_status: 'paid' }, { billing_agreement_id: 'other' }, { notes: 'other fee' }, { total_with_vat: 300 }]) {
    await assert.rejects(() => reserveRollingFeePayment(
      database([{ error: { code: '23P01' } }, { data: { ...existing, ...patch } }]), fee,
    ), /different pricing commitment/);
  }
});

test('invoice-first commitment preserves agreed method while Stripe is only settlement', async () => {
  const fee = { ...token('invoice'), history_record_id: 'invoice-row' };
  const db = database([{ error: { code: '23505' } }, { data: {
    id: 'invoice-row', ...commitment('invoice'), payment_method: 'invoice',
    total_with_vat: 288, payment_status: 'unpaid',
  } }]);
  const result = await reserveRollingFeePayment(db, fee);
  assert.equal(result.payment_method, 'invoice');
});

for (const method of ['direct_debit', 'card_monthly']) {
  test(`${method}: organisation monthly reservation uses immutable net/VAT/gross, not live sim`, async () => {
    const agreed = commitment(method);
    const agreement = { id: 'agreement-a', tenant_id: 'tenant-a', organization_id: 'org-a' };
    const db = database([{ data: { id: 'history-a' } }]);
    await reserveRollingMonthlyHistory(db, agreement, { commitment: agreed }, {
      annualCost: 999, finalCost: 999, vatAmount: 999, matchedBand: { id: 'changed-band' },
    });
    const row = db.calls[0].insert;
    assert.equal(db.calls[0].table, 'organisation_membership_history');
    assert.equal(row.organization_id, 'org-a');
    assert.equal(row.member_id, undefined);
    assert.equal(row.final_cost, agreed.commitment_snapshot.amounts.final_cost);
    assert.equal(row.vat_amount, 48);
    assert.equal(row.total_with_vat, 288);
    assert.equal(row.annual_cost, 240);
    assert.equal(row.band_id, 'band-a');
    assert.equal(row.vat_rate_percent, 20);
    assert.equal(row.status, 'pending_payment_setup');
    assert.equal(row.payment_method, method);
  });
}

test('monthly reservation rejects ambiguous owner and foreign agreement conflict', async () => {
  const agreement = { id: 'a', tenant_id: 't', member_id: 'm', organization_id: 'o' };
  await assert.rejects(() => reserveRollingMonthlyHistory(database(), agreement, { commitment: commitment('direct_debit') }, {}), /exactly one/);
  await assert.rejects(() => reserveRollingMonthlyHistory(
    database([{ error: { code: '23505' } }, { data: null }]),
    { ...agreement, organization_id: null }, { commitment: commitment('direct_debit') }, {},
  ), /reserve the monthly/);
});

test('fee email requires authoritative canonical start rather than account/creation date', async () => {
  await assert.rejects(() => snapshotRollingFeeQuote(database(), {
    tenantId: 't', memberId: 'm', tierConfig: config, membershipYear: '2026/2027',
    finalCost: 240, currency: 'GBP', costBreakdown: { created_at: '2026-09-15' },
  }), /verified commencement/);
  const result = await snapshotRollingFeeQuote(database([{ data: null }]), {
    tenantId: 't', memberId: 'm', tierConfig: config, membershipYear: 'rolling:2026-09-15',
    finalCost: 240, currency: 'GBP', costBreakdown: { vatAmount: 48, totalWithVat: 288 },
  });
  assert.equal(result.commitment.term_start_date, '2026-09-15');
});

test('workflow invoice-first is pending; zero-due future membership is scheduled', () => {
  const sim = {
    config, membershipYear: { start: '2099-09-15' },
    annualCost: 240, finalCost: 240, vatAmount: 48, totalWithVat: 288, currency: 'GBP',
  };
  const pending = workflowRollingCommitment(sim, { addonTotals: { subtotal: 10, vat: 2, total: 12 } });
  assert.equal(pending.status, 'pending_payment_setup');
  assert.equal(pending.payment_method, 'invoice');
  assert.equal(pending.total_with_vat, 300);
  const zero = workflowRollingCommitment({ ...sim, annualCost: 0, finalCost: 0, vatAmount: 0, totalWithVat: 0 }, { zeroDue: true });
  assert.equal(zero.status, 'scheduled');
  assert.equal(zero.scheduled_activation_date, '2099-09-15');
  assert.equal(zero.payment_method, 'none');
});

test('workflow refuses annual invoice for existing monthly commitment, including read errors', async () => {
  assert.equal(await hasRollingMonthlyArrangement(database(), {
    simResult: { config, previousTerm: { commitment_snapshot: { payment_frequency: 'monthly' } } },
  }), true);
  await assert.rejects(() => hasRollingMonthlyArrangement(database([{ error: { message: 'offline' } }]), {
    tenantId: 't', memberId: 'm', simResult: { config },
  }), /verify/);
});

test('provider setup is after durable reservation and finite boundary in fee/org routes', () => {
  const publicCode = readFileSync(new URL('../public/membership-fees/[token].js', import.meta.url), 'utf8');
  const upfront = publicCode.slice(publicCode.indexOf("if (action === 'create_payment')"), publicCode.indexOf("if (action === 'confirm_payment')"));
  assert.ok(upfront.indexOf('reserveRollingFeePayment') < upfront.indexOf('stripe.paymentIntents.create'));
  assert.match(upfront, /rolling-fee-payment:/);
  assert.ok(upfront.indexOf('stripe_payment_attempted_at: new Date') < upfront.indexOf('stripe.paymentIntents.create'));
  assert.match(upfront, /23 \* 60 \* 60 \* 1000/);
  assert.match(upfront, /reservedTerm && paymentLinkError/);
  const monthly = publicCode.slice(publicCode.indexOf("if (action === 'start_monthly_card')"));
  assert.ok(monthly.indexOf('reserveRollingMonthlyHistory') < monthly.indexOf('stripe.checkout.sessions.create'));
  assert.match(monthly, /snapshot\.commitment\.membership_renewal_date/);
  const org = readFileSync(new URL('../membership/org-direct-debit.js', import.meta.url), 'utf8');
  assert.ok(org.indexOf('existingHistory = await reserveRollingMonthlyHistory') < org.indexOf('await client.createBillingRequest'));
});