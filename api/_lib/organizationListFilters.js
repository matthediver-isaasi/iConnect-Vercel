import { getCountryByName } from '../../shared/countries.js';
import { normalizeCustomFilterEntry, applyPrefFilterEntry, prefEntryNeedsAntiJoin, parseCoreFilters, applyDirectColumnFilter } from './prefValueOptionFilter.js';

const CORE_FILTER_COLUMNS = { phone: {}, website_url: {}, invoicing_email: {}, invoicing_address: {} };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function buildCountryOrConditions(names) {
  const conditions = [];
  for (const name of names) {
    const code = getCountryByName(name)?.code;
    conditions.push(`value.eq.${name}`, `value.ilike.*"${name}"*`);
    if (code) conditions.push(`value.eq.${code}`, `value.ilike.*"${code}"*`);
  }
  return conditions.join(',');
}

// One normalization/application path for pages and alphabet aggregation.
// Keep historical wire encodings and country name/ISO matching unchanged.
export function organizationListContract(params, tenantId, drillIds = []) {
  let parsed = {};
  if (params.customFilters && String(params.customFilters).trim()) {
    try {
      const obj = JSON.parse(params.customFilters);
      if (obj && typeof obj === 'object') {
        for (const [id, raw] of Object.entries(obj)) {
          const entry = normalizeCustomFilterEntry(raw);
          if (entry) parsed[id] = entry;
        }
      }
    } catch { /* Historical malformed-filter behavior: ignore. */ }
  }
  const customFilterEntries = Object.entries(parsed).slice(0,20);
  const coreFilterEntries = parseCoreFilters(params.coreFilters, CORE_FILTER_COLUMNS);
  const buildSelect = (base) => customFilterEntries.reduce((select, [, entry], index) =>
    `${select}, cf${index}:organization_preference_value${prefEntryNeedsAntiJoin(entry) ? '!left' : '!inner'}(field_id, value)`, base);
  const applyFilters = (query) => {
    query = query.eq('tenant_id',tenantId);
    if (drillIds.length) query = query.in('id',drillIds);
    if (params.group === 'none') query = query.is('organization_group_id',null);
    else if (params.group && UUID_RE.test(params.group)) query = query.eq('organization_group_id',params.group);
    customFilterEntries.forEach(([id,entry],index) => {
      const alias = `cf${index}`;
      query = applyPrefFilterEntry(query,alias,id,entry,{buildCountryConditions:buildCountryOrConditions});
      if (prefEntryNeedsAntiJoin(entry)) query = query.is(alias,null);
    });
    for (const entry of coreFilterEntries) query = applyDirectColumnFilter(query,entry);
    if (params.search && params.search.trim()) {
      const term = `%${params.search.trim().toLowerCase()}%`;
      query = query.or(`name.ilike.${term},invoicing_email.ilike.${term},phone.ilike.${term},website_url.ilike.${term}`);
    }
    for (const col of Object.keys(CORE_FILTER_COLUMNS)) {
      if (params[col] && params[col].trim()) query = query.ilike(col,`%${params[col].trim()}%`);
    }
    return query;
  };
  return { customFilterEntries, buildSelect, applyFilters };
}
