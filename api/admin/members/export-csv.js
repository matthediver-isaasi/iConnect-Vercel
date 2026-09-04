import { supabase } from '../../_lib/database.js';
import { getTenantContext } from '../../_lib/tenantContext.js';
import { escapeCsvCell as escapeCSV, CSV_BOM, CSV_ROW_SEPARATOR } from '../../_lib/csvCell.js';
import {
  parseMemberListFilters,
  validateOrganizationFilterEntries,
  memberFilterSelectJoins,
  applyMemberListFilters,
  stripFilterJoinAliases,
} from '../../_lib/memberListFilters.js';
import { resolveDepartmentMemberIds, enrichMembersWithDepartments, MemberDepartmentError } from '../../_lib/memberDepartments.js';
import {
  memberExportCountError,
  parseExpectedMemberExportTotal,
  shouldRejectEmptyMemberExport,
} from '../../_lib/memberExportContract.js';

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
  if (req.method !== 'GET' && req.method !== 'POST') {
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
       departmentId = '',
      roleId = '',
      status = 'all',
      customFilters = '',
      organizationFilters = '',
      coreFilters = ''
    } = req.query;

    const rawSelectedIds = req.method === 'POST' ? req.body?.selectedIds : ids;
    let idList = null;
    if (rawSelectedIds) {
      idList = (Array.isArray(rawSelectedIds) ? rawSelectedIds : String(rawSelectedIds).split(','))
        .map(id => String(id).trim()).filter(Boolean);
      if (idList.length === 0) {
        return res.status(400).json({ error: 'No valid IDs provided' });
      }
    }
    const rawDrillIds = req.method === 'POST' ? req.body?.drillIds : '';
    const drillIds = (Array.isArray(rawDrillIds) ? rawDrillIds : String(rawDrillIds || '').split(','))
      .map(id => String(id).trim()).filter(Boolean).slice(0, 2000);
    const expectedTotalRaw = req.method === 'POST' ? req.body?.expectedTotal : null;
    const expectedTotal = parseExpectedMemberExportTotal(req.method, expectedTotalRaw);

    // Same filter contract as /api/admin/members/paginated (shared module), so
    // "export all filtered" always exports exactly the population the list
    // shows — including multi-role selections, operator-driven coreFilters
    // (e.g. role none_of) and custom field filters.
    const filterCtx = parseMemberListFilters({ search, organizationId, departmentId, roleId, status, customFilters, organizationFilters, coreFilters });
    await validateOrganizationFilterEntries(supabase, tenantId, filterCtx);
    const departmentMemberIds = !idList && filterCtx.departmentIds.length
      ? await resolveDepartmentMemberIds(supabase, tenantId, filterCtx.departmentIds) : null;
    const hasNoDepartmentMatches = departmentMemberIds !== null && departmentMemberIds.length === 0;

    const buildMemberQuery = (from, pageSize, withCount = false) => {
      let selectClause = `
          id, first_name, last_name, email, handle, job_title, biography,
          mobile, landline, login_enabled, show_in_directory, status,
          last_activity, role_effective_from, created_on,
          organization_id, role_id,
          organization (id, name),
          role (id, name)`;
      if (!idList) {
        selectClause += memberFilterSelectJoins(filterCtx);
      }

      let q = supabase
        .from('member')
        .select(selectClause, withCount ? { count: 'exact' } : undefined)
        .eq('tenant_id', tenantId)
        .not('email', 'like', 'deleted_%@deleted.local');

      if (idList) {
        q = q.in('id', idList);
      } else {
        if (drillIds.length > 0) q = q.in('id', drillIds);
        q = applyMemberListFilters(q, filterCtx, { tenantId });
        // Do not send `in.()` to PostgREST for an empty resolved edge set.
        // A nil UUID is an impossible member ID and keeps normal CSV header/
        // streaming behavior for an empty filtered export.
        if (hasNoDepartmentMatches) q = q.eq('id', '00000000-0000-0000-0000-000000000000');
        else if (departmentMemberIds) q = q.in('id', departmentMemberIds);
      }

      return q.order('last_name', { ascending: true }).range(from, from + pageSize - 1);
    };

    // Custom preference fields drive the extra CSV columns; fetch their
    // definitions up front so the header row can be emitted before any data.
    const { data: prefFields } = await supabase
      .from('preference_field')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .eq('entity_scope', 'member')
      .order('display_order', { ascending: true });

    const customFields = prefFields || [];

    const coreHeaders = [
      'first_name', 'last_name', 'email', 'handle', 'job_title',
      'biography', 'mobile', 'landline',
      'organisation_name', 'department_name', 'role_name',
      'login_enabled', 'show_in_directory', 'status',
      'created_on', 'last_activity', 'role_effective_from'
    ];

    const customHeaders = customFields.map(f => f.label);
    const allHeaders = [...coreHeaders, ...customHeaders];
    const headerRow = allHeaders.map(escapeCSV).join(',');

    const PAGE_SIZE = 1000;
    const PREF_BATCH_SIZE = 200;

    // Load preference values for a single page of members at a time so memory
    // stays bounded to one page regardless of tenant size.
    const loadPrefValuesForMembers = async (memberIds) => {
      const pagePrefMap = {};
      if (customFields.length === 0 || memberIds.length === 0) return pagePrefMap;
      for (let i = 0; i < memberIds.length; i += PREF_BATCH_SIZE) {
        const batch = memberIds.slice(i, i + PREF_BATCH_SIZE);
        let from = 0;
        const pageSize = 1000;
        while (true) {
          const { data: pvData, error: pvError } = await supabase
            .from('member_preference_value')
            .select('member_id, field_id, value')
            .in('member_id', batch)
            .range(from, from + pageSize - 1);
          if (pvError) {
            throw new Error(`Preference values query failed: ${pvError.message}`);
          }
          if (pvData && pvData.length > 0) {
            for (const pv of pvData) {
              const fieldIdKey = pv.field_id;
              if (!fieldIdKey) continue;
              if (!pagePrefMap[pv.member_id]) pagePrefMap[pv.member_id] = {};
              pagePrefMap[pv.member_id][fieldIdKey] = pv.value;
            }
          }
          if (!pvData || pvData.length < pageSize) break;
          from += pageSize;
        }
      }
      return pagePrefMap;
    };

    const buildMemberRow = (member, pagePrefMap) => {
      const coreValues = coreHeaders.map(field => {
        if (field === 'organisation_name') {
          return member.organization?.name || '';
        }
        if (field === 'role_name') {
          return member.role?.name || '';
        }
        // Semicolon is the documented separator for this single multi-value
        // cell; department enrichment has already applied stable name ordering.
        if (field === 'department_name') return (member.departments || []).map(department => department.name).join('; ');
        if (field === 'created_on' || field === 'last_activity' || field === 'role_effective_from') {
          return formatDate(member[field]);
        }
        if (field === 'login_enabled' || field === 'show_in_directory') {
          return member[field] === false ? 'No' : 'Yes';
        }
        return member[field] != null ? String(member[field]) : '';
      });

      const customValues = customFields.map(f => {
        let rawValue = pagePrefMap[member.id]?.[f.id];
        if (rawValue === null || rawValue === undefined) return '';
        if (f.field_type === 'picklist' || f.field_type === 'dropdown' || f.field_type === 'list') {
          return resolvePicklistValue(rawValue, f);
        }
        if (typeof rawValue === 'string') {
          const trimmed = rawValue.trim();
          if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
            try { rawValue = JSON.parse(trimmed); } catch {}
          }
        }
        rawValue = normalizePreferenceValue(rawValue);
        if (Array.isArray(rawValue)) return rawValue.join(', ');
        return String(rawValue);
      });

      return [...coreValues, ...customValues].map(escapeCSV).join(',');
    };

    // Fetch the first page before committing to a streamed 200 response so any
    // query error still surfaces as a proper HTTP error status.
    const firstPage = await buildMemberQuery(0, PAGE_SIZE, true);
    if (firstPage.error) {
      console.error('[MemberExportCSV] Query error:', firstPage.error);
      return res.status(500).json({ error: 'Failed to fetch members' });
    }
    const actualTotal = firstPage.count ?? (firstPage.data || []).length;
    const countError = memberExportCountError(expectedTotal, actualTotal);
    if (countError) {
      const message = countError;
      return res.status(409).json({ error: message, expectedTotal, actualTotal });
    }
    if (shouldRejectEmptyMemberExport(req.method, actualTotal)) {
      return res.status(422).json({ error: 'There are no members to export for the current selection.' });
    }

    let pageData = firstPage.data || [];
    pageData = await enrichMembersWithDepartments(supabase, tenantId, pageData);

    const today = new Date().toISOString().split('T')[0];
    const filename = `members_export_${today}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    // UTF-8 BOM so Excel decodes non-ASCII characters correctly.
    res.write(CSV_BOM + headerRow);

    try {
      let pageFrom = 0;
      let pageIsEnriched = true;
      while (true) {
        if (pageData.length > 0) {
          const memberIds = pageData.map(m => m.id);
          const pagePrefMap = await loadPrefValuesForMembers(memberIds);
          if (!pageIsEnriched) {
            pageData = await enrichMembersWithDepartments(supabase, tenantId, pageData);
          }
          let chunk = '';
          for (const member of pageData) {
            chunk += CSV_ROW_SEPARATOR + buildMemberRow(member, pagePrefMap);
          }
          res.write(chunk);
          // Yield to the event loop so the buffered chunk flushes to the network.
          await new Promise(resolve => setImmediate(resolve));
        }
        if (pageData.length < PAGE_SIZE) break;
        pageFrom += PAGE_SIZE;
        const next = await buildMemberQuery(pageFrom, PAGE_SIZE);
        if (next.error) {
          throw new Error(`Members query failed: ${next.error.message}`);
        }
        pageData = next.data || [];
        pageIsEnriched = false;
      }
      return res.end();
    } catch (streamErr) {
      // The response is already streaming, so we cannot switch to a 500.
      // Abort the connection so the client sees a failed download rather than
      // silently receiving a truncated CSV.
      console.error('[MemberExportCSV] Streaming error:', streamErr);
      try { res.destroy(streamErr); } catch { /* ignore */ }
      return;
    }
  } catch (err) {
    if (err instanceof MemberDepartmentError) return res.status(err.status).json({ error: err.message });
    console.error('[MemberExportCSV] Error:', err);
    if (res.headersSent) {
      try { res.destroy(err); } catch { /* ignore */ }
      return;
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
}
