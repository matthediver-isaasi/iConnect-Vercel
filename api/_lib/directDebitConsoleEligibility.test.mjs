import test from 'node:test';
import assert from 'node:assert/strict';
import { filterConsoleRows, readConsoleRows, paginateConsolePlans } from './directDebitConsoleEligibility.js';

function fixture(tables, error = null) {
  return { from(table) {
    const filters = [];
    return { select() { return this; },
      eq(k, v) { filters.push(r => r[k] === v); return this; },
      in(k, values) { filters.push(r => values.includes(r[k])); return this; },
      then(resolve) { resolve({ data: (tables[table] || []).filter(r => filters.every(f => f(r))), error }); },
    };
  } };
}
const member = (id, email = null, tenant_id = 't') => ({ id, email, tenant_id });

test('console uses only exact anonymisation deletion signal; preserves null-email and disabled members', async () => {
  const db = fixture({ organization: [{ id: 'org', tenant_id: 't' }], member: [
    member('null'), { ...member('disabled', 'person@example.org'), status: 'disabled' },
    member('deleted', 'DELETED_abc@DELETED.LOCAL'), member('similar', 'deleted_@deleted.local'),
    member('foreign', null, 'other'),
  ] });
  const rows = ['null', 'disabled', 'deleted', 'similar', 'missing', 'foreign'].map(member_id => ({ member_id }));
  rows.push({ organization_id: 'org' });
  assert.deepEqual(await filterConsoleRows(db, 't', rows), [rows[0], rows[1], rows[3], rows[6]]);
});

test('org-only relationships require existing same-tenant canonical organizations without owner conflicts', async () => {
  const db = fixture({
    organization: [{ id: 'org', tenant_id: 't' }, { id: 'org2', tenant_id: 't' }, { id: 'foreign', tenant_id: 'other' }],
    membership_billing_agreements: [{ id: 'a', tenant_id: 't', organization_id: 'org' }],
    membership_payment_plans: [{ id: 'p', tenant_id: 't', billing_agreement_id: 'a', organization_id: 'org' }],
  });
  const rows = [{ plan_id: 'p' }, { organization_id: 'org' }, { organization_id: 'missing' },
    { organization_id: 'foreign' }, { billing_agreement_id: 'a', organization_id: 'org2' }];
  assert.deepEqual(await filterConsoleRows(db, 't', rows), rows.slice(0, 2));
});

test('canonical plan and agreement owners must all resolve within tenant without conflicts', async () => {
  const db = fixture({
    member: [member('ok'), member('deleted', 'deleted_x@deleted.local')],
    membership_billing_agreements: [
      { id: 'a', tenant_id: 't', member_id: 'ok' },
      { id: 'gone', tenant_id: 't', member_id: 'deleted' },
      { id: 'other', tenant_id: 'other', member_id: 'ok' },
    ],
    membership_payment_plans: [
      { id: 'p', tenant_id: 't', member_id: 'ok', billing_agreement_id: 'a' },
      { id: 'bad', tenant_id: 't', member_id: 'ok', billing_agreement_id: 'gone' },
    ],
  });
  const rows = [{ plan_id: 'p' }, { plan_id: 'bad' }, { billing_agreement_id: 'other' },
    { previous_agreement_id: 'gone' }, { plan_id: 'missing', member_id: 'ok' },
    { billing_agreement_id: 'a', member_id: 'deleted' }];
  assert.deepEqual(await filterConsoleRows(db, 't', rows), [rows[0]]);
});

test('lookup errors are explicit, never empty successful results', async () => {
  await assert.rejects(filterConsoleRows(fixture({}, { message: 'unavailable' }), 't', [{ member_id: 'a' }]), /unavailable/);
});

test('complete stable range reads discover records after first 200 and pagination exposes totals', async () => {
  const population = Array.from({ length: 1201 }, (_, id) => ({ id }));
  const ranges = [];
  const result = await readConsoleRows(() => ({ async range(start, end) {
    ranges.push([start, end]); return { data: population.slice(start, end + 1) };
  } }));
  assert.deepEqual(ranges, [[0, 499], [500, 999], [1000, 1499]]);
  assert.deepEqual(paginateConsolePlans(result.filter(r => r.id === 1200), {}), {
    plans: [{ id: 1200 }], total: 1, page: 1, pageSize: 50, hasMore: false,
  });
  assert.equal(paginateConsolePlans(result, { page: 2, pageSize: 200 }).plans[0].id, 200);
  assert.throws(() => paginateConsolePlans(result, { pageSize: 201 }), /pageSize/);
});