import { supabase } from '../../_lib/database.js';
import { getTenantContext } from '../../_lib/tenantContext.js';

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
      const opt = options.find(o => o.value === v);
      return opt?.label || v;
    }).join(', ');
  }

  const lookupVal = typeof parsed === 'string' ? parsed : rawValue;
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

function matchesCustomFieldFilter(orgFieldValue, filterValue) {
  if (!filterValue || filterValue === 'all' || filterValue.trim() === '') return true;
  if (orgFieldValue === null || orgFieldValue === undefined) return false;

  const isTextFilter = filterValue.startsWith('__text__:');
  const actualValue = isTextFilter ? filterValue.replace('__text__:', '').toLowerCase() : filterValue;

  if (isTextFilter) {
    const strVal = Array.isArray(orgFieldValue) ? orgFieldValue.join(' ') : String(orgFieldValue);
    return strVal.toLowerCase().includes(actualValue);
  }

  if (Array.isArray(orgFieldValue)) {
    return orgFieldValue.includes(filterValue);
  }
  return orgFieldValue === filterValue;
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
      customFieldFilters: customFieldFiltersParam = ''
    } = req.query;

    let query = supabase
      .from('organization')
      .select('*')
      .eq('tenant_id', tenantId);

    if (ids) {
      const idList = ids.split(',').map(id => id.trim()).filter(Boolean);
      if (idList.length === 0) {
        return res.status(400).json({ error: 'No valid IDs provided' });
      }
      query = query.in('id', idList);
    } else {
      if (search && search.trim()) {
        const searchTerm = `%${search.trim().toLowerCase()}%`;
        query = query.or(`name.ilike.${searchTerm},invoicing_email.ilike.${searchTerm},phone.ilike.${searchTerm},website_url.ilike.${searchTerm}`);
      }

      if (phone && phone.trim()) {
        query = query.ilike('phone', `%${phone.trim()}%`);
      }
      if (website_url && website_url.trim()) {
        query = query.ilike('website_url', `%${website_url.trim()}%`);
      }
      if (invoicing_email && invoicing_email.trim()) {
        query = query.ilike('invoicing_email', `%${invoicing_email.trim()}%`);
      }
      if (invoicing_address && invoicing_address.trim()) {
        query = query.ilike('invoicing_address', `%${invoicing_address.trim()}%`);
      }
    }

    if (excludePrimary === 'true') {
      query = query.neq('is_primary', true);
    }

    query = query.order('name', { ascending: true });

    const { data: organizations, error } = await query;
    if (error) {
      console.error('[OrgExportCSV] Query error:', error);
      return res.status(500).json({ error: 'Failed to fetch organisations' });
    }

    const { data: prefFields } = await supabase
      .from('preference_field')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .eq('entity_scope', 'organization')
      .order('display_order', { ascending: true });

    const customFields = prefFields || [];

    let prefValues = [];
    if (organizations.length > 0) {
      const orgIds = organizations.map(o => o.id);
      const { data: pvData } = await supabase
        .from('organization_preference_value')
        .select('*')
        .in('organization_id', orgIds);
      prefValues = pvData || [];
    }

    const orgPrefMap = {};
    prefValues.forEach(pv => {
      if (!orgPrefMap[pv.organization_id]) orgPrefMap[pv.organization_id] = {};
      let normalizedValue = pv.value;
      if (typeof pv.value === 'string') {
        const trimmed = pv.value.trim();
        if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
          try { normalizedValue = JSON.parse(trimmed); } catch {}
        }
      }
      normalizedValue = normalizePreferenceValue(normalizedValue);
      orgPrefMap[pv.organization_id][pv.field_id] = normalizedValue;
    });

    let customFilterMap = {};
    if (customFieldFiltersParam) {
      try {
        customFilterMap = JSON.parse(customFieldFiltersParam);
      } catch {}
    }

    let filteredOrgs = organizations;
    const hasCustomFilters = Object.entries(customFilterMap).some(
      ([, v]) => v && v !== 'all' && v.trim() !== ''
    );

    if (hasCustomFilters) {
      filteredOrgs = organizations.filter(org => {
        return Object.entries(customFilterMap).every(([fieldId, filterValue]) => {
          if (!filterValue || filterValue === 'all' || filterValue.trim() === '') return true;
          const orgFieldValue = orgPrefMap[org.id]?.[fieldId];
          return matchesCustomFieldFilter(orgFieldValue, filterValue);
        });
      });
    }

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

    const dataRows = filteredOrgs.map(org => {
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
        const rawValue = orgPrefMap[org.id]?.[f.id];
        if (rawValue === null || rawValue === undefined) return '';
        if (f.field_type === 'picklist' || f.field_type === 'dropdown' || f.field_type === 'list') {
          const originalValue = prefValues.find(
            pv => pv.organization_id === org.id && pv.field_id === f.id
          )?.value;
          return resolvePicklistValue(originalValue || '', f);
        }
        if (Array.isArray(rawValue)) return rawValue.join(', ');
        return String(rawValue);
      });

      return [...coreValues, ...customValues].map(escapeCSV).join(',');
    });

    const csv = [headerRow, ...dataRows].join('\n');

    const today = new Date().toISOString().split('T')[0];
    const filename = `organisations_export_${today}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  } catch (err) {
    console.error('[OrgExportCSV] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
