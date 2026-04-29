/**
 * World Bank Low- and Middle-Income Countries (LMIC) — ISO-2 codes.
 *
 * Source: World Bank country and lending groups (low + lower-middle +
 * upper-middle income), as published for fiscal year 2024–2025.
 *   https://datahelpdesk.worldbank.org/knowledgebase/articles/906519
 *
 * This is the seed list used the first time a tenant opens the LMIC
 * settings page; admins can add or remove countries afterwards. Storing
 * the list as a static constant (rather than a runtime fetch) keeps the
 * dashboard responsive and avoids a third-party dependency for what is
 * essentially a slow-moving reference list.
 *
 * Codes are ISO-3166-1 alpha-2, matching `client/src/data/countries.js`.
 */
export const WORLD_BANK_LMIC_ISO2 = [
  // Low income
  'AF', 'BF', 'BI', 'CF', 'TD', 'CD', 'ER', 'ET', 'GM', 'GN',
  'GW', 'KP', 'LR', 'MG', 'MW', 'ML', 'MZ', 'NE', 'RW', 'SL',
  'SO', 'SS', 'SD', 'SY', 'TG', 'UG', 'YE',
  // Lower middle income
  'AO', 'BD', 'BJ', 'BO', 'BT', 'CV', 'CI', 'CM', 'CG', 'DJ',
  'EG', 'GH', 'HN', 'HT', 'IN', 'IR', 'JO', 'KE', 'KG', 'KH',
  'KM', 'LA', 'LB', 'LK', 'LS', 'MA', 'MD', 'MM', 'MN', 'MR',
  'NG', 'NI', 'NP', 'PG', 'PH', 'PK', 'PS', 'SB', 'SN', 'ST',
  'SV', 'SZ', 'TJ', 'TL', 'TN', 'TZ', 'UA', 'UZ', 'VN', 'VU',
  'WS', 'ZM', 'ZW',
  // Upper middle income
  'AL', 'AM', 'AR', 'AZ', 'BA', 'BG', 'BR', 'BW', 'BY', 'BZ',
  'CN', 'CO', 'CR', 'CU', 'DM', 'DO', 'EC', 'FJ', 'FM', 'GA',
  'GD', 'GE', 'GQ', 'GT', 'GY', 'IQ', 'JM', 'KZ', 'LC', 'LY',
  'MH', 'MK', 'MU', 'MV', 'MX', 'MY', 'NA', 'PE', 'PY',
  'RS', 'RU', 'SR', 'TH', 'TM', 'TO', 'TR', 'TV', 'VC', 'VE',
  'XK', 'ZA',
];

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
