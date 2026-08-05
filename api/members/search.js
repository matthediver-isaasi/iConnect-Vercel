import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { supabase } from '../_lib/database.js';

// Resolve the tenant's primary organisation (is_primary=true, created at
// provisioning). Falls back to the tenant's earliest-created organisation when
// no org is flagged primary (or the is_primary column is missing), mirroring
// the first-org fallback pattern used elsewhere. Returns null only when the
// tenant has no organisations at all.
async function resolvePrimaryOrganizationId(tenantId) {
  const { data: primaryOrg, error: primaryError } = await supabase
    .from('organization')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('is_primary', true)
    .limit(1)
    .maybeSingle();

  if (!primaryError && primaryOrg?.id) {
    return primaryOrg.id;
  }

  if (primaryError && primaryError.code !== '42703') {
    console.error('[Member Search] Primary org lookup error:', primaryError);
  }

  // Fallback: earliest-created organisation for the tenant.
  const { data: firstOrg, error: firstError } = await supabase
    .from('organization')
    .select('id')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (firstError) {
    console.error('[Member Search] First org fallback error:', firstError);
    return null;
  }

  return firstOrg?.id || null;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tenantContext = await getTenantContext(req);
  if (!tenantContext.isAuthenticated || !tenantContext.tenantId) {
    return res.status(401).json({ error: 'Unauthorized - authentication and tenant context required' });
  }

  const isAdmin = await hasAdminAccess(tenantContext);
  if (!isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { tenantId } = tenantContext;
  const { q: query, limit = 10, organization_id: organizationId } = req.query;

  const normalized = (query || '').trim();
  if (normalized.length < 2) {
    return res.json([]);
  }

  try {
    // Search members by name or email using ilike for case-insensitive matching.
    // Multi-token queries require every token to match at least one column (AND of ORs).
    const tokens = normalized.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      return res.json([]);
    }

    let memberQuery = supabase
      .from('member')
      .select('id, first_name, last_name, email, job_title, biography, profile_photo_url, linkedin_url, organization_id')
      .eq('tenant_id', tenantId)
      .not('email', 'ilike', 'deleted_%@deleted.local');

    // Optional organisation filter:
    // - '__primary__'                 => members of the tenant's primary organisation
    // - 'none' / '__no_org__' / 'null' => members with no organisation
    // - any other value (org UUID)    => members in that organisation
    if (organizationId) {
      const noOrgValues = ['none', '__no_org__', 'null'];
      if (organizationId === '__primary__') {
        const primaryOrgId = await resolvePrimaryOrganizationId(tenantId);
        if (!primaryOrgId) {
          // Tenant has no organisations at all — nothing can match the filter.
          return res.json([]);
        }
        memberQuery = memberQuery.eq('organization_id', primaryOrgId);
      } else if (noOrgValues.includes(organizationId)) {
        memberQuery = memberQuery.is('organization_id', null);
      } else {
        memberQuery = memberQuery.eq('organization_id', organizationId);
      }
    }

    for (const token of tokens) {
      const pattern = `%${token}%`;
      memberQuery = memberQuery.or(`first_name.ilike.${pattern},last_name.ilike.${pattern},email.ilike.${pattern}`);
    }

    const { data: members, error } = await memberQuery.limit(parseInt(limit, 10));

    if (error) {
      console.error('[Member Search] Error:', error);
      return res.status(500).json({ error: 'Failed to search members' });
    }

    return res.json(members || []);
  } catch (err) {
    console.error('[Member Search] Error:', err);
    return res.status(500).json({ error: 'Failed to search members' });
  }
}
