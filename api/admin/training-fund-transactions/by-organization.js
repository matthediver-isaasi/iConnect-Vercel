import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
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

  const organizationId = req.query.organization_id || req.query.organizationId;
  if (!organizationId || typeof organizationId !== 'string') {
    return res.status(400).json({ error: 'organization_id is required' });
  }

  try {
    const { data: org, error: orgErr } = await supabase
      .from('organization')
      .select('id, tenant_id, training_fund_balance, training_fund_pending_balance')
      .eq('id', organizationId)
      .maybeSingle();
    if (orgErr) {
      console.error('[TrainingFundByOrg] Organization lookup error:', orgErr);
      return res.status(500).json({ error: 'Failed to fetch organisation' });
    }
    if (!org || org.tenant_id !== tenantId) {
      return res.status(404).json({ error: 'Organisation not found' });
    }

    const transactions = [];
    const pageSize = 1000;
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from('training_fund_transaction')
        .select('id, organization_id, type, amount, balance_before, balance_after, reason, booking_id, created_by, created_date')
        .eq('tenant_id', tenantId)
        .eq('organization_id', organizationId)
        .order('created_date', { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) {
        console.error('[TrainingFundByOrg] Transactions query error:', error);
        return res.status(500).json({ error: 'Failed to fetch transactions' });
      }
      if (data && data.length > 0) {
        transactions.push(...data);
      }
      if (!data || data.length < pageSize) break;
      from += pageSize;
    }

    // Purchases still awaiting payment (invoiced but not yet credited).
    // These make up the org's pending balance and are not spendable yet.
    const { data: pendingPurchases, error: pendingErr } = await supabase
      .from('training_fund_purchase')
      .select('id, organization_id, amount, payment_method, purchase_order_number, po_to_follow, accounting_provider, accounting_invoice_number, xero_invoice_number, online_invoice_url, created_date')
      .eq('tenant_id', tenantId)
      .eq('organization_id', organizationId)
      .eq('status', 'pending')
      .order('created_date', { ascending: false })
      .limit(500);
    if (pendingErr) {
      console.error('[TrainingFundByOrg] Pending purchases query error:', pendingErr);
      return res.status(500).json({ error: 'Failed to fetch pending purchases' });
    }

    return res.status(200).json({
      organization_id: organizationId,
      current_balance: org.training_fund_balance || 0,
      pending_balance: org.training_fund_pending_balance || 0,
      pending_purchases: pendingPurchases || [],
      transactions
    });
  } catch (err) {
    console.error('[TrainingFundByOrg] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
