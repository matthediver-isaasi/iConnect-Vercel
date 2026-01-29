import { supabase } from '../../_lib/database.js';
import { getTenantContext } from '../../_lib/tenantContext.js';

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
      page = '1',
      limit = '50',
      search = '',
      organizationId = '',
      roleId = '',
      status = 'all',
      sortField = 'created_on',
      sortDir = 'desc'
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    const offset = (pageNum - 1) * limitNum;

    let query = supabase
      .from('member')
      .select(`
        id,
        first_name,
        last_name,
        email,
        mobile,
        job_title,
        organization_id,
        role_id,
        login_enabled,
        show_in_directory,
        created_on,
        profile_photo_url,
        organization:organization_id (id, name, tenant_id)
      `, { count: 'exact' });

    query = query.eq('organization.tenant_id', tenantId);

    if (search && search.trim()) {
      const searchTerm = `%${search.trim().toLowerCase()}%`;
      query = query.or(`first_name.ilike.${searchTerm},last_name.ilike.${searchTerm},email.ilike.${searchTerm},mobile.ilike.${searchTerm},job_title.ilike.${searchTerm}`);
    }

    if (organizationId && organizationId !== 'all') {
      query = query.eq('organization_id', organizationId);
    }

    if (roleId && roleId !== 'all') {
      query = query.eq('role_id', roleId);
    }

    if (status === 'active') {
      query = query.eq('login_enabled', true);
    } else if (status === 'disabled') {
      query = query.eq('login_enabled', false);
    }

    const validSortFields = ['first_name', 'last_name', 'email', 'created_on', 'job_title'];
    const actualSortField = validSortFields.includes(sortField) ? sortField : 'created_on';
    const ascending = sortDir === 'asc';

    query = query.order(actualSortField, { ascending });
    query = query.range(offset, offset + limitNum - 1);

    const { data: members, error, count } = await query;

    if (error) {
      console.error('[MembersPaginated] Query error:', error);
      return res.status(500).json({ error: 'Failed to fetch members' });
    }

    const filteredMembers = (members || []).filter(m => m.organization !== null).map(m => ({
      ...m,
      disabled: m.login_enabled === false,
      profile_photo: m.profile_photo_url
    }));

    const totalPages = Math.ceil((count || 0) / limitNum);

    return res.json({
      members: filteredMembers,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: count || 0,
        totalPages
      }
    });
  } catch (err) {
    console.error('[MembersPaginated] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
