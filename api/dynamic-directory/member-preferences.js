import { getTenantContext } from '../_lib/tenantContext.js';
import { supabase as defaultDb } from '../_lib/database.js';
import { canReadOrganisationDirectory } from '../_lib/organisationDirectoryPublication.js';
import { directoryEligibleIds } from '../_lib/directoryExpression.js';
import { fetchMemberFields } from '../_lib/directoryConfig.js';

export default async function handler(req, res, dependencies = {}) {
  const supabase = dependencies.supabase || defaultDb;
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tenantContext = await (dependencies.getTenantContext || getTenantContext)(req);
  if (!tenantContext.tenantId) {
    return res.status(401).json({ error: 'Unauthorized - tenant required' });
  }

  const { tenantId } = tenantContext;
  const { member_ids, field_ids, slug } = req.query;
  if (tenantContext.tenantMismatch) return res.status(403).json({ error: 'Directory access denied' });
  if (!slug || typeof slug !== 'string') return res.status(400).json({ error: 'slug is required' });

  if (!member_ids) {
    return res.json([]);
  }

  const memberIdList = member_ids.split(',').filter(Boolean);
  if (memberIdList.length === 0) {
    return res.json([]);
  }

  try {
    const { data: directories, error: directoryError } = await supabase.from('dynamic_directory')
      .select('*').eq('tenant_id', tenantId).eq('slug', slug).eq('is_active', true).limit(1);
    if (directoryError) throw directoryError;
    const directory = directories?.[0];
    if (!directory) return res.status(404).json({ error: 'Directory not found' });
    if (!canReadOrganisationDirectory(directory, tenantContext, tenantId)) {
      return res.status(tenantContext.isAuthenticated ? 403 : 401).json({ error: 'Directory access denied' });
    }
    if (directory.entity_type !== 'member') return res.status(400).json({ error: 'Member directory required' });
    if (memberIdList.length > 100) return res.status(400).json({ error: 'Too many members' });
    const eligible = await directoryEligibleIds(supabase, tenantId, directory);
    const { data: members, error: memberError } = await supabase.from('member').select('id')
      .eq('tenant_id', tenantId).or('show_in_directory.is.null,show_in_directory.neq.false')
      .or('login_enabled.is.null,login_enabled.neq.false').not('email', 'ilike', 'deleted_%@deleted.local')
      .in('id', memberIdList);
    if (memberError) throw memberError;
    const allowedMembers = (members || []).map(m => m.id).filter(id => eligible === null || eligible.includes(id));
    const { directoryCustomFields } = await fetchMemberFields(supabase, tenantId, directory.id);
    const requestedFields = field_ids ? field_ids.split(',') : null;
    const allowedFields = directoryCustomFields.map(f => f.id).filter(id => !requestedFields || requestedFields.includes(id));
    if (!allowedMembers.length || !allowedFields.length) return res.json([]);
    const allPreferences = [];
    const batchSize = 200;

    for (let i = 0; i < allowedMembers.length; i += batchSize) {
      const batch = allowedMembers.slice(i, i + batchSize);

      let query = supabase
        .from('member_preference_value')
        .select('id, member_id, field_id, value')
        .in('member_id', batch).in('field_id', allowedFields);

      if (field_ids) {
        const fieldIdList = field_ids.split(',').filter(Boolean);
        if (fieldIdList.length > 0) {
          query = query.in('field_id', fieldIdList);
        }
      }

      const { data, error } = await query;

      if (error) {
        console.error('[DynamicDirectory MemberPreferences] Batch error:', error);
        throw error;
      }

      if (data) {
        allPreferences.push(...data);
      }
    }

    return res.json(allPreferences);
  } catch (err) {
    console.error('[DynamicDirectory MemberPreferences] Error:', err);
    return res.status(500).json({ error: 'Failed to fetch member preferences' });
  }
}
