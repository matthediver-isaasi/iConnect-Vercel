import { supabase } from '../../_lib/database.js';
import { getSessionMember } from '../../_lib/session.js';
import { getTenantContext, hasAdminAccess } from '../../_lib/tenantContext.js';
import {
  loadMemberCpdPointsHistory,
  parseCpdPointsHistoryPagination,
} from '../../_lib/eventCpdPointsService.js';

export function createMemberCpdPointsHandler(dependencies = {}) {
  const db = dependencies.db || supabase;
  const sessionMember = dependencies.getSessionMember || getSessionMember;
  const tenantContext = dependencies.getTenantContext || getTenantContext;
  const adminAccess = dependencies.hasAdminAccess || hasAdminAccess;
  const loadHistory = dependencies.loadMemberCpdPointsHistory || loadMemberCpdPointsHistory;

  return async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    if (!db) return res.status(503).json({ error: 'Database not configured' });

    try {
      const memberId = req.query.memberId;
      let tenantId = null;
      const ownMember = await sessionMember(req).catch(() => null);
      if (ownMember?.id && String(ownMember.id) === String(memberId)) {
        tenantId = ownMember.tenant_id || ownMember.organization?.tenant_id || null;
      } else {
        const context = await tenantContext(req).catch(() => null);
        if (context?.tenantId && await adminAccess(context)) tenantId = context.tenantId;
      }
      if (!tenantId) return res.status(403).json({ error: 'Forbidden' });

      const { page, pageSize } = parseCpdPointsHistoryPagination(req.query);
      const history = await loadHistory(
        { tenantId, memberId, page, pageSize },
        { db },
      );
      if (!history) return res.status(404).json({ error: 'Member not found' });
      return res.status(200).json(history);
    } catch (error) {
      console.error('[Member CPD points] Failed to load history:', error);
      return res.status(500).json({ error: 'Failed to load CPD points history' });
    }
  };
}

export default createMemberCpdPointsHandler();