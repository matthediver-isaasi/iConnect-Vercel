import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  runDynamicCollection, runDynamicCompletion, runDynamicNotification,
} from './directDebitDynamicPipeline.js';
import { createLiveDynamicCollectionEffects } from './gocardlessDynamicCollections.js';
import { DryRunEffectBoundary, readonlyTenantDatabase } from './directDebitDryRunRuntime.js';

function fixture() {
  const now = new Date('2026-10-01T12:00:00Z');
  const config = { id: 'config', tenant_id: 'tenant', dd_enabled: true, pricing_model: 'flat',
    currency: 'GBP', dd_monthly_amount: 24, structure_scope_type: 'member', start_mode: 'immediate' };
  const plan = { id: 'plan', tenant_id: 'tenant', billing_agreement_id: 'agreement',
    provider: 'gocardless', status: 'active', dynamic_next_collection_date: '2026-10-01',
    metadata: { collection_mode: 'dynamic', dynamic_first_date: '2026-10-01' } };
  const agreement = { id: 'agreement', tenant_id: 'tenant', member_id: 'member',
    status: 'active', gocardless_mandate_id: 'MD1', metadata: { dd: {
      currency: 'GBP', membership_year: '2026', instalment_count: 12,
      invoicing_mode: 'per_instalment', collection_policy: { version: 1, pricing_policy: 'dynamic', end_policy: 'stop' },
      commitment: { term_key: 'term', term_start_date: '2026-10-01', term_end_date: '2027-09-30',
        commitment_snapshot: { config } },
    } } };
  const rows = { membership_payment_plans: [plan], membership_billing_agreements: [agreement],
    membership_tier_config: [config], membership_tier_vat_override: [], membership_monthly_arrears_period: [],
    gocardless_collection_reservations: [], gocardless_dynamic_term_completions: [] };
  const mutations = [], reads = [];
  const db = { from(table) {
    const filters = [];
    let single = false;
    const q = {
      select() { return q; }, order() { return q; }, limit() { return q; }, or() { return q; },
      eq(k, v) { filters.push(row => (k.includes('->>') ? row.metadata?.[k.split('->>')[1]] : row[k]) === v); return q; },
      neq(k, v) { filters.push(row => row[k] !== v); return q; },
      is(k, v) { filters.push(row => v === null ? row[k] == null : row[k] === v); return q; },
      in(k, v) { filters.push(row => v.includes(row[k])); return q; },
      lte(k, v) { filters.push(row => row[k] <= v); return q; },
      single() { single = true; return q; }, maybeSingle() { single = true; return q; },
      then(resolve) { const data = (rows[table] || []).filter(row => filters.every(f => f(row)));
        return Promise.resolve({ data: single ? data[0] || null : data }).then(resolve); },
      update() { mutations.push('update'); return q; },
    };
    return q;
  }, async rpc(name, params) {
    mutations.push(name);
    if (name === 'reserve_gocardless_dynamic_collection') {
      return { data: { id: 'reservation', tenant_id: 'tenant', plan_id: 'plan',
        collection_number: params.p_collection_number, due_date: params.p_due_date,
        amount_minor: params.p_price_snapshot.monthly_amount_minor, currency: 'GBP',
        requested_charge_date: '2026-10-05', price_snapshot: params.p_price_snapshot,
        provider_evidence: params.p_provider_evidence, idempotency_key: params.p_idempotency_key } };
    }
    return { data: {} };
  } };
  const gc = {
    async getMandate(id) { reads.push(id); return { status: 'active', next_possible_charge_date: '2026-10-05' }; },
    async createPayment(p) { mutations.push('createPayment'); return { id: 'PM1', amount: p.amountMinor,
      currency: p.currency, charge_date: p.chargeDate, links: { mandate: p.mandateId } }; },
  };
  return { db, rows, plan, agreement, now, gc, getGc: async () => gc, mutations, reads };
}

test('dynamic cron entry constructs identical priced reservation in live and recording modes', async () => {
  const live = fixture(), recording = fixture(), liveOps = [], previewOps = [];
  const interpreter = createLiveDynamicCollectionEffects(live);
  const result = await runDynamicCollection({ ...live,
    effects: { perform(op) { liveOps.push(op); return interpreter.perform(op); } } });
  await assert.rejects(runDynamicCollection({ ...recording,
    db: readonlyTenantDatabase(recording.db, 'tenant'),
    effects: { perform(op) { previewOps.push(op); throw new DryRunEffectBoundary(op); } },
  }), error => error.code === 'DD_DRY_RUN_EFFECT_BOUNDARY');
  assert.deepEqual(previewOps, liveOps);
  assert.equal(previewOps[0].amountMinor, 2400);
  assert.equal(previewOps[0].date, '2026-10-05');
  assert.deepEqual(recording.mutations, []);
  assert.deepEqual(recording.reads, live.reads);
  assert.match(result.detail, /scheduled/);
  assert.deepEqual(live.mutations, ['reserve_gocardless_dynamic_collection', 'reserve_gocardless_dynamic_collection', 'createPayment', 'attach_gocardless_dynamic_payment']);
});

test('failed reservation never submits a payment; failed provider validation never proposes reservation', async () => {
  const f = fixture();
  f.db.rpc = async () => ({ error: { message: 'owner paused concurrently' } });
  await assert.rejects(runDynamicCollection({ ...f, effects: createLiveDynamicCollectionEffects(f) }), /owner paused/);
  assert.deepEqual(f.mutations, []);
  f.gc.getMandate = async () => { throw Error('provider unavailable'); };
  await assert.rejects(runDynamicCollection({ ...f, effects: { perform() { assert.fail('No intended effect'); } } }), /provider unavailable/);
});

test('existing reservation reuses frozen amount and date; skips and held plans never fabricate effects', async () => {
  const f = fixture();
  f.rows.gocardless_collection_reservations.push({ status: 'reserved', tenant_id: 'tenant',
    plan_id: 'plan', collection_number: 1, due_date: '2026-10-01', amount_minor: 1700,
    currency: 'GBP', requested_charge_date: '2026-10-05', price_snapshot: { monthly_amount_minor: 1700, currency: 'GBP' } });
  await assert.rejects(runDynamicCollection({ ...f, effects: { perform(op) {
    assert.equal(op.amountMinor, 1700); assert.equal(op.payload.existing, true); throw new DryRunEffectBoundary(op);
  } } }), /Not executed/);
  f.plan.collection_stopped_at = '2026-09-30';
  await assert.rejects(runDynamicCollection({ ...f }), /blocked by agreement or plan lifecycle/);
  f.plan.provider = 'stripe';
  assert.match((await runDynamicCollection({ ...f })).detail, /Not due/);
  assert.deepEqual(f.mutations, []);
});

test('completion and notification independently stop before claims, emails and settlement', async () => {
  const f = fixture();
  const effects = { perform(op) { throw new DryRunEffectBoundary(op); } };
  await assert.rejects(runDynamicCompletion({ ...f, effects }), error =>
    error.operation.type === 'dynamic.complete_term' && error.operation.conditional);
  f.rows.gocardless_dynamic_term_completions.push({ tenant_id: 'tenant', plan_id: 'plan',
    notification_status: 'pending', notification_next_check_at: '2026-10-01T00:00:00Z' });
  await assert.rejects(runDynamicNotification({ ...f, effects }), error =>
    error.operation.type === 'dynamic.completion_notice' && error.operation.conditional);
  assert.deepEqual(f.mutations, []);
});

test('production cron uses the same entries and pure dynamic module has no production-client imports', async () => {
  const collection = await readFile(new URL('./gocardlessDynamicCollections.js', import.meta.url), 'utf8');
  const completion = await readFile(new URL('./gocardlessDynamicCompletion.js', import.meta.url), 'utf8');
  const pipeline = await readFile(new URL('./directDebitDynamicPipeline.js', import.meta.url), 'utf8');
  assert.match(collection, /await runDynamicCollection\(/);
  assert.match(completion, /await runDynamicCompletion\(/);
  assert.match(completion, /await runDynamicNotification\(/);
  assert.doesNotMatch(pipeline, /from ['"].*(database|gocardless\.js|Email|Simulation)/);
  assert.doesNotMatch(pipeline.replace("createHash('sha256').update(parts.join('|'))", ''), /db\.rpc|\.update\(|\.insert\(|createPayment\(/);
});