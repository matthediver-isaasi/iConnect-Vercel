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

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function parseJsonShapedString(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return value;
  try { return JSON.parse(trimmed); } catch { return value; }
}

function resolvePicklistValue(rawValue, field) {
  if (rawValue === null || rawValue === undefined || !field) return '';
  const options = field.options || [];
  const parsed = parseJsonShapedString(rawValue);
  const optionFor = value => options.find(option => String(option.value) === String(value));
  const resolveOne = value => {
    if (value && typeof value === 'object' && !Array.isArray(value) && value.value !== undefined) {
      return {
        value: value.value,
        label: optionFor(value.value)?.label ?? value.label ?? String(value.value),
      };
    }
    const option = optionFor(value);
    return option ? { value, label: option.label ?? String(value) } : value;
  };

  if (Array.isArray(parsed)) {
    return stableJson(parsed.map(resolveOne));
  }
  const resolved = resolveOne(parsed);
  return resolved && typeof resolved === 'object'
    ? stableJson(resolved)
    : String(resolved ?? '');
}

export function formatCustomFieldValueForCsv(rawValue, field) {
  if (rawValue === null || rawValue === undefined || rawValue === '') return '';
  if (field?.field_type === 'boolean' || field?.field_type === 'checkbox') {
    if (rawValue === true || rawValue === 'true') return 'Yes';
    if (rawValue === false || rawValue === 'false') return 'No';
    return String(rawValue);
  }
  if (field?.field_type === 'picklist' || field?.field_type === 'dropdown' || field?.field_type === 'list') {
    return resolvePicklistValue(rawValue, field);
  }
  const parsed = parseJsonShapedString(rawValue);
  if (parsed && typeof parsed === 'object') {
    return stableJson(parsed);
  }
  return String(parsed);
}

export const MEMBER_CSV_CORE_FIELDS = Object.freeze([
  { header: 'member_id', select: 'id', value: member => member.id },
  { header: 'first_name', select: 'first_name' },
  { header: 'last_name', select: 'last_name' },
  { header: 'email', select: 'email' },
  { header: 'handle', select: 'handle' },
  { header: 'job_title', select: 'job_title' },
  { header: 'biography', select: 'biography' },
  { header: 'profile_photo_url', select: 'profile_photo_url' },
  { header: 'profile_image_url', select: 'profile_image_url' },
  { header: 'linkedin_url', select: 'linkedin_url' },
  { header: 'mobile', select: 'mobile' },
  { header: 'landline', select: 'landline' },
  { header: 'organisation_id', select: 'organization_id', value: member => member.organization_id },
  { header: 'organisation_name', value: member => member.organization?.name },
  { header: 'department_ids', value: member => (member.departments || []).map(row => row.id).join('; ') },
  { header: 'department_names', value: member => (member.departments || []).map(row => row.name).join('; ') },
  { header: 'organisation_group_id', select: 'organization_group_id', value: member => member.organization_group_id },
  { header: 'organisation_group_name', value: member => member.organization_group?.name },
  { header: 'role_id', select: 'role_id', value: member => member.role_id },
  { header: 'role_name', value: member => member.role?.name },
  { header: 'role_effective_from', select: 'role_effective_from', format: 'date' },
  { header: 'login_enabled', select: 'login_enabled', format: 'boolean' },
  { header: 'show_in_directory', select: 'show_in_directory', format: 'boolean' },
  { header: 'status', select: 'status' },
  { header: 'is_guest', select: 'is_guest', format: 'boolean' },
  { header: 'guest_expires_at', select: 'guest_expires_at', format: 'date' },
  { header: 'communications_opted_out_all', select: 'communications_opted_out_all', format: 'boolean' },
  { header: 'tags', select: 'tags', format: 'array' },
  { header: 'membership_paused', select: 'membership_paused', format: 'boolean' },
  { header: 'membership_paused_at', select: 'membership_paused_at', format: 'date' },
  { header: 'membership_pause_restart_date', select: 'membership_pause_restart_date', format: 'date' },
  { header: 'membership_paused_by_member_id', select: 'membership_paused_by' },
  { header: 'membership_pause_reason', select: 'membership_pause_reason' },
  { header: 'engagement_opening_balances', select: 'engagement_opening_balances', format: 'object' },
  { header: 'created_on', select: 'created_on', format: 'date' },
  { header: 'last_activity', select: 'last_activity', format: 'date' },
]);

export function formatMemberCoreValueForCsv(member, field) {
  const rawValue = field.value ? field.value(member) : member[field.select];
  if (rawValue === null || rawValue === undefined || rawValue === '') return '';
  if (field.format === 'date') return formatDate(rawValue);
  if (field.format === 'boolean') {
    if (rawValue === true) return 'Yes';
    if (rawValue === false) return 'No';
  }
  if (field.format === 'array' || typeof rawValue === 'object') return stableJson(rawValue);
  return String(rawValue);
}

export function buildCustomFieldHeaders(
  fields,
  reservedHeaders = MEMBER_CSV_CORE_FIELDS.map(field => field.header),
) {
  const bases = fields.map(field => (
    String(field.label || '').trim()
    || String(field.name || '').trim()
    || `Custom field ${field.id}`
  ));
  const used = new Set(reservedHeaders);
  return bases.map((base, index) => {
    let header = base;
    if (used.has(header) || bases.indexOf(base) !== bases.lastIndexOf(base)) {
      const name = String(fields[index].name || '').trim();
      header = `${base} [${name ? `${name}:` : ''}${fields[index].id}]`;
    }
    let suffix = 2;
    const candidate = header;
    while (used.has(header)) header = `${candidate} (${suffix++})`;
    used.add(header);
    return header;
  });
}

export async function loadMemberPreferenceValuesForCsv(
  supabaseClient,
  memberIds,
  fieldIds,
  { memberBatchSize = 200, pageSize = 1000 } = {},
) {
  const preferenceMap = {};
  if (fieldIds.length === 0 || memberIds.length === 0) return preferenceMap;

  for (let i = 0; i < memberIds.length; i += memberBatchSize) {
    const batch = memberIds.slice(i, i + memberBatchSize);
    let from = 0;
    while (true) {
      const { data, error } = await supabaseClient
        .from('member_preference_value')
        .select('id, member_id, field_id, value')
        .in('member_id', batch)
        .in('field_id', fieldIds)
        // PostgREST ranges are only reliable with a stable unique order.
        // Without this, dense preference pages can skip a whole field.
        .order('id', { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) {
        throw new Error(`Preference values query failed: ${error.message}`);
      }
      for (const preference of data || []) {
        if (!preference.field_id) continue;
        if (!preferenceMap[preference.member_id]) preferenceMap[preference.member_id] = {};
        preferenceMap[preference.member_id][preference.field_id] = preference.value;
      }
      if (!data || data.length < pageSize) break;
      from += pageSize;
    }
  }

  return preferenceMap;
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
          ${[...new Set(MEMBER_CSV_CORE_FIELDS.map(field => field.select).filter(Boolean))].join(', ')},
          organization (id, name),
          organization_group (id, name),
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

      return q
        .order('last_name', { ascending: true })
        .order('first_name', { ascending: true })
        .order('id', { ascending: true })
        .range(from, from + pageSize - 1);
    };

    // Custom preference fields drive the extra CSV columns; fetch their
    // definitions up front so the header row can be emitted before any data.
    const { data: prefFields, error: prefFieldsError } = await supabase
      .from('preference_field')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .eq('entity_scope', 'member')
      .order('display_order', { ascending: true })
      .order('id', { ascending: true });
    if (prefFieldsError) throw new Error(`Preference fields query failed: ${prefFieldsError.message}`);

    const customFields = prefFields || [];

    const coreHeaders = MEMBER_CSV_CORE_FIELDS.map(field => field.header);
    const customHeaders = buildCustomFieldHeaders(customFields);
    const allHeaders = [...coreHeaders, ...customHeaders];
    const headerRow = allHeaders.map(escapeCSV).join(',');

    const PAGE_SIZE = 1000;
    const customFieldIds = customFields.map(field => field.id);

    // Load preference values for a single page of members at a time so memory
    // stays bounded to one page regardless of tenant size.
    const loadPrefValuesForMembers = memberIds => (
      loadMemberPreferenceValuesForCsv(supabase, memberIds, customFieldIds)
    );

    const buildMemberRow = (member, pagePrefMap) => {
      const coreValues = MEMBER_CSV_CORE_FIELDS.map(field => formatMemberCoreValueForCsv(member, field));

      const customValues = customFields.map(f => {
        const rawValue = pagePrefMap[member.id]?.[f.id];
        return formatCustomFieldValueForCsv(rawValue, f);
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
