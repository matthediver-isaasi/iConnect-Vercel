import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess, hasFeatureAccess } from '../_lib/tenantContext.js';
import { createMemberStartService } from '../_lib/memberStart.js';
import { START_UUID } from '../_lib/memberStartQuote.js';
import { previewMemberDateExtension } from '../../shared/memberDateMembershipTerm.js';

export function createMemberStartHandler({ db = supabase, getContext = getTenantContext,
  isAdmin = hasAdminAccess, hasFinance = hasFeatureAccess, service = null } = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    try {
      const context = await getContext(req);
      if (!context?.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
      if (context.tenantMismatch) return res.status(409).json({ error: 'Tenant context mismatch' });
      if (!context.tenantId || !await isAdmin(context)) return res.status(403).json({ error: 'Tenant admin access required' });
      if ((!context.tenantUserId && !context.roleId) || (context.roleId && !await hasFinance(context.roleId,
        'commerce.monthly-finance-report', context.memberExcludedFeatures || []))) return res.status(403).json({ error: 'Membership finance permission required' });
      const actorId = context.tenantUserId || context.memberId;
      if (!actorId) return res.status(403).json({ error: 'Authenticated audit identity required' });
      if (req.method === 'POST' && req.body?.action === 'extend-date-term') {
        const { memberId, historyId, expectedEnd, newEnd, reason } = req.body;
        if (!START_UUID.test(memberId || '') || !START_UUID.test(historyId || '')) {
          return res.status(400).json({ error: 'Valid member and membership IDs are required.' });
        }
        const { data: history, error } = await db.from('member_membership_history').select('*')
          .eq('tenant_id', context.tenantId).eq('member_id', memberId).eq('id', historyId).maybeSingle();
        if (error) return res.status(503).json({ error: 'Could not verify the existing membership.' });
        if (!history) return res.status(404).json({ error: 'Membership not found.' });
        if (history.term_end_date !== expectedEnd) return res.status(409).json({ error: 'This membership changed. Reload before extending it.' });
        try { previewMemberDateExtension({ current: history, newEndDate: newEnd, reason }); }
        catch (validation) { return res.status(422).json({ error: validation.message }); }
        const extended = await db.rpc('extend_member_date_term', {
          p_tenant_id: context.tenantId, p_member_id: memberId, p_history_id: historyId,
          p_expected_end: expectedEnd, p_new_end: newEnd, p_actor: actorId, p_reason: reason.trim(),
        });
        if (extended.error) return res.status(409).json({ error: 'The extension could not be confirmed. Another membership or a recent change may conflict; reload and review the membership history.' });
        return res.json(extended.data);
      }
      const start = service || createMemberStartService({ db });
      if (req.method === 'GET') {
        if (!START_UUID.test(req.query?.memberId || '')) return res.status(400).json({ error: 'Valid memberId required' });
        return res.json(await start.list(context.tenantId, req.query.memberId));
      }
      if (req.body?.action === 'preview') return res.json(await start.preview(context.tenantId, req.body));
      if (req.body?.action === 'create') {
        const result = await start.create(context.tenantId, actorId, req.body);
        return res.status(result.reconciliation_required || result.accounting_pending ? 202 : result.replayed ? 200 : 201).json(result);
      }
      if (req.body?.action === 'resume') {
        if (!START_UUID.test(req.body.memberId || '') || !START_UUID.test(req.body.requestId || '')) return res.status(400).json({ error: 'Valid memberId and requestId required' });
        const result = await start.resume(context.tenantId, { memberId: req.body.memberId.toLowerCase(), requestId: req.body.requestId.toLowerCase() });
        return res.status(result.reconciliation_required || result.accounting_pending ? 202 : 200).json(result);
      }
      return res.status(400).json({ error: 'action must be preview, create or resume' });
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.status ? error.message : 'Membership start request failed', code: error.code || 'internal_error' });
    }
  };
}
export default createMemberStartHandler();
