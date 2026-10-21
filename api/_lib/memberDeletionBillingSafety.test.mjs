import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkMemberDeletionBilling } from './memberDeletionBillingSafety.js';

function fakeDb(rows = {}, { errorTable, cappedTable } = {}) {
  const reads = [];
  return {
    reads,
    from(table) {
      const filters = [];
      const query = {
        select() { return query; },
        eq(key, value) { filters.push([key, value]); return query; },
        in(key, value) { filters.push([key, value]); return query; },
        then(resolve) {
          reads.push({ table, filters });
          const data = (rows[table] || []).filter(row => filters.every(([key, value]) =>
            Array.isArray(value) ? value.includes(row[key]) : row[key] === value));
          return Promise.resolve({
            data, count: table === cappedTable ? data.length + 1 : data.length,
            error: table === errorTable ? { code: '42P01' } : null,
          }).then(resolve);
        },
      };
      return query;
    },
  };
}
const scope = { memberId: 'm', tenantId: 't' };
const row = (status, extra = {}) => ({ id: 'a', member_id: 'm', tenant_id: 't', status, provider: 'stripe', ...extra });
test('no agreements: safe read-only preflight', async () => {
  assert.equal((await checkMemberDeletionBilling(fakeDb(), scope)).success, true);
});
for (const status of ['active', 'pending', 'payment_setup_required', 'paused', 'past_due', 'failed', 'cancel_at_period_end', null, 'new_unknown_state']) {
  test(`${status} blocks anonymisation for either provider`, async () => {
    for (const provider of ['stripe', 'gocardless']) {
      const result = await checkMemberDeletionBilling(fakeDb({
        membership_payment_plans: [row(status, { provider })],
      }), scope);
      assert.equal(result.status, 409);
      assert.equal(result.blockers.length, 1);
      assert.match(result.error, /does not cancel/);
    }
  });
}
test('terminal history remains untouched and does not block', async () => {
  const rows = ['payment_plan_cancelled', 'cancelled', 'canceled', 'completed', 'finished', 'expired', 'incomplete_expired'].map((status, i) => row(status, { id: `${i}` }));
  const db = fakeDb({ membership_billing_agreements: rows, membership_payment_plans: rows });
  assert.equal((await checkMemberDeletionBilling(db, scope)).success, true);
});
test('member and tenant scope excludes unrelated billing', async () => {
  const db = fakeDb({ membership_payment_plans: [row('active', { tenant_id: 'other' }), row('active', { member_id: 'other' })] });
  assert.equal((await checkMemberDeletionBilling(db, scope)).success, true);
});
test('agreement-only linkage blocks even when agreement is terminal', async () => {
  const result = await checkMemberDeletionBilling(fakeDb({
    membership_billing_agreements: [row('cancelled')],
    membership_payment_plans: [row('active', { id: 'p', member_id: null, billing_agreement_id: 'a' })],
  }), scope);
  assert.equal(result.status, 409);
  assert.equal(result.blockers[0].id, 'p');
});
test('partial read failure and capped results fail closed', async () => {
  for (const options of [{ errorTable: 'membership_payment_plans' }, { cappedTable: 'membership_billing_agreements' }]) {
    const result = await checkMemberDeletionBilling(fakeDb({
      membership_billing_agreements: [row('active')],
    }, options), scope);
    assert.equal(result.status, 503);
    assert.equal(result.success, false);
    assert.ok(result.failures.length);
  }
});
test('organisation-owned recurring agreements block cascade', async () => {
  const result = await checkMemberDeletionBilling(fakeDb({
    membership_billing_agreements: [row('active', { organization_id: 'o', member_id: null })],
  }), { organizationId: 'o', tenantId: 't' });
  assert.equal(result.status, 409);
});
test('all destructive paths gate before side effects; UI requires successful fresh check', () => {
  const source = name => readFileSync(new URL(name, import.meta.url), 'utf8');
  const anon = source('./memberAnonymize.js');
  assert.ok(anon.indexOf('if (!billingSafety.success)') < anon.indexOf('const sessionResult'));
  const merge = source('../admin/members/merge.js');
  assert.ok(merge.indexOf('if (!safety.success)') < merge.indexOf('const requestedCore'));
  const entity = source('../entities/[entity]/[id].js');
  assert.ok(entity.indexOf('const orgSafety') < entity.indexOf('Invalidating sessions for'));
  const ui = source('../../client/src/pages/MemberDetail.jsx');
  assert.match(ui, /deletionBilling\.data\?\.success !== true/);
  assert.match(ui, /Financial records are retained/);
});
