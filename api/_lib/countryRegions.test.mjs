import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REGION_BUCKETS,
  REGION_NAMES,
  REGION_MULTI,
  REGION_UNKNOWN,
  WB_REGION_NAMES,
  WB_REGION_BUCKETS,
  REGION_SCHEME_APP,
  REGION_SCHEME_WORLD_BANK,
  normaliseRegionScheme,
  regionBucketsForScheme,
  regionForIso2,
  regionForCountry,
  deriveRegionBucket,
  listUnmappedCountryCodes,
} from '../../shared/countryRegions.js';
import { COUNTRIES } from '../../shared/countries.js';

test('every canonical country classifies to a region', () => {
  assert.deepEqual(listUnmappedCountryCodes(), []);
  for (const { code } of COUNTRIES) {
    const region = regionForIso2(code);
    assert.ok(REGION_NAMES.includes(region), `${code} → ${region}`);
  }
});

test('bucket list is the 6 regions plus Multi-region and Unknown', () => {
  assert.deepEqual(REGION_BUCKETS, [
    'Africa', 'Asia', 'Europe', 'Latin America', 'North America', 'Oceania',
    'Multi-region', 'Unknown',
  ]);
});

// The classification must agree with GSF's gsf_map_country_lookup
// (Zoho-era, 75 countries). Names below are the iConnect canonical
// spellings for each of the lookup's entries; expected regions are the
// lookup's own region values. Verified 1:1 against the live tenant
// setting on 2026-07-09 — if GSF re-seeds the lookup with different
// classifications this table needs re-checking.
const GSF_LOOKUP_EXPECTATIONS = {
  Africa: [
    'Angola', 'Benin', 'Botswana', 'Burkina Faso', 'Burundi', 'Cameroon',
    'Congo (Democratic Republic)', "Côte d'Ivoire", 'Egypt', 'Eswatini',
    'Ethiopia', 'Gambia', 'Ghana', 'Kenya', 'Lesotho', 'Liberia',
    'Madagascar', 'Malawi', 'Mali', 'Mozambique', 'Namibia', 'Niger',
    'Nigeria', 'Rwanda', 'Senegal', 'Sierra Leone', 'South Africa',
    'Tanzania', 'Togo', 'Uganda', 'Zambia', 'Zimbabwe',
  ],
  Asia: [
    'Afghanistan', 'Armenia', 'Bangladesh', 'Cambodia', 'India', 'Indonesia',
    'Iraq', 'Israel', 'Jordan', 'Kazakhstan', 'Kyrgyzstan', 'Laos',
    'Lebanon', 'Malaysia', 'Mongolia', 'Myanmar', 'Nepal', 'Pakistan',
    'Philippines', 'Sri Lanka', 'Thailand', 'Vietnam',
  ],
  Europe: ['Croatia', 'Czechia', 'Poland', 'Serbia', 'United Kingdom'],
  'Latin America': [
    'Bolivia', 'Brazil', 'Colombia', 'Dominican Republic', 'Ecuador',
    'El Salvador', 'Guatemala', 'Haiti', 'Honduras', 'Jamaica', 'Mexico',
    'Nicaragua', 'Paraguay', 'Peru', 'Venezuela',
  ],
  'North America': ['United States'],
};

test('classification agrees with the GSF country lookup', () => {
  for (const [region, names] of Object.entries(GSF_LOOKUP_EXPECTATIONS)) {
    for (const name of names) {
      assert.equal(regionForCountry(name), region, `${name} should be ${region}`);
    }
  }
});

test('spot checks for countries outside the GSF lookup', () => {
  assert.equal(regionForCountry('Turkey'), 'Asia');
  assert.equal(regionForCountry('Georgia'), 'Asia');
  assert.equal(regionForCountry('Russia'), 'Europe');
  assert.equal(regionForCountry('Canada'), 'North America');
  assert.equal(regionForCountry('Australia'), 'Oceania');
  assert.equal(regionForCountry('Fiji'), 'Oceania');
  assert.equal(regionForCountry('Cuba'), 'Latin America');
});

test('regionForCountry resolves ISO-2 codes and free text, null otherwise', () => {
  assert.equal(regionForCountry('KE'), 'Africa');
  assert.equal(regionForCountry(' kenya '), 'Africa');
  assert.equal(regionForCountry('Narnia'), null);
  assert.equal(regionForCountry(''), null);
  assert.equal(regionForCountry(null), null);
});

test('deriveRegionBucket: single region', () => {
  assert.equal(deriveRegionBucket(['Kenya']), 'Africa');
  assert.equal(deriveRegionBucket(['Kenya', 'Uganda', 'Tanzania']), 'Africa');
});

test('deriveRegionBucket: multiple regions → Multi-region', () => {
  assert.equal(deriveRegionBucket(['Pakistan', 'United Kingdom']), REGION_MULTI);
  assert.equal(
    deriveRegionBucket(['India', 'Jamaica', 'Mexico', 'South Africa']),
    REGION_MULTI,
  );
});

test('deriveRegionBucket: empty or unresolvable → Unknown', () => {
  assert.equal(deriveRegionBucket([]), REGION_UNKNOWN);
  assert.equal(deriveRegionBucket(null), REGION_UNKNOWN);
  assert.equal(deriveRegionBucket(['Atlantis', '???']), REGION_UNKNOWN);
});

test('deriveRegionBucket: unresolvable entries ignored when others resolve', () => {
  assert.equal(deriveRegionBucket(['Atlantis', 'Kenya']), 'Africa');
});

// ---------------------------------------------------------------------------
// World Bank scheme

test('normaliseRegionScheme: absent/unknown falls back to app', () => {
  assert.equal(normaliseRegionScheme(undefined), REGION_SCHEME_APP);
  assert.equal(normaliseRegionScheme(null), REGION_SCHEME_APP);
  assert.equal(normaliseRegionScheme(''), REGION_SCHEME_APP);
  assert.equal(normaliseRegionScheme('nonsense'), REGION_SCHEME_APP);
  assert.equal(normaliseRegionScheme('app'), REGION_SCHEME_APP);
  assert.equal(normaliseRegionScheme('world_bank'), REGION_SCHEME_WORLD_BANK);
});

test('World Bank bucket list is the 7 regions plus Multi-region and Unknown', () => {
  assert.deepEqual(WB_REGION_BUCKETS, [
    'Sub-Saharan Africa', 'South Asia', 'East Asia & Pacific',
    'Latin America & Caribbean', 'Middle East & North Africa',
    'Europe & Central Asia', 'North America',
    'Multi-region', 'Unknown',
  ]);
  assert.deepEqual(regionBucketsForScheme('world_bank'), WB_REGION_BUCKETS);
  assert.deepEqual(regionBucketsForScheme('app'), REGION_BUCKETS);
  assert.deepEqual(regionBucketsForScheme('bogus'), REGION_BUCKETS, 'unknown scheme = app');
});

test('every canonical country classifies to a World Bank region', () => {
  assert.deepEqual(listUnmappedCountryCodes('world_bank'), []);
  for (const { code } of COUNTRIES) {
    const region = regionForIso2(code, 'world_bank');
    assert.ok(WB_REGION_NAMES.includes(region), `${code} → ${region}`);
  }
});

test('World Bank scheme spot checks (divergences from the app scheme)', () => {
  // North Africa splits off from Sub-Saharan Africa...
  assert.equal(regionForCountry('Egypt', 'world_bank'), 'Middle East & North Africa');
  assert.equal(regionForCountry('Morocco', 'world_bank'), 'Middle East & North Africa');
  // ...but Sudan stays Sub-Saharan per the Bank's table.
  assert.equal(regionForCountry('Sudan', 'world_bank'), 'Sub-Saharan Africa');
  assert.equal(regionForCountry('Djibouti', 'world_bank'), 'Middle East & North Africa');
  assert.equal(regionForCountry('Malta', 'world_bank'), 'Middle East & North Africa');
  // Turkey / Caucasus / Central Asia move from Asia to Europe & Central Asia.
  assert.equal(regionForCountry('Turkey', 'world_bank'), 'Europe & Central Asia');
  assert.equal(regionForCountry('Kazakhstan', 'world_bank'), 'Europe & Central Asia');
  assert.equal(regionForCountry('Armenia', 'world_bank'), 'Europe & Central Asia');
  // South Asia splits off from Asia.
  assert.equal(regionForCountry('India', 'world_bank'), 'South Asia');
  assert.equal(regionForCountry('Pakistan', 'world_bank'), 'South Asia');
  // Oceania folds into East Asia & Pacific.
  assert.equal(regionForCountry('Australia', 'world_bank'), 'East Asia & Pacific');
  assert.equal(regionForCountry('Fiji', 'world_bank'), 'East Asia & Pacific');
  assert.equal(regionForCountry('Vietnam', 'world_bank'), 'East Asia & Pacific');
  // Mexico + Caribbean stay Latin America & Caribbean; NA unchanged.
  assert.equal(regionForCountry('Mexico', 'world_bank'), 'Latin America & Caribbean');
  assert.equal(regionForCountry('Canada', 'world_bank'), 'North America');
  assert.equal(regionForCountry('United Kingdom', 'world_bank'), 'Europe & Central Asia');
});

test('deriveRegionBucket honours the scheme option', () => {
  assert.equal(
    deriveRegionBucket(['Kenya', 'Uganda'], { scheme: 'world_bank' }),
    'Sub-Saharan Africa',
  );
  // Same-region under app, multi-region under World Bank (Africa splits).
  assert.equal(deriveRegionBucket(['Kenya', 'Egypt']), 'Africa');
  assert.equal(
    deriveRegionBucket(['Kenya', 'Egypt'], { scheme: 'world_bank' }),
    REGION_MULTI,
  );
  // Multi under app, single under World Bank (Asia + Oceania merge).
  assert.equal(deriveRegionBucket(['Vietnam', 'Fiji']), REGION_MULTI);
  assert.equal(
    deriveRegionBucket(['Vietnam', 'Fiji'], { scheme: 'world_bank' }),
    'East Asia & Pacific',
  );
  assert.equal(deriveRegionBucket([], { scheme: 'world_bank' }), REGION_UNKNOWN);
});

test('deriveRegionBucket default (no options) is unchanged — legacy regression', () => {
  assert.equal(deriveRegionBucket(['Kenya']), 'Africa');
  assert.equal(deriveRegionBucket(['Pakistan', 'United Kingdom']), REGION_MULTI);
  assert.equal(deriveRegionBucket(null), REGION_UNKNOWN);
});

// ---------------------------------------------------------------------------
// LMIC pruning: with lmicCodeSet, only countries resolving to an LMIC code
// contribute to the region derivation; nothing surviving → null (the caller
// creates NO bucket for the row — not "Unknown").

test('deriveRegionBucket with lmicCodeSet derives region from LMIC countries only', () => {
  const lmic = new Set(['KE', 'IN']);
  assert.equal(
    deriveRegionBucket(['Kenya', 'United Kingdom'], { lmicCodeSet: lmic }),
    'Africa',
    'non-LMIC UK must not push the row into Multi-region',
  );
  assert.equal(
    deriveRegionBucket(['Kenya', 'India'], { lmicCodeSet: lmic }),
    REGION_MULTI,
    'two LMIC countries in different regions → Multi-region',
  );
  assert.equal(
    deriveRegionBucket(['Kenya', 'United Kingdom'], { scheme: 'world_bank', lmicCodeSet: lmic }),
    'Sub-Saharan Africa',
    'scheme and pruning compose',
  );
});

test('deriveRegionBucket with lmicCodeSet returns null when nothing survives', () => {
  const lmic = new Set(['KE']);
  assert.equal(deriveRegionBucket(['United Kingdom', 'France'], { lmicCodeSet: lmic }), null);
  assert.equal(deriveRegionBucket([], { lmicCodeSet: lmic }), null);
  assert.equal(deriveRegionBucket(null, { lmicCodeSet: lmic }), null);
  assert.equal(deriveRegionBucket(['Narnia'], { lmicCodeSet: lmic }), null);
  assert.equal(deriveRegionBucket(['Kenya'], { lmicCodeSet: new Set() }), null, 'empty LMIC list');
});
