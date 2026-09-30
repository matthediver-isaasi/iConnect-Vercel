// Admin-only training fund balance resync — repairs an organisation whose
// stored training_fund_balance has drifted from the transaction ledger.
//
// The recompute + balance write + audit row happen atomically inside the
// Postgres function `resync_training_fund_balance`, which mirrors the
// drift-summary computation exactly, so a resynced org can never still read
// as drifted. Supports a dry-run preview so the UI can show stored vs ledger
// balance before the admin confirms.
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

  const { organization_id, dry_run } = req.body || {};

  if (!organization_id || typeof organization_id !== 'string') {
    return res.status(400).json({ error: 'organization_id is required' });
  }

  try {
    const { data, error } = await supabase.rpc('resync_training_fund_balance', {
      p_tenant_id: tenantId,
      p_org_id: organization_id,
      p_created_by: ctx.memberId || null,
      p_dry_run: dry_run === true,
    });

    if (error) {
      console.error('[TrainingFundResync] RPC error:', error);
      return res.status(500).json({ error: 'Failed to resync balance' });
    }

    const result = data || {};

    if (result.reason === 'org-not-found') {
      return res.status(404).json({ error: 'Organisation not found' });
    }

    if (!result.resynced && result.reason !== 'in-sync' && result.reason !== 'dry-run') {
      return res.status(400).json({ error: `Resync rejected (${result.reason || 'unknown'})` });
    }

    if (result.resynced) {
      console.log(
        `[TrainingFundResync] org ${organization_id}: stored ${result.stored_balance} -> ledger ${result.ledger_balance} (txn ${result.transaction_id})`
      );
    }

    return res.status(200).json({
      success: true,
      resynced: result.resynced === true,
      in_sync: result.reason === 'in-sync',
      dry_run: result.reason === 'dry-run',
      stored_balance: Number(result.stored_balance),
      ledger_balance: Number(result.ledger_balance),
      difference: Number(result.difference),
      transaction_id: result.transaction_id || null,
    });
  } catch (err) {
    console.error('[TrainingFundResync] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
