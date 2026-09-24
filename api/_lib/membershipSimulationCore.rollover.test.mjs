import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateOriginalIncentiveRollover, createMembershipSimulator } from './membershipSimulationCore.js';
import { membershipIncentiveSnapshot } from './membershipIncentiveSnapshot.js';

const original = {
  id: 'original', tenant_id: 'tenant', start_mode: 'fixed_date', pricing_model: 'flat',
  flat_cost: 1833.47, membership_start_month: 8, membership_start_day: 1,
  currency: 'GBP', billing_period: 'annual', prorata_enabled: true,
  free_period_amount: 30, free_period_unit: 'percent', rollover_enabled: true,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
};
const year1 = {
  id: 'year1', tenant_id: 'tenant', organization_id: 'org', config_id: 'original',
  membership_year: '2026/2027', year_number: 1, status: 'active',
  annual_cost: 1833.47, free_period_discount: 477.71, free_period_days_applied: 0,
  created_at: '2026-09-18T00:00:00Z', commitment_snapshot: { config: original },
};
function rollover(changes = {}) {
  return calculateOriginalIncentiveRollover({
    history: year1, goLiveDate: '2026-09-18', annualCost: 1833.47, ...changes,
  });
}

// No SDK, environment variables, network, or write-capable client is involved.
function fixture({ history = [year1], config = original, overrides = [], extraConfigs = [], bands = [] } = {}) {
  const tables = {
    organization: [{ id: 'org', tenant_id: 'tenant', name: 'Isolated organisation' }],
    membership_tier_config: [config, ...extraConfigs],
    membership_tier_band: bands,
    organisation_membership_history: history,
    organisation_membership_override: overrides,
    preference_field: [{ id: 'go-live', tenant_id: 'tenant', name: 'go_live', entity_scope: 'organization', is_active: true }],
    organization_preference_value: [{ organization_id: 'org', field_id: 'go-live', value: '2026-09-18' }],
  };
  const reads = [];
  const db = { from(table) {
    reads.push(table);
    const filters = [];
    let single = false;
    const q = {
      select() { return q; }, eq(key, value) { filters.push(row => row[key] === value); return q; },
      or() { return q; }, order() { return q; }, limit() { return q; },
      maybeSingle() { single = true; return q; }, single() { single = true; return q; },
      then(resolve, reject) {
        const rows = (tables[table] || []).filter(row => filters.every(f => f(row)));
        return Promise.resolve({ data: single ? rows[0] || null : rows, error: null }).then(resolve, reject);
      },
      insert() { assert.fail('writes forbidden'); }, update() { assert.fail('writes forbidden'); },
      upsert() { assert.fail('writes forbidden'); }, delete() { assert.fail('writes forbidden'); },
    };
    return q;
  } };
  return { db, reads };
}
async function simulate(fixtureOptions = {}, options = {}, now = '2026-09-24') {
  const { db } = fixture(fixtureOptions);
  return createMembershipSimulator(db, () => new Date(`${now}T00:00:00Z`))
    .simulateMembershipForOrg('tenant', 'org', {
      configId: fixtureOptions.config?.id || original.id,
      source: 'simulate', targetYear: '2027/2028', ...options,
    });
}

test('recorded Year 1 retains the original £72.33, independent of current newness', async () => {
  const result = await simulate();
  assert.equal(result.success, true, result.error);
  assert.equal(result.isNewOrg, false);
  assert.equal(result.rolloverDiscount, 72.33);
  assert.equal(result.finalCost, 1761.14);
  assert.equal(result.freeDiscount, 0);
  assert.equal(result.incentiveRollover.originalEntitlement, 550.04);
  assert.equal(result.incentiveRollover.source, 'commitment_snapshot');
});

test('future asOfDate and exact renewal boundary preserve the same entitlement', async () => {
  for (const [now, options] of [
    ['2026-09-24', { asOfDate: '2027-08-01' }],
    ['2027-08-01', {}],
    ['2027-08-02', { source: 'manual' }],
  ]) {
    const result = await simulate({}, options, now);
    assert.equal(result.success, true, result.error);
    assert.equal(result.yearNumber, 2);
    assert.equal(result.rolloverDiscount, 72.33);
  }
});

test('later price, incentive, and rollover settings cannot reprice the original percentage', async () => {
  const result = await simulate({ config: { ...original, flat_cost: 4000, free_period_amount: 90, rollover_enabled: false } });
  assert.equal(result.success, true, result.error);
  assert.equal(result.rolloverDiscount, 72.33);
  assert.equal(result.finalCost, 3927.67);
});

test('day incentive uses recorded days and original daily valuation, never renewal rates', async () => {
  const config = { ...original, flat_cost: 3650, free_period_amount: 365, free_period_unit: 'days' };
  const history = [{ ...year1, annual_cost: 3650, free_period_discount: 3170, free_period_days_applied: 317,
    commitment_snapshot: { config } }];
  const result = await simulate({ history, config: { ...config, flat_cost: 7300, free_period_amount: 1 } });
  assert.equal(result.success, true, result.error);
  assert.equal(result.freePeriodDaysApplied, 48);
  assert.equal(result.rolloverDiscount, 480);
  assert.equal(result.finalCost, 6820);
});

test('price override suppresses rollover, discount override changes renewal price only', async () => {
  for (const [override, cost, discount] of [
    [{ override_type: 'price', manual_price: 100 }, 100, 0],
    [{ override_type: 'discount', discount_type: 'percentage', discount_value: 50 }, 844.4, 72.33],
  ]) {
    const result = await simulate({ overrides: [{ ...override, tenant_id: 'tenant', organization_id: 'org', membership_year: '2027/2028' }] });
    assert.equal(result.success, true, result.error);
    assert.equal(result.finalCost, cost);
    assert.equal(result.rolloverDiscount, discount);
  }
});

test('history-linked unchanged config is credible legacy evidence; later or missing timestamps are not', () => {
  const history = { ...year1, commitment_snapshot: null };
  assert.equal(rollover({ history, originalConfig: original }).appliedDiscount, 72.33);
  for (const config of [{ ...original, updated_at: '2027-01-01' }, { ...original, updated_at: null }, { ...original, id: 'later' }]) {
    assert.throws(() => rollover({ history, originalConfig: config }), { code: 'new_member_incentive_review_required' });
  }
});

test('incomplete usage fails closed instead of assuming zero consumption', () => {
  assert.throws(() => rollover({ history: { ...year1, free_period_discount: null } }), /usage must both be recorded/);
  assert.throws(() => rollover({ history: { ...year1, commitment_snapshot: null }, originalConfig: null }), /unavailable/);
});

test('fully consumed and originally disabled incentives do not revive under later settings', () => {
  assert.equal(rollover({ history: { ...year1, free_period_discount: 550.04 } }).appliedDiscount, 0);
  assert.equal(rollover({ history: { ...year1, commitment_snapshot: { config: { ...original, rollover_enabled: false } } } }).appliedDiscount, 0);
  assert.equal(rollover({ annualCost: 20 }).appliedDiscount, 20);
});

test('ambiguous records and changed legacy configuration return an explicit review response', async () => {
  for (const params of [
    { history: [year1, { ...year1, id: 'duplicate' }] },
    { history: [{ ...year1, commitment_snapshot: null }], config: { ...original, updated_at: '2027-01-01' } },
  ]) {
    const result = await simulate(params);
    assert.equal(result.success, false);
    assert.equal(result.code, 'new_member_incentive_review_required');
    assert.ok(result.error);
  }
});

test('unrecorded Year 1 flat-price preview is reconstructed only with unchanged original evidence', async () => {
  const result = await simulate({ history: [] });
  assert.equal(result.success, true, result.error);
  assert.equal(result.rolloverDiscount, 72.33);
  assert.equal(result.incentiveRollover.source, 'unchanged_joining_config');
  const changed = await simulate({ history: [], config: { ...original, updated_at: '2027-01-01' } });
  assert.equal(changed.success, false);
  assert.equal(changed.code, 'new_member_incentive_review_required');
});

test('date-based config resolution also respects future asOfDate', async () => {
  const result = await simulate({}, { configId: null, asOfDate: '2027-08-01' });
  assert.equal(result.success, true, result.error);
  assert.equal(result.rolloverDiscount, 72.33);
  assert.equal(result.membershipYear.label, '2027/2028');
});

test('recorded original price override never creates incentive credit', () => {
  assert.equal(rollover({ history: { ...year1, override_type: 'price', override_applied: true } }).appliedDiscount, 0);
  assert.throws(() => rollover({ history: { ...year1, override_applied: true } }), /override type is missing/);
});

test('days, weeks and months use recorded Year 1 usage and reject missing days', () => {
  for (const [unit, amount, entitlement] of [['days', 365, 365], ['weeks', 52, 366], ['months', 12, 365]]) {
    const history = { ...year1, annual_cost: 3650, free_period_discount: 3170, free_period_days_applied: 317,
      commitment_snapshot: { config: { ...original, free_period_unit: unit, free_period_amount: amount } } };
    const result = rollover({ history });
    assert.equal(result.originalEntitlement, entitlement);
    assert.equal(result.appliedDiscount, (entitlement - 317) * 10);
    assert.throws(() => rollover({ history: { ...history, free_period_days_applied: null } }), /day usage must both be recorded/);
  }
});

test('Year 3 does not reapply Year 2 credit', async () => {
  const result = await simulate({}, { targetYear: '2028/2029', asOfDate: '2028-08-01' }, '2028-08-01');
  assert.equal(result.success, true, result.error);
  assert.equal(result.yearNumber, 3);
  assert.equal(result.rolloverDiscount, 0);
});

test('cross-currency renewals require review rather than transferring nominal credit', async () => {
  const result = await simulate({ config: { ...original, currency: 'EUR' } });
  assert.equal(result.success, false);
  assert.equal(result.code, 'new_member_incentive_review_required');
});

test('Year 1 structure override freezes effective incentive policy for Year 2 despite later edits', async () => {
  const baseConfig = { ...original, free_period_amount: 5, rollover_enabled: false };
  const effectiveConfig = { ...original, id: 'override-structure', pricing_model: 'banded', free_period_amount: 30 };
  const first = await simulate({
    config: baseConfig, history: [], extraConfigs: [effectiveConfig],
    bands: [{ id: 'override-band', config_id: effectiveConfig.id, tenant_id: 'tenant', label: 'Original agreed band', annual_cost: 1833.47 }],
    overrides: [{ tenant_id: 'tenant', organization_id: 'org', membership_year: '2026/2027',
      override_type: 'structure', config_id: effectiveConfig.id, band_id: 'override-band' }],
  }, { source: 'manual', targetYear: '2026/2027', asOfDate: '2026-09-18' });
  assert.equal(first.success, true, first.error);
  assert.equal(first.config.id, baseConfig.id, 'schedule config remains backward compatible');
  assert.equal(first.incentiveConfig.id, effectiveConfig.id);
  assert.equal(first.freePeriodAmount, 30);
  assert.equal(first.freeDiscount, 477.71);
  const snapshot = membershipIncentiveSnapshot(first);
  assert.equal(snapshot.commitment_snapshot.config.id, effectiveConfig.id);
  assert.equal(snapshot.commitment_snapshot.config.rollover_enabled, true);
  // Mutate the same live object to additionally verify snapshot deep-copying.
  effectiveConfig.free_period_amount = 90;
  effectiveConfig.rollover_enabled = false;
  const saved = {
    ...year1, ...snapshot, annual_cost: first.annualCost,
    free_period_discount: first.freeDiscount, free_period_days_applied: first.freePeriodDaysApplied,
    override_applied: true, override_type: 'structure',
  };
  const second = await simulate({
    history: [saved], config: { ...baseConfig, flat_cost: 4000 },
    extraConfigs: [effectiveConfig],
  }, { asOfDate: '2027-08-01' });
  assert.equal(second.success, true, second.error);
  assert.equal(second.incentiveRollover.originalConfigId, effectiveConfig.id);
  assert.equal(second.incentiveRollover.originalEntitlement, 550.04);
  assert.equal(second.rolloverDiscount, 72.33);
  assert.equal(second.finalCost, 3927.67);
});