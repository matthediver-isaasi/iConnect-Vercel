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

  try {
    // Page through every transaction for this tenant. We need full coverage
    // (no per-org row cap) so the org-list drift indicator is accurate even
    // for organisations with thousands of transactions.
    const byOrg = new Map();
    const pageSize = 1000;
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from('training_fund_transaction')
        .select('organization_id, type, amount, balance_before, balance_after, created_date')
        .eq('tenant_id', tenantId)
        .order('created_date', { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) {
        console.error('[TrainingFundDriftSummary] Query error:', error);
        return res.status(500).json({ error: 'Failed to fetch transactions' });
      }
      if (data && data.length > 0) {
        for (const t of data) {
          if (!t.organization_id) continue;
          let bucket = byOrg.get(t.organization_id);
          if (!bucket) {
            bucket = { sum_deltas: 0, opening: 0, transaction_count: 0, has_opening: false };
            byOrg.set(t.organization_id, bucket);
          }
          if (!bucket.has_opening) {
            bucket.opening = Number(t.balance_before) || 0;
            bucket.has_opening = true;
          }
          const beforeRaw = t.balance_before;
          const afterRaw = t.balance_after;
          const before = beforeRaw === null || beforeRaw === undefined || beforeRaw === '' ? NaN : Number(beforeRaw);
          const after = afterRaw === null || afterRaw === undefined || afterRaw === '' ? NaN : Number(afterRaw);
          let delta;
          if (Number.isFinite(before) && Number.isFinite(after)) {
            delta = after - before;
          } else {
            const amt = Math.abs(Number(t.amount) || 0);
            delta = (t.type === 'add' ? 1 : -1) * amt;
          }
          bucket.sum_deltas += delta;
          bucket.transaction_count += 1;
        }
      }
      if (!data || data.length < pageSize) break;
      from += pageSize;
    }

    const summary = {};
    for (const [orgId, b] of byOrg.entries()) {
      summary[orgId] = {
        sum_deltas: b.sum_deltas,
        opening: b.opening,
        transaction_count: b.transaction_count
      };
    }

    return res.status(200).json({ summary });
  } catch (err) {
    console.error('[TrainingFundDriftSummary] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
