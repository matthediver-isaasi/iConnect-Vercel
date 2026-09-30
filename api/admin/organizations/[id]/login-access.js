import { supabase } from '../../../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../../../_lib/tenantContext.js';
import { evaluateEffectiveOrganisationLoginAccess } from '../../../_lib/organisationLoginGate.js';
import { invalidateOrganizationMemberSessions } from '../../../_lib/session.js';

function responsePayload(access) {
  return {
    manualBlocked: !!access.manualBlocked,
    gateBlocked: !!access.gateBlocked,
    blocked: !!access.blocked,
    causes: Array.isArray(access.causes) ? access.causes : [],
    updatedAt: access.updatedAt || null,
    updatedBy: access.updatedBy || null,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Tenant-Id');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'PATCH') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  const tenantCtx = await getTenantContext(req);
  if (!tenantCtx.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
  if (!(await hasAdminAccess(tenantCtx))) return res.status(403).json({ error: 'Administrator access required' });
  const tenantId = tenantCtx.effectiveTenantId || tenantCtx.tenantId;
  const organizationId = req.query?.id;
  if (!tenantId || !organizationId) return res.status(400).json({ error: 'Organisation and tenant context are required' });

  const { data: organization, error: organizationError } = await supabase
    .from('organization')
    .select('id')
    .eq('id', organizationId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (organizationError) return res.status(500).json({ error: 'Failed to verify organisation access' });
  if (!organization) return res.status(404).json({ error: 'Organisation not found' });

  if (req.method === 'GET') {
    const access = await evaluateEffectiveOrganisationLoginAccess({ supabase, tenantId, organizationId });
    return res.status(200).json(responsePayload(access));
  }

  if (typeof req.body?.blocked !== 'boolean') {
    return res.status(400).json({ error: 'blocked must be a boolean' });
  }

  const now = new Date().toISOString();
  const actorId = tenantCtx.tenantUserId || tenantCtx.memberId || null;
  const { error: updateError } = await supabase
    .from('organization')
    .update({
      member_login_blocked: req.body.blocked,
      member_login_blocked_at: now,
      member_login_blocked_by: actorId,
    })
    .eq('id', organizationId)
    .eq('tenant_id', tenantId);
  if (updateError) {
    console.error('[Organisation Login Access] Failed to update manual block:', updateError);
    return res.status(500).json({ error: 'Failed to update member login access' });
  }

  // Deletion is durable: a later unblock merely permits a fresh login and can
  // never make one of these old cookie/bearer tokens valid again.
  if (req.body.blocked) {
    const revoked = await invalidateOrganizationMemberSessions({ tenantId, organizationId });
    if (!revoked.success) {
      // Current-session validation still enforces the block, but surface the
      // cleanup failure instead of claiming a successful revocation.
      return res.status(503).json({
        error: 'Member login access was blocked but session revocation could not be completed',
        blocked: true,
      });
    }
  }

  const access = await evaluateEffectiveOrganisationLoginAccess({ supabase, tenantId, organizationId });
  return res.status(200).json(responsePayload(access));
}