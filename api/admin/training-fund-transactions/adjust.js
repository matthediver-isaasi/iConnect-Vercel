// Prevent untracked training fund balance writes — dedicated admin endpoint
// for manual add/deduct adjustments from /TrainingFundManagement.
//
// The balance mutation and the training_fund_transaction ledger row are
// written atomically inside the Postgres function
// `adjust_training_fund_balance` (same lock-safe pattern as
// credit_training_fund_purchase), so a partial failure can never leave the
// balance and ledger diverged.
import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
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

  const { organization_id, type, amount, reason, created_date } = req.body || {};

  if (!organization_id || typeof organization_id !== 'string') {
    return res.status(400).json({ error: 'organization_id is required' });
  }
  if (type !== 'add' && type !== 'deduct') {
    return res.status(400).json({ error: 'type must be "add" or "deduct"' });
  }
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }

  // Optional backdated timestamp; must parse and must not be in the future.
  let createdDate = null;
  if (created_date) {
    const d = new Date(created_date);
    if (isNaN(d.getTime())) {
      return res.status(400).json({ error: 'created_date is not a valid date' });
    }
    if (d.getTime() > Date.now() + 60 * 1000) {
      return res.status(400).json({ error: 'created_date cannot be in the future' });
    }
    createdDate = d.toISOString();
  }

  try {
    const { data, error } = await supabase.rpc('adjust_training_fund_balance', {
      p_tenant_id: tenantId,
      p_org_id: organization_id,
      p_type: type,
      p_amount: amt,
      p_reason: typeof reason === 'string' ? reason : null,
      p_created_by: ctx.memberId || null,
      p_created_date: createdDate || new Date().toISOString(),
    });

    if (error) {
      console.error('[TrainingFundAdjust] RPC error:', error);
      return res.status(500).json({ error: 'Failed to adjust balance' });
    }

    const result = data || {};
    if (!result.adjusted) {
      const reasonCode = result.reason || 'unknown';
      if (reasonCode === 'insufficient-balance') {
        return res.status(400).json({ error: 'Cannot reduce balance below zero' });
      }
      if (reasonCode === 'org-not-found') {
        return res.status(404).json({ error: 'Organisation not found' });
      }
      return res.status(400).json({ error: `Adjustment rejected (${reasonCode})` });
    }

    console.log(`[TrainingFundAdjust] ${type} £${amt} for org ${organization_id} -> ${result.balance_after} (txn ${result.transaction_id})`);

    return res.status(200).json({
      success: true,
      balance_before: Number(result.balance_before),
      balance_after: Number(result.balance_after),
      transaction_id: result.transaction_id,
    });
  } catch (err) {
    console.error('[TrainingFundAdjust] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
