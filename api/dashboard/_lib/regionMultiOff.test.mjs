// Multi-region toggle (widget region group-by): when a widget's region
// group-by has multiRegion === false, rows spanning several regions are
// counted once under EACH region (deriveRegionBucketList) instead of once
// under "Multi-region" (deriveRegionBucket). These tests pin the pure
// derivation semantics both paths share, plus the widget-config schema
// accepting the new flags.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveRegionBucket,
  deriveRegionBucketList,
  REGION_MULTI,
  REGION_UNKNOWN,
  REGION_SCHEME_WORLD_BANK,
} from '../../../shared/countryRegions.js';
import { widgetConfigSchema } from './validation.js';

test('single-region row: list matches the single bucket', () => {
  const countries = ['Kenya', 'Tanzania'];
  assert.equal(deriveRegionBucket(countries), 'Africa');
  assert.deepEqual(deriveRegionBucketList(countries), ['Africa']);
});

test('multi-region row: bucket collapses, list expands per region', () => {
  const countries = ['Kenya', 'India'];
  assert.equal(deriveRegionBucket(countries), REGION_MULTI);
  const list = deriveRegionBucketList(countries);
  assert.deepEqual([...list].sort(), ['Africa', 'Asia']);
});

test('duplicate regions are deduped in the list', () => {
  const list = deriveRegionBucketList(['Kenya', 'Uganda', 'India']);
  assert.equal(list.filter(r => r === 'Africa').length, 1);
});

test('no resolvable countries -> ["Unknown"], mirroring single-bucket', () => {
  assert.equal(deriveRegionBucket([]), REGION_UNKNOWN);
  assert.deepEqual(deriveRegionBucketList([]), [REGION_UNKNOWN]);
  assert.deepEqual(deriveRegionBucketList(['Atlantis']), [REGION_UNKNOWN]);
});

test('LMIC pruning: nothing survives -> null / [] (no bucket)', () => {
  const lmicCodeSet = new Set(['KE']);
  // France is not in the LMIC set, so it contributes nothing.
  assert.equal(deriveRegionBucket(['France'], { lmicCodeSet }), null);
  assert.deepEqual(deriveRegionBucketList(['France'], { lmicCodeSet }), []);
  // Kenya survives; France is pruned.
  assert.deepEqual(
    deriveRegionBucketList(['France', 'Kenya'], { lmicCodeSet }),
    ['Africa'],
  );
});

test('not_lmic inversion prunes LMIC members instead', () => {
  const lmicCodeSet = new Set(['KE']);
  assert.deepEqual(
    deriveRegionBucketList(['France', 'Kenya'], { lmicCodeSet, lmicInvert: true }),
    ['Europe'],
  );
});

test('world bank scheme drives the list buckets', () => {
  const list = deriveRegionBucketList(['Kenya', 'India'], {
    scheme: REGION_SCHEME_WORLD_BANK,
  });
  assert.deepEqual(
    [...list].sort(),
    ['South Asia', 'Sub-Saharan Africa'],
  );
});

test('widget config schema accepts multiRegion and clickThrough flags', () => {
  const config = {
    source: 'organization',
    measure: { aggregator: 'count' },
    groupBy: { kind: 'system', field: 'region', regionScheme: 'app', multiRegion: false },
    clickThrough: true,
  };
  const parsed = widgetConfigSchema.parse(config);
  assert.equal(parsed.groupBy.multiRegion, false);
  assert.equal(parsed.clickThrough, true);
});

test('widget config schema still accepts configs without the new flags', () => {
  const parsed = widgetConfigSchema.parse({
    source: 'organization',
    measure: { aggregator: 'count' },
    groupBy: { kind: 'system', field: 'region', regionScheme: 'app' },
  });
  assert.ok(parsed);
});
