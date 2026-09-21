import { getSession, getSessionMember } from '../_lib/session.js';
import { isResourceExcluded } from '../_lib/roleVisibility.js';
import { supabase } from '../_lib/database.js';
import { resolveTenantFromHost, getHostFromRequest } from '../_lib/tenantResolver.js';
import { loadCanvasMemberSnapshot } from '../_lib/canvasMemberValues.js';

async function loadSessionRole(db, member) {
  const snapshot = {
    status: 'missing',
    member_id: member.id,
    tenant_id: member.tenant_id ?? null,
    role_id: member.role_id ?? null,
    role: null,
  };

  if (!member.role_id) return snapshot;
  if (!db) return { ...snapshot, status: 'error' };

  try {
    const { data: role, error } = await db
      .from('role')
      .select('*')
      .eq('id', member.role_id)
      .maybeSingle();

    if (error) {
      if (error.code === 'PGRST116') return snapshot;
      return { ...snapshot, status: 'error' };
    }
    if (!role) return snapshot;

    // Roles are tenant-owned. A null tenant is only valid for a tenantless
    // member; it is not a global fallback for a tenant member.
    if (role.id !== member.role_id || (role.tenant_id ?? null) !== (member.tenant_id ?? null)) {
      return { ...snapshot, status: 'error' };
    }

    return { ...snapshot, status: 'ready', role };
  } catch (error) {
    console.warn('[Auth Me] Session role unavailable:', error?.message || error);
    return { ...snapshot, status: 'error' };
  }
}

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
    // Resolve the authenticated session once and pass it through to the member
    // lookup. getSessionMember historically loaded it again, duplicating the
    // session row and revocation-fence reads on every cold /auth/me request.
    const session = await readSession(req);
    const member = await readMember(req, session);
    
    if (!member) {
      return res.status(200).json(null);
    }
    // Start host resolution only for an authenticated member. Starting this
    // before the guest/member boundary left a rejecting promise without a
    // consumer when the handler returned early.
    const hostTenantPromise = Promise.resolve().then(
      () => resolveHostTenant(getHostFromRequest(req))
    );

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
    
    // Start independent enrichment reads together. Canvas awaits only session
    // and host tenancy, while role/link/tenant reads continue in parallel.
    const sessionRolePromise = loadSessionRole(db, member);
    const tenantUserLinkPromise = !hasTenantUserLink && db
      ? db
        .from('tenant_user_member_link')
        .select('id')
        .eq('member_id', member.id)
        .maybeSingle()
      : Promise.resolve({ data: null });
    const tenantPromise = member.tenant_id && db
      ? db
        .from('tenant')
        .select('slug, domain')
        .eq('id', member.tenant_id)
        .maybeSingle()
      : Promise.resolve({ data: null });
    const canvasMemberSnapshotPromise = hostTenantPromise
      .then(tenant => loadCanvasMemberSnapshot({ member, session, tenant, db }))
      .catch((error) => {
        // Personalisation is optional. A lookup failure must hide Canvas values,
        // not turn an otherwise valid session into a failed login.
        console.warn('[Auth Me] Canvas member projection unavailable; personalisation disabled:', error?.message || error);
        return null;
      });

    const [
      sessionRole,
      { data: link },
      { data: tenantRow },
      canvasMemberSnapshot,
    ] = await Promise.all([
      sessionRolePromise,
      tenantUserLinkPromise,
      tenantPromise,
      canvasMemberSnapshotPromise,
    ]);

    // A role grants capabilities only after a successful tenant-bound read.
    let isAdmin = false;
    let canEditMembers = false;
    let canManageCommunications = false;
    if (sessionRole.status === 'ready') {
      const excludedFeatures = Array.isArray(sessionRole.role.excluded_features)
        ? sessionRole.role.excluded_features
        : [];
      isAdmin = !isResourceExcluded(excludedFeatures, 'admin.role-management');
      canEditMembers = isAdmin || !isResourceExcluded(excludedFeatures, 'admin_can_edit_members');
      canManageCommunications = isAdmin || !isResourceExcluded(excludedFeatures, 'admin_can_manage_communications');
    }

    if (!hasTenantUserLink) {
      hasTenantUserLink = !!link;
      if (hasTenantUserLink) {
        console.log('[Auth Me] hasTenantUserLink=true via database lookup for member:', member.id);
      }
    }
    
    console.log('[Auth Me] Final hasTenantUserLink:', hasTenantUserLink, 'for member:', member.id);

    // Tenant slug/domain so the client can canonicalize a typo'd wildcard
    // subdomain (Task #3387: fgi.dev.iconn.app serving the gfi tenant).
    const tenantSlug = tenantRow?.slug || null;
    const tenantDomain = tenantRow?.domain || null;
    const isMasquerading = session?.data?.isMasquerading === true;
    const masqueradeAdminName = isMasquerading ? session.data.masqueradeAdminName : null;

    return res.json({ ...member, sessionRole, isAdmin, canEditMembers, canManageCommunications, hasTenantUserLink, isMasquerading, masqueradeAdminName, tenantSlug, tenantDomain, canvasMemberSnapshot });
  } catch (error) {
    console.error('Auth me error:', error);
    return res.status(500).json({ error: 'Failed to get user' });
  }
}
