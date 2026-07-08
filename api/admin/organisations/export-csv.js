import { supabase } from '../../_lib/database.js';
import { getTenantContext } from '../../_lib/tenantContext.js';
import { getCountryByName } from '../../../shared/countries.js';
import {
  normalizeCustomFilterEntry,
  parseCoreFilters,
  applyDirectColumnFilter,
} from '../../_lib/prefValueOptionFilter.js';

// Direct organization columns filterable through the coreFilters param
// (mirrors /api/admin/organizations/paginated).
const CORE_FILTER_COLUMNS = {
  phone: {},
  website_url: {},
  invoicing_email: {},
  invoicing_address: {},
};

function sanitizeForCSV(value) {
  if (value === null || value === undefined) return '';
  let str = String(value);
  if (/^[=+\-@\t\r]/.test(str)) {
    str = "'" + str;
  }
  return str;
}

function escapeCSV(value) {
  const str = sanitizeForCSV(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    return d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
  } catch {
    return '';
  }
}

function resolvePicklistValue(rawValue, field) {
  if (!rawValue || !field) return rawValue || '';
  const options = field.options || [];
  if (!options.length) return rawValue;

  let parsed = rawValue;
  if (typeof rawValue === 'string') {
    const trimmed = rawValue.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try { parsed = JSON.parse(trimmed); } catch { parsed = rawValue; }
    }
  }

  if (Array.isArray(parsed)) {
    return parsed.map(v => {
      const itemVal = (typeof v === 'object' && v !== null && v.value !== undefined) ? v.value : v;
      const opt = options.find(o => o.value === itemVal);
      return opt?.label || (typeof v === 'object' && v !== null && v.label) || itemVal;
    }).join(', ');
  }

  if (typeof parsed === 'object' && parsed !== null && parsed.value !== undefined) {
    const opt = options.find(o => o.value === parsed.value);
    return opt?.label || parsed.label || parsed.value;
  }

  const lookupVal = typeof parsed === 'string' ? parsed : String(rawValue);
  const opt = options.find(o => o.value === lookupVal);
  return opt?.label || lookupVal;
}

function normalizePreferenceValue(val) {
  if (val === null || val === undefined) return val;
  if (typeof val === 'object' && !Array.isArray(val) && val.value !== undefined) {
    return val.value;
  }
  if (Array.isArray(val)) {
    return val.map(item => {
      if (typeof item === 'object' && item !== null && item.value !== undefined) {
        return item.value;
      }
      return item;
    });
  }
  return val;
}

// True when a customFieldFilters entry should actually filter the export.
// Array values (multi-select option filters) are active when they contain a
// real value; operator objects are active when they normalize to a usable
// entry; legacy string values keep the old truthy/'all' semantics.
export function isActiveExportFilterValue(filterValue) {
  if (Array.isArray(filterValue)) {
    return filterValue.some(v => v && v !== 'all');
  }
  if (filterValue && typeof filterValue === 'object') {
    return normalizeCustomFilterEntry(filterValue) !== null;
  }
  return Boolean(filterValue && filterValue !== 'all' && filterValue.trim() !== '');
}

export function matchesSingleOptionValue(orgFieldValue, optionValue) {
  if (Array.isArray(orgFieldValue)) {
    return orgFieldValue.includes(optionValue);
  }
  return orgFieldValue === optionValue;
}

export function matchesCustomFieldFilter(orgFieldValue, filterValue) {
  // Multi-select option filter: OR across the selected values.
  if (Array.isArray(filterValue)) {
    const vals = filterValue.filter(v => v && v !== 'all');
    if (vals.length === 0) return true;
    if (orgFieldValue === null || orgFieldValue === undefined) return false;
    return vals.some(v => matchesSingleOptionValue(orgFieldValue, v));
  }

  if (!filterValue || filterValue === 'all' || filterValue.trim() === '') return true;
  if (orgFieldValue === null || orgFieldValue === undefined) return false;

  const isTextFilter = filterValue.startsWith('__text__:');
  const actualValue = isTextFilter ? filterValue.replace('__text__:', '').toLowerCase() : filterValue;

  if (isTextFilter) {
    const strVal = Array.isArray(orgFieldValue) ? orgFieldValue.join(' ') : String(orgFieldValue);
    return strVal.toLowerCase().includes(actualValue);
  }

  return matchesSingleOptionValue(orgFieldValue, filterValue);
}

// Expand a set of country names with their ISO-2 codes so stored legacy codes
// still match (mirrors the DB-side country matching in the paginated endpoint).
function expandCountryValues(names) {
  const out = [];
  for (const name of names) {
    out.push(name);
    const code = getCountryByName(name)?.code;
    if (code) out.push(code);
  }
  return out;
}

// In-memory matcher for a normalized filter entry (see
// normalizeCustomFilterEntry) against one org's normalized field value.
export function matchesNormalizedEntry(orgFieldValue, entry) {
  const isEmptyVal = orgFieldValue === null || orgFieldValue === undefined
    || (typeof orgFieldValue === 'string' && orgFieldValue.trim() === '')
    || (Array.isArray(orgFieldValue) && orgFieldValue.length === 0);
  switch (entry.op) {
    case 'empty':
      return isEmptyVal;
    case 'not_empty':
      return !isEmptyVal;
    case 'contains':
    case 'not_contains': {
      const strVal = isEmptyVal
        ? ''
        : (Array.isArray(orgFieldValue) ? orgFieldValue.join(' ') : String(orgFieldValue));
      const matched = !isEmptyVal && strVal.toLowerCase().includes(String(entry.value).toLowerCase());
      return entry.op === 'contains' ? matched : !matched;
    }
    case 'equals':
      return !isEmptyVal && !Array.isArray(orgFieldValue)
        && String(orgFieldValue).toLowerCase() === String(entry.value).toLowerCase();
    case 'bool_is': {
      if (isEmptyVal) return false;
      const target = entry.value === 'Yes' ? ['yes', 'true'] : ['no', 'false'];
      return target.includes(String(orgFieldValue).toLowerCase());
    }
    case 'any_of':
    case 'none_of': {
      const values = entry.kind === 'country' ? expandCountryValues(entry.values) : entry.values;
      const matched = !isEmptyVal && values.some(v => matchesSingleOptionValue(orgFieldValue, v));
      return entry.op === 'any_of' ? matched : !matched;
    }
    default:
      return true;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tenantCtx = await getTenantContext(req);
  if (!tenantCtx || !tenantCtx.isAuthenticated) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const tenantId = tenantCtx.tenantId;
  if (!tenantId) {
    return res.status(403).json({ error: 'Invalid tenant context' });
  }

  try {
    const {
      ids,
      search = '',
      excludePrimary,
      phone = '',
      website_url = '',
      invoicing_email = '',
      invoicing_address = '',
      coreFilters = '',
      customFieldFilters: customFieldFiltersParam = ''
    } = req.query;

    const coreFilterEntries = parseCoreFilters(coreFilters, CORE_FILTER_COLUMNS);

    let idList = null;
    if (ids) {
      idList = ids.split(',').map(id => id.trim()).filter(Boolean);
      if (idList.length === 0) {
        return res.status(400).json({ error: 'No valid IDs provided' });
      }
    }

    const buildOrgQuery = (from, pageSize) => {
      let q = supabase
        .from('organization')
        .select('*')
        .eq('tenant_id', tenantId);

      if (idList) {
        q = q.in('id', idList);
      } else {
        if (search && search.trim()) {
          const searchTerm = `%${search.trim().toLowerCase()}%`;
          q = q.or(`name.ilike.${searchTerm},invoicing_email.ilike.${searchTerm},phone.ilike.${searchTerm},website_url.ilike.${searchTerm}`);
        }

        if (phone && phone.trim()) {
          q = q.ilike('phone', `%${phone.trim()}%`);
        }
        if (website_url && website_url.trim()) {
          q = q.ilike('website_url', `%${website_url.trim()}%`);
        }
        if (invoicing_email && invoicing_email.trim()) {
          q = q.ilike('invoicing_email', `%${invoicing_email.trim()}%`);
        }
        if (invoicing_address && invoicing_address.trim()) {
          q = q.ilike('invoicing_address', `%${invoicing_address.trim()}%`);
        }
        for (const coreEntry of coreFilterEntries) {
          q = applyDirectColumnFilter(q, coreEntry);
        }
      }

      if (excludePrimary === 'true') {
        q = q.neq('is_primary', true);
      }

      return q.order('name', { ascending: true }).range(from, from + pageSize - 1);
    };

    // Custom preference fields drive the extra CSV columns; fetch their
    // definitions up front so the header row can be emitted before any data.
    const { data: prefFields } = await supabase
      .from('preference_field')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .eq('entity_scope', 'organization')
      .order('display_order', { ascending: true });

    const customFields = prefFields || [];

    let customFilterMap = {};
    if (customFieldFiltersParam) {
      try {
        customFilterMap = JSON.parse(customFieldFiltersParam);
      } catch {}
    }
    // Normalize each active filter entry once (legacy encodings and operator
    // objects share the same canonical shape).
    const normalizedCustomFilters = Object.entries(customFilterMap)
      .map(([fieldId, raw]) => [fieldId, normalizeCustomFilterEntry(raw)])
      .filter(([, entry]) => entry !== null);
    const hasCustomFilters = normalizedCustomFilters.length > 0;

    const coreHeaders = [
      'name', 'slug', 'description', 'website_url', 'logo_url',
      'email', 'phone', 'address', 'city', 'country', 'postcode',
      'invoicing_email', 'invoicing_address',
      'training_fund_balance', 'is_active', 'external_id',
      'linkedin_url', 'twitter_url', 'facebook_url', 'instagram_url',
      'created_at', 'updated_at'
    ];

    const customHeaders = customFields.map(f => f.label);
    const allHeaders = [...coreHeaders, ...customHeaders];
    const headerRow = allHeaders.map(escapeCSV).join(',');

    const PAGE_SIZE = 1000;
    const PREF_BATCH_SIZE = 200;

    // Load preference values for a single page of organisations at a time so
    // memory stays bounded to one page regardless of tenant size. Keeps both a
    // normalised map (for filtering / plain display) and the raw value (needed
    // to resolve picklist labels).
    const loadPrefValuesForOrgs = async (orgIds) => {
      const pagePrefMap = {};
      const pageRawMap = {};
      if (orgIds.length === 0) return { pagePrefMap, pageRawMap };
      for (let i = 0; i < orgIds.length; i += PREF_BATCH_SIZE) {
        const batch = orgIds.slice(i, i + PREF_BATCH_SIZE);
        let from = 0;
        const pageSize = 1000;
        while (true) {
          const { data: pvData, error: pvError } = await supabase
            .from('organization_preference_value')
            .select('organization_id, field_id, value')
            .in('organization_id', batch)
            .range(from, from + pageSize - 1);
          if (pvError) {
            throw new Error(`Preference values query failed: ${pvError.message}`);
          }
          if (pvData && pvData.length > 0) {
            for (const pv of pvData) {
              const fieldIdKey = pv.field_id;
              if (!fieldIdKey) continue;
              if (!pageRawMap[pv.organization_id]) pageRawMap[pv.organization_id] = {};
              pageRawMap[pv.organization_id][fieldIdKey] = pv.value;

              let normalizedValue = pv.value;
              if (typeof pv.value === 'string') {
                const trimmed = pv.value.trim();
                if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
                  try { normalizedValue = JSON.parse(trimmed); } catch {}
                }
              }
              normalizedValue = normalizePreferenceValue(normalizedValue);
              if (!pagePrefMap[pv.organization_id]) pagePrefMap[pv.organization_id] = {};
              pagePrefMap[pv.organization_id][fieldIdKey] = normalizedValue;
            }
          }
          if (!pvData || pvData.length < pageSize) break;
          from += pageSize;
        }
      }
      return { pagePrefMap, pageRawMap };
    };

    const buildOrgRow = (org, pagePrefMap, pageRawMap) => {
      const coreValues = coreHeaders.map(field => {
        if (field === 'created_at' || field === 'updated_at') {
          return formatDate(org[field]);
        }
        if (field === 'address' || field === 'invoicing_address') {
          const val = org[field];
          if (!val) return '';
          if (typeof val === 'object') {
            const parts = [val.line1, val.line2, val.city, val.region, val.postcode, val.country].filter(Boolean);
            return parts.join(', ');
          }
          if (typeof val === 'string') {
            try {
              const parsed = JSON.parse(val);
              if (typeof parsed === 'object' && parsed !== null) {
                const parts = [parsed.line1, parsed.line2, parsed.city, parsed.region, parsed.postcode, parsed.country].filter(Boolean);
                return parts.join(', ');
              }
            } catch {}
          }
          return String(val);
        }
        if (field === 'is_active') {
          return org[field] === false ? 'No' : 'Yes';
        }
        if (field === 'training_fund_balance') {
          return org[field] != null ? String(org[field]) : '0';
        }
        return org[field] != null ? String(org[field]) : '';
      });

      const customValues = customFields.map(f => {
        const rawValue = pagePrefMap[org.id]?.[f.id];
        if (rawValue === null || rawValue === undefined) return '';
        if (f.field_type === 'picklist' || f.field_type === 'dropdown' || f.field_type === 'list') {
          const originalValue = pageRawMap[org.id]?.[f.id];
          return resolvePicklistValue(originalValue || '', f);
        }
        if (Array.isArray(rawValue)) return rawValue.join(', ');
        return String(rawValue);
      });

      return [...coreValues, ...customValues].map(escapeCSV).join(',');
    };

    // Fetch the first page before committing to a streamed 200 response so any
    // query error still surfaces as a proper HTTP error status.
    const firstPage = await buildOrgQuery(0, PAGE_SIZE);
    if (firstPage.error) {
      console.error('[OrgExportCSV] Query error:', firstPage.error);
      return res.status(500).json({ error: 'Failed to fetch organisations' });
    }

    const today = new Date().toISOString().split('T')[0];
    const filename = `organisations_export_${today}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    res.write(headerRow);

    try {
      let pageData = firstPage.data || [];
      let pageFrom = 0;
      while (true) {
        if (pageData.length > 0) {
          const orgIds = pageData.map(o => o.id);
          const { pagePrefMap, pageRawMap } = await loadPrefValuesForOrgs(orgIds);
          let chunk = '';
          for (const org of pageData) {
            if (hasCustomFilters) {
              const passes = normalizedCustomFilters.every(([fieldId, entry]) => {
                const orgFieldValue = pagePrefMap[org.id]?.[fieldId];
                return matchesNormalizedEntry(orgFieldValue, entry);
              });
              if (!passes) continue;
            }
            chunk += '\n' + buildOrgRow(org, pagePrefMap, pageRawMap);
          }
          if (chunk) {
            res.write(chunk);
            // Yield so the buffered chunk flushes to the network.
            await new Promise(resolve => setImmediate(resolve));
          }
        }
        if (pageData.length < PAGE_SIZE) break;
        pageFrom += PAGE_SIZE;
        const next = await buildOrgQuery(pageFrom, PAGE_SIZE);
        if (next.error) {
          throw new Error(`Organisations query failed: ${next.error.message}`);
        }
        pageData = next.data || [];
      }
      return res.end();
    } catch (streamErr) {
      // The response is already streaming, so we cannot switch to a 500.
      // Abort the connection so the client sees a failed download rather than
      // silently receiving a truncated CSV.
      console.error('[OrgExportCSV] Streaming error:', streamErr);
      try { res.destroy(streamErr); } catch { /* ignore */ }
      return;
    }
  } catch (err) {
    console.error('[OrgExportCSV] Error:', err);
    if (res.headersSent) {
      try { res.destroy(err); } catch { /* ignore */ }
      return;
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
}
