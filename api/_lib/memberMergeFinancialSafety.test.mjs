import test from 'node:test';
import assert from 'node:assert/strict';
import { activePaidMembership, readMemberMandates, checkMergeSourceDisposal } from './memberMergeFinancialSafety.js';
import { performMerge } from '../admin/members/merge.js';

const source = { id: 's', first_name: 'Source', email: 'source@test.invalid' };
const target = { id: 't', email: 'target@test.invalid' };
function database({ status = 'active', fail = false, failTable = null, billingStatus = 'completed' } = {}) {
  const writes = [];
  const tables = {
    membership_billing_agreements: [
      { id: 'old', tenant_id: 'tenant', member_id: 's', agreement_type: 'member', organization_id: null, status: billingStatus, gocardless_mandate_id: 'old-mandate', created_at: '2025-01-01' },
      { id: 'new', tenant_id: 'tenant', member_id: 's', agreement_type: 'member', organization_id: null, status: 'completed', created_at: '2026-01-01' },
      { id: 'foreign', tenant_id: 'other', member_id: 's', agreement_type: 'member', organization_id: null, status: 'active', gocardless_mandate_id: 'foreign' },
    ],
    membership_payment_plans: [],
    gocardless_mandates: [{ tenant_id: 'tenant', gocardless_mandate_id: 'old-mandate', status }],
  };
  return { writes, tables, from(table) {
    const filters = [];
    const q = {
      select() { return q; },
      eq(k, v) { filters.push(r => r[k] === v); return q; },
      is(k, v) { filters.push(r => (r[k] ?? null) === v); return q; },
      in(k, v) { filters.push(r => v.includes(r[k])); return q; },
      update() { writes.push(table); return q; }, insert() { writes.push(table); return q; },
      then(resolve) {
        const data = (tables[table] || []).filter(r => filters.every(f => f(r)));
        return Promise.resolve({ data, count: data.length, error: fail || table === failTable ? { message: 'offline' } : null }).then(resolve);
      },
    };
    return q;
  } };
}

for (const sourceDisposal of ['reassign', 'anonymise']) {
  test(`customer-only active mandate blocks ${sourceDisposal} without writes`, async () => {
    const db = database();
    db.tables.membership_billing_agreements = [];
    db.tables.gocardless_customers = [{ tenant_id: 'tenant', member_id: 's', organization_id: null,
      gocardless_customer_id: 'customer' }];
    db.tables.gocardless_mandates = [{ tenant_id: 'tenant', gocardless_customer_id: 'customer',
      gocardless_mandate_id: 'customer-only', status: 'active' }];
    const result = await performMerge({ db, source, target, sourceDisposal, coreFields: ['email', 'first_name'],
      callerTenantId: 'tenant' });
    assert.equal(result.status, 409);
    assert.match(result.body.error, /active GoCardless mandate/);
    assert.deepEqual(db.writes, []);
    db.tables.gocardless_customers[0].tenant_id = 'other';
    assert.equal((await readMemberMandates(db, { tenantId: 'tenant', memberId: 's' })).active, false);
  });
}

test('failed customer verification blocks disposal before writes', async () => {
  const db = database({ failTable: 'gocardless_customers', status: 'cancelled' });
  const result = await performMerge({ db, source, target, sourceDisposal: 'anonymise', callerTenantId: 'tenant' });
  assert.equal(result.status, 503);
  assert.match(result.body.error, /verification is incomplete/);
  assert.deepEqual(db.writes, []);
});

test('paid terms include collected instalments, not unpaid, future, expired or mandate-only rows', () => {
  const row = { status: 'active', payment_status: 'paid', term_start_date: '2026-01-01', term_end_date: '2026-12-31' };
  const active = r => activePaidMembership([r], 'tenant', new Date('2026-06-01'));
  assert.equal(active(row), true);
  assert.equal(active({ ...row, payment_status: 'partial' }), true);
  assert.equal(active({ ...row, payment_status: 'partial', payment_method: 'direct_debit', billing_agreement_id: 'agreement' }), true);
  assert.equal(active({ ...row, commitment_snapshot: { term_start_date: row.term_start_date, term_end_date: row.term_end_date } }), true);
  for (const change of [{ payment_status: 'unpaid' }, { payment_status: 'unverified' }, { status: 'scheduled' },
    { term_start_date: '2026-07-01' }, { term_end_date: '2026-05-31' }, { term_start_date: null }, { status: 'cancelled' }]) {
    assert.equal(active({ ...row, ...change }), false);
  }
  assert.equal(active({ gocardless_mandate_id: 'MD' }), false);
});

test('supported attested legacy paid membership retains unknown start but must not be expired', () => {
  const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
  const legacy = { tenant_id: tenant, membership_year: '2025/2026', status: 'active', payment_status: 'paid',
    payment_method: 'upfront', billing_period: 'annual', currency: 'GBP', tier_label: 'Full member',
    term_end_date: '2026-09-29', notes: { source: 'bnms_non_dd_current_backfill' },
    final_cost: 109, total_with_vat: 109 };
  assert.equal(activePaidMembership([legacy], tenant, new Date('2026-09-22')), true);
  assert.equal(activePaidMembership([legacy], tenant, new Date('2026-09-30')), false);
  assert.equal(activePaidMembership([legacy], 'other', new Date('2026-09-22')), false);
});

test('survivor change checks the new source, and replacement plan mandates are also inspected', async () => {
  const db = database({ status: 'cancelled' });
  db.tables.membership_payment_plans.push({ id: 'replacement', tenant_id: 'tenant', billing_agreement_id: 'old',
    organization_id: null, status: 'completed', gocardless_mandate_id: 'replacement' });
  db.tables.gocardless_mandates.push({ tenant_id: 'tenant', gocardless_mandate_id: 'replacement', status: 'active' });
  assert.equal((await checkMergeSourceDisposal(db, { source, target, tenantId: 'tenant' })).success, false);
  assert.equal((await checkMergeSourceDisposal(db, { source: target, target: source, tenantId: 'tenant' })).success, true);
});

test('new incomplete journey does not hide older active mandate; unrelated tenant evidence excluded', async () => {
  const db = database();
  const dd = await readMemberMandates(db, { tenantId: 'tenant', memberId: 's' });
  assert.equal(dd.active, true);
  assert.equal(dd.verified, true);
  assert.equal(dd.current.mandateId, null);
  db.tables.gocardless_mandates = [{ tenant_id: 'other', gocardless_mandate_id: 'old-mandate', status: 'active' }];
  assert.equal((await readMemberMandates(db, { tenantId: 'tenant', memberId: 's' })).verified, false);
});

for (const status of ['active', 'unknown', null]) {
  for (const sourceDisposal of ['reassign', 'anonymise']) {
    test(`${status} mandate blocks ${sourceDisposal} before email copy or any writes`, async () => {
      const db = database({ status });
      const result = await performMerge({ db, source, target, sourceDisposal, coreFields: ['email', 'first_name'], callerTenantId: 'tenant' });
      assert.ok([409, 503].includes(result.status));
      assert.match(result.body.error, /Source cannot be removed/);
      assert.deepEqual(db.writes, []);
    });
  }
}
test('normalized persisted emails do not bypass recurring billing, missing emails fail closed', async () => {
  for (const email of [' SOURCE@test.invalid ', 'source@test.invalid']) {
    const safe = await checkMergeSourceDisposal(database(), { source, target: { ...target, email }, tenantId: 'tenant' });
    assert.equal(safe.success, true);
    const blocked = await checkMergeSourceDisposal(database({ billingStatus: 'active' }), { source, target: { ...target, email }, tenantId: 'tenant' });
    assert.equal(blocked.success, false);
    assert.match(blocked.error, /unresolved recurring/);
  }
  for (const email of [null, '', '   ']) {
    assert.equal((await checkMergeSourceDisposal(database({ status: 'cancelled' }), {
      source, target: { ...target, email }, tenantId: 'tenant',
    })).status, 503);
  }
});
test('terminal mandate allows different emails; stale preview and read failure cannot authorize execution', async () => {
  const db = database({ status: 'cancelled' });
  assert.equal((await checkMergeSourceDisposal(db, { source, target, tenantId: 'tenant' })).success, true);
  db.tables.gocardless_mandates[0].status = 'active';
  assert.equal((await performMerge({ db, source, target, sourceDisposal: 'reassign', callerTenantId: 'tenant' })).status, 409);
  const failed = database({ fail: true });
  assert.equal((await performMerge({ db: failed, source, target, sourceDisposal: 'anonymise', callerTenantId: 'tenant' })).status, 503);
  assert.deepEqual(db.writes, []);
  assert.deepEqual(failed.writes, []);
});
