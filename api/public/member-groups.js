import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';

export const PUBLIC_SELF_JOIN_GROUP_SELECT = `
  id,
  name,
  description,
  who_is_it_for,
  about_the_group,
  header_image_url,
  allow_self_join,
  is_active,
  default_self_join_role,
  self_join_closed,
  self_join_closed_label
`;

// Deliberately smaller than the legacy self-join payload. A manually featured
// managed group is public only as a card; assignment, vacancy, admin and
// automatic-membership configuration never leave this endpoint.
export const PUBLIC_SELECTED_GROUP_SELECT = `
  id,
  name,
  description,
  header_image_url,
  allow_self_join,
  is_active,
  self_join_closed,
  self_join_closed_label
`;

export function parseRequestedGroupIds(value) {
  const values = Array.isArray(value) ? value : [value];
  const ids = [];
  const seen = new Set();
  for (const item of values) {
    for (const rawId of String(item || '').split(',')) {
      const id = rawId.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
      if (ids.length === 24) return ids;
    }
  }
  return ids;
}

export async function handlePublicMemberGroups(req, res, { supabase, tenant }) {
  const requestedSelectedGroups = Object.prototype.hasOwnProperty.call(req.query || {}, 'groupIds');
  const selectedGroupIds = parseRequestedGroupIds(req.query?.groupIds);

  if (requestedSelectedGroups && selectedGroupIds.length === 0) {
    return res.json([]);
  }

  let query = supabase
    .from('member_group')
    .select(requestedSelectedGroups ? PUBLIC_SELECTED_GROUP_SELECT : PUBLIC_SELF_JOIN_GROUP_SELECT)
    .eq('tenant_id', tenant.id)
    .neq('is_active', false);

  if (requestedSelectedGroups) {
    query = query.in('id', selectedGroupIds);
  } else {
    query = query
      .eq('allow_self_join', true)
      .order('name', { ascending: true });
  }

  const { data: groups, error } = await query;
  if (error) {
    console.error('[Public MemberGroups] Query error:', error);
    return res.status(500).json({ error: 'Failed to fetch member groups' });
  }

  return res.json(groups || []);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const tenant = await resolveTenantFromRequest(req);

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    return handlePublicMemberGroups(req, res, { supabase, tenant });
  } catch (error) {
    console.error('[Public MemberGroups] Error:', error);
    res.status(500).json({ error: 'Failed to fetch member groups' });
  }
}
