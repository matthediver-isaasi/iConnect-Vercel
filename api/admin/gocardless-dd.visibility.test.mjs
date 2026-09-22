import test from 'node:test';
import assert from 'node:assert/strict';
import { listPlans } from './gocardless-dd.js';

function fixture() {
  const members = Array.from({ length: 1205 }, (_, n) => ({
    id: `m${n}`, tenant_id: 'tenant', first_name: n === 1204 ? 'Find me' : `Person ${n}`,
    email: n === 0 ? 'deleted_x@deleted.local' : null, status: 'disabled',
  }));
  const agreements = members.map(m => ({ id: `a${m.id}`, provider: 'gocardless', tenant_id: 'tenant', member_id: m.id }));
  const plans = agreements.map((a, n) => ({
    id: String(n).padStart(4, '0'), provider: 'gocardless', tenant_id: 'tenant', member_id: a.member_id,
    billing_agreement_id: a.id, status: 'first_payment_pending',
    updated_at: '2026-01-01', membership_billing_agreements: a,
  }));
  const tables = {
    member: members, membership_billing_agreements: agreements, membership_payment_plans: plans,
    member_membership_history: [{ id: 'history', tenant_id: 'tenant', billing_agreement_id: agreements[1204].id, status: 'pending_activation' }],
  };
  const calls = [];
  return { calls, from(table) {
    const filters = [], ordering = [];
    const execute = () => {
      let rows = (tables[table] || []).filter(r => filters.every(f => f(r)));
      rows = [...rows].sort((a, b) => {
        for (const [key, ascending] of ordering) {
          const cmp = String(a[key]).localeCompare(String(b[key]));
          if (cmp) return ascending ? cmp : -cmp;
        }
        return 0;
      });
      return rows;
    };
    return {
      select() { return this; },
      eq(k, v) { filters.push(r => r[k] === v); return this; },
      in(k, values) { filters.push(r => values.includes(r[k])); return this; },
      order(k, opts = {}) { ordering.push([k, opts.ascending !== false]); return this; },
      async range(start, end) {
        calls.push({ table, start, end, ordering });
        return { data: execute().slice(start, end + 1) };
      },
      then(resolve) { resolve({ data: execute() }); },
    };
  } };
}

test('plans search is applied to complete eligible population before paging, including first-payment pending imports', async () => {
  const db = fixture();
  const result = await listPlans('tenant', { q: 'find me', page: 1, pageSize: 10 }, db);
  assert.equal(result.total, 1);
  assert.equal(result.plans[0].id, '1204');
  assert.equal(result.hasMore, false);
  const ranges = db.calls.filter(c => c.table === 'membership_payment_plans');
  assert.equal(ranges.length, 3);
  assert.deepEqual(ranges[0].ordering, [['updated_at', false], ['id', true]]);
});

test('deleted rows cannot occupy pages or inflate totals; disabled/null email rows remain visible', async () => {
  const db = fixture();
  const first = await listPlans('tenant', { pageSize: 200 }, db);
  const second = await listPlans('tenant', { page: 2, pageSize: 200 }, db);
  assert.equal(first.total, 1204);
  assert.equal(first.plans[0].id, '0001');
  assert.equal(second.plans[0].id, '0201');
  assert.equal(first.hasMore, true);
  assert.equal(new Set([...first.plans, ...second.plans].map(p => p.id)).size, 400);
});

test('pending activation filtering also precedes pagination', async () => {
  const result = await listPlans('tenant', { status: 'pending_activation' }, fixture());
  assert.equal(result.total, 1);
  assert.equal(result.plans[0].id, '1204');
});