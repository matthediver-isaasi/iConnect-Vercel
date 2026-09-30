import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const context = await getTenantContext(req);
    if (!context?.isAuthenticated || !context?.tenantId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!(await hasAdminAccess(context))) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const {
      transition_id: transitionId,
      workflow_id: workflowId,
      acknowledge_without_replay: acknowledgeWithoutReplay,
      note,
    } = req.body || {};
    if (!transitionId || !workflowId) {
      return res.status(400).json({ error: 'transition_id and workflow_id are required' });
    }
    if (acknowledgeWithoutReplay !== true) {
      return res.status(400).json({
        error: 'acknowledge_without_replay must be true',
        code: 'explicit_acknowledgement_required',
      });
    }

    const { data: acknowledged, error } = await supabase.rpc(
      'acknowledge_attendance_workflow_delivery',
      {
        p_tenant_id: context.tenantId,
        p_transition_id: transitionId,
        p_workflow_id: workflowId,
        p_note: typeof note === 'string' ? note.slice(0, 500) : null,
        p_actor: context.email || context.member?.email || null,
      },
    );
    if (error) {
      if (error.code === '55000') {
        return res.status(409).json({ error: 'The attendance transition is currently processing' });
      }
      throw error;
    }
    if (!acknowledged) {
      return res.status(409).json({
        error: 'No blocked attendance delivery was available to acknowledge',
      });
    }

    return res.status(200).json({
      success: true,
      requeued: true,
      replayed_claimed_actions: false,
    });
  } catch (error) {
    console.error('[workflows/acknowledge-attendance-delivery] Failed:', error);
    return res.status(500).json({ error: 'Failed to acknowledge attendance delivery' });
  }
}