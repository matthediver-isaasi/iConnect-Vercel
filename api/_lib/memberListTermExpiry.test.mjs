import test from 'node:test';
import assert from 'node:assert/strict';
import { loadMemberListTermExpiries } from './memberListTermExpiry.js';
import { makeFakeSupabase, methodArguments } from '../admin/_test/paginatedFakeSupabase.mjs';

const now = new Date('2027-01-01T12:00:00Z');
const row = {
  id: 'term', member_id: 'member', tenant_id: 'tenant',
  status: 'active', payment_status: 'paid', term_key: 'term',
  term_start_date: '2026-09-06', term_end_date: '2027-09-05',
  membership_renewal_date: '2027-09-06',
};
async function expiry(rows) {
  return (await loadMemberListTermExpiries(makeFakeSupabase(() => ({ data: rows })), 'tenant', ['member'], now)).get('member');
}
test('current persisted term wins over scheduled renewal, snapshots supply missing dates', async () => {
  assert.equal(await expiry([row, { ...row, id: 'future', term_start_date: '2027-09-06', term_end_date: '2028-09-05', status: 'scheduled' }]), '2027-09-05');
  assert.equal(await expiry([{ ...row, term_start_date: null, term_end_date: null, membership_renewal_date: null,
    commitment_snapshot: { term_start_date: row.term_start_date, term_end_date: row.term_end_date, membership_renewal_date: row.membership_renewal_date } }]), '2027-09-05');
});
test('legacy and expired paid fallback retain exact expiry without extending grace', async () => {
  assert.equal(await expiry([{ ...row, term_key: null, membership_renewal_date: null }]), '2027-09-05');
  assert.equal(await expiry([{ ...row, status: 'expired', term_end_date: '2026-09-05', membership_renewal_date: '2026-09-06' }]), '2026-09-05');
});
test('ambiguous, missing, unverified, unpaid, future, and cross-tenant evidence fails closed', async () => {
  assert.equal(await expiry([row, { ...row, id: 'competing' }]), null);
  for (const changes of [
    { payment_status: 'unverified' }, { payment_status: 'unpaid' },
    { status: 'cancelled' }, { term_start_date: '2099-01-01' },
    { tenant_id: 'other' }, { member_id: 'other' }, { term_end_date: null },
    { term_end_date: '2027-02-30' },
  ]) assert.equal(await expiry([{ ...row, ...changes }]), null, JSON.stringify(changes));
  assert.equal(await expiry([]), null);
});
test('tenant/page scoped history pagination reads beyond the server cap, never per member', async () => {
  const first = Array.from({ length: 500 }, (_, i) => ({ ...row, id: `old-${i}`, status: 'cancelled' }));
  const db = makeFakeSupabase(call => ({
    data: methodArguments(call, 'range')[0][0] === 0 ? first : [row],
  }));
  const result = await loadMemberListTermExpiries(db, 'tenant', ['member', 'second'], now);
  assert.equal(result.get('member'), row.term_end_date);
  assert.equal(result.get('second'), null);
  assert.equal(db.calls.length, 2);
  for (const call of db.calls) {
    assert.equal(call.table, 'member_membership_history');
    assert.deepEqual(methodArguments(call, 'eq'), [['tenant_id', 'tenant']]);
    assert.deepEqual(methodArguments(call, 'in'), [['member_id', ['member', 'second']]]);
  }
  const emptyDb = makeFakeSupabase(() => { throw new Error('unexpected read'); });
  assert.equal((await loadMemberListTermExpiries(emptyDb, 'tenant', [], now)).size, 0);
});
test('lookup errors and malformed responses are not confirmed absence', async () => {
  for (const response of [{ error: { code: '42P01' } }, { data: null }, { error: { message: 'offline' } }]) {
    await assert.rejects(loadMemberListTermExpiries(makeFakeSupabase(() => response), 'tenant', ['member'], now), /Failed to fetch/);
  }
});
