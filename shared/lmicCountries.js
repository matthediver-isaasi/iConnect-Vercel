/**
 * World Bank Low- and Middle-Income Countries (LMIC) — ISO-2 codes.
 *
 * Source: World Bank country and lending groups (low + lower-middle +
 * upper-middle income), FY2026 classification (effective 1 July 2025,
 * based on 2024 GNI per capita).
 *   https://datahelpdesk.worldbank.org/knowledgebase/articles/906519
 *
 * This is the seed list used the first time a tenant opens the LMIC
 * settings page; admins can add or remove countries afterwards. Storing
 * the list as a static constant (rather than a runtime fetch) keeps the
 * dashboard responsive and avoids a third-party dependency for what is
 * essentially a slow-moving reference list.
 *
 * Note: the World Bank currently leaves Ethiopia (ET) and Venezuela (VE)
 * "unclassified" pending data, so neither appears in the official low /
 * lower-middle / upper-middle groups below. They are intentionally
 * excluded here to match the published classification exactly.
 *
 * Codes are ISO-3166-1 alpha-2, matching `client/src/data/countries.js`.
 */
export const WORLD_BANK_LMIC_ISO2 = [
  // Low income (25)
  'AF', 'BF', 'BI', 'CD', 'CF', 'ER', 'GM', 'GW', 'KP', 'LR',
  'MG', 'ML', 'MW', 'MZ', 'NE', 'RW', 'SD', 'SL', 'SO', 'SS',
  'SY', 'TD', 'TG', 'UG', 'YE',
  // Lower-middle income (50)
  'AO', 'BD', 'BJ', 'BO', 'BT', 'CG', 'CI', 'CM', 'DJ', 'EG',
  'FM', 'GH', 'GN', 'HN', 'HT', 'IN', 'JO', 'KE', 'KG', 'KH',
  'KI', 'KM', 'LA', 'LB', 'LK', 'LS', 'MA', 'MM', 'MR', 'NA',
  'NG', 'NI', 'NP', 'PG', 'PH', 'PK', 'PS', 'SB', 'SN', 'ST',
  'SZ', 'TJ', 'TL', 'TN', 'TZ', 'UZ', 'VN', 'VU', 'ZM', 'ZW',
  // Upper-middle income (54)
  'AL', 'AM', 'AR', 'AZ', 'BA', 'BR', 'BW', 'BY', 'BZ', 'CN',
  'CO', 'CU', 'CV', 'DM', 'DO', 'DZ', 'EC', 'FJ', 'GA', 'GD',
  'GE', 'GQ', 'GT', 'ID', 'IQ', 'IR', 'JM', 'KZ', 'LC', 'LY',
  'MD', 'ME', 'MH', 'MK', 'MN', 'MU', 'MV', 'MX', 'MY', 'PE',
  'PY', 'RS', 'SR', 'SV', 'TH', 'TM', 'TO', 'TR', 'TV', 'UA',
  'VC', 'WS', 'XK', 'ZA',
];

/**
 * Provenance for the seed list above, surfaced in the admin UI so admins
 * can see exactly which World Bank dataset/version the default is based on.
 * Keep this in lockstep with WORLD_BANK_LMIC_ISO2 whenever the list is
 * refreshed for a new World Bank classification.
 */
export const WORLD_BANK_LMIC_SOURCE = {
  classification: 'FY2026',
  effectiveDate: '1 July 2025',
  basedOn: '2024 GNI per capita (Atlas method)',
  label: 'World Bank country and lending groups',
  url: 'https://datahelpdesk.worldbank.org/knowledgebase/articles/906519',
};

/**
 * Returns a sanitised, de-duplicated, upper-cased list of ISO-2 codes.
 * Filters out anything that isn't a 2-letter alpha string so we never
 * persist or query with garbage values.
 */
export function normaliseCountryCodes(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const code = raw.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) continue;
    if (seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}
