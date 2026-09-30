import test from 'node:test';
import assert from 'node:assert/strict';
import handler from './gocardless-dd.js';
import { dryRunFixture } from './gocardless-dd.dry-run.test.mjs';
import { manualCollectionPeriodAllowed } from '../_lib/directDebitDynamicPipeline.js';

const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; }, setHeader() {} });
const auth = { getContext: async () => ({ tenantId: 'tenant', roleId: 'role', tenantUserId: 'finance-user' }),
  adminAccess: async () => true, featureAccess: async () => true };
const request = body => ({ method: 'POST', body, query: {} });
function fixture() {
  const f = dryRunFixture();
  const today = new Date().toISOString().slice(0, 10);
  const config = { id: 'config', tenant_id: 'tenant', dd_enabled: true, pricing_model: 'flat',
    currency: 'GBP', dd_monthly_amount: 24, structure_scope_type: 'member', start_mode: 'immediate' };
  Object.assign(f.tables.membership_payment_plans[0], { status: 'active', environment: 'sandbox', gocardless_mandate_id: 'MD12345',
    dynamic_next_collection_date: today, metadata: { collection_mode: 'dynamic', dynamic_first_date: today } });
  Object.assign(f.tables.membership_billing_agreements[0], { status: 'active', environment: 'sandbox', gocardless_mandate_id: 'MD12345',
    metadata: { dd: { currency: 'GBP', membership_year: today.slice(0, 4), instalment_count: 12, invoicing_mode: 'per_instalment',
      collection_policy: { version: 1, pricing_policy: 'dynamic', end_policy: 'stop' },
      commitment: { term_key: 'term', term_start_date: today, term_end_date: '2099-12-31', commitment_snapshot: { config } } } } });
  f.tables.membership_tier_config = [config];
  f.tables.gocardless_manual_collection_authorizations = [];
  f.writes = [];
  const from = f.db.from.bind(f.db);
  f.db.from = table => {
    const query = from(table);
    query.update = value => { f.writes.push({ table, value }); return query; };
    return query;
  };
  f.db.rpc = async (name, params) => {
    if (name === 'gocardless_manual_collection_due_date') {
      assert.equal(params.p_tenant_id, 'tenant');
      assert.equal(params.p_plan_id, 'plan');
      return { data: today };
    }
    f.writes.push({ name, params });
    if (name === 'authorize_gocardless_manual_collection') {
      f.tables.gocardless_manual_collection_authorizations.push({ id: 'auth', tenant_id: 'tenant', plan_id: 'plan', due_date: today });
      return { data: { id: 'auth' } };
    }
    if (name === 'reserve_gocardless_dynamic_collection') return { data: {
      id: 'reservation', tenant_id: 'tenant', plan_id: 'plan', collection_number: 1, due_date: today,
      amount_minor: 2400, currency: 'GBP', requested_charge_date: today, price_snapshot: params.p_price_snapshot,
      provider_evidence: params.p_provider_evidence, idempotency_key: params.p_idempotency_key,
    } };
    if (name === 'attach_gocardless_dynamic_payment') return { data: {} };
    assert.fail(`Unexpected RPC ${name}`);
  };
  f.provider = { getGocardlessEnvironment: () => 'sandbox',
    getMandate: async () => ({ status: 'active', next_possible_charge_date: today }),
    createPayment: async params => {
      f.writes.push({ name: 'provider', params });
      return { id: 'PM_TEST', amount: params.amountMinor, currency: params.currency, charge_date: params.chargeDate,
        status: 'pending_submission', links: { mandate: params.mandateId } };
    } };
  f.invoke = async (body, deps = {}) => {
    const res = response();
    await handler(request(body), res, { ...auth, db: f.db, collectionProvider: async () => f.provider, ...deps });
    return res;
  };
  return f;
}

test('manual collection RBAC, foreign plan and all client overrides fail before writes', async () => {
  const f = fixture();
  for (const action of ['preview_collection', 'run_collection']) {
    for (const dep of [{ adminAccess: async () => false }, { featureAccess: async () => false },
      { featureAccess: async (_r, key) => key !== 'commerce.monthly-finance-report' }]) {
      assert.equal((await f.invoke({ action, planId: 'plan' }, dep)).statusCode, 403);
    }
  }
  assert.equal((await f.invoke({ action: 'preview_collection', planId: 'foreign' })).statusCode, 404);
  for (const key of ['tenantId', 'amountMinor', 'mandateId', 'now', 'dueDate', 'manualTiming', 'force']) {
    assert.equal((await f.invoke({ action: 'preview_collection', planId: 'plan', [key]: 'evil' })).statusCode, 400);
  }
  assert.equal((await f.invoke({ action: 'run_collection', planId: 'plan' })).statusCode, 400);
  assert.deepEqual(f.writes, []);
});

test('confirmed scoped attempt uses canonical pipeline, reports actual payment, repeated period cannot run', async () => {
  const f = fixture();
  const preview = await f.invoke({ action: 'preview_collection', planId: 'plan' });
  assert.equal(preview.body.status, 'ready', JSON.stringify(preview.body));
  assert.equal(preview.body.confirmation.mandate, '••••2345');
  assert.equal(preview.body.confirmation.amountMinor, 2400);
  assert.deepEqual(f.writes, []);
  const body = { action: 'run_collection', planId: 'plan', confirmed: true,
    confirmationToken: preview.body.confirmation.token, reason: 'Finance reviewed this one period' };
  const result = await f.invoke(body);
  assert.equal(result.body.status, 'submitted', JSON.stringify(result.body));
  assert.deepEqual(result.body.payment, { id: 'PM_TEST', amountMinor: 2400, currency: 'GBP',
    date: f.tables.membership_payment_plans[0].dynamic_next_collection_date, status: 'pending_submission' });
  assert.equal(f.writes.filter(write => write.name === 'provider').length, 1);
  assert.equal((await f.invoke(body)).body.status, 'blocked');
  assert.equal(f.writes.filter(write => write.name === 'provider').length, 1);
  assert.equal(f.writes.find(write => write.name === 'authorize_gocardless_manual_collection').params.p_actor, 'tenant_user:finance-user');
  assert.ok(f.writes.filter(write => write.name === 'reserve_gocardless_dynamic_collection')
    .every(write => write.params.p_plan_id === 'plan' && write.params.p_provider_evidence.manual_authorization_id === 'auth'));
});

test('authenticated member and dual identities record the correct actor and trimmed reason', async () => {
  for (const [ids, actor] of [
    [{ memberId: 'finance-member' }, 'member:finance-member'],
    [{ tenantUserId: 'finance-user', memberId: 'finance-member' }, 'tenant_user:finance-user'],
  ]) {
    const f = fixture();
    const deps = { getContext: async () => ({ tenantId: 'tenant', roleId: 'role', ...ids }) };
    const preview = await f.invoke({ action: 'preview_collection', planId: 'plan' }, deps);
    const result = await f.invoke({ action: 'run_collection', planId: 'plan', confirmed: true,
      confirmationToken: preview.body.confirmation.token, reason: `  ${'r'.repeat(500)}  ` }, deps);
    assert.equal(result.body.status, 'submitted', JSON.stringify(result.body));
    const params = f.writes.find(write => write.name === 'authorize_gocardless_manual_collection').params;
    assert.equal(params.p_actor, actor);
    assert.equal(params.p_reason, 'r'.repeat(500));
  }
});

test('missing authenticated IDs fail closed, even with email or caller actor, without any effects', async () => {
  const f = fixture();
  f.db.from = () => assert.fail('No database reads expected');
  f.db.rpc = () => assert.fail('No RPC expected');
  const deps = { getContext: async () => ({ tenantId: 'tenant', roleId: 'role',
    email: 'ignored@example.test', member: { email: 'ignored@example.test' } }),
    collectionProvider: () => assert.fail('No provider access expected') };
  for (const action of ['preview_collection', 'run_collection']) {
    for (const extra of [{}, { actor: 'caller', actorEmail: 'caller@example.test' }]) {
      const result = await f.invoke({ action, planId: 'plan', ...(action === 'run_collection' ? {
        confirmed: true, confirmationToken: 'a'.repeat(64), reason: 'Valid finance reason',
      } : {}), ...extra }, deps);
      assert.equal(result.statusCode, 403);
      assert.equal(result.body.code, 'COLLECTION_ACTOR_REQUIRED');
    }
  }
  assert.deepEqual(f.writes, []);
});

test('confirmation and trimmed reason validation return distinct errors without effects', async () => {
  const f = fixture();
  f.db.from = () => assert.fail('No database reads expected');
  const body = { action: 'run_collection', planId: 'plan', confirmed: true,
    confirmationToken: 'a'.repeat(64), reason: 'Valid finance reason' };
  for (const invalid of [{ confirmed: false }, { confirmationToken: 'bad' }, { confirmationToken: null }]) {
    const result = await f.invoke({ ...body, ...invalid });
    assert.equal(result.statusCode, 400);
    assert.equal(result.body.code, 'COLLECTION_CONFIRMATION_REQUIRED');
  }
  for (const reason of [undefined, null, 123, ' '.repeat(20), '  short  ', 'r'.repeat(501)]) {
    const result = await f.invoke({ ...body, reason });
    assert.equal(result.statusCode, 400);
    assert.equal(result.body.code, 'COLLECTION_REASON_INVALID');
  }
  assert.deepEqual(f.writes, []);
});

test('ambiguous provider acceptance never retries and changed confirmation fails closed', async () => {
  const f = fixture();
  const preview = (await f.invoke({ action: 'preview_collection', planId: 'plan' })).body;
  const body = { action: 'run_collection', planId: 'plan', confirmed: true,
    confirmationToken: preview.confirmation.token, reason: 'Finance approved early processing' };
  assert.equal((await f.invoke({ ...body, confirmationToken: 'a'.repeat(64) })).statusCode, 409);
  assert.deepEqual(f.writes, []);
  f.provider.createPayment = async () => { throw new Error('Provider response lost'); };
  assert.equal((await f.invoke(body)).body.status, 'uncertain');
  assert.equal((await f.invoke(body)).body.status, 'blocked');
});

test('provider acceptance plus local attach failure returns known payment evidence without success or retry', async () => {
  const f = fixture();
  const rpc = f.db.rpc;
  f.db.rpc = async (name, params) => name === 'attach_gocardless_dynamic_payment'
    ? { error: { message: 'Local attachment unavailable' } } : rpc(name, params);
  const preview = (await f.invoke({ action: 'preview_collection', planId: 'plan' })).body;
  const body = { action: 'run_collection', planId: 'plan', confirmed: true,
    confirmationToken: preview.confirmation.token, reason: 'Finance reviewed this collection' };
  const result = await f.invoke(body);
  assert.equal(result.body.status, 'uncertain');
  assert.equal(result.body.payment.id, 'PM_TEST');
  assert.equal(result.body.errors[0].code, 'COLLECTION_EXECUTION_FAILED');
  assert.doesNotMatch(JSON.stringify(result.body), /Local attachment/);
  assert.equal((await f.invoke(body)).body.status, 'blocked');
  assert.equal(f.writes.filter(write => write.name === 'provider').length, 1);
});

test('provider IDs, request paths and raw errors never reach preview or execution responses', async () => {
  const f = fixture();
  const sensitive = 'GET /mandates/MD_FULL_SECRET_OWNER_123 failed at /private/provider-client.js';
  f.provider.getMandate = async () => { throw new Error(sensitive); };
  const blocked = await f.invoke({ action: 'preview_collection', planId: 'plan' });
  assert.equal(blocked.body.errors[0].code, 'COLLECTION_PREFLIGHT_FAILED');
  assert.doesNotMatch(JSON.stringify(blocked.body), /MD_FULL|mandates\/|private\/|provider-client/);
  const live = fixture();
  const preview = (await live.invoke({ action: 'preview_collection', planId: 'plan' })).body;
  live.provider.createPayment = async () => { throw new Error(sensitive); };
  const result = await live.invoke({ action: 'run_collection', planId: 'plan', confirmed: true,
    confirmationToken: preview.confirmation.token, reason: 'Finance reviewed early collection' });
  assert.equal(result.body.status, 'uncertain');
  assert.equal(result.body.errors[0].code, 'COLLECTION_EXECUTION_FAILED');
  assert.doesNotMatch(JSON.stringify(result.body), /MD_FULL|mandates\/|private\/|provider-client/);
  assert.doesNotMatch(JSON.stringify(live.writes.filter(write => write.table)), /MD_FULL|mandates\/|private\/|provider-client/);
  const broken = fixture();
  broken.db.from = () => { throw new Error(sensitive); };
  const requestFailure = await broken.invoke({ action: 'preview_collection', planId: 'plan' });
  assert.equal(requestFailure.statusCode, 500);
  assert.equal(requestFailure.body.code, 'COLLECTION_REQUEST_FAILED');
  assert.doesNotMatch(JSON.stringify(requestFailure.body), /MD_FULL|mandates\/|private\/|provider-client/);
});

test('manual period bound permits tomorrow across month end, never next future period or arrears month', () => {
  const now = new Date('2026-09-30T12:00:00Z');
  assert.equal(manualCollectionPeriodAllowed('2026-10-01', now), true);
  assert.equal(manualCollectionPeriodAllowed('2026-10-02', now), false);
  assert.equal(manualCollectionPeriodAllowed('2026-08-31', now), false);
  assert.equal(manualCollectionPeriodAllowed('2026-09-01', now), true);
});