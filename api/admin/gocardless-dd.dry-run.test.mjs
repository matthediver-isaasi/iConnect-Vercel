import test from 'node:test';
import assert from 'node:assert/strict';
import handler from './gocardless-dd.js';

const response = () => ({
  statusCode: 200, headers: {}, body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
  setHeader(key, value) { this.headers[key] = value; },
});
const request = planId => ({ method: 'POST', body: { action: 'dry_run', planId }, query: {} });
const auth = {
  getContext: async () => ({ tenantId: 'tenant', roleId: 'role' }),
  adminAccess: async () => true, featureAccess: async () => true,
};

export function dryRunFixture() {
  const tables = {
    member: [{ id: 'member', tenant_id: 'tenant', first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.test' }],
    membership_billing_agreements: [{ id: 'agreement', tenant_id: 'tenant', provider: 'gocardless', member_id: 'member', status: 'cancelled', metadata: {} }],
    membership_payment_plans: [{ id: 'plan', tenant_id: 'tenant', provider: 'gocardless', member_id: 'member', billing_agreement_id: 'agreement', status: 'cancelled', metadata: {} }],
  };
  const calls = [];
  const db = {
    from(table) {
      calls.push(table);
      const filters = [];
      const value = (row, key) => key.split(/->>?/).reduce((current, part) => current?.[part], row);
      let max = Infinity;
      const rows = () => (tables[table] || []).filter(row => filters.every(fn => fn(row))).slice(0, max);
      return {
        select() { return this; }, order() { return this; },
        eq(k, v) { filters.push(row => value(row, k) === v); return this; },
        neq(k, v) { filters.push(row => row[k] !== v); return this; },
        in(k, values) { filters.push(row => values.includes(row[k])); return this; },
        is(k, v) { filters.push(row => (row[k] ?? null) === v); return this; },
        lte(k, v) { filters.push(row => row[k] != null && row[k] <= v); return this; },
        lt(k, v) { filters.push(row => row[k] != null && row[k] < v); return this; },
        gte(k, v) { filters.push(row => row[k] != null && row[k] >= v); return this; },
        gt(k, v) { filters.push(row => row[k] != null && row[k] > v); return this; },
        not(k, op, v) { filters.push(row => (row[k] ?? null) !== v); return this; },
        or() { return this; }, contains() { return this; },
        limit(n) { max = n; return this; },
        range(start, end) { return Promise.resolve({ data: rows().slice(start, end + 1), error: null }); },
        maybeSingle() { return Promise.resolve({ data: rows()[0] || null, error: null }); },
        single() { return this.maybeSingle(); },
        then(resolve) { return Promise.resolve({ data: rows(), error: null }).then(resolve); },
        insert() { assert.fail('Database insert'); }, update() { assert.fail('Database update'); },
        upsert() { assert.fail('Database upsert'); }, delete() { assert.fail('Database delete'); },
      };
    },
    rpc() { assert.fail('RPC/claim forbidden'); },
  };
  return { db, calls, tables };
}

test('dry run actual endpoint gates authentication, DD and finance before sensitive reads', async () => {
  for (const scenario of [
    { getContext: async () => { throw Error('No session'); }, code: 401 },
    { getContext: async () => ({}), code: 403 },
    { adminAccess: async () => false, code: 403 },
    { featureAccess: async () => false, code: 403 },
    { featureAccess: async (_role, feature) => feature !== 'commerce.monthly-finance-report', code: 403 },
  ]) {
    const res = response();
    await handler(request('plan'), res, {
      ...auth, db: { from() { assert.fail('Unauthorized read'); } }, ...scenario,
      dryRunProvider() { assert.fail('Unauthorized provider access'); },
    });
    assert.equal(res.statusCode, scenario.code);
  }
});

test('dry run fails closed for foreign, non-DD, deleted and conflicting owners', async () => {
  for (const alter of [
    tables => { tables.membership_payment_plans[0].tenant_id = 'other'; },
    tables => { tables.membership_payment_plans[0].provider = 'stripe'; },
    tables => { delete tables.membership_billing_agreements[0].provider; },
    tables => { tables.member[0].email = 'deleted_x@deleted.local'; },
    tables => { tables.membership_billing_agreements[0].member_id = 'other'; },
    tables => { tables.member = []; },
  ]) {
    const { db, tables } = dryRunFixture(), res = response();
    alter(tables);
    await handler(request('plan'), res, {
      ...auth, db, dryRunProvider() { assert.fail('Provider must not be resolved'); },
    });
    assert.equal(res.statusCode, 404);
  }
});

test('dry run repeated actual endpoint evaluations perform no mutations or provider writes', async () => {
  const { db } = dryRunFixture();
  for (let index = 0; index < 2; index++) {
    const res = response();
    await handler(request('plan'), res, {
      ...auth, db, dryRunProvider() { throw new Error('Provider unavailable'); },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.plan.id, 'plan');
    assert.equal(res.body.plan.ownerLabel, 'Ada Lovelace');
    assert.equal(res.body.jobs.length, 4);
    assert.ok(res.body.jobs.every(job => job.stages.every(stage => stage.status !== 'error')),
      JSON.stringify(res.body.jobs));
    assert.equal(res.headers['Cache-Control'], 'private, no-store');
    assert.ok(res.body.limitations.length);
    const envelope = res.body.jobs.find(job => job.id === 'renewals').stages.find(stage => stage.stage === 'renewal-runner-envelope');
    assert.equal(envelope.status, 'unknown');
    assert.match(envelope.reason, /registered, unfinished billing opportunity/);
    assert.match(envelope.reason, /done flag, stage and row cursor/);
  }
});

test('actual endpoint reaches retry claim boundary using fresh provider reads, never collections', async () => {
  const { db, tables } = dryRunFixture();
  Object.assign(tables.membership_payment_plans[0], {
    status: 'payment_grace_period', auto_retry_payment_id: 'PM1',
    auto_retry_next_at: '2000-01-01', grace_expires_at: '2099-01-01',
    gocardless_mandate_id: 'MD1', amount_minor: 1250, currency: 'GBP',
  });
  tables.gocardless_payments = [{
    id: 'payment', tenant_id: 'tenant', plan_id: 'plan',
    gocardless_payment_id: 'PM1', status: 'failed', amount_minor: 1250, currency: 'GBP',
  }];
  tables.tenant_integrations = [{
    tenant_id: 'tenant', integration_type: 'gocardless', is_enabled: true,
    credentials: { auto_retry_enabled: true, access_token: 'isolated-test-not-a-real-token' },
  }];
  let reads = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail('No external network in isolated endpoint test');
  try {
    for (const providerFailure of [false, true]) {
      const res = response();
      await handler(request('plan'), res, {
        ...auth, db, dryRunProvider: async () => ({
          getMandate: async () => {
            reads++;
            if (providerFailure) throw new Error('Provider read failed');
            return { id: 'MD1', status: 'active' };
          },
          getPayment: async () => ({ id: 'PM1', status: 'failed' }),
          createPayment() { assert.fail('Collection request'); },
          retryPayment() { assert.fail('Retry request'); },
        }),
      });
      assert.equal(res.statusCode, 200);
      const retry = res.body.jobs.find(job => job.id === 'retries');
      assert.equal(retry.stages.at(-1).status, providerFailure ? 'error' : 'conditional');
      if (!providerFailure) {
        assert.equal(retry.stages.at(-1).operations[0].type, 'retry.claim');
        assert.equal(retry.stages.at(-1).operations[0].amountMinor, 1250);
      }
      assert.ok(retry.evidence.some(item => item.method === 'getMandate'));
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(reads >= 2);
});

test('actual endpoint records dynamic reservation reauthorization without RPC or provider mutations', async () => {
  const { db, tables } = dryRunFixture(), res = response();
  const today = new Date().toISOString().slice(0, 10);
  Object.assign(tables.membership_payment_plans[0], {
    status: 'active', dynamic_next_collection_date: today,
    metadata: { collection_mode: 'dynamic', dynamic_first_date: today },
  });
  Object.assign(tables.membership_billing_agreements[0], {
    status: 'active', gocardless_mandate_id: 'MD1',
    metadata: { dd: {
      collection_policy: { version: 1, pricing_policy: 'dynamic', end_policy: 'continue' },
      instalment_count: 12, commitment: { term_end_date: '2099-12-31', term_key: 'term' },
    } },
  });
  tables.gocardless_collection_reservations = [{
    id: 'reservation', tenant_id: 'tenant', plan_id: 'plan', status: 'reserved',
    collection_number: 1, due_date: today, requested_charge_date: today,
    amount_minor: 2500, currency: 'GBP', idempotency_key: 'isolated-key',
    price_snapshot: { monthly_amount_minor: 2500, currency: 'GBP' }, provider_evidence: {},
  }];
  await handler(request('plan'), res, {
    ...auth, db, dryRunProvider: async () => ({
      getMandate: async () => ({ status: 'active', next_possible_charge_date: today }),
      createPayment() { assert.fail('No collection may be sent'); },
    }),
  });
  assert.equal(res.statusCode, 200);
  const stages = res.body.jobs.find(job => job.id === 'reconciliation').stages;
  const dynamic = stages.find(stage => stage.stage === 'dynamic-collection');
  assert.equal(dynamic.status, 'conditional', JSON.stringify(dynamic));
  assert.equal(dynamic.operations[0].type, 'dynamic.reserve_collection');
  assert.equal(dynamic.operations[0].amountMinor, 2500);
  assert.equal(dynamic.operations[0].date, today);
  assert.ok(stages.some(stage => stage.stage === 'accounting-retry'), 'Other independent reconciliation sweeps still evaluated');
});

test('actual endpoint records independent arrears access and debt operations without acquiring either claim', async () => {
  const { db, tables } = dryRunFixture(), res = response();
  Object.assign(tables.membership_payment_plans[0], {
    status: 'payment_overdue', grace_expires_at: '2000-01-01',
    interval_unit: 'monthly', amount_minor: 3000, currency: 'GBP',
  });
  await handler(request('plan'), res, {
    ...auth, db, dryRunProvider: async () => { throw new Error('Provider was not needed before accrual'); },
  });
  assert.equal(res.statusCode, 200);
  const arrears = res.body.jobs.find(job => job.id === 'arrears');
  const conditional = arrears.stages.filter(stage => stage.status === 'conditional');
  assert.deepEqual(conditional.map(stage => stage.operations[0].type), ['arrears_transition', 'arrears_accrual']);
  assert.equal(conditional[1].operations[0].amountMinor, 3000);
  assert.match(conditional[1].reason, /resulting ledger/);
});

test('actual endpoint owner activation stops before compare-and-set and keeps other owner stages visible', async () => {
  const { db, tables } = dryRunFixture(), res = response();
  tables.member_membership_history = [{
    id: 'history', tenant_id: 'tenant', member_id: 'member', status: 'scheduled',
    scheduled_activation_date: '2000-01-01', membership_year: '2000/01',
    payment_status: 'paid', final_cost: 100,
  }];
  await handler(request('plan'), res, {
    ...auth, db, dryRunProvider: async () => { throw new Error('No provider evidence needed'); },
  });
  assert.equal(res.statusCode, 200);
  const renewals = res.body.jobs.find(job => job.id === 'renewals');
  const activation = renewals.stages.find(stage => stage.operations.some(operation => operation.type === 'owner.activate_scheduled'));
  assert.equal(activation?.status, 'conditional');
  assert.match(activation.reason, /compare-and-set/);
  assert.match(activation.operations[0].continuation, /compare-and-set/);
  assert.ok(renewals.stages.some(stage => /renewal/i.test(stage.stage) && stage !== activation), JSON.stringify(renewals.stages));
  assert.equal(tables.member_membership_history[0].status, 'scheduled');
});

test('actual endpoint failed policy read is unknown, not permission to apply a default policy', async () => {
  const { db, tables } = dryRunFixture(), res = response();
  Object.assign(tables.membership_payment_plans[0], { status: 'payment_overdue', grace_expires_at: '2000-01-01' });
  tables.membership_billing_agreements[0].metadata = { dd: { config_id: 'config' } };
  const originalFrom = db.from.bind(db);
  db.from = table => {
    const query = originalFrom(table);
    if (table === 'membership_tier_config') query.maybeSingle = async () => ({ data: null, error: { message: 'Tier read unavailable' } });
    return query;
  };
  await handler(request('plan'), res, { ...auth, db, dryRunProvider: async () => { throw new Error('Not needed'); } });
  assert.equal(res.statusCode, 200);
  const arrears = res.body.jobs.find(job => job.id === 'arrears');
  assert.ok(arrears.stages.some(stage => stage.status === 'error' && /Tier read unavailable/.test(stage.reason)));
  assert.ok(arrears.stages.every(stage => stage.operations.length === 0));
});

test('actual endpoint runs successor pricing with tenantless owner preferences and stops before renewal email', async () => {
  const { db, tables } = dryRunFixture(), res = response();
  const lastYear = String(new Date().getUTCFullYear() - 1);
  Object.assign(tables.membership_payment_plans[0], { status: 'active' });
  Object.assign(tables.membership_billing_agreements[0], {
    status: 'active', created_at: `${lastYear}-01-01`,
    metadata: { dd: {
      kind: 'monthly_direct_debit', membership_year_start: `${lastYear}-01-01`, membership_year: lastYear,
      start_mode: 'fixed_date', config_id: 'config',
      collection_policy: { version: 1, end_policy: 'continue', pricing_policy: 'fixed' },
    } },
  });
  tables.member[0].created_on = `${lastYear}-01-01`;
  tables.membership_tier_config = [{
    id: 'config', tenant_id: 'tenant', structure_scope_type: 'member', start_mode: 'fixed_date',
    membership_start_month: 1, membership_start_day: 1, pricing_model: 'flat',
    flat_cost: 120, dd_enabled: true, dd_monthly_amount: 10, dd_instalment_count: 12,
    currency: 'GBP', billing_period: 'annual', dd_policy_version: 1,
    dd_collection_end_policy: 'continue', dd_pricing_policy: 'fixed',
  }];
  tables.preference_field = [{ id: 'go-live', tenant_id: 'tenant', entity_scope: 'member', is_active: true, name: 'go_live' }];
  tables.member_preference_value = [{ member_id: 'member', field_id: 'go-live', value: `${lastYear}-01-01` }];
  tables.member_membership_history = [{
    id: 'history', tenant_id: 'tenant', member_id: 'member', billing_agreement_id: 'agreement',
    membership_year: lastYear, payment_method: 'direct_debit',
  }];
  const from = db.from.bind(db);
  let preferencesRead = false;
  db.from = table => {
    const query = from(table);
    if (table === 'member_preference_value') {
      preferencesRead = true;
      const eq = query.eq.bind(query);
      query.eq = (key, value) => {
        assert.notEqual(key, 'tenant_id', 'Real preference schema has no tenant_id');
        return eq(key, value);
      };
    }
    return query;
  };
  await handler(request('plan'), res, { ...auth, db, dryRunProvider: async () => { throw new Error('No provider read precedes notice'); } });
  assert.equal(res.statusCode, 200);
  const stages = res.body.jobs.find(job => job.id === 'renewals').stages;
  const notice = stages.find(stage => stage.operations.some(operation => operation.type === 'renewal.email'));
  assert.ok(notice, JSON.stringify(stages));
  assert.equal(notice.status, 'conditional');
  assert.equal(notice.operations[0].amountMinor, 1000);
  assert.ok(preferencesRead);
});

test('actual endpoint reconciles fresh remote payment evidence but never replays business events', async () => {
  const { db, tables } = dryRunFixture(), res = response();
  tables.gocardless_payments = [{
    id: 'payment', tenant_id: 'tenant', plan_id: 'plan', gocardless_payment_id: 'PM1',
    status: 'submitted', updated_at: '2000-01-01', amount_minor: 2400, currency: 'GBP',
  }];
  let reads = 0;
  await handler(request('plan'), res, {
    ...auth, db, dryRunProvider: async () => ({
      getPayment: async id => { assert.equal(id, 'PM1'); reads++; return { status: 'paid_out', links: {} }; },
      createPayment() { assert.fail('No collection'); },
      retryPayment() { assert.fail('No retry'); },
    }),
  });
  assert.equal(res.statusCode, 200);
  const reconciliation = res.body.jobs.find(job => job.id === 'reconciliation');
  const replay = reconciliation.stages.find(stage => stage.stage === 'stale-payments' && stage.status === 'conditional');
  assert.equal(replay?.operations[0].type, 'reconciliation.replay');
  assert.equal(reads, 1);
  assert.equal(tables.gocardless_payments[0].status, 'submitted');
  assert.ok(reconciliation.evidence.some(item => item.method === 'getPayment' && item.evidenceAt));
});

test('actual endpoint owner annual processing constructs a history insert but creates no record or invoice', async () => {
  const { db, tables } = dryRunFixture(), res = response();
  tables.member[0].created_on = '2020-01-01';
  tables.member_membership_invoicing = [{
    id: 'setting', tenant_id: 'tenant', member_id: 'member', invoicing_mode: 'automatic', membership_year: null,
  }];
  tables.membership_tier_config = [{
    id: 'config', tenant_id: 'tenant', is_active: true, structure_scope_type: 'member',
    start_mode: 'fixed_date', membership_start_month: 1, membership_start_day: 1,
    pricing_model: 'flat', flat_cost: 120, currency: 'GBP', billing_period: 'annual',
  }];
  tables.preference_field = [{ id: 'go-live', tenant_id: 'tenant', entity_scope: 'member', is_active: true, name: 'go_live' }];
  tables.member_preference_value = [{ member_id: 'member', field_id: 'go-live', value: '2020-01-01' }];
  await handler(request('plan'), res, { ...auth, db, dryRunProvider: async () => { throw new Error('No provider read needed'); } });
  assert.equal(res.statusCode, 200);
  const stages = res.body.jobs.find(job => job.id === 'renewals').stages;
  const annual = stages.find(stage => stage.operations.some(operation => operation.type === 'owner.annual_history_insert'));
  assert.ok(annual, JSON.stringify(stages));
  assert.equal(annual.status, 'conditional');
  assert.equal(annual.operations[0].currency, 'GBP');
  assert.match(annual.operations[0].continuation, /workflows|accounting|emails/i);
  assert.equal(tables.member_membership_history, undefined);
});