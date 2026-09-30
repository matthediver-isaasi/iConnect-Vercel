// Unit tests for the member source's derived dashboard dimensions:
// "Organisation type" (org_type preference hydration → bucket keys) and
// "Active in period" (last_activity vs a config-carried date range), plus
// the validation schema's acceptance of the new seriesBy / from / to shapes
// and the registry's replacement of the dropped last_login column.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activePeriodBounds,
  activeInPeriodBucket,
  orgTypeBucketKey,
} from './aggregation.js';
import { widgetConfigSchema } from './validation.js';
import { getSourceDef } from './sources.js';

test('activePeriodBounds expands date-only strings to full days (UTC)', () => {
  const b = activePeriodBounds({ from: '2026-01-01', to: '2026-01-31' });
  assert.equal(b.from, Date.parse('2026-01-01T00:00:00.000Z'));
  assert.equal(b.to, Date.parse('2026-01-31T23:59:59.999Z'));
});

test('activePeriodBounds accepts open-ended ranges', () => {
  assert.equal(activePeriodBounds({ from: '2026-01-01' }).to, null);
  assert.equal(activePeriodBounds({ to: '2026-01-31' }).from, null);
});

test('activePeriodBounds throws without any valid bound', () => {
  assert.throws(() => activePeriodBounds({}), /date range/i);
  assert.throws(() => activePeriodBounds({ from: 'not-a-date' }), /date range/i);
});

test('activeInPeriodBucket buckets Active inside, Inactive outside/never', () => {
  const b = activePeriodBounds({ from: '2026-01-01', to: '2026-01-31' });
  assert.equal(activeInPeriodBucket('2026-01-15T10:00:00Z', b), 'Active');
  assert.equal(activeInPeriodBucket('2026-01-01T00:00:00Z', b), 'Active');
  assert.equal(activeInPeriodBucket('2026-01-31T23:00:00Z', b), 'Active');
  assert.equal(activeInPeriodBucket('2025-12-31T23:59:00Z', b), 'Inactive');
  assert.equal(activeInPeriodBucket('2026-02-01T00:00:00Z', b), 'Inactive');
  assert.equal(activeInPeriodBucket(null, b), 'Inactive');
  assert.equal(activeInPeriodBucket('garbage', b), 'Inactive');
});

test('orgTypeBucketKey collapses missing/empty values to Unknown', () => {
  assert.equal(orgTypeBucketKey('ESO'), 'ESO');
  assert.equal(orgTypeBucketKey('  SO  '), 'SO');
  assert.equal(orgTypeBucketKey(null), 'Unknown');
  assert.equal(orgTypeBucketKey(undefined), 'Unknown');
  assert.equal(orgTypeBucketKey(''), 'Unknown');
  assert.equal(orgTypeBucketKey('   '), 'Unknown');
});

test('member source registers last_activity and drops the stale last_login', () => {
  const member = getSourceDef('member');
  const names = member.systemFields.map(f => f.name);
  assert.ok(names.includes('last_activity'));
  assert.ok(!names.includes('last_login'));
  const orgType = member.systemFields.find(f => f.name === 'org_type');
  assert.equal(orgType.derived, 'org_type');
  assert.equal(orgType.groupOnly, true);
  assert.equal(orgType.filterable, true);
  const active = member.systemFields.find(f => f.name === 'active_in_period');
  assert.equal(active.derived, 'active_in_period');
  assert.equal(active.periodField, true);
  assert.deepEqual(active.options.map(o => o.value), ['Active', 'Inactive']);
});

test('widgetConfigSchema accepts seriesBy and period-carrying refs', () => {
  const parsed = widgetConfigSchema.parse({
    source: 'member',
    measure: { aggregator: 'count' },
    groupBy: { kind: 'system', field: 'org_type' },
    seriesBy: { kind: 'system', field: 'active_in_period', from: '2026-01-01', to: '2026-03-31' },
    filters: [
      { fieldKind: 'system', field: 'active_in_period', operator: 'eq', value: 'Active', from: '2026-01-01', to: null },
    ],
  });
  assert.equal(parsed.seriesBy.from, '2026-01-01');
  assert.equal(parsed.filters[0].from, '2026-01-01');
  assert.equal(parsed.groupBy.field, 'org_type');
});
