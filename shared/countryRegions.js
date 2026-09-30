/**
 * Country → world-region classification, shared by client and server.
 *
 * Two schemes are supported:
 *
 * `app` (default) — region names and country assignments deliberately
 * agree with GSF's Zoho-era country lookup (`gsf_map_country_lookup`
 * seed, 75 countries) so dashboard widgets grouped by region match the
 * legacy map site:
 *   - Middle East (Israel, Iraq, Jordan, Lebanon, …) → Asia
 *   - Central Asia (Kazakhstan, Kyrgyzstan, …) and the Caucasus
 *     (Armenia, Georgia, Azerbaijan) → Asia
 *   - Mexico, Central America and the Caribbean → Latin America
 *   - North America is Canada + United States only
 * Countries the GSF lookup doesn't cover follow the same convention
 * (e.g. Turkey → Asia alongside Armenia/Georgia; Russia → Europe).
 *
 * `world_bank` — the World Bank's 7 official analytical regions
 * (all-income classification): Sub-Saharan Africa, South Asia,
 * East Asia & Pacific, Latin America & Caribbean, Middle East & North
 * Africa, Europe & Central Asia, North America. Assignments follow the
 * Bank's published country/region table (e.g. Sudan → Sub-Saharan
 * Africa, Djibouti and Malta → Middle East & North Africa, Turkey and
 * the Caucasus/Central Asia → Europe & Central Asia). Taiwan, which the
 * Bank does not classify, is placed in East Asia & Pacific.
 *
 * Pure and dependency-light so both the widget builder UI and the
 * aggregation engine can import it.
 */

import { COUNTRIES, resolveCountryToIso2 } from './countries.js';

export const REGION_AFRICA = 'Africa';
export const REGION_ASIA = 'Asia';
export const REGION_EUROPE = 'Europe';
export const REGION_LATIN_AMERICA = 'Latin America';
export const REGION_NORTH_AMERICA = 'North America';
export const REGION_OCEANIA = 'Oceania';
export const REGION_MULTI = 'Multi-region';
export const REGION_UNKNOWN = 'Unknown';

// The app-scheme single-region names, in stable display order.
export const REGION_NAMES = [
  REGION_AFRICA,
  REGION_ASIA,
  REGION_EUROPE,
  REGION_LATIN_AMERICA,
  REGION_NORTH_AMERICA,
  REGION_OCEANIA,
];

// Every derivable app-scheme bucket, including the two synthetic ones.
export const REGION_BUCKETS = [...REGION_NAMES, REGION_MULTI, REGION_UNKNOWN];

const REGION_ISO2 = {
  [REGION_AFRICA]: [
    'DZ', 'AO', 'BJ', 'BW', 'BF', 'BI', 'CV', 'CM', 'CF', 'TD', 'KM', 'CG',
    'CD', 'CI', 'DJ', 'EG', 'GQ', 'ER', 'SZ', 'ET', 'GA', 'GM', 'GH', 'GN',
    'GW', 'KE', 'LS', 'LR', 'LY', 'MG', 'MW', 'ML', 'MR', 'MU', 'MA', 'MZ',
    'NA', 'NE', 'NG', 'RW', 'ST', 'SN', 'SC', 'SL', 'SO', 'ZA', 'SS', 'SD',
    'TZ', 'TG', 'TN', 'UG', 'ZM', 'ZW',
  ],
  [REGION_ASIA]: [
    'AF', 'AM', 'AZ', 'BH', 'BD', 'BT', 'BN', 'KH', 'CN', 'GE', 'IN', 'ID',
    'IR', 'IQ', 'IL', 'JP', 'JO', 'KZ', 'KP', 'KR', 'KW', 'KG', 'LA', 'LB',
    'MY', 'MV', 'MN', 'MM', 'NP', 'OM', 'PK', 'PS', 'PH', 'QA', 'SA', 'SG',
    'LK', 'SY', 'TW', 'TJ', 'TH', 'TL', 'TR', 'TM', 'AE', 'UZ', 'VN', 'YE',
  ],
  [REGION_EUROPE]: [
    'AL', 'AD', 'AT', 'BY', 'BE', 'BA', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE',
    'FI', 'FR', 'DE', 'GR', 'HU', 'IS', 'IE', 'IT', 'XK', 'LV', 'LI', 'LT',
    'LU', 'MT', 'MD', 'MC', 'ME', 'NL', 'MK', 'NO', 'PL', 'PT', 'RO', 'RU',
    'SM', 'RS', 'SK', 'SI', 'ES', 'SE', 'CH', 'UA', 'GB', 'VA',
  ],
  [REGION_LATIN_AMERICA]: [
    'AG', 'AR', 'BS', 'BB', 'BZ', 'BO', 'BR', 'CL', 'CO', 'CR', 'CU', 'DM',
    'DO', 'EC', 'SV', 'GD', 'GT', 'GY', 'HT', 'HN', 'JM', 'MX', 'NI', 'PA',
    'PY', 'PE', 'KN', 'LC', 'VC', 'SR', 'TT', 'UY', 'VE',
  ],
  [REGION_NORTH_AMERICA]: ['CA', 'US'],
  [REGION_OCEANIA]: [
    'AU', 'FJ', 'KI', 'MH', 'FM', 'NR', 'NZ', 'PW', 'PG', 'WS', 'SB', 'TO',
    'TV', 'VU',
  ],
};

// --- World Bank scheme -----------------------------------------------------

export const WB_SUB_SAHARAN_AFRICA = 'Sub-Saharan Africa';
export const WB_SOUTH_ASIA = 'South Asia';
export const WB_EAST_ASIA_PACIFIC = 'East Asia & Pacific';
export const WB_LATIN_AMERICA_CARIBBEAN = 'Latin America & Caribbean';
export const WB_MIDDLE_EAST_NORTH_AFRICA = 'Middle East & North Africa';
export const WB_EUROPE_CENTRAL_ASIA = 'Europe & Central Asia';
export const WB_NORTH_AMERICA = 'North America';

// World Bank single-region names, in stable display order.
export const WB_REGION_NAMES = [
  WB_SUB_SAHARAN_AFRICA,
  WB_SOUTH_ASIA,
  WB_EAST_ASIA_PACIFIC,
  WB_LATIN_AMERICA_CARIBBEAN,
  WB_MIDDLE_EAST_NORTH_AFRICA,
  WB_EUROPE_CENTRAL_ASIA,
  WB_NORTH_AMERICA,
];

export const WB_REGION_BUCKETS = [...WB_REGION_NAMES, REGION_MULTI, REGION_UNKNOWN];

const WB_REGION_ISO2 = {
  [WB_SUB_SAHARAN_AFRICA]: [
    'AO', 'BJ', 'BW', 'BF', 'BI', 'CV', 'CM', 'CF', 'TD', 'KM', 'CG', 'CD',
    'CI', 'GQ', 'ER', 'SZ', 'ET', 'GA', 'GM', 'GH', 'GN', 'GW', 'KE', 'LS',
    'LR', 'MG', 'MW', 'ML', 'MR', 'MU', 'MZ', 'NA', 'NE', 'NG', 'RW', 'ST',
    'SN', 'SC', 'SL', 'SO', 'ZA', 'SS', 'SD', 'TZ', 'TG', 'UG', 'ZM', 'ZW',
  ],
  [WB_SOUTH_ASIA]: ['AF', 'BD', 'BT', 'IN', 'MV', 'NP', 'PK', 'LK'],
  [WB_EAST_ASIA_PACIFIC]: [
    'BN', 'KH', 'CN', 'ID', 'JP', 'KP', 'KR', 'LA', 'MY', 'MN', 'MM', 'PH',
    'SG', 'TW', 'TH', 'TL', 'VN',
    'AU', 'FJ', 'KI', 'MH', 'FM', 'NR', 'NZ', 'PW', 'PG', 'WS', 'SB', 'TO',
    'TV', 'VU',
  ],
  [WB_LATIN_AMERICA_CARIBBEAN]: [
    'AG', 'AR', 'BS', 'BB', 'BZ', 'BO', 'BR', 'CL', 'CO', 'CR', 'CU', 'DM',
    'DO', 'EC', 'SV', 'GD', 'GT', 'GY', 'HT', 'HN', 'JM', 'MX', 'NI', 'PA',
    'PY', 'PE', 'KN', 'LC', 'VC', 'SR', 'TT', 'UY', 'VE',
  ],
  [WB_MIDDLE_EAST_NORTH_AFRICA]: [
    'DZ', 'BH', 'DJ', 'EG', 'IR', 'IQ', 'IL', 'JO', 'KW', 'LB', 'LY', 'MT',
    'MA', 'OM', 'PS', 'QA', 'SA', 'SY', 'TN', 'AE', 'YE',
  ],
  [WB_EUROPE_CENTRAL_ASIA]: [
    'AL', 'AD', 'AM', 'AT', 'AZ', 'BY', 'BE', 'BA', 'BG', 'HR', 'CY', 'CZ',
    'DK', 'EE', 'FI', 'FR', 'GE', 'DE', 'GR', 'HU', 'IS', 'IE', 'IT', 'KZ',
    'XK', 'KG', 'LV', 'LI', 'LT', 'LU', 'MD', 'MC', 'ME', 'NL', 'MK', 'NO',
    'PL', 'PT', 'RO', 'RU', 'SM', 'RS', 'SK', 'SI', 'ES', 'SE', 'CH', 'TJ',
    'TR', 'TM', 'UA', 'GB', 'UZ', 'VA',
  ],
  [WB_NORTH_AMERICA]: ['CA', 'US'],
};

// --- Scheme registry --------------------------------------------------------

export const REGION_SCHEME_APP = 'app';
export const REGION_SCHEME_WORLD_BANK = 'world_bank';

function buildIso2Map(regionIso2) {
  const map = new Map();
  for (const [region, codes] of Object.entries(regionIso2)) {
    for (const code of codes) map.set(code, region);
  }
  return map;
}

const SCHEMES = {
  [REGION_SCHEME_APP]: {
    id: REGION_SCHEME_APP,
    label: 'App regions',
    names: REGION_NAMES,
    buckets: REGION_BUCKETS,
    iso2ToRegion: buildIso2Map(REGION_ISO2),
  },
  [REGION_SCHEME_WORLD_BANK]: {
    id: REGION_SCHEME_WORLD_BANK,
    label: 'World Bank regions',
    names: WB_REGION_NAMES,
    buckets: WB_REGION_BUCKETS,
    iso2ToRegion: buildIso2Map(WB_REGION_ISO2),
  },
};

export const REGION_SCHEME_IDS = Object.keys(SCHEMES);

/**
 * Resolve a stored/requested scheme id to a canonical one. Absent or
 * unrecognised values fall back to the app scheme so existing widgets
 * (no scheme stored) reproduce today's output exactly.
 */
export function normaliseRegionScheme(scheme) {
  return SCHEMES[scheme] ? scheme : REGION_SCHEME_APP;
}

/** Bucket names (regions + Multi-region + Unknown) for a scheme. */
export function regionBucketsForScheme(scheme) {
  return SCHEMES[normaliseRegionScheme(scheme)].buckets;
}

/**
 * Region for a single ISO-2 code (uppercase), or null when unknown.
 */
export function regionForIso2(code, scheme = REGION_SCHEME_APP) {
  if (!code) return null;
  const map = SCHEMES[normaliseRegionScheme(scheme)].iso2ToRegion;
  return map.get(String(code).trim().toUpperCase()) || null;
}

/**
 * Region for a single stored country value — an ISO-2 code or a
 * free-text country name — resolved through the shared name→code
 * helper. Returns null when the value doesn't resolve to a known
 * country/region.
 */
export function regionForCountry(value, scheme = REGION_SCHEME_APP) {
  const code = resolveCountryToIso2(value);
  return code ? regionForIso2(code, scheme) : null;
}

/**
 * Derive the single region bucket for a LIST of country values
 * (e.g. an organisation's "Countries of operation" multi-pick):
 *   - no values, or none resolvable → "Unknown"
 *   - all resolvable values in one region → that region's name
 *   - resolvable values spanning >1 region → "Multi-region"
 * Unresolvable entries in an otherwise-resolvable list are ignored.
 *
 * Options:
 *   - `scheme`: 'app' (default) or 'world_bank'.
 *   - `lmicCodeSet`: a Set of ISO-2 codes. When provided, ONLY country
 *     values resolving to a code in the set contribute to the region
 *     derivation (used when an LMIC filter rides on the country fields
 *     feeding the region dimension). When NO value survives the pruning
 *     the function returns null — the caller must create NO bucket for
 *     the row (not "Unknown"), mirroring pruneLmicGroupKeys semantics.
 *   - `lmicInvert`: when true (with `lmicCodeSet` provided), membership
 *     is inverted — ONLY country values resolving to a code OUTSIDE the
 *     set contribute (used for the `not_lmic` filter operator). The set
 *     may be empty in this mode (every resolvable country contributes).
 */
export function deriveRegionBucket(countries, options = {}) {
  const { scheme = REGION_SCHEME_APP, lmicCodeSet = null, lmicInvert = false } = options || {};
  const list = Array.isArray(countries) ? countries : [];
  const regions = new Set();
  for (const value of list) {
    if (lmicCodeSet) {
      const code = resolveCountryToIso2(value);
      if (code === null || (lmicInvert ? lmicCodeSet.has(code) : !lmicCodeSet.has(code))) continue;
      const region = regionForIso2(code, scheme);
      if (region) regions.add(region);
    } else {
      const region = regionForCountry(value, scheme);
      if (region) regions.add(region);
    }
  }
  if (regions.size === 0) return lmicCodeSet ? null : REGION_UNKNOWN;
  if (regions.size > 1) return REGION_MULTI;
  return regions.values().next().value;
}

/**
 * List-variant of deriveRegionBucket, used when a widget's region
 * group-by has "Multi-region" turned OFF: instead of collapsing an
 * organisation spanning several regions into one "Multi-region" bucket,
 * it returns EVERY distinct region its countries touch (so the row is
 * counted once per region). Same options and pruning semantics as
 * deriveRegionBucket:
 *   - no values, or none resolvable → ["Unknown"]
 *   - with `lmicCodeSet` and nothing surviving the pruning → [] (the
 *     caller must create NO bucket for the row).
 */
export function deriveRegionBucketList(countries, options = {}) {
  const { scheme = REGION_SCHEME_APP, lmicCodeSet = null, lmicInvert = false } = options || {};
  const list = Array.isArray(countries) ? countries : [];
  const regions = new Set();
  for (const value of list) {
    if (lmicCodeSet) {
      const code = resolveCountryToIso2(value);
      if (code === null || (lmicInvert ? lmicCodeSet.has(code) : !lmicCodeSet.has(code))) continue;
      const region = regionForIso2(code, scheme);
      if (region) regions.add(region);
    } else {
      const region = regionForCountry(value, scheme);
      if (region) regions.add(region);
    }
  }
  if (regions.size === 0) return lmicCodeSet ? [] : [REGION_UNKNOWN];
  return Array.from(regions);
}

/**
 * Guard used by tests: every canonical country must classify to a region
 * in the given scheme. Returns the list of unmapped ISO-2 codes (empty
 * when fully covered).
 */
export function listUnmappedCountryCodes(scheme = REGION_SCHEME_APP) {
  const map = SCHEMES[normaliseRegionScheme(scheme)].iso2ToRegion;
  return COUNTRIES.filter(c => !map.has(c.code)).map(c => c.code);
}
