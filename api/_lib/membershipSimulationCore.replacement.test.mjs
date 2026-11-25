import test from 'node:test';
import assert from 'node:assert/strict';
import { createMembershipSimulator } from './membershipSimulationCore.js';

// Real simulator over an isolated read-only fake database: a replacement
// re-prices the same year-one period as if the original row did not exist.
function fixture({ goLive = '2026-11-01', original = {} } = {}) {
  const config = {
    id: 'cfg', tenant_id: 'tenant', structure_scope_type: 'organization',
    start_mode: 'fixed_date', pricing_model: 'flat', flat_cost: 365,
    membership_start_month: 8, membership_start_day: 1, prorata_enabled: true,
    billing_period: 'annual', currency: 'GBP', effective_from: '2020-01-01',
  };
  const tables = {
    organization: [{ id: 'org', tenant_id: 'tenant', name: 'Organisation' }],
    membership_tier_config: [config],
    preference_field: [{ id: 'go-live', tenant_id: 'tenant', entity_scope: 'organization', name: 'go_live', is_active: true }],
    organization_preference_value: goLive ? [{ organization_id: 'org', field_id: 'go-live', value: goLive }] : [],
    organisation_membership_history: [{
      id: 'original', tenant_id: 'tenant', organization_id: 'org', membership_year: '2026/2027',
      status: 'active', year_number: 1, final_cost: 273, prorata_days: 273, ...original,
    }],
  };
  const db = { from(table) {
    const filters = [];
    const result = single => {
      const rows = (tables[table] || []).filter(row => filters.every(f => f(row)));
      return { data: single ? rows[0] || null : rows, error: null };
    };
    const q = {
      select() { return q; },
      eq(key, value) { filters.push(row => row[key] === value); return q; },
      neq(key, value) { filters.push(row => row[key] !== value); return q; },
      in(key, values) { filters.push(row => values.includes(row[key])); return q; },
      not() { return q; }, is() { return q; }, gte() { return q; }, lte() { return q; },
      or(expression) {
        const date = expression.match(/effective_(?:from|to)\.(?:lte|gte)\.(\d{4}-\d{2}-\d{2})/)?.[1];
        if (date && expression.startsWith('effective_from')) filters.push(row => !row.effective_from || row.effective_from <= date);
        if (date && expression.startsWith('effective_to')) filters.push(row => !row.effective_to || row.effective_to >= date);
        return q;
      },
      order() { return q; }, limit() { return q; },
      maybeSingle() { return Promise.resolve(result(true)); },
      single() { return Promise.resolve(result(true)); },
      then(resolve, reject) { return Promise.resolve(result(false)).then(resolve, reject); },
      insert() { assert.fail('writes forbidden'); }, update() { assert.fail('writes forbidden'); },
      upsert() { assert.fail('writes forbidden'); }, delete() { assert.fail('writes forbidden'); },
    };
    return q;
  } };
  const simulator = createMembershipSimulator(db, () => new Date('2027-01-15T12:00:00Z'));
  return options => simulator.simulateMembershipForOrg('tenant', 'org', {
    source: 'manual', mode: 'manual', targetYear: '2026/2027', replacementOverride: null, ...options,
  });
}

test('without replacement context the recorded year hides year-one pro-rata (the defect)', async () => {
  const result = await fixture()({});
  assert.equal(result.success, true, result.error);
  assert.equal(result.finalCost, 365);
});

test('replacement pricing keeps year-one pro-rata from the go-live date', async () => {
  const result = await fixture()({ replacementOfRecordId: 'original', replacementProrataDays: 273 });
  assert.equal(result.success, true, result.error);
  assert.equal(result.membershipYear.label, '2026/2027');
  assert.equal(result.prorataDays, 273); // 1 Nov 2026 – 31 Jul 2027
  assert.equal(result.finalCost, 273);
});

test('without a go-live date the replacement keeps the original join day, not today', async () => {
  const result = await fixture({ goLive: null })({ replacementOfRecordId: 'original', replacementProrataDays: 300 });
  assert.equal(result.success, true, result.error);
  assert.equal(result.prorataDays, 300);
  assert.equal(result.finalCost, 300);
});

test('a replacement manual price still suppresses incentives', async () => {
  const result = await fixture()({ replacementOfRecordId: 'original', replacementOverride: { override_type: 'price', manual_price: 500 } });
  assert.equal(result.success, true, result.error);
  assert.equal(result.finalCost, 500);
});
