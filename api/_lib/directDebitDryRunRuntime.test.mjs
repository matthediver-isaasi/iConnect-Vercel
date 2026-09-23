import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readonlyTenantDatabase, readonlyGocardless, recordingEffects,
  evaluateDryRunJob, evaluateDryRunStages, DryRunEffectBoundary,
} from './directDebitDryRunRuntime.js';

test('database capability scopes before reads and denies every mutation/client escape', async () => {
  const seen = [];
  const raw = {
    from(table) {
      seen.push(['from', table]);
      return {
        select() { seen.push(['select']); return this; },
        eq(...args) { seen.push(['eq', ...args]); return this; },
        maybeSingle() { return Promise.resolve({ data: { id: 'plan' } }); },
        update() { assert.fail('raw write'); },
      };
    },
    rpc() { assert.fail('raw RPC'); },
  };
  const db = readonlyTenantDatabase(raw, 'tenant');
  assert.deepEqual(await db.from('membership_payment_plans').select('*').eq('id', 'plan').maybeSingle(), { data: { id: 'plan' } });
  assert.deepEqual(seen[2], ['eq', 'tenant_id', 'tenant']);
  for (const key of ['rpc', 'storage', 'auth', 'schema', 'constructor']) {
    assert.throws(() => db[key], /capability denied/);
  }
  const query = db.from('membership_payment_plans').select('*');
  for (const key of ['insert', 'upsert', 'update', 'delete', 'rpc', 'url', 'headers', 'fetch', 'constructor']) {
    assert.throws(() => query[key], /capability denied/);
  }
  assert.equal(Object.getPrototypeOf(query), null);
  await assert.rejects(async () => await db.from('member'), /without select/);
});

test('provider exposes fresh reads and non-secret identity only; denied calls never reach client', async () => {
  let reads = 0;
  const evidence = [];
  const gc = readonlyGocardless({
    credentials: { tenantId: 'tenant', environment: 'sandbox', accessToken: 'secret' },
    getPayment: async () => ({ status: ++reads === 1 ? 'failed' : 'paid_out' }),
    retryPayment() { assert.fail('provider write'); },
  }, { onEvidence: item => evidence.push(item) });
  assert.equal((await gc.getPayment('payment')).status, 'failed');
  assert.equal((await gc.getPayment('payment')).status, 'paid_out');
  assert.equal(evidence.length, 2);
  assert.equal(gc.credentials.accessToken, undefined);
  for (const key of ['retryPayment', 'createPayment', 'createSubscription', 'cancelMandate', 'request', 'constructor']) {
    assert.throws(() => gc[key], /capability denied/);
  }
});

test('recording never supplies a claim/provider success; errors and finally cannot write', async () => {
  const records = [];
  await assert.rejects(recordingEffects(records).perform({ type: 'claim', description: 'Claim payment', payload: { id: 'plan' } }), DryRunEffectBoundary);
  assert.equal(records.length, 1);
  const db = readonlyTenantDatabase({ from: () => ({ select() { return this; }, eq() { return this; } }) }, 'tenant');
  const context = { db, plan: { tenant_id: 'tenant' }, now: new Date('2026-01-01'), getGc: () => assert.fail('no provider call') };
  const result = await evaluateDryRunJob({
    id: 'retry', label: 'Retry',
    async run({ effects, db }) {
      try {
        await effects.perform({ type: 'claim', description: 'Reserve retry', payload: { private: true } });
        assert.fail('recording returned fake success');
      } finally {
        assert.throws(() => db.rpc('release_claim'), /capability denied/);
      }
    },
  }, context);
  assert.equal(result.stages[0].status, 'error');
  assert.match(result.stages[0].reason, /capability denied/);
});

test('provider failures remain errors, cross-tenant provider reads fail before client resolution', async () => {
  for (const otherTenant of [false, true]) {
    const result = await evaluateDryRunJob({
      id: 'retry', label: 'Retry',
      async run({ getGc }) { await (await getGc(otherTenant ? 'other' : 'tenant')).getPayment('payment'); },
    }, {
      plan: { tenant_id: 'tenant' }, now: new Date(),
      getGc: async () => ({ getPayment: async () => { throw new Error('Provider unavailable'); } }),
    });
    assert.equal(result.stages[0].status, 'error');
    assert.match(result.stages[0].reason, otherTenant ? /tenant mismatch/ : /Provider unavailable/);
  }
});

test('independent sweeps remain visible after another sweep stops at an effect', async () => {
  const result = await evaluateDryRunStages({
    id: 'arrears', label: 'Arrears',
    runners: [
      { id: 'access', run: ({ effects }) => effects.perform({ type: 'access.claim', description: 'Claim access policy' }) },
      { id: 'collections', run: ({ trace }) => trace({ stage: 'collections', status: 'skipped', reason: 'Not due' }) },
    ],
  }, { plan: { tenant_id: 'tenant' }, now: new Date(), getGc: () => assert.fail('no provider call') });
  assert.deepEqual(result.stages.map(stage => [stage.stage, stage.status]), [
    ['access', 'conditional'], ['collections', 'skipped'],
  ]);
});

test('independent sweeps never inherit hypothetical input mutations or clock changes', async () => {
  const plan = { tenant_id: 'tenant', status: 'active' };
  const now = new Date('2026-01-01');
  await evaluateDryRunStages({
    id: 'job', label: 'Job', runners: [
      { id: 'first', run: async ({ plan, now }) => { plan.status = 'cancelled'; now.setFullYear(2099); } },
      { id: 'second', run: async ({ plan, now: clock }) => {
        assert.equal(plan.status, 'active');
        assert.equal(clock.toISOString(), now.toISOString());
      } },
    ],
  }, { plan, now });
  assert.equal(plan.status, 'active');
  assert.equal(now.getUTCFullYear(), 2026);
});

test('swallowed boundaries cannot manufacture later recorded operations or successful traces', async () => {
  const result = await evaluateDryRunJob({
    id: 'test', label: 'Test',
    async run({ effects }) {
      try { await effects.perform({ type: 'claim', description: 'First claim' }); } catch {}
      try { await effects.perform({ type: 'collect', description: 'Must not infer later collection' }); } catch {}
    },
  }, { plan: { tenant_id: 'tenant' }, now: new Date() });
  assert.equal(result.stages.at(-1).status, 'conditional');
  assert.deepEqual(result.stages.at(-1).operations.map(item => item.type), ['claim']);
  assert.equal(result.stages.at(-1).operations[0].payload, undefined);
});

test('caught database failures cannot be converted into confident financial intent', async () => {
  const db = readonlyTenantDatabase({
    from() {
      return { select() { return this; }, eq() { return this; },
        then(resolve) { resolve({ data: null, error: { message: 'Read unavailable' } }); } };
    },
  }, 'tenant');
  const result = await evaluateDryRunJob({
    id: 'pricing', label: 'Pricing',
    async run({ db, effects }) {
      await db.from('membership_tier_config').select('*'); // Legacy helper ignores error.
      await effects.perform({ type: 'invoice', description: 'Unsafe fallback must not be presented' });
    },
  }, { db, plan: { tenant_id: 'tenant' }, now: new Date() });
  assert.equal(result.stages.at(-1).status, 'error');
  assert.match(result.stages.at(-1).reason, /Read unavailable/);
  assert.deepEqual(result.stages.at(-1).operations, []);
});

test('conditional continuation details survive the public operation serialization', async () => {
  const result = await evaluateDryRunJob({
    id: 'owner', label: 'Owner',
    run: ({ effects }) => effects.perform({
      type: 'owner.claim', description: 'Claim owner work',
      conditional: 'Invoices, emails and membership access depend on successful claim.',
      payload: { private: 'must not appear' },
    }),
  }, { plan: { tenant_id: 'tenant' }, now: new Date() });
  const operation = JSON.parse(JSON.stringify(result)).stages[0].operations[0];
  assert.equal(operation.conditional, true);
  assert.match(operation.continuation, /Invoices, emails and membership access/);
  assert.equal(operation.payload, undefined);
});

test('tenantless preference graph uses validated canonical owner, never caller-selected owners', async () => {
  const tables = {
    member_preference_value: [{ member_id: 'member', field_id: 'field', value: 'allowed' }, { member_id: 'foreign', field_id: 'field', value: 'secret' }],
    organization_preference_value: [{ organization_id: 'org', field_id: 'field', value: 'allowed' }, { organization_id: 'foreign', field_id: 'field', value: 'secret' }],
    system_settings: [
      { tenant_id: null, setting_key: 'xero_vat_rates_tenant', setting_value: 'allowed-cache' },
      { tenant_id: 'other', setting_key: 'xero_vat_rates_other', setting_value: 'secret' },
      { tenant_id: 'other', setting_key: 'xero_invoice_status', setting_value: 'secret' },
      { tenant_id: 'tenant', setting_key: 'xero_invoice_status', setting_value: 'allowed-setting' },
    ],
  };
  const raw = {
    from(table) {
      const filters = [];
      const result = () => (tables[table] || []).filter(row => filters.every(fn => fn(row)));
      return {
        select() { return this; },
        eq(key, value) {
          if (table.endsWith('_preference_value')) assert.notEqual(key, 'tenant_id', 'Real preference schema has no tenant_id');
          filters.push(row => row[key] === value);
          return this;
        },
        async maybeSingle() { return { data: result()[0] || null }; },
        then(resolve) { resolve({ data: result() }); },
      };
    },
  };
  assert.throws(() => readonlyTenantDatabase(raw, 'tenant').from('member_preference_value'), /without validated owner/);
  const reads = readonlyTenantDatabase(raw, 'tenant', { memberId: 'member', organizationId: 'org' });
  for (const [table, key] of [['member_preference_value', 'member_id'], ['organization_preference_value', 'organization_id']]) {
    assert.equal((await reads.from(table).select('*')).data[0].value, 'allowed');
    assert.equal((await reads.from(table).select('*').eq(key, 'foreign')).data.length, 0);
  }
  assert.equal((await reads.from('system_settings').select('*').eq('setting_key', 'xero_vat_rates_tenant').maybeSingle()).data.setting_value, 'allowed-cache');
  assert.equal((await reads.from('system_settings').select('*').eq('setting_key', 'xero_vat_rates_other').maybeSingle()).data, null);
  assert.equal((await reads.from('system_settings').select('*').eq('setting_key', 'xero_invoice_status').maybeSingle()).data.setting_value, 'allowed-setting');
  assert.deepEqual((await reads.from('system_settings').select('*')).data.map(row => row.setting_value), ['allowed-setting']);
});