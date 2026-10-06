import { COUNTRIES, resolveCountryToIso2 } from '../shared/countries.js';

export const keys = ['org_address_line_1', 'org_address_line_2', 'org_address_line_3', 'org_town_city', 'org_county', 'org_postcode', 'org_country'];
const norm = v => String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const postal = {
  GB: /^(?:GIR\s?0AA|[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})$/i,
  IE: /^[A-Z]\d{2}\s?[A-Z0-9]{4}$/i,
  US: /^\d{5}(?:-\d{4})?$/, CA: /^[A-Z]\d[A-Z]\s?\d[A-Z]\d$/i,
  PK: /^\d{5}$/, UY: /^\d{5}$/, RO: /^\d{6}$/,
  DE: /^\d{5}$/, FR: /^\d{5}$/, AU: /^\d{4}$/, NZ: /^\d{4}$/,
};
// Classification only of explicit source text; never enrich from postcode or town.
const counties = new Set(('Greater London|Greater Manchester|West Midlands|Merseyside|South Yorkshire|North Yorkshire|West Yorkshire|East Yorkshire|County Durham|Kent|Surrey|Essex|Sussex|East Sussex|West Sussex|Cumbria|Norfolk|Suffolk|Somerset|Dorset|Devon|Cornwall|Isle of Wight|Tyne and Wear|Northumberland|Bedfordshire|Berkshire|Buckinghamshire|Cambridgeshire|Cheshire|Derbyshire|Gloucestershire|Hampshire|Herefordshire|Hertfordshire|Lancashire|Leicestershire|Lincolnshire|Northamptonshire|Nottinghamshire|Oxfordshire|Shropshire|Staffordshire|Warwickshire|Wiltshire|Worcestershire|Renfrewshire|Ayrshire|Lanarkshire|Fife|Midlothian').toLowerCase().split('|'));

export function mapAddress(source, existing = {}, countryField = {}) {
  const proposed = Object.fromEntries(keys.map(k => [k, null]));
  const reasons = [], ledger = [];
  if (!source?.trim()) return { proposed, reasons: ['No source invoicing address; existing values retained.'], ledger, unassigned: [], conflicts: [], ambiguous: false, missing: true };
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]|<[^>]+>|\\n/.test(source)) reasons.push('Malformed/control/HTML or literal escaped-newline content requires review.');
  const parts = source.split(/\r\n|\r|\n|,|;/).map(text => ({ text, value: text.trim() })).filter(p => p.value);
  const remaining = [...parts];
  const assign = (part, key, value = part.value, evidence = 'Explicit source component') => {
    proposed[key] = value;
    ledger.push({ source: part.value, destination: key, value, evidence });
    remaining.splice(remaining.indexOf(part), 1);
  };
  const last = remaining.at(-1);
  const code = last && resolveCountryToIso2(last.value);
  if (code) {
    const name = COUNTRIES.find(c => c.code === code).name;
    assign(last, 'org_country', name, 'Explicit terminal country; canonical country name used by organisation editor');
    if (countryField.all_countries === false && !(countryField.selected_countries || []).some(v => resolveCountryToIso2(v) === code)) reasons.push('Explicit country is excluded by destination allowed-country configuration.');
  }
  const country = code || resolveCountryToIso2(existing.org_country);
  const tail = remaining.at(-1);
  if (tail && postal[country]?.test(tail.value)) assign(tail, 'org_postcode', tail.value, `Terminal ${country} postal pattern; pattern is not postal deliverability verification`);
  // Existing town corroborates the boundary only when it occurs exactly once in the source.
  const towns = remaining.filter(p => norm(p.value) === norm(existing.org_town_city) && norm(existing.org_town_city));
  if (towns.length === 1) assign(towns[0], 'org_town_city', towns[0].value, 'Exact source component matches existing town/city');
  else if (towns.length > 1) reasons.push('Repeated town/city component; boundary is ambiguous.');
  const countyTail = remaining.at(-1);
  if (countyTail && (norm(countyTail.value) === norm(existing.org_county) || (country === 'GB' && counties.has(norm(countyTail.value))))) {
    assign(countyTail, 'org_county', countyTail.value, 'Explicit source county matches existing county or enumerated UK county label; not independently geographically verified');
  }
  if (!proposed.org_town_city && remaining.length > 1) reasons.push('Town/city is not corroborated; locality/county boundaries remain unresolved.');
  const townIndex = proposed.org_town_city ? parts.indexOf(towns[0]) : -1;
  for (const part of [...remaining]) {
    if (townIndex >= 0 && parts.indexOf(part) > townIndex) continue;
    const index = keys.slice(0, 3).findIndex(k => proposed[k] === null);
    if (index >= 0) assign(part, keys[index], part.value, 'Source order retained before corroborated town, or provisional address-line placement');
  }
  if (remaining.length) reasons.push('Unassigned components or overflow beyond three address lines; no text discarded.');
  if (!proposed.org_town_city && !proposed.org_postcode) reasons.push('Incomplete address without corroborated town or recognised terminal postcode; provisional lines need review.');
  if (new Set(parts.map(p => norm(p.value))).size !== parts.length) reasons.push('Repeated source components retained; potential duplicate address text.');
  const conflicts = keys.filter(k => proposed[k] !== null && norm(existing[k]) && norm(existing[k]) !== norm(proposed[k]));
  // Every nonempty source component must appear exactly once, either assigned or retained.
  if (ledger.length + remaining.length !== parts.length) throw new Error('Source coverage failure');
  return { proposed, reasons, ledger, unassigned: remaining.map(p => p.value), conflicts, ambiguous: reasons.length > 0, missing: false };
}
