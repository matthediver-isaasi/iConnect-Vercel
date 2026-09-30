import test from 'node:test';
import assert from 'node:assert/strict';
import { runRenewals } from './ddRenewalPipeline.js';
import { processTenantDdRenewals } from './gocardlessDdRenewals.js';
import { recordingEffects, readonlyTenantDatabase } from './directDebitDryRunRuntime.js';
import { createMembershipSimulator } from './membershipSimulationCore.js';

const now = new Date('2026-01-01T00:00:00.000Z');
const config = {
  id: 'c', tenant_id: 't', structure_scope_type: 'member', start_mode: 'fixed_date',
  membership_start_month: 1, membership_start_day: 1, pricing_model: 'flat',
  flat_cost: 120, dd_enabled: true, dd_monthly_amount: 10, dd_instalment_count: 12,
  currency: 'GBP', billing_period: 'annual', dd_policy_version: 1, dd_collection_end_policy: 'continue', dd_pricing_policy: 'fixed',
};
const agreement = {
  id: 'a', tenant_id: 't', member_id: 'm', provider: 'gocardless', created_at: '2025-01-01',
  metadata: { dd: {
    kind: 'monthly_direct_debit', membership_year_start: '2025-01-01', membership_year: '2025',
    start_mode: 'fixed_date', config_id: 'c',
    collection_policy: { version: 1, end_policy: 'continue', pricing_policy: 'fixed' },
  } },
};
const plan = { id: 'p', tenant_id: 't', billing_agreement_id: 'a', status: 'active' };
const clone = value => structuredClone(value);
function fixture({ paused = false, debt = 0, latest = 'a', planId = 'p', rolling = false, auto = false, failTable } = {}) {
  const a = clone(agreement), p = { ...plan, id: planId };
  if (rolling) a.metadata.dd.commitment = {
    term_key: 'fixed:2025-01-01', term_start_date: '2025-01-01', term_end_date: '2025-12-31',
    membership_renewal_date: '2026-01-01', term_anchor_date: '2025-01-01', term_duration_months: 12,
    commitment_snapshot: { start_mode: 'fixed_date', config },
  };
  const tables = {
    membership_billing_agreements: [a, ...(latest !== 'a' ? [{ ...a, id: latest, created_at: '2025-02-01' }] : [])],
    member: [{ id: 'm', tenant_id: 't', membership_paused: paused, first_name: 'Test', email: 'test@example.test', created_on: '2025-01-01' }],
    membership_payment_plans: [p], membership_tier_config: [clone(config)],
    membership_monthly_arrears_period: Array.from({ length: debt }, (_, n) => ({ id: `debt${n}`, tenant_id: 't', plan_id: 'p', settled_at: null })),
    membership_dd_renewals: auto ? [{ id: 'r', tenant_id: 't', previous_agreement_id: 'a', renewal_year: '2026', mode: 'auto', status: 'notice_sent' }] : [],
    member_membership_history: [{ id: 'h', tenant_id: 't', member_id: 'm', billing_agreement_id: 'a', membership_year: '2025', payment_method: 'direct_debit' }],
  };
  const reads = [], mutations = [];
  const field = (r, k) => k.split(/->>?/).reduce((v, key) => v?.[key], r);
  const db = { from(table) {
    const filters = [], orders = [];
    let single = false, limit = Infinity, count = false;
    const q = {
      select(_columns, options) { count = !!options?.count; return q; },
      eq(k, v) { filters.push(r => field(r, k) === v); return q; },
      in(k, v) { filters.push(r => v.includes(field(r, k))); return q; },
      is(k, v) { filters.push(r => (field(r, k) ?? null) === v); return q; },
      gt(k, v) { filters.push(r => field(r, k) > v); return q; },
      or(expression) {
        filters.push(r => expression.split(',').some(clause => {
          const [key, operator, ...rest] = clause.split('.'), value = rest.join('.');
          const actual = field(r, key);
          if (operator === 'is') return actual == null;
          if (operator === 'eq') return String(actual) === value;
          if (operator === 'lte') return actual <= value;
          if (operator === 'gte') return actual >= value;
          throw new Error(`Unexpected fixture filter ${clause}`);
        })); return q;
      },
      order(k, opts) { orders.push([k, opts?.ascending !== false]); return q; },
      limit(n) { limit = n; return q; }, maybeSingle() { single = true; return q; },
      then(resolve, reject) {
        reads.push(table);
        if (table === failTable) return Promise.resolve({ data: null, error: { message: 'read unavailable' } }).then(resolve, reject);
        const rows = (tables[table] || []).filter(r => filters.every(f => f(r))).sort((a, b) => {
          for (const [k, asc] of orders) { const c = String(a[k]).localeCompare(String(b[k])); if (c) return asc ? c : -c; }
          return 0;
        }).slice(0, limit);
        return Promise.resolve({ data: single ? rows[0] || null : rows, ...(count ? { count: rows.length } : {}) }).then(resolve, reject);
      },
      insert() { mutations.push(table); assert.fail('raw insert forbidden'); },
      update() { mutations.push(table); assert.fail('raw update forbidden'); },
      upsert() { mutations.push(table); assert.fail('raw upsert forbidden'); },
    };
    return q;
  }, rpc() { assert.fail('RPC forbidden'); } };
  return { db, agreement: a, plan: { ...p, id: 'p' }, reads, mutations };
}
const quote = async () => ({
  success: true, config, currency: 'GBP', annualCost: 120, finalCost: 120,
  membershipYear: { label: '2026', start: new Date('2026-01-01'), end: new Date('2026-12-31') },
});

test('real cron and scoped preview construct identical first operations for notice and automatic reservation', async () => {
  for (const scenario of [{}, { rolling: true }, { auto: true }, { rolling: true, auto: true }]) {
    const live = fixture(scenario), preview = fixture(scenario), liveOps = [], previewOps = [];
    await assert.rejects(processTenantDdRenewals('t', { details: [] }, {
      db: live.db, now: () => now, simulate: quote, effects: recordingEffects(liveOps),
    }), { code: 'DD_DRY_RUN_EFFECT_BOUNDARY' });
    await assert.rejects(runRenewals({
      ...preview, db: readonlyTenantDatabase(preview.db, 't'), now,
      simulate: quote, effects: recordingEffects(previewOps),
    }), { code: 'DD_DRY_RUN_EFFECT_BOUNDARY' });
    assert.deepEqual(previewOps, liveOps);
    assert.equal(previewOps.length, 1);
    assert.equal(previewOps[0].amountMinor, 1000);
    assert.equal(previewOps[0].currency, 'GBP');
    assert.deepEqual(live.mutations, []);
    assert.deepEqual(preview.mutations, []);
  }
});

test('scoped preview honors pause, debt, superseding agreement, and latest payment plan', async () => {
  for (const [options, reason] of [
    [{ paused: true }, 'Membership paused'], [{ debt: 1 }, 'unresolved monthly arrears block renewal'],
    [{ latest: 'newer' }, 'superseded by a later owner agreement'],
    [{ planId: 'newer' }, 'selected plan is not the latest agreement payment plan'],
  ]) {
    const f = fixture(options), operations = [];
    const result = await runRenewals({ ...f, now, effects: recordingEffects(operations) });
    assert.equal(result.reason, reason);
    assert.deepEqual(operations, []);
  }
});

test('actual successor pricing executes against the injected read client only', async () => {
  const f = fixture(), ops = [];
  await assert.rejects(runRenewals({ ...f, now, effects: recordingEffects(ops) }), { code: 'DD_DRY_RUN_EFFECT_BOUNDARY' });
  assert.equal(ops[0].amountMinor, 1000);
  assert.ok(f.reads.includes('member_membership_invoicing'));
  assert.ok(f.reads.includes('membership_tier_config'));
});

test('a simulator read failure cannot be swallowed into authority to send a notice', async () => {
  const f = fixture({ failTable: 'membership_tier_vat_override' }), ops = [];
  await assert.rejects(runRenewals({ ...f, now, effects: recordingEffects(ops) }), /Renewal read failed/);
  assert.deepEqual(ops, []);
});

test('injected simulator has no production database fallback', async () => {
  await assert.rejects(createMembershipSimulator({ from() { throw new Error('fixture read denied'); } })
    .simulateMembershipForMember('t', 'm'), /fixture read denied/);
});

test('live effect results control notice completion or failure, preview never fabricates those results', async () => {
  for (const delivered of [true, false]) {
    const f = fixture({ rolling: true }), operations = [], results = { details: [] };
    await processTenantDdRenewals('t', results, {
      db: f.db, now: () => now, simulate: quote,
      effects: { async perform(operation) {
        operations.push(operation);
        if (operation.type === 'renewal.email') {
          if (!delivered) throw new Error('delivery failed');
          return { sent: true };
        }
        if (operation.payload.calls[0][0] === 'insert') return { data: { id: 'claim' } };
        return { data: null };
      } },
    });
    assert.deepEqual(operations.map(op => op.type), ['renewal.database', 'renewal.email', 'renewal.database']);
    const completion = operations[2].payload.calls[0][1][0];
    assert.equal(completion.status, delivered ? 'notice_sent' : 'notice_error');
    assert.equal(results.errors || 0, delivered ? 0 : 1);
    const preview = fixture({ rolling: true }), recorded = [];
    await assert.rejects(runRenewals({ ...preview, now, simulate: quote, effects: recordingEffects(recorded) }), { code: 'DD_DRY_RUN_EFFECT_BOUNDARY' });
    assert.deepEqual(recorded, [JSON.parse(JSON.stringify(operations[0]))]);
  }
});