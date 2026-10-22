import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateMembershipTerm, membershipAmountMinor, membershipVoucherBasis,
  buildMembershipVoucherQuote, discoverMembershipVouchers, persistMembershipVoucherQuote,
} from './membershipVoucherQuote.js';

const now = new Date('2026-08-01T12:00:00Z');
const token = { id: 'token', tenant_id: 'tenant', member_id: 'member', organization_id: null,
  final_cost: 100, currency: 'GBP', status: 'pending', expires_at: '2026-08-02T12:00:00Z' };
const discovery = { enabled: true, vouchers: [
  { id: 'later', value: 80, displayName: 'Learning Credit', expires_at: '2027-01-01' },
  { id: 'earlier', value: 30, displayName: 'Learning Credit', expires_at: '2026-09-01' },
] };

test('finite instalments reconcile gross, explicit funding and cash exactly', () => {
  for (let gross = 0; gross < 10000; gross += 113) {
    for (const count of [1, 3, 12]) {
      const credit = Math.floor(gross / 3);
      const plan = allocateMembershipTerm(gross, credit, count);
      for (const key of ['grossMinor', 'creditMinor', 'cashMinor']) {
        assert.equal(plan.instalments.reduce((sum, row) => sum + row[key], 0), plan[key]);
      }
      assert.ok(plan.instalments.every(row => row.grossMinor === row.creditMinor + row.cashMinor && row.creditMinor >= 0));
      assert.equal(plan.instalments.length, count);
    }
  }
});
test('full coverage requires no provider and partial minimum is explicit', () => {
  assert.equal(allocateMembershipTerm(10000, 10000, 12, 30).paymentPath, 'credit_only');
  assert.equal(allocateMembershipTerm(10000, 9900, 12, 30).paymentPath, 'adjust_credit_or_pay_upfront');
  assert.equal(allocateMembershipTerm(10000, 9900, 1, 30).paymentPath, 'provider');
  assert.throws(() => allocateMembershipTerm(100, 101));
  assert.throws(() => allocateMembershipTerm(100, 0, Infinity));
});
test('invalid money fails closed and zero VAT total is not replaced by net fee', () => {
  for (const amount of [null, '', NaN, Infinity, -1]) assert.throws(() => membershipAmountMinor(amount));
  assert.equal(membershipVoucherBasis({ ...token, cost_breakdown: { totalWithVat: 0 } }).grossMinor, 0);
});
test('quote caps credit at gross and uses first expiry ordering', () => {
  const quote = buildMembershipVoucherQuote(token, discovery, ['later', 'earlier'], now);
  assert.deepEqual(quote.allocations.map(row => [row.voucherId, row.amountMinor]), [['earlier', 3000], ['later', 7000]]);
  assert.equal(quote.cashMinor, 0);
  assert.equal(quote.grossMinor, 10000);
  assert.equal(quote.settlementEnabled, true);
  assert.equal(quote.expiresAt, '2026-08-01T12:15:00.000Z');
});
test('partial credit leaves the provider minimum rather than a tiny unchargeable balance', () => {
  const quote = buildMembershipVoucherQuote(token, { enabled: true, vouchers: [
    { id: 'tiny-remainder', value: 99.9, displayName: 'Learning Credit', expires_at: '2027-01-01' },
  ] }, ['tiny-remainder'], now);
  assert.equal(quote.creditMinor, 9970);
  assert.equal(quote.cashMinor, 30);
  assert.equal(quote.grossMinor, 10000);
});
test('owner forgery, duplicates and organization purchases cannot quote personal credit', () => {
  assert.throws(() => buildMembershipVoucherQuote(token, discovery, ['another-member-credit'], now));
  assert.throws(() => buildMembershipVoucherQuote(token, discovery, ['later', 'later'], now));
  assert.throws(() => buildMembershipVoucherQuote({ ...token, organization_id: 'org' }, discovery, ['later'], now));
  assert.throws(() => buildMembershipVoucherQuote(token, { ...discovery, enabled: false }, ['later'], now));
});
test('payment setup freezes selection and saved financial basis changes invalidate fingerprint', () => {
  for (const change of [{ status: 'paid' }, { stripe_payment_intent_id: 'pi' }, { stripe_payment_attempted_at: now.toISOString() }]) {
    assert.throws(() => buildMembershipVoucherQuote({ ...token, ...change }, discovery, ['later'], now));
  }
  assert.notEqual(membershipVoucherBasis(token).fingerprint, membershipVoucherBasis({ ...token, final_cost: 101 }).fingerprint);
  assert.notEqual(membershipVoucherBasis(token).fingerprint, membershipVoucherBasis({ ...token, history_record_id: 'invoice-history' }).fingerprint);
});

function fakeDb({ enabled = true, failSettings = false, failPersist = false } = {}) {
  const calls = [];
  return { calls, from(table) {
    calls.push(table);
    const result = table === 'system_settings'
      ? { data: [{ setting_key: 'individual_vouchers_enabled', setting_value: String(enabled) }], error: failSettings ? {} : null }
      : table === 'voucher' ? { data: [{ ...discovery.vouchers[0], tenant_id: 'tenant', member_id: 'member',
        organization_id: null, status: 'active', currency: 'GBP' }] }
        : { data: failPersist ? null : { id: 'quote-id' }, error: failPersist ? {} : null };
    const query = { then(resolve) { return Promise.resolve(result).then(resolve); } };
    for (const method of ['select', 'eq', 'is', 'in', 'gt', 'insert', 'single']) {
      query[method] = (...args) => { calls.push([table, method, ...args]); return query; };
    }
    return query;
  } };
}
test('flag off and organization token never query voucher table', async () => {
  const db = fakeDb({ enabled: false });
  assert.equal((await discoverMembershipVouchers(db, token, now)).enabled, false);
  assert.ok(!db.calls.includes('voucher'));
  const orgDb = fakeDb();
  await discoverMembershipVouchers(orgDb, { ...token, member_id: null, organization_id: 'org' }, now);
  assert.ok(!orgDb.calls.includes('voucher'));
});
test('discovery is tenant/member scoped and never expands into organization credit', async () => {
  const db = fakeDb();
  const found = await discoverMembershipVouchers(db, token, now);
  assert.equal(found.vouchers.length, 1);
  assert.ok(db.calls.some(call => Array.isArray(call) && call[0] === 'voucher' && call[1] === 'eq' && call[2] === 'member_id' && call[3] === 'member'));
  assert.ok(db.calls.some(call => Array.isArray(call) && call[0] === 'voucher' && call[1] === 'is' && call[2] === 'organization_id'));
  await assert.rejects(discoverMembershipVouchers(fakeDb({ failSettings: true }), token, now), /settings/);
});
test('durable preview writes only quote, never reserves or changes a voucher', async () => {
  const db = fakeDb();
  const quote = await persistMembershipVoucherQuote(db, token, ['later'], now);
  assert.equal(quote.id, 'quote-id');
  assert.equal(quote.cashMinor, 2000);
  assert.ok(db.calls.some(call => Array.isArray(call) && call[0] === 'membership_voucher_quote' && call[1] === 'insert'));
  await assert.rejects(persistMembershipVoucherQuote(fakeDb({ failPersist: true }), token, ['later'], now), /migration/);
});
