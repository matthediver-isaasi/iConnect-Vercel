import { getTenantContext } from '../_lib/tenantContext.js';
import { supabase } from '../_lib/database.js';

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

  if (!slug) {
    return res.status(400).json({ error: 'slug is required' });
  }

  try {
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

    const directory = directories?.[0];
    if (!directory) {
      return res.status(404).json({ error: 'Directory not found' });
    }

    if (directory.entity_type !== 'member') {
      return res.status(400).json({ error: 'This endpoint only supports member directories' });
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10) || 12));
    const offset = (pageNum - 1) * pageSize;
    const showDisabled = show_disabled === 'true';

    let customFilters = {};
    if (filters) {
      try {
        customFilters = JSON.parse(filters);
      } catch {}
    }

    const allFilterFields = [];
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

    let memberIds = null;

    if (allFilterFields.length > 0) {
      memberIds = await getFilteredMemberIds(tenantId, allFilterFields);
      if (memberIds.length === 0) {
        return res.json({ members: [], total: 0, page: pageNum, pageSize });
      }
    }

    let countQuery = supabase
      .from('member')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .or('show_in_directory.is.null,show_in_directory.neq.false')
      .not('email', 'ilike', 'deleted_%@deleted.local');

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

    return res.json({
      members: members || [],
      total: totalCount || 0,
      page: pageNum,
      pageSize
    });
  } catch (err) {
    console.error('[DynamicDirectory Members] Error:', err);
    return res.status(500).json({ error: 'Failed to fetch directory members' });
  }
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
