import { getSession, getSessionMember } from '../_lib/session.js';
import { isResourceExcluded } from '../_lib/roleVisibility.js';
import { supabase } from '../_lib/database.js';
import { resolveTenantFromHost, getHostFromRequest } from '../_lib/tenantResolver.js';
import { loadCanvasMemberSnapshot } from '../_lib/canvasMemberValues.js';

export default async function handler(req, res, {
  db = supabase,
  readMember = getSessionMember,
  readSession = getSession,
  resolveHostTenant = resolveTenantFromHost,
} = {}) {
  res.setHeader('Cache-Control', 'private, no-store, must-revalidate');
  res.setHeader('Vary', 'Cookie, Authorization, Host');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const member = await readMember(req);
    
    if (!member) {
      return res.status(200).json(null);
    }

    // Fetch role to determine permissions
    let isAdmin = false;
    let canEditMembers = false;
    let canManageCommunications = false;
    
    if (member.role_id && db) {
      const { data: role } = await db
        .from('role')
        .select('excluded_features')
        .eq('id', member.role_id)
        .single();
      
      const excludedFeatures = role?.excluded_features || [];
      
      // Derive admin status from whether admin.role-management is NOT excluded
      // This replaces the deprecated is_admin flag
      isAdmin = !isResourceExcluded(excludedFeatures, 'admin.role-management');
      
      // Admin role has all permissions
      if (isAdmin) {
        canEditMembers = true;
        canManageCommunications = true;
      } else {
        // Check if permissions are NOT excluded (hierarchical check)
        canEditMembers = !isResourceExcluded(excludedFeatures, 'admin_can_edit_members');
        canManageCommunications = !isResourceExcluded(excludedFeatures, 'admin_can_manage_communications');
      }
    }

    // Check if member has a linked tenant_user account (for SaaS admin access)
    // This can be either via the tenant_user_member_link table OR if the session
    // has preserved admin context (meaning they came from the admin area via SSO)
    let hasTenantUserLink = false;
    
    // First check if session has preserved admin context (from portal SSO flow)
    if (member._sessionPreservedTenantUserId || member._sessionPreservedIdentityId) {
      hasTenantUserLink = true;
      console.log('[Auth Me] Detected preserved admin context:', {
        memberId: member.id,
        preservedTenantUserId: member._sessionPreservedTenantUserId,
        preservedIdentityId: member._sessionPreservedIdentityId
      });
    }
    
    // Fallback to database lookup
    if (!hasTenantUserLink && db) {
      const { data: link } = await db
        .from('tenant_user_member_link')
        .select('id')
        .eq('member_id', member.id)
        .maybeSingle();
      
      hasTenantUserLink = !!link;
      if (hasTenantUserLink) {
        console.log('[Auth Me] hasTenantUserLink=true via database lookup for member:', member.id);
      }
    }
    
    console.log('[Auth Me] Final hasTenantUserLink:', hasTenantUserLink, 'for member:', member.id);

    // Tenant slug/domain so the client can canonicalize a typo'd wildcard
    // subdomain (Task #3387: fgi.dev.iconn.app serving the gfi tenant).
    let tenantSlug = null;
    let tenantDomain = null;
    if (member.tenant_id && db) {
      const { data: tenantRow } = await db
        .from('tenant')
        .select('slug, domain')
        .eq('id', member.tenant_id)
        .maybeSingle();
      tenantSlug = tenantRow?.slug || null;
      tenantDomain = tenantRow?.domain || null;
    }

    const session = await readSession(req);
    // Resolve from the request host only: preview/query parameters must never
    // choose the identity or tenant used for Canvas personalisation.
    let canvasMemberSnapshot = null;
    try {
      const tenant = await resolveHostTenant(getHostFromRequest(req));
      canvasMemberSnapshot = await loadCanvasMemberSnapshot({ member, session, tenant, db });
    } catch (error) {
      // Personalisation is optional. A lookup failure must hide Canvas values,
      // not turn an otherwise valid session into a failed login.
      console.warn('[Auth Me] Canvas member projection unavailable; personalisation disabled:', error?.message || error);
    }
    const isMasquerading = session?.data?.isMasquerading === true;
    const masqueradeAdminName = isMasquerading ? session.data.masqueradeAdminName : null;

    return res.json({ ...member, isAdmin, canEditMembers, canManageCommunications, hasTenantUserLink, isMasquerading, masqueradeAdminName, tenantSlug, tenantDomain, canvasMemberSnapshot });
  } catch (error) {
    console.error('Auth me error:', error);
    return res.status(500).json({ error: 'Failed to get user' });
  }
}
