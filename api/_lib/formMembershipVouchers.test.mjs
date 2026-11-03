import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formVoucherCheckoutReady, loadFormVoucherAuthority, formVoucherBreakdown,
  formVoucherHistoryFields, discoverFormMembershipVouchers,
  validateFormVoucherSelection,
  formVoucherSetupStatus,
} from './formMembershipVouchers.js';

function setupDb({ provider = 'stripe', status = 'active', fundingState = 'plan_committed',
  subscription = 'sub_verified', mandate = 'MD_verified', error = null } = {}) {
  const queries = [];
  const rows = {
    membership_fee_token: { id: 'fee' },
    membership_voucher_settlement: { state: fundingState, billing_agreement_id: 'agreement' },
    membership_billing_agreements: { id: 'agreement', provider, status, gocardless_mandate_id: mandate },
    membership_payment_plans: { id: 'plan', status, stripe_subscription_id: subscription },
  };
  return { queries, from(table) {
    const filters = [];
    queries.push({ table, filters });
    return { select() { return this; }, eq(k, v) { filters.push([k, v]); return this; },
      neq() { return this; }, is(k, v) { filters.push([k, v]); return this; },
      async maybeSingle() { return { data: rows[table], error }; } };
  } };
}
const setupScope = { tenantId: 'tenant', memberId: 'member', electionId: 'election', token: 'token' };
test('only a scoped, funded, provider-backed arrangement resumes a monthly form', async () => {
  const db = setupDb();
  assert.deepEqual(await formVoucherSetupStatus(db, setupScope),
    { status: 'monthly_card_started', agreementId: 'agreement' });
  const filters = db.queries.find(q => q.table === 'membership_billing_agreements').filters;
  for (const pair of [['tenant_id', 'tenant'], ['member_id', 'member'],
    ['membership_successor_election_id', 'election'], ['organization_id', null]]) {
    assert.ok(filters.some(f => JSON.stringify(f) === JSON.stringify(pair)));
  }
  assert.deepEqual(await formVoucherSetupStatus(setupDb({ provider: 'gocardless' }), setupScope),
    { status: 'direct_debit_started', agreementId: 'agreement' });
  for (const fixture of [{ fundingState: 'reserved' }, { status: 'mandate_pending' },
    { status: 'cancelled' }, { subscription: null }, { provider: 'gocardless', mandate: null }]) {
    assert.equal(await formVoucherSetupStatus(setupDb(fixture), setupScope), null);
  }
  await assert.rejects(formVoucherSetupStatus(setupDb({ error: { message: 'Unavailable' } }), setupScope));
  const untouched = setupDb();
  assert.equal(await formVoucherSetupStatus(untouched, { ...setupScope, token: null }), null);
  assert.equal(untouched.queries.length, 0);
});

test('selected vouchers must be a unique nonempty subset of current server-owned discovery', () => {
  const discovery = { enabled: true, vouchers: [{ id: 'a', value: 10 }, { id: 'b', value: 20 }] };
  assert.deepEqual(validateFormVoucherSelection(discovery, ['b', 'a']).map(v => v.value), [20, 10]);
  for (const ids of [null, [], ['a', 'a'], ['other'], [1], ['']]) {
    assert.throws(() => validateFormVoucherSelection(discovery, ids));
  }
  assert.throws(() => validateFormVoucherSelection({ ...discovery, enabled: false }, ['a']));
});

test('missing rollout fails closed, and database errors are not absence of credit', async () => {
  assert.equal(await formVoucherCheckoutReady({ rpc: async () => ({ error: { code: 'PGRST202' } }) }), false);
  assert.equal(await formVoucherCheckoutReady({ rpc: async () => ({ data: false }) }), false);
  assert.equal(await formVoucherCheckoutReady({ rpc: async () => ({ data: true }) }), true);
  await assert.rejects(formVoucherCheckoutReady({ rpc: async () => ({ error: { code: 'timeout' } }) }), /verify/);
});

test('ordinary fee links do not acquire form authority or extra history fields', async () => {
  const db = { from() { throw new Error('Unexpected database read'); } };
  assert.equal(await loadFormVoucherAuthority(db, { cost_breakdown: {} }), null);
  assert.deepEqual(formVoucherHistoryFields({ cost_breakdown: {} }), {});
});

test('discovery cannot guess a personal owner or spend personal credit on an organisation purchase', async () => {
  await assert.rejects(discoverFormMembershipVouchers({}, { tenantId: 't' }), /Verified/);
  assert.deepEqual(await discoverFormMembershipVouchers({}, {
    tenantId: 't', memberId: 'm', organizationId: 'o',
  }), { enabled: false, vouchers: [] });
});

test('post-grace bridge stays closed until cash-plus-credit finalization is supported', () => {
  assert.throws(() => formVoucherBreakdown({
    payment_method: 'upfront',
    quote: { simulation: { success: true, formRenewal: { state: 'post_grace_renewal' } } },
  }), /payment-date-aware/);
});

const election = { id: 'e', tenant_id: 't', member_id: 'm', origin: 'form', status: 'reserved',
  payment_method: 'upfront', quote: { payerMemberId: 'm', simulation: {
    success: true, membershipYear: { label: '2026/2027', start: '2026-10-01', end: '2027-09-30' },
  } } };
const token = { id: 'token', tenant_id: 't', member_id: 'm', membership_year: '2026/2027',
  cost_breakdown: { formVoucher: { electionId: 'e', paymentMode: 'stripe_upfront' } } };
function dbFor(row, bridge = { election_id: 'e' }) {
  return { from(table) {
    const chain = { eq() { return chain; }, is() { return chain; }, select() { return chain; },
      async maybeSingle() { return { data: table === 'membership_successor_election' ? row : bridge }; } };
    return chain;
  } };
}
test('bound checkout verifies payer, method, term, origin and reservation before reuse', async () => {
  assert.equal((await loadFormVoucherAuthority(dbFor(election), token)).id, 'e');
  for (const patch of [
    { status: 'released' }, { origin: 'worker' }, { organization_id: 'o' }, { switch_state: 'reconciling' },
    { payment_method: 'monthly_card' }, { quote: { ...election.quote, payerMemberId: 'another' } },
    { quote: { ...election.quote, simulation: { membershipYear: { label: 'other' } } } },
  ]) await assert.rejects(loadFormVoucherAuthority(dbFor({ ...election, ...patch }), token), /no longer matches/);
  await assert.rejects(loadFormVoucherAuthority(dbFor(election, null), token), /could not be verified/);
});
