import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { readMembershipChangePolicy, validateMembershipChangePolicy } from '../_lib/membershipChangePolicy.js';

export function createMembershipChangePolicyHandler({
  db = supabase, getContext = getTenantContext, isAdmin = hasAdminAccess,
} = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    if (!['GET', 'PUT'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
    try {
      const context = await getContext(req);
      if (!context?.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
      if (context.tenantMismatch) return res.status(409).json({ error: 'Tenant context mismatch' });
      if (!context.tenantId || !await isAdmin(context)) return res.status(403).json({ error: 'Administrator access required' });
      if (req.method === 'GET') return res.json(await readMembershipChangePolicy(db, context.tenantId));
      const actor = context.tenantUserId ? `tenant_user:${context.tenantUserId}` : context.memberId ? `member:${context.memberId}` : null;
      if (!actor) return res.status(403).json({ error: 'An authenticated audit identity is required' });
      const policy = validateMembershipChangePolicy(req.body?.policy);
      const revision = req.body?.expectedRevision;
      if (!Number.isSafeInteger(revision) || revision < 0) return res.status(400).json({ error: 'A valid settings revision is required' });
      const { data, error } = await db.rpc('save_membership_change_policy', {
        p_tenant_id: context.tenantId, p_actor: actor, p_policy: policy, p_expected_revision: revision,
      });
      if (error?.code === '40001') return res.status(409).json({ error: 'These settings changed. Reload them before saving again.' });
      if (error) throw error;
      return res.json({ policy: data.policy, revision: data.revision, executionEnabled: false });
    } catch (error) {
      return res.status(error.status || 503).json({
        error: error.status ? error.message : 'Membership change settings are unavailable. No change was confirmed.',
      });
    }
  };
}
export default createMembershipChangePolicyHandler();
