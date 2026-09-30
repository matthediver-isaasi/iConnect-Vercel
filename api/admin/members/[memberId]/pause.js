// Task #3586 — admin pause/resume of a member's access + membership payments.
//
// POST /api/admin/members/:memberId/pause
//   { action: 'pause', reason: string, restartDate?: 'YYYY-MM-DD' }
//   { action: 'resume' }
//
// Admin-gated via getTenantContext + hasAdminAccess (tenant membership alone
// is NOT enough). All state changes go through api/_lib/memberPause.js.

import { supabase } from '../../../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../../../_lib/tenantContext.js';
import { pauseMember, resumeMember } from '../../../_lib/memberPause.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  try {
    const context = await getTenantContext(req);
    if (!context?.isAuthenticated || !context.tenantId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const isAdmin = await hasAdminAccess(context);
    if (!isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { memberId } = req.query;
    const { action, reason, restartDate } = req.body || {};
    if (!memberId) return res.status(400).json({ error: 'memberId is required' });

    // Resolve actor for the note attribution.
    let actorName = null;
    let actorMemberId = null;
    if (context.memberId) {
      actorMemberId = context.memberId;
      const { data: actor } = await supabase
        .from('member')
        .select('first_name, last_name, email')
        .eq('id', context.memberId)
        .maybeSingle();
      actorName = actor
        ? ([actor.first_name, actor.last_name].filter(Boolean).join(' ') || actor.email)
        : null;
    } else if (context.tenantUserId) {
      const { data: tu } = await supabase
        .from('tenant_user')
        .select('email, first_name, last_name')
        .eq('id', context.tenantUserId)
        .maybeSingle();
      actorName = tu
        ? ([tu.first_name, tu.last_name].filter(Boolean).join(' ') || tu.email)
        : 'Admin';
    }

    if (action === 'pause') {
      if (!reason || !String(reason).trim()) {
        return res.status(400).json({ error: 'A reason is required to pause a member' });
      }
      let restart = null;
      if (restartDate) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(restartDate))) {
          return res.status(400).json({ error: 'restartDate must be YYYY-MM-DD' });
        }
        restart = String(restartDate);
      }
      const result = await pauseMember({
        tenantId: context.tenantId,
        memberId,
        reason,
        restartDate: restart,
        actorName,
        actorMemberId,
      });
      if (!result.ok) {
        const status = result.error === 'Member not found' ? 404 : 500;
        return res.status(status).json({ error: result.error });
      }
      return res.json({ ok: true, paused: true, alreadyPaused: !!result.alreadyPaused, warnings: result.warnings });
    }

    if (action === 'resume') {
      const result = await resumeMember({
        tenantId: context.tenantId,
        memberId,
        actorName,
        actorMemberId,
      });
      if (!result.ok) {
        const status = result.error === 'Member not found' ? 404 : 500;
        return res.status(status).json({ error: result.error });
      }
      return res.json({ ok: true, paused: false, alreadyResumed: !!result.alreadyResumed, warnings: result.warnings });
    }

    return res.status(400).json({ error: "action must be 'pause' or 'resume'" });
  } catch (error) {
    console.error('[Member Pause] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
