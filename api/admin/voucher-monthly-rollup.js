// Task #3117 Phase 2: Admin endpoint for the monthly voucher rollup.
//
//   GET  ?month=YYYY-MM                 -> live computed rollup (no writes)
//                                          + stored snapshot rows if closed
//   GET  ?month=YYYY-MM&reconcile=1     -> reconcile stored snapshots against
//                                          a fresh recompute from the ledger
//   POST { month, action: 'close' }     -> write month-end snapshots
//                                          (refuses if already closed)
//   POST { month, action: 'recompute' } -> retrospectively re-run a month,
//                                          overwriting stored snapshots
//
// Admin RBAC via getTenantContext + hasAdminAccess (never
// getTenantIdFromSession — membership alone is not enough).

import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import {
  isValidMonth,
  monthStartDate,
  computeTenantMonthRollup,
  snapshotTenantMonth,
  reconcileTenantMonth,
} from '../_lib/voucherMonthlyRollup.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const ctx = await getTenantContext(req);
  if (!ctx || !ctx.isAuthenticated) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const tenantId = ctx.tenantId;
  if (!tenantId) {
    return res.status(403).json({ error: 'Invalid tenant context' });
  }
  const isAdmin = await hasAdminAccess(ctx);
  if (!isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const month = req.method === 'GET' ? req.query?.month : req.body?.month;
  if (!isValidMonth(month)) {
    return res.status(400).json({ error: 'month must be YYYY-MM' });
  }
  // Never close/preview the current or a future month — it isn't over yet.
  const currentMonth = new Date().toISOString().slice(0, 7);
  const isPastMonth = month < currentMonth;

  try {
    if (req.method === 'GET') {
      const reconcile = req.query?.reconcile === '1' || req.query?.reconcile === 'true';
      if (reconcile) {
        const result = await reconcileTenantMonth(tenantId, month);
        return res.status(200).json({ month, ...result, clean: result.closed && result.differences.length === 0 && result.carryForwardBreaks.length === 0 });
      }

      const { rows } = await computeTenantMonthRollup(tenantId, month);
      const { data: stored, error: sErr } = await supabase
        .from('voucher_monthly_snapshot')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('month', monthStartDate(month));
      if (sErr && sErr.code !== '42P01') {
        console.error('[VoucherMonthlyRollup] Snapshot read error:', sErr);
      }
      return res.status(200).json({
        month,
        closed: !!(stored && stored.length > 0),
        computed: rows,
        snapshots: stored || [],
      });
    }

    // POST
    const action = req.body?.action;
    if (action !== 'close' && action !== 'recompute') {
      return res.status(400).json({ error: "action must be 'close' or 'recompute'" });
    }
    if (!isPastMonth) {
      return res.status(400).json({ error: 'Only past months can be closed or recomputed' });
    }
    const result = await snapshotTenantMonth(tenantId, month, {
      mode: action,
      generatedBy: ctx.tenantUserId
        ? `tenant_user:${ctx.tenantUserId}`
        : (ctx.memberId ? `member:${ctx.memberId}` : 'admin'),
    });
    if (result.skipped) {
      return res.status(409).json({ error: 'Month is already closed — use recompute to overwrite', ...result, month });
    }
    return res.status(200).json({ month, action, ...result });
  } catch (err) {
    console.error('[VoucherMonthlyRollup] Error:', err);
    return res.status(500).json({ error: 'Voucher monthly rollup failed', details: err.message });
  }
}
