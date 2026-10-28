import test from 'node:test';
import assert from 'node:assert/strict';
import { createMembershipSimulator } from './membershipSimulationCore.js';

function fixture({ paymentStatus = 'paid', error = null } = {}) {
  const reachedPricing = new Error('Evidence check passed; pricing lookup reached');
  const db = {
    from(table) {
      if (!['member', 'member_membership_history'].includes(table)) throw reachedPricing;
      const filters = {};
      const query = {
        select(columns) {
          if (table === 'member_membership_history') {
            assert.ok(!columns.split(',').map(s => s.trim()).includes('organization_id'),
              'Individual history has no organization_id column');
          }
          return query;
        },
        eq(key, value) { filters[key] = value; return query; },
        maybeSingle() { return { data: { id: 'member', tenant_id: 'tenant' }, error: null }; },
        then(resolve, reject) {
          assert.deepEqual(filters, { tenant_id: 'tenant', member_id: 'member' });
          return Promise.resolve({ error, data: error ? null : [{
            id: 'history', tenant_id: 'tenant', member_id: 'member',
            payment_status: paymentStatus, status: 'expired',
            term_start_date: '2025-10-01', term_end_date: '2026-09-30',
          }] }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  return { simulate: () => createMembershipSimulator(db).simulateMembershipForMember('tenant', 'member'), reachedPricing };
}

test('paid individual history passes evidence checks using supported history columns', async () => {
  const f = fixture();
  await assert.rejects(f.simulate, error => error === f.reachedPricing);
});

test('genuinely unverified individual payment still blocks pricing', async () => {
  const result = await fixture({ paymentStatus: 'unverified' }).simulate();
  assert.equal(result.success, false);
  assert.equal(result.code, 'MEMBERSHIP_PAYMENT_UNVERIFIED');
  assert.match(result.error, /^Payment unverified/);
});

test('history database failures still fail closed', async () => {
  const result = await fixture({ error: { code: '08006', message: 'Unavailable' } }).simulate();
  assert.equal(result.success, false);
  assert.match(result.error, /Could not verify historical membership payment evidence/);
});
