import test from 'node:test';
import assert from 'node:assert/strict';
import handler, { listPlans, exportPlansCsv } from './gocardless-dd.js';

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
    member_membership_history: [{ id: 'history', tenant_id: 'tenant', member_id: members[1204].id, billing_agreement_id: agreements[1204].id, status: 'pending_activation' }],
  };
  const calls = [];
  return { calls, tables, from(table) {
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

const response = () => ({
  statusCode: 200, headers: {}, body: null,
  status(code) { this.statusCode = code; return this; },
  setHeader(key, value) { this.headers[key] = value; },
  json(body) { this.body = body; return this; },
  send(body) { this.body = body; return this; },
});
const csvIds = res => res.body.slice(1).trimEnd().split('\r\n').slice(1).map(line => line.split(',')[0]);

test('CSV exports all matching pages in list order and ignores UI paging', async () => {
  const db = fixture(), res = response();
  await exportPlansCsv(res, 'tenant', { page: 20, pageSize: 1 }, db);
  assert.equal(csvIds(res).length, 1204);
  assert.deepEqual(csvIds(res), db.tables.membership_payment_plans.slice(1).map(p => p.id));
  assert.match(res.headers['Content-Disposition'], /^attachment; filename="dd-plans-\d{4}-\d{2}-\d{2}\.csv"$/);
  assert.equal(res.headers['Content-Type'], 'text/csv; charset=utf-8');
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
  for (const query of [
    { q: ' FIND ME ' }, { status: 'pending_activation' },
    { displayStatus: 'first_payment_pending', q: 'Person 12' },
    { status: 'active' }, { displayStatus: 'current' },
    { status: 'first_payment_pending', displayStatus: 'first_payment_pending', q: 'find me' },
  ]) {
    const csv = response();
    await exportPlansCsv(csv, 'tenant', query, db);
    const list = await listPlans('tenant', { ...query, pageSize: 200 }, db);
    assert.deepEqual(csvIds(csv), list.plans.map(p => p.id), JSON.stringify(query));
  }
});

test('CSV uses a minimal safe projection, readable statuses, blanks and decimal amounts', async () => {
  const db = fixture(), res = response();
  const member = db.tables.member[1204], plan = db.tables.membership_payment_plans[1204];
  member.first_name = '=Zoë, "测试"\r\nNext';
  member.email = '@unsafe';
  Object.assign(plan, { amount_minor: 12345, currency: 'GBP', retry_count: 0,
    metadata: { bnms_release_required: true, secret: 'DO NOT EXPORT' },
    gocardless_subscription_id: '+SUB' });
  await exportPlansCsv(res, 'tenant', { q: '@unsafe' }, db);
  assert.ok(res.body.startsWith('\ufeffPlan ID,Payer name,Payer email,Membership display status,Financial plan status,Amount (major currency units),Currency,Next charge date,Subscription ID,Collections held,Grace expiry,Retry count\r\n'));
  assert.match(res.body, /"'=Zoë, ""测试"" Next",'@unsafe,Awaiting first payment,Awaiting first payment,123\.45,GBP,,'\+SUB,Yes,,0\r\n$/);
  assert.ok(!res.body.includes('DO NOT EXPORT'));
  plan.amount_minor = null; plan.retry_count = null;
  await exportPlansCsv(res, 'tenant', { q: '@unsafe' }, db);
  assert.match(res.body, /Awaiting first payment,,GBP,,'\+SUB,Yes,,\r\n$/);
  for (const [amount, expected] of [[0, '0.00'], [1, '0.01'], [1099, '10.99']]) {
    plan.amount_minor = amount; plan.currency = 'EUR';
    await exportPlansCsv(res, 'tenant', { q: '@unsafe' }, db);
    assert.ok(res.body.includes(`,${expected},EUR,`));
  }
});

test('CSV excludes other tenants, providers, missing owners and discovery-only mandates', async () => {
  const db = fixture(), res = response();
  db.tables.membership_payment_plans[1].tenant_id = 'other';
  db.tables.membership_payment_plans[2].provider = 'stripe';
  db.tables.membership_billing_agreements[3].provider = 'stripe';
  db.tables.member.splice(4, 1);
  db.tables.gocardless_mandates = [{ id: 'discovery', tenant_id: 'tenant' }];
  await exportPlansCsv(res, 'tenant', {}, db);
  assert.equal(csvIds(res).length, 1200);
  assert.equal(csvIds(res)[0], '0005');
  assert.ok(!db.calls.some(c => c.table === 'gocardless_mandates'));
  await exportPlansCsv(res, 'tenant', { q: 'no matching owner' }, db);
  assert.equal(res.body.split('\r\n').length, 2);
});

test('actual export route enforces authentication, tenant admin and feature gates before reads', async () => {
  for (const scenario of [
    { getContext: async () => { throw Error('no session'); }, code: 401 },
    { getContext: async () => ({}), code: 403 },
    { adminAccess: async () => false, code: 403 },
    { featureAccess: async () => false, code: 403 },
  ]) {
    const res = response();
    await handler({ method: 'GET', query: { view: 'plans_export' } }, res, {
      db: { from() { assert.fail('Denied requests must not read'); } },
      getContext: async () => ({ tenantId: 'tenant', roleId: 'role' }),
      adminAccess: async () => true, featureAccess: async () => true, ...scenario,
    });
    assert.equal(res.statusCode, scenario.code);
    assert.equal(res.headers['Content-Disposition'], undefined);
  }
});

test('later page and enrichment errors fail export without a partial attachment', async () => {
  for (const failingTable of ['membership_payment_plans', 'member', 'member_membership_history']) {
    const db = fixture(), from = db.from.bind(db), res = response();
    db.from = table => {
      const builder = from(table);
      if (table === failingTable) {
        const range = builder.range.bind(builder);
        builder.range = async (start, end) => table !== 'membership_payment_plans' || start >= 500
          ? { error: { message: 'Read failed; retry export' } } : range(start, end);
        if (table === 'member') builder.then = resolve => resolve({ error: { message: 'Read failed; retry export' } });
      }
      return builder;
    };
    await handler({ method: 'GET', query: { view: 'plans_export' } }, res, {
      db, getContext: async () => ({ tenantId: 'tenant' }), adminAccess: async () => true,
    });
    assert.equal(res.statusCode, 500);
    assert.match(res.body.error, /Read failed/);
    assert.equal(res.headers['Content-Disposition'], undefined);
  }
});

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