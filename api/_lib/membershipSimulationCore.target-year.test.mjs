import test from 'node:test';
import assert from 'node:assert/strict';
import { createMembershipSimulator } from './membershipSimulationCore.js';

// Read-only, isolated database: no credentials or provider calls.
function fixture() {
  const original = {
    id: 'original', tenant_id: 'tenant', structure_scope_type: 'organization',
    start_mode: 'fixed_date', pricing_model: 'flat', flat_cost: 100,
    membership_start_month: 8, membership_start_day: 1,
    billing_period: 'annual', currency: 'GBP', effective_from: '2020-01-01',
  };
  const future = { ...original, id: 'future', flat_cost: 200,
    membership_start_month: 10, effective_from: '2027-08-01' };
  const tables = {
    organization: [{ id: 'entity', tenant_id: 'tenant', name: 'Organisation' }],
    membership_tier_config: [future, original],
    preference_field: [{ id: 'go-live', tenant_id: 'tenant', entity_scope: 'organization', name: 'go_live', is_active: true }],
    organization_preference_value: [{ organization_id: 'entity', field_id: 'go-live', value: '2021-07-16' }],
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
      or(expression) {
        const date = expression.match(/effective_(?:from|to)\.(?:lte|gte)\.(\d{4}-\d{2}-\d{2})/)?.[1];
        if (date && expression.startsWith('effective_from')) filters.push(row => !row.effective_from || row.effective_from <= date);
        if (date && expression.startsWith('effective_to')) filters.push(row => !row.effective_to || row.effective_to >= date);
        return q;
      },
      order() { return q; }, limit() { return q; },
      maybeSingle() { return Promise.resolve(result(true)); },
      then(resolve, reject) { return Promise.resolve(result(false)).then(resolve, reject); },
      insert() { assert.fail('writes forbidden'); }, update() { assert.fail('writes forbidden'); },
      upsert() { assert.fail('writes forbidden'); }, delete() { assert.fail('writes forbidden'); },
    };
    return q;
  } };
  const simulator = createMembershipSimulator(db, () => new Date('2026-09-24T00:00:00Z'));
  const run = simulator.simulateMembershipForOrg;
  return options => run('tenant', 'entity', { source: 'tab', asOfDate: '2026-09-24', ...options });
}

for (const scope of ['organization']) {
  test(`${scope}: unsupported explicit years fail closed, including with an explicit config`, async () => {
    const run = fixture();
    for (const targetYear of ['2025/2026', '2028/2029', 'invalid', '', 2027]) {
      for (const configId of [null, 'original']) {
        const result = await run({ targetYear, configId });
        assert.equal(result.success, false);
        assert.equal(result.code, 'unsupported_membership_year');
        assert.equal(result.membershipYear, undefined);
        assert.match(result.error, /Expected 2026\/2027 or 2027\/2028/);
      }
    }
  });

  test(`${scope}: next target keeps label and dates while taking future pricing`, async () => {
    const run = fixture();
    for (const options of [{ targetYear: '2027/2028' }, { source: 'simulate' }]) {
      const result = await run(options);
      assert.equal(result.success, true, result.error);
      assert.equal(result.config.id, 'future');
      assert.equal(result.annualCost, 200);
      assert.equal(result.membershipYear.label, '2027/2028');
      assert.equal(result.membershipYear.start.toISOString().slice(0, 10), '2027-08-01');
      assert.equal(result.membershipYear.end.toISOString().slice(0, 10), '2028-07-31');
    }
  });

  test(`${scope}: explicit current and implicit tab target remain current`, async () => {
    const run = fixture();
    for (const options of [{ targetYear: '2026/2027' }, {}]) {
      const result = await run(options);
      assert.equal(result.success, true, result.error);
      assert.equal(result.config.id, 'original');
      assert.equal(result.membershipYear.label, '2026/2027');
      assert.equal(result.annualCost, 100);
    }
  });
}