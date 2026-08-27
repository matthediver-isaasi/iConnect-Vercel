import { getTenantContext, hasFeatureAccess } from '../_lib/tenantContext.js';
import { supabase } from '../_lib/database.js';
import {
  buildOrganisationMembersResponse,
  fetchMemberDisplaySettings,
  fetchRoles,
  resolveOrgViewMembersRoleIds,
} from '../_lib/directoryConfig.js';
import { resolveDepartmentMemberIds, enrichMembersWithDepartments, listDepartmentOptions, MemberDepartmentError } from '../_lib/memberDepartments.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tenantContext = await getTenantContext(req);
  if (!tenantContext.tenantId) {
    return res.status(401).json({ error: 'Unauthorized - tenant required' });
  }

  const { tenantId } = tenantContext;
  const {
    slug,
    search,
    page = '1',
    limit = '12',
    sort = 'name-asc',
    show_disabled = 'false',
    filters
  } = req.query;
  const organizationId = req.query.organization_id;
  const departmentId = req.query.department_id;
  const isStandardOrgDirectory = req.query.source === 'standard';
  if (departmentId && !organizationId) {
    return res.status(400).json({ error: 'department_id requires an organisation-scoped directory' });
  }
  if (organizationId && !tenantContext.isAuthenticated) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (!slug && !isStandardOrgDirectory) {
    return res.status(400).json({ error: 'slug is required' });
  }
  if (isStandardOrgDirectory && !organizationId) {
    return res.status(400).json({ error: 'organization_id is required for the standard directory' });
  }

  try {
    let directory = null;
    let viewMembersRoleIds = [];
    if (isStandardOrgDirectory) {
      const isTenantAdmin = !!tenantContext.tenantUserId;
      const canAccess = isTenantAdmin || await hasFeatureAccess(
        tenantContext.roleId,
        'membership.organisation-directory'
      );
      if (!canAccess) return res.status(403).json({ error: 'Directory access denied' });
      directory = { entity_type: organizationId ? 'organization' : 'member', id: 'main' };
      viewMembersRoleIds = await resolveOrgViewMembersRoleIds(supabase, tenantId, directory);
    } else {
      const { data: directories, error: dirError } = await supabase
        .from('dynamic_directory')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('slug', slug)
        .eq('is_active', true)
        .limit(1);

      if (dirError) {
        console.error('[DynamicDirectory Members] Directory lookup error:', dirError);
        return res.status(500).json({ error: 'Failed to look up directory' });
      }

      directory = directories?.[0];
      if (!directory) return res.status(404).json({ error: 'Directory not found' });
      const allowedRoles = parseArray(directory.allowed_role_ids);
      const isTenantAdmin = !!tenantContext.tenantUserId;
      if (
        organizationId &&
        !isTenantAdmin &&
        allowedRoles.length > 0 &&
        !allowedRoles.includes(tenantContext.roleId)
      ) {
        return res.status(403).json({ error: 'Directory access denied' });
      }
      viewMembersRoleIds = await resolveOrgViewMembersRoleIds(supabase, tenantId, directory);
    }

    if (organizationId && directory.entity_type !== 'organization') {
      return res.status(400).json({ error: 'Organisation scope requires an organisation directory' });
    }
    if (!organizationId && directory.entity_type !== 'member') {
      return res.status(400).json({ error: 'This endpoint only supports member directories' });
    }

    let selectedOrganization = null;
    if (organizationId) {
      selectedOrganization = await getEligibleOrganization({
        tenantId,
        organizationId,
        directory,
        requesterOrganizationId: tenantContext.organizationId,
      });
      if (!selectedOrganization) return res.status(404).json({ error: 'Organisation not found in this directory' });
      // View Members eligibility is entirely server-resolved. Empty, missing,
      // or malformed configuration intentionally returns no members.
      if (viewMembersRoleIds.length === 0) {
        return res.json(buildOrganisationMembersResponse({
          organization: selectedOrganization,
          departments: await listDepartmentOptions(supabase, tenantId, [organizationId]),
          roles: await fetchRoles(supabase, tenantId),
          displaySettings: await fetchMemberDisplaySettings(supabase, tenantId),
        }));
      }
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10) || 12));
    const offset = (pageNum - 1) * pageSize;
    const canShowDisabled = !!tenantContext.tenantUserId || (
      tenantContext.roleId
        ? await hasFeatureAccess(tenantContext.roleId, 'element_ShowDisabledAccounts')
        : false
    );
    const showDisabled = show_disabled === 'true' && canShowDisabled;

    let customFilters = {};
    if (filters) {
      try {
        customFilters = JSON.parse(filters);
      } catch {}
    }

    const allFilterFields = [];
    if (directory.entity_type === 'member') {
      if (directory.filter_field_id && directory.filter_value) {
        allFilterFields.push({ fieldId: directory.filter_field_id, value: directory.filter_value });
      }
      for (const [fieldId, value] of Object.entries(customFilters)) {
        if (Array.isArray(value)) {
          if (value.length > 0) {
            allFilterFields.push({ fieldId, value });
          }
        } else if (value && value !== 'all') {
          allFilterFields.push({ fieldId, value });
        }
      }
    }

    let memberIds = null;
    if (departmentId) {
      const requestedDepartmentIds = String(departmentId).split(',').map(id => id.trim()).filter(Boolean).slice(0, 100);
      if (!requestedDepartmentIds.length) return res.status(400).json({ error: 'department_id is invalid' });
      if (organizationId) {
        const departmentOptions = await listDepartmentOptions(supabase, tenantId, [organizationId]);
        const eligibleDepartmentIds = new Set(departmentOptions.map(option => option.id));
        if (requestedDepartmentIds.some(id => !eligibleDepartmentIds.has(id))) {
          return res.status(400).json({ error: 'department_id is not available for this organisation' });
        }
      }
      memberIds = await resolveDepartmentMemberIds(supabase, tenantId, requestedDepartmentIds);
      if (!memberIds.length) {
        const empty = { members: [], total: 0, page: pageNum, pageSize };
        if (organizationId) return res.json(buildOrganisationMembersResponse({
          ...empty, organization: selectedOrganization,
          departments: await listDepartmentOptions(supabase, tenantId, [organizationId]),
          roles: await fetchRoles(supabase, tenantId),
          displaySettings: await fetchMemberDisplaySettings(supabase, tenantId),
        }));
        return res.json(empty);
      }
    }

    if (allFilterFields.length > 0) {
      const customFilterMemberIds = await getFilteredMemberIds(tenantId, allFilterFields);
      const customFilterSet = new Set(customFilterMemberIds);
      memberIds = memberIds === null ? customFilterMemberIds
        : memberIds.filter(id => customFilterSet.has(id));
      if (memberIds.length === 0) {
        const empty = { members: [], total: 0, page: pageNum, pageSize };
        if (organizationId) return res.json(buildOrganisationMembersResponse({
          ...empty, organization: selectedOrganization,
          departments: await listDepartmentOptions(supabase, tenantId, [organizationId]),
          roles: await fetchRoles(supabase, tenantId),
          displaySettings: await fetchMemberDisplaySettings(supabase, tenantId),
        }));
        return res.json(empty);
      }
    }

    let countQuery = supabase
      .from('member')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .or('show_in_directory.is.null,show_in_directory.neq.false')
      .not('email', 'ilike', 'deleted_%@deleted.local');

    if (organizationId) {
      countQuery = countQuery.eq('organization_id', organizationId).in('role_id', viewMembersRoleIds);
    }

    if (!showDisabled) {
      countQuery = countQuery.or('login_enabled.is.null,login_enabled.neq.false');
    }

    if (memberIds) {
      countQuery = countQuery.in('id', memberIds);
    }

    if (search) {
      const searchPattern = `%${search}%`;
      countQuery = countQuery.or(`first_name.ilike.${searchPattern},last_name.ilike.${searchPattern},email.ilike.${searchPattern},job_title.ilike.${searchPattern}`);
    }

    const { count: totalCount, error: countError } = await countQuery;

    if (countError) {
      console.error('[DynamicDirectory Members] Count error:', countError);
      return res.status(500).json({ error: 'Failed to count members' });
    }

    let dataQuery = supabase
      .from('member')
      .select('id, first_name, last_name, email, job_title, organization_id, profile_photo_url, login_enabled, show_in_directory, role_id, handle, biography, mobile')
      .eq('tenant_id', tenantId)
      .or('show_in_directory.is.null,show_in_directory.neq.false')
      .not('email', 'ilike', 'deleted_%@deleted.local');

    if (organizationId) {
      dataQuery = dataQuery.eq('organization_id', organizationId).in('role_id', viewMembersRoleIds);
    }

    if (!showDisabled) {
      dataQuery = dataQuery.or('login_enabled.is.null,login_enabled.neq.false');
    }

    if (memberIds) {
      dataQuery = dataQuery.in('id', memberIds);
    }

    if (search) {
      const searchPattern = `%${search}%`;
      dataQuery = dataQuery.or(`first_name.ilike.${searchPattern},last_name.ilike.${searchPattern},email.ilike.${searchPattern},job_title.ilike.${searchPattern}`);
    }

    switch (sort) {
      case 'name-desc':
        dataQuery = dataQuery.order('first_name', { ascending: false }).order('last_name', { ascending: false });
        break;
      case 'name-asc':
      default:
        dataQuery = dataQuery.order('first_name', { ascending: true }).order('last_name', { ascending: true });
        break;
    }

    dataQuery = dataQuery.range(offset, offset + pageSize - 1);

    const { data: members, error: dataError } = await dataQuery;

    if (dataError) {
      console.error('[DynamicDirectory Members] Data query error:', dataError);
      return res.status(500).json({ error: 'Failed to fetch members' });
    }

    const response = {
      // Department membership is private organisation-directory metadata.
      // Public, unscoped member directories must not query or expose it.
      members: organizationId
        ? await enrichMembersWithDepartments(supabase, tenantId, members || [])
        : (members || []),
      total: totalCount || 0,
      page: pageNum,
      pageSize
    };
    if (organizationId) {
      return res.json(buildOrganisationMembersResponse({
        ...response,
        organization: selectedOrganization,
        departments: await listDepartmentOptions(supabase, tenantId, [organizationId]),
        roles: await fetchRoles(supabase, tenantId),
        displaySettings: await fetchMemberDisplaySettings(supabase, tenantId),
      }));
    }
    return res.json(response);
  } catch (err) {
    if (err instanceof MemberDepartmentError) return res.status(err.status).json({ error: err.message });
    console.error('[DynamicDirectory Members] Error:', err);
    return res.status(500).json({ error: 'Failed to fetch directory members' });
  }
}

async function fetchSettingArray(tenantId, key) {
  const { data, error } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('tenant_id', tenantId)
    .eq('setting_key', key)
    .limit(1);
  if (error || !data?.[0]?.setting_value) return [];
  try {
    return parseArray(data[0].setting_value);
  } catch {
    return [];
  }
}

function parseArray(value) {
  if (Array.isArray(value)) return value.filter((id) => typeof id === 'string' && id);
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string' && id) : [];
  } catch {
    return [];
  }
}

async function getEligibleOrganization({
  tenantId,
  organizationId,
  directory,
  requesterOrganizationId,
}) {
  const { data, error } = await supabase
    .from('organization')
    .select('id, name')
    .eq('tenant_id', tenantId)
    .eq('id', organizationId)
    .limit(1);
  if (error || !data?.[0]) return null;

  const isRequesterOrganization = requesterOrganizationId === organizationId;
  const excludedIds = await fetchSettingArray(tenantId, 'org_directory_excluded_orgs');
  if (!isRequesterOrganization && excludedIds.includes(organizationId)) return null;

  if (directory.id === 'main' && !isRequesterOrganization) {
    const allowedStatuses = await fetchSettingArray(
      tenantId,
      'org_directory_allowed_application_statuses'
    );
    if (allowedStatuses.length > 0) {
      const matchesStatus = await organizationMatchesNamedField({
        tenantId,
        organizationId,
        fieldNames: ['application_status'],
        allowedValues: allowedStatuses,
      });
      if (!matchesStatus) return null;
    }

    const visibleTypes = await fetchSettingArray(tenantId, 'org_directory_visible_org_types');
    if (visibleTypes.length > 0) {
      const matchesType = await organizationMatchesNamedField({
        tenantId,
        organizationId,
        fieldNames: ['org_type', 'organisation_type', 'organization_type'],
        allowedValues: visibleTypes,
      });
      if (!matchesType) return null;
    }
  }

  if (directory.id !== 'main' && directory.filter_field_id && directory.filter_value) {
    const { data: values, error: valuesError } = await supabase
      .from('organization_preference_value')
      .select('value')
      .eq('organization_id', organizationId)
      .eq('field_id', directory.filter_field_id);
    if (valuesError || !(values || []).some((row) => matchesValue(row.value, directory.filter_value))) {
      return null;
    }
  }
  return data[0];
}

async function organizationMatchesNamedField({
  tenantId,
  organizationId,
  fieldNames,
  allowedValues,
}) {
  const { data: fields, error: fieldError } = await supabase
    .from('preference_field')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('entity_scope', 'organization')
    .in('name', fieldNames);
  if (fieldError || !fields?.length) return false;
  const fieldIds = fields.map((field) => field.id);
  const { data: values, error: valueError } = await supabase
    .from('organization_preference_value')
    .select('value')
    .eq('organization_id', organizationId)
    .in('field_id', fieldIds);
  if (valueError) return false;
  return (values || []).some((row) => matchesValue(row.value, allowedValues));
}

async function getFilteredMemberIds(tenantId, filterFields) {
  let resultIds = null;

  for (const { fieldId, value } of filterFields) {
    const matchingIds = await getMemberIdsForFieldValue(tenantId, fieldId, value);

    if (resultIds === null) {
      resultIds = new Set(matchingIds);
    } else {
      const matchSet = new Set(matchingIds);
      resultIds = new Set([...resultIds].filter(id => matchSet.has(id)));
    }

    if (resultIds.size === 0) break;
  }

  return resultIds ? [...resultIds] : [];
}

async function getMemberIdsForFieldValue(tenantId, fieldId, filterValue) {
  const matchingIds = [];
  let offset = 0;
  const batchSize = 1000;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await supabase
      .from('member_preference_value')
      .select('member_id, value')
      .eq('field_id', fieldId)
      .range(offset, offset + batchSize - 1);

    if (error) {
      console.error('[DynamicDirectory Members] Preference lookup error:', error);
      break;
    }

    if (!data || data.length === 0) {
      hasMore = false;
      break;
    }

    for (const pv of data) {
      if (matchesValue(pv.value, filterValue)) {
        matchingIds.push(pv.member_id);
      }
    }

    if (data.length < batchSize) {
      hasMore = false;
    } else {
      offset += batchSize;
    }
  }

  return matchingIds;
}

function matchesValue(storedValue, filterValue) {
  if (Array.isArray(filterValue)) {
    return filterValue.some(v => matchesSingleValue(storedValue, v));
  }
  return matchesSingleValue(storedValue, filterValue);
}

function matchesSingleValue(storedValue, filterValue) {
  if (storedValue === filterValue) return true;

  if (Array.isArray(storedValue)) {
    return storedValue.includes(filterValue);
  }

  if (typeof storedValue === 'string') {
    const trimmed = storedValue.trim();
    if (trimmed.startsWith('[')) {
      try {
        const arr = JSON.parse(trimmed);
        if (Array.isArray(arr) && arr.includes(filterValue)) {
          return true;
        }
      } catch {}
    }
  }

  // Boolean fields: stored values may be true/false, 'true'/'false', 'yes'/'no', '1'/'0'
  const storedBool = toBoolCanonical(storedValue);
  if (storedBool !== null) {
    return toBoolCanonical(filterValue) === storedBool;
  }

  return false;
}

const BOOL_TRUE = new Set(['true', 'yes', '1']);
const BOOL_FALSE = new Set(['false', 'no', '0']);

function toBoolCanonical(v) {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toLowerCase();
  if (BOOL_TRUE.has(s)) return 'true';
  if (BOOL_FALSE.has(s)) return 'false';
  return null;
}
