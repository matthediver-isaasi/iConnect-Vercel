import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasAdminAccess, hasFeatureAccess } from '../../_lib/tenantContext.js';

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
  const canManageSpeakers = await hasAdminAccess(tenantCtx)
    || (tenantCtx.roleId
      ? await hasFeatureAccess(tenantCtx.roleId, 'events.speakers')
      : false);
  if (!canManageSpeakers) {
    return res.status(403).json({ error: 'Speaker Management access required' });
  }

  try {
    const {
      page = '1',
      limit = '50',
      search = '',
      status = 'all',
      sortField = 'full_name',
      sortDir = 'asc'
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    const offset = (pageNum - 1) * limitNum;

    let query = supabase
      .from('speaker')
      .select(`
        id,
        full_name,
        email,
        organization,
        job_title,
        biography,
        profile_photo_url,
        member_id,
        is_active,
        created_at
      `, { count: 'exact' })
      .eq('tenant_id', tenantId);

    if (search && search.trim()) {
      const searchTerm = `%${search.trim().toLowerCase()}%`;
      query = query.or(`full_name.ilike.${searchTerm},email.ilike.${searchTerm},organization.ilike.${searchTerm},job_title.ilike.${searchTerm}`);
    }

    if (status === 'active') {
      query = query.eq('is_active', true);
    } else if (status === 'inactive') {
      query = query.eq('is_active', false);
    }

    const validSortFields = ['full_name', 'email', 'organization', 'job_title', 'created_at'];
    const actualSortField = validSortFields.includes(sortField) ? sortField : 'full_name';
    const ascending = sortDir === 'asc';

    query = query.order(actualSortField, { ascending });
    query = query.range(offset, offset + limitNum - 1);

    const { data: speakers, error, count } = await query;

    if (error) {
      console.error('[SpeakersPaginated] Query error:', error);
      return res.status(500).json({ error: 'Failed to fetch speakers' });
    }

    const linkedMemberIds = [...new Set((speakers || []).map((speaker) => speaker.member_id).filter(Boolean))];
    const linkedMembersById = {};
    if (linkedMemberIds.length > 0) {
      const { data: members, error: membersError } = await supabase
        .from('member')
        .select('id, first_name, last_name, email, job_title, biography, profile_photo_url, organization (id, name)')
        .eq('tenant_id', tenantId)
        .in('id', linkedMemberIds);
      if (membersError) {
        console.error('[SpeakersPaginated] Linked member query error:', membersError);
        return res.status(500).json({ error: 'Failed to fetch linked members' });
      }
      (members || []).forEach((member) => {
        linkedMembersById[member.id] = {
          id: member.id,
          first_name: member.first_name,
          last_name: member.last_name,
          email: member.email,
          job_title: member.job_title || null,
          biography: member.biography || null,
          profile_photo_url: member.profile_photo_url || null,
          organization_id: member.organization?.id || null,
          organization_name: member.organization?.name || null,
        };
      });
    }

    const totalPages = Math.ceil((count || 0) / limitNum);

    return res.json({
      speakers: (speakers || []).map((speaker) => ({
        ...speaker,
        linked_member: speaker.member_id ? (linkedMembersById[speaker.member_id] || null) : null,
      })),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: count || 0,
        totalPages
      }
    });
  } catch (err) {
    console.error('[SpeakersPaginated] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
