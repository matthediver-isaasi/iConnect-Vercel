/**
 * Country → world-region classification, shared by client and server.
 *
 * Region names and country assignments deliberately agree with GSF's
 * Zoho-era country lookup (`gsf_map_country_lookup` seed, 75 countries)
 * so dashboard widgets grouped by region match the legacy map site:
 *   - Middle East (Israel, Iraq, Jordan, Lebanon, …) → Asia
 *   - Central Asia (Kazakhstan, Kyrgyzstan, …) and the Caucasus
 *     (Armenia, Georgia, Azerbaijan) → Asia
 *   - Mexico, Central America and the Caribbean → Latin America
 *   - North America is Canada + United States only
 * Countries the GSF lookup doesn't cover follow the same convention
 * (e.g. Turkey → Asia alongside Armenia/Georgia; Russia → Europe).
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

// The single-region names, in stable display order.
export const REGION_NAMES = [
  REGION_AFRICA,
  REGION_ASIA,
  REGION_EUROPE,
  REGION_LATIN_AMERICA,
  REGION_NORTH_AMERICA,
  REGION_OCEANIA,
];

// Every derivable bucket, including the two synthetic ones.
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

// ISO-2 code -> region name, built once at module load.
const ISO2_TO_REGION = new Map();
for (const [region, codes] of Object.entries(REGION_ISO2)) {
  for (const code of codes) ISO2_TO_REGION.set(code, region);
}

/**
 * Region for a single ISO-2 code (uppercase), or null when unknown.
 */
export function regionForIso2(code) {
  if (!code) return null;
  return ISO2_TO_REGION.get(String(code).trim().toUpperCase()) || null;
}

/**
 * Region for a single stored country value — an ISO-2 code or a
 * free-text country name — resolved through the shared name→code
 * helper. Returns null when the value doesn't resolve to a known
 * country/region.
 */
export function regionForCountry(value) {
  const code = resolveCountryToIso2(value);
  return code ? regionForIso2(code) : null;
}

/**
 * Derive the single region bucket for a LIST of country values
 * (e.g. an organisation's "Countries of operation" multi-pick):
 *   - no values, or none resolvable → "Unknown"
 *   - all resolvable values in one region → that region's name
 *   - resolvable values spanning >1 region → "Multi-region"
 * Unresolvable entries in an otherwise-resolvable list are ignored.
 */
export function deriveRegionBucket(countries) {
  const list = Array.isArray(countries) ? countries : [];
  const regions = new Set();
  for (const value of list) {
    const region = regionForCountry(value);
    if (region) regions.add(region);
  }
  if (regions.size === 0) return REGION_UNKNOWN;
  if (regions.size > 1) return REGION_MULTI;
  return regions.values().next().value;
}

/**
 * Guard used by tests: every canonical country must classify to a region.
 * Returns the list of unmapped ISO-2 codes (empty when fully covered).
 */
export function listUnmappedCountryCodes() {
  return COUNTRIES.filter(c => !ISO2_TO_REGION.has(c.code)).map(c => c.code);
}
