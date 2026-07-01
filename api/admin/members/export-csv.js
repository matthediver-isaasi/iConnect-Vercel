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

function normalizePreferenceValue(val) {
  if (val === null || val === undefined) return '';
  if (typeof val === 'object' && !Array.isArray(val) && val.value !== undefined) {
    return val.label || val.value;
  }
  if (Array.isArray(val)) {
    return val.map(v => {
      if (typeof v === 'object' && v !== null && v.value !== undefined) return v.label || v.value;
      return v;
    }).join(', ');
  }
  return val;
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
      organizationId = '',
      roleId = '',
      status = 'all'
    } = req.query;

    let idList = null;
    if (ids) {
      idList = ids.split(',').map(id => id.trim()).filter(Boolean);
      if (idList.length === 0) {
        return res.status(400).json({ error: 'No valid IDs provided' });
      }
    }

    const buildMemberQuery = (from, pageSize) => {
      let q = supabase
        .from('member')
        .select(`
          id, first_name, last_name, email, handle, job_title, biography,
          mobile, landline, login_enabled, show_in_directory, status,
          last_activity, role_effective_from, created_on,
          organization_id, role_id,
          organization (id, name),
          role (id, name)
        `)
        .eq('tenant_id', tenantId)
        .not('email', 'like', 'deleted_%@deleted.local');

      if (idList) {
        q = q.in('id', idList);
      } else {
        if (search && search.trim()) {
          const searchTerm = `%${search.trim().toLowerCase()}%`;
          q = q.or(`first_name.ilike.${searchTerm},last_name.ilike.${searchTerm},email.ilike.${searchTerm},mobile.ilike.${searchTerm},job_title.ilike.${searchTerm}`);
        }
        if (organizationId && organizationId !== 'all') {
          q = q.eq('organization_id', organizationId);
        }
        if (roleId && roleId !== 'all') {
          q = q.eq('role_id', roleId);
        }
        if (status === 'active') {
          q = q.eq('login_enabled', true);
        } else if (status === 'disabled') {
          q = q.eq('login_enabled', false);
        }
      }

      return q.order('last_name', { ascending: true }).range(from, from + pageSize - 1);
    };

    const members = [];
    const PAGE_SIZE = 1000;
    let pageFrom = 0;
    while (true) {
      const { data: pageData, error } = await buildMemberQuery(pageFrom, PAGE_SIZE);
      if (error) {
        console.error('[MemberExportCSV] Query error:', error);
        return res.status(500).json({ error: 'Failed to fetch members' });
      }
      if (pageData && pageData.length > 0) members.push(...pageData);
      if (!pageData || pageData.length < PAGE_SIZE) break;
      pageFrom += PAGE_SIZE;
    }
    

    const { data: prefFields } = await supabase
      .from('preference_field')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .eq('entity_scope', 'member')
      .order('display_order', { ascending: true });

    const customFields = prefFields || [];

    let prefValues = [];
    if (customFields.length > 0 && members.length > 0) {
      const memberIds = members.map(m => m.id);
      const batchSize = 50;
      for (let i = 0; i < memberIds.length; i += batchSize) {
        const batch = memberIds.slice(i, i + batchSize);
        let from = 0;
        const pageSize = 1000;
        while (true) {
          const { data: pvData, error: pvError } = await supabase
            .from('member_preference_value')
            .select('*')
            .in('member_id', batch)
            .range(from, from + pageSize - 1);
          if (pvError) {
            console.error('[MemberExportCSV] Preference values query error:', pvError);
            break;
          }
          if (pvData && pvData.length > 0) {
            prefValues.push(...pvData);
          }
          if (!pvData || pvData.length < pageSize) break;
          from += pageSize;
        }
      }
      
    }

    const memberPrefMap = {};
    prefValues.forEach(pv => {
      if (!memberPrefMap[pv.member_id]) memberPrefMap[pv.member_id] = {};
      const fieldIdKey = pv.field_id || pv.preference_field_id;
      if (!fieldIdKey) return;
      memberPrefMap[pv.member_id][fieldIdKey] = pv.value;
    });

    const coreHeaders = [
      'first_name', 'last_name', 'email', 'handle', 'job_title',
      'biography', 'mobile', 'landline',
      'organisation_name', 'role_name',
      'login_enabled', 'show_in_directory', 'status',
      'created_on', 'last_activity', 'role_effective_from'
    ];

    const customHeaders = customFields.map(f => f.label);
    const allHeaders = [...coreHeaders, ...customHeaders];

    const headerRow = allHeaders.map(escapeCSV).join(',');

    const dataRows = members.map(member => {
      const coreValues = coreHeaders.map(field => {
        if (field === 'organisation_name') {
          return member.organization?.name || '';
        }
        if (field === 'role_name') {
          return member.role?.name || '';
        }
        if (field === 'created_on' || field === 'last_activity' || field === 'role_effective_from') {
          return formatDate(member[field]);
        }
        if (field === 'login_enabled' || field === 'show_in_directory') {
          return member[field] === false ? 'No' : 'Yes';
        }
        return member[field] != null ? String(member[field]) : '';
      });

      const customValues = customFields.map(f => {
        let rawValue = memberPrefMap[member.id]?.[f.id];
        if (rawValue === null || rawValue === undefined) return '';
        if (typeof rawValue === 'string') {
          const trimmed = rawValue.trim();
          if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
            try { rawValue = JSON.parse(trimmed); } catch {}
          }
        }
        if (f.field_type === 'picklist' || f.field_type === 'dropdown' || f.field_type === 'list') {
          const originalValue = prefValues.find(
            pv => pv.member_id === member.id && (pv.field_id === f.id || pv.preference_field_id === f.id)
          )?.value;
          return resolvePicklistValue(originalValue || '', f);
        }
        rawValue = normalizePreferenceValue(rawValue);
        if (Array.isArray(rawValue)) return rawValue.join(', ');
        return String(rawValue);
      });

      return [...coreValues, ...customValues].map(escapeCSV).join(',');
    });

    const csv = [headerRow, ...dataRows].join('\n');

    const today = new Date().toISOString().split('T')[0];
    const filename = `members_export_${today}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  } catch (err) {
    console.error('[MemberExportCSV] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
