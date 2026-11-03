import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formVoucherCheckoutReady, loadFormVoucherAuthority, formVoucherBreakdown,
  formVoucherHistoryFields, discoverFormMembershipVouchers,
} from './formMembershipVouchers.js';

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
    { status: 'released' }, { origin: 'worker' }, { organization_id: 'o' },
    { payment_method: 'monthly_card' }, { quote: { ...election.quote, payerMemberId: 'another' } },
    { quote: { ...election.quote, simulation: { membershipYear: { label: 'other' } } } },
  ]) await assert.rejects(loadFormVoucherAuthority(dbFor({ ...election, ...patch }), token), /no longer matches/);
  await assert.rejects(loadFormVoucherAuthority(dbFor(election, null), token), /could not be verified/);
});
