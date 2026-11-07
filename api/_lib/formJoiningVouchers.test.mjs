import test from 'node:test';
import assert from 'node:assert/strict';
import { bindJoiningVoucherCheckout, loadJoiningVoucherAuthority } from './formJoiningVouchers.js';
import { readFormVoucherCheckout, formVoucherHistoryFields } from './formMembershipVouchers.js';
import { reserveMembershipVoucherSettlement } from './membershipVoucherSettlement.js';

function fixture() {
  const sim = { success: true, config: { id: 'schedule', structure_scope_type: 'member', start_mode: 'fixed_date' },
    membershipYear: { label: '2027', start: '2027-01-01', end: '2027-12-31' },
    annualCost: 100, finalCost: 100, totalWithVat: 100, vatAmount: 0, currency: 'GBP' };
  const marker = { version: 1, formId: 'form', paymentFieldId: 'payment', paymentMode: 'stripe_upfront', simulation: sim };
  const breakdown = { ...sim, formJoiningVoucher: marker };
  const token = { id: 'token', token: 'secret-fixture', tenant_id: 'tenant', member_id: 'member',
    organization_id: null, membership_year: '2027', cost_breakdown: breakdown, final_cost: 100, currency: 'GBP' };
  const tables = {
    form_joining_voucher_checkout: [{ tenant_id: 'tenant', member_id: 'member', fee_token_id: 'token',
      released_at: null, breakdown: structuredClone(breakdown) }],
    member: [{ id: 'member', tenant_id: 'tenant', membership_paused: false }],
    membership_fee_token: [token],
    membership_voucher_settlement: [],
    membership_voucher_quote: [{ id: 'quote', tenant_id: 'tenant', fee_token_id: 'token', quote: {} }],
    member_membership_history: [],
  };
  let snapshot;
  const db = { from(name) {
    let rows = tables[name] || [];
    return { select() { return this; }, eq(k, v) { rows = rows.filter(r => r[k] === v); return this; },
      is(k, v) { rows = rows.filter(r => r[k] === v); return this; },
      neq(k, v) { rows = rows.filter(r => r[k] !== v); return this; },
      async maybeSingle() { return { data: rows[0] || null }; }, async single() { return { data: rows[0] || null }; } };
  }, async rpc(name, args) {
    if (name === 'bind_form_joining_voucher_checkout') return { data: { ...token, cost_breakdown: args.p_breakdown } };
    assert.equal(name, 'membership_voucher_reserve');
    snapshot = args.p_history_snapshot;
    return { data: { id: 'settlement', fee_token_id: 'token' } };
  } };
  return { sim, marker, token, db, tables, snapshot: () => snapshot };
}

test('first purchase binding freezes the selected schedule for all payment methods', async () => {
  for (const paymentMethod of ['upfront', 'monthly_card', 'direct_debit']) {
    const f = fixture();
    const original = structuredClone(f.sim);
    const token = await bindJoiningVoucherCheckout(f.db, { tenantId: 'tenant', memberId: 'member',
      simulation: f.sim, paymentMethod, formId: 'form', paymentFieldId: 'payment' });
    assert.equal(token.cost_breakdown.formJoiningVoucher.simulation.config.id, 'schedule');
    assert.equal(token.cost_breakdown.formVoucher, undefined);
    assert.deepEqual(f.sim, original);
  }
});

test('first purchase authority rejects altered pricing, owner, released mapping and paused membership', async () => {
  assert.equal((await loadJoiningVoucherAuthority(fixture().db, fixture().token)).formId, 'form');
  for (const change of [
    f => { f.token.cost_breakdown.formJoiningVoucher.simulation.finalCost = 1; },
    f => { f.token.member_id = 'someone-else'; },
    f => { f.token.tenant_id = 'other'; },
    f => { f.token.final_cost = 1; },
    f => { f.token.currency = 'USD'; },
    f => { f.tables.form_joining_voucher_checkout[0].released_at = '2027-01-01'; },
    f => { f.tables.member[0].membership_paused = true; },
  ]) {
    const f = fixture(); change(f);
    await assert.rejects(loadJoiningVoucherAuthority(f.db, f.token));
  }
});

test('saved answer verifies original form, payment field and exact member before submission', async () => {
  const f = fixture();
  const input = { tenantId: 'tenant', memberId: 'member', checkoutId: 'token', formId: 'form', paymentFieldId: 'payment' };
  const receipt = await readFormVoucherCheckout(f.db, input);
  assert.equal(receipt.election, null);
  assert.equal(receipt.joining.simulation.config.id, 'schedule');
  assert.equal(receipt.setup, null);
  await assert.rejects(readFormVoucherCheckout(f.db, { ...input, formId: 'other' }), /original membership form/);
  await assert.rejects(readFormVoucherCheckout(f.db, { ...input, paymentFieldId: 'other' }), /original membership form/);
});

test('voucher settlement uses frozen first-term dates and price, never the current member class or a fake predecessor', async () => {
  const f = fixture();
  await reserveMembershipVoucherSettlement(f.db, f.token, 'quote', {
    simulate() { throw new Error('Must not reprice'); },
    facade: { getActiveAccountingProvider: async () => null },
  });
  const snapshot = f.snapshot();
  assert.equal(snapshot.config_id, 'schedule');
  assert.equal(snapshot.total_with_vat, 100);
  assert.equal(snapshot.term_start_date, '2027-01-01');
  assert.equal(snapshot.term_end_date, '2027-12-31');
  assert.equal(snapshot.membership_successor_election_id, undefined);
  assert.equal(snapshot.previous_term_id, undefined);
  assert.deepEqual(formVoucherHistoryFields(f.token).renewal_policy_snapshot, f.sim.config);
});
