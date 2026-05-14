import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const tenant = await resolveTenantFromRequest(req);
  if (!tenant) return res.status(400).json({ error: 'Invalid tenant context' });
  const tenantId = tenant.id;

  const { slug, page = '1', limit = '12', sort = 'name-asc', search, filters } = req.query;
  if (!slug) return res.status(400).json({ error: 'slug is required' });

  let customFilters = {};
  if (filters) {
    try { const parsed = JSON.parse(filters); if (parsed && typeof parsed === 'object') customFilters = parsed; }
    catch { return res.status(400).json({ error: 'Invalid filters JSON' }); }
  }

  try {
    const { data: directories, error: dirError } = await supabase
      .from('dynamic_directory')
      .select('id, slug, name, entity_type, filter_field_id, filter_value, is_active')
      .eq('tenant_id', tenantId)
      .eq('slug', slug)
      .eq('is_active', true)
      .limit(1);

    if (dirError) {
      console.error('[PublicDynamicDirectory] Directory lookup error:', dirError);
      return res.status(500).json({ error: 'Failed to look up directory' });
    }
    const directory = directories?.[0];
    if (!directory) return res.status(404).json({ error: 'Directory not found' });

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(limit, 10) || 12));
    const offset = (pageNum - 1) * pageSize;

    if (directory.entity_type === 'member') {
      return await renderMembers({ supabase, tenantId, directory, pageNum, pageSize, offset, sort, search, customFilters, res });
    }
    if (directory.entity_type === 'organization') {
      return await renderOrganizations({ supabase, tenantId, directory, pageNum, pageSize, offset, sort, search, customFilters, res });
    }
    return res.status(400).json({ error: `Directory entity type '${directory.entity_type}' is not supported in public embeds yet.` });
  } catch (err) {
    console.error('[PublicDynamicDirectory] Error:', err);
    return res.status(500).json({ error: 'Failed to fetch directory records' });
  }
}

async function renderMembers({ supabase, tenantId, directory, pageNum, pageSize, offset, sort, search, customFilters, res }) {
  const filterFields = [];
  if (directory.filter_field_id && directory.filter_value) {
    filterFields.push({ fieldId: directory.filter_field_id, value: directory.filter_value });
  }
  for (const [fieldId, value] of Object.entries(customFilters || {})) {
    if (value && value !== 'all') filterFields.push({ fieldId, value });
  }
  let memberIds = null;
  if (filterFields.length > 0) {
    memberIds = await intersectMemberIds(supabase, filterFields);
    if (memberIds.length === 0) return res.json({ entityType: 'member', records: [], total: 0, page: pageNum, pageSize });
  }

  const baseFilter = (q) => {
    let qq = q.eq('tenant_id', tenantId)
      .or('show_in_directory.is.null,show_in_directory.neq.false')
      .or('login_enabled.is.null,login_enabled.neq.false')
      .not('email', 'ilike', 'deleted_%@deleted.local');
    if (memberIds) qq = qq.in('id', memberIds);
    if (search) {
      const p = `%${search}%`;
      qq = qq.or(`first_name.ilike.${p},last_name.ilike.${p},email.ilike.${p},job_title.ilike.${p}`);
    }
    return qq;
  };

  const { count: total } = await baseFilter(supabase.from('member').select('id', { count: 'exact', head: true }));

  let dataQ = baseFilter(supabase.from('member').select('id, first_name, last_name, job_title, profile_photo_url, handle'));
  if (sort === 'name-desc') {
    dataQ = dataQ.order('first_name', { ascending: false }).order('last_name', { ascending: false });
  } else {
    dataQ = dataQ.order('first_name', { ascending: true }).order('last_name', { ascending: true });
  }
  const { data, error } = await dataQ.range(offset, offset + pageSize - 1);
  if (error) {
    console.error('[PublicDynamicDirectory] member fetch error', error);
    return res.status(500).json({ error: 'Failed to fetch members' });
  }
  const records = (data || []).map((m) => ({
    id: m.id,
    name: [m.first_name, m.last_name].filter(Boolean).join(' ').trim() || null,
    subtitle: m.job_title || null,
    image_url: m.profile_photo_url || null,
    handle: m.handle || null,
  }));
  return res.json({ entityType: 'member', records, total: total || 0, page: pageNum, pageSize });
}

async function renderOrganizations({ supabase, tenantId, directory, pageNum, pageSize, offset, sort, search, customFilters, res }) {
  const filterFields = [];
  if (directory.filter_field_id && directory.filter_value) {
    filterFields.push({ fieldId: directory.filter_field_id, value: directory.filter_value });
  }
  for (const [fieldId, value] of Object.entries(customFilters || {})) {
    if (value && value !== 'all') filterFields.push({ fieldId, value });
  }
  let orgIds = null;
  if (filterFields.length > 0) {
    orgIds = await intersectOrgIds(supabase, filterFields);
    if (orgIds.length === 0) return res.json({ entityType: 'organization', records: [], total: 0, page: pageNum, pageSize });
  }
  let q = supabase
    .from('organization')
    .select('id, name, slug, logo_url, description, city, country, website_url', { count: 'exact' })
    .eq('tenant_id', tenantId);
  if (orgIds) q = q.in('id', orgIds);
  if (search) {
    const p = `%${search}%`;
    q = q.or(`name.ilike.${p},city.ilike.${p},country.ilike.${p}`);
  }
  q = sort === 'name-desc' ? q.order('name', { ascending: false }) : q.order('name', { ascending: true });
  const { data, error, count } = await q.range(offset, offset + pageSize - 1);
  if (error) {
    console.error('[PublicDynamicDirectory] organization fetch error', error);
    return res.status(500).json({ error: 'Failed to fetch organizations' });
  }
  const records = (data || []).map((o) => ({
    id: o.id,
    name: o.name,
    subtitle: [o.city, o.country].filter(Boolean).join(', ') || null,
    image_url: o.logo_url || null,
    slug: o.slug || null,
    website_url: o.website_url || null,
  }));
  return res.json({ entityType: 'organization', records, total: count || 0, page: pageNum, pageSize });
}

async function intersectMemberIds(supabase, filterFields) {
  return intersectIds(supabase, 'member_preference_value', 'member_id', filterFields);
}

async function intersectOrgIds(supabase, filterFields) {
  return intersectIds(supabase, 'organization_preference_value', 'organization_id', filterFields);
}

async function intersectIds(supabase, table, idColumn, filterFields) {
  let result = null;
  for (const { fieldId, value } of filterFields) {
    const ids = await getIdsForFieldValue(supabase, table, idColumn, fieldId, value);
    const set = new Set(ids);
    if (result === null) result = set;
    else result = new Set([...result].filter((id) => set.has(id)));
    if (result.size === 0) break;
  }
  return result ? [...result] : [];
}

async function getIdsForFieldValue(supabase, table, idColumn, fieldId, filterValue) {
  const ids = [];
  let offset = 0;
  const batchSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select(`${idColumn}, value`)
      .eq('field_id', fieldId)
      .range(offset, offset + batchSize - 1);
    if (error || !data || data.length === 0) break;
    for (const pv of data) {
      if (matchesValue(pv.value, filterValue)) ids.push(pv[idColumn]);
    }
    if (data.length < batchSize) break;
    offset += batchSize;
  }
  return ids;
}

function matchesValue(storedValue, filterValue) {
  if (storedValue === filterValue) return true;
  if (Array.isArray(storedValue)) return storedValue.includes(filterValue);
  if (typeof storedValue === 'string') {
    const t = storedValue.trim();
    if (t.startsWith('[')) {
      try { const arr = JSON.parse(t); if (Array.isArray(arr) && arr.includes(filterValue)) return true; } catch {}
    }
  }
  return false;
}
