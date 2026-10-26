import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess, hasFeatureAccess } from '../_lib/tenantContext.js';
import { AMENDMENT_UUID, createMemberAmendmentsService } from '../_lib/memberAmendments.js';
import { createMemberChangeAuthorityService } from '../_lib/memberChangeAuthority.js';
import { createMemberChangeAuthorityResolver } from '../_lib/memberChangeAuthorityResolver.js';

export function createMemberAmendmentsHandler({
  db = supabase, getContext = getTenantContext, isAdmin = hasAdminAccess,
  hasFinance = hasFeatureAccess, service = null, authorityService = null,
} = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    try {
      const context = await getContext(req);
      if (!context?.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
      if (context.tenantMismatch) return res.status(409).json({ error: 'Tenant context mismatch' });
      if (!context.tenantId || !await isAdmin(context)) return res.status(403).json({ error: 'Tenant admin access required' });
      // Tenant-account administrators without a member role follow the existing
      // monthly-finance gate; role-bearing accounts also need finance visibility.
      if ((!context.tenantUserId && !context.roleId)
          || (context.roleId && !await hasFinance(context.roleId, 'commerce.monthly-finance-report', context.memberExcludedFeatures || []))) {
        return res.status(403).json({ error: 'Membership finance permission required' });
      }
      const actorId = context.tenantUserId || context.memberId;
      if (!actorId) return res.status(403).json({ error: 'An authenticated audit identity is required' });
      const amendments = service || createMemberAmendmentsService({ db });
      if(req.method==='POST' && ['preview_change','confirm_change'].includes(req.body?.action)) {
        if(!AMENDMENT_UUID.test(req.body?.memberId||'')) return res.status(400).json({error:'A valid memberId is required'});
        const authority=authorityService || createMemberChangeAuthorityService({
          db,resolve:createMemberChangeAuthorityResolver({db,amendments}),
        });
        const actor={tenantId:context.tenantId,memberId:req.body.memberId,actorId,actorKind:'admin'};
        if(req.body.action==='preview_change') return res.json(await authority.preview(actor,req.body.selection));
        return res.json({record:await authority.confirm(actor,{
          selection:req.body.selection,fingerprint:req.body.fingerprint,key:req.body.idempotencyKey,
        }),executionEnabled:false});
      }
      if (req.method === 'GET') {
        if (!AMENDMENT_UUID.test(req.query?.memberId || '')) return res.status(400).json({ error: 'A valid memberId is required' });
        return res.json(await amendments.list(context.tenantId, req.query.memberId));
      }
      if (req.body?.action === 'preview') return res.json(await amendments.preview(context.tenantId, req.body));
      if (req.body?.action === 'create') {
        const result = await amendments.create(context.tenantId, actorId, req.body);
        return res.status(result.replayed ? 200 : 201).json(result);
      }
      if (['settle', 'reconcile', 'apply', 'notify'].includes(req.body?.action)) {
        if (!AMENDMENT_UUID.test(req.body.amendmentId || '')) return res.status(400).json({ error: 'A valid amendmentId is required' });
        return res.json(await amendments[req.body.action](context.tenantId, actorId, req.body));
      }
      return res.status(400).json({ error: 'action must be preview, create, settle, reconcile, apply or notify' });
    } catch (error) {
      return res.status(error.status || 500).json({
        error: error.status ? error.message : 'Membership amendment request failed',
        code: error.code || 'internal_error',
      });
    }
  };
}

export default createMemberAmendmentsHandler();
