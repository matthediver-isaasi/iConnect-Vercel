import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REGION_BUCKETS,
  REGION_NAMES,
  REGION_MULTI,
  REGION_UNKNOWN,
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
