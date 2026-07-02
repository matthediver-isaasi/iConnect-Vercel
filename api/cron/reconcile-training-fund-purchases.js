// Task #1660 — cron that reconciles pending invoice-method Training Fund
// purchases against Xero/QBO and releases funds once the invoice is paid.
//
// Mirrors the membership invoice reconciliation cron: each tenant is
// processed independently inside a try/catch, rows are interleaved by
// tenant (round-robin) so one large tenant can't starve others, and the
// run is capped to stay within the Vercel function time budget.

import { supabase } from '../_lib/database.js';
import { reconcilePurchaseRow } from '../_lib/trainingFundPurchaseReconciliation.js';

const MAX_ROWS_PER_RUN = 500;
const TABLE = 'training_fund_purchase';

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    console.log('[cron/reconcile-training-fund-purchases] Unauthorized request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  const startTime = Date.now();
  const results = {
    processed: 0,
    credited: 0,
    cancelled: 0,
    skipped: 0,
    errors: 0,
    details: [],
    by_tenant: {},
  };

  try {
    const rows = await fetchPendingInvoicePurchases();

    const byTenant = new Map();
    for (const row of rows) {
      const t = row.tenant_id || 'unknown';
      if (!byTenant.has(t)) byTenant.set(t, []);
      byTenant.get(t).push(row);
    }

    const queues = [...byTenant.entries()];
    let totalProcessed = 0;

    outer:
    for (let cursor = 0; queues.length > 0 && totalProcessed < MAX_ROWS_PER_RUN; cursor++) {
      const idx = cursor % queues.length;
      const [tenantId, queue] = queues[idx];
      const row = queue.shift();
      if (!row) {
        queues.splice(idx, 1);
        cursor--;
        continue;
      }

      const tenantBucket = (results.by_tenant[tenantId] ||= {
        processed: 0, credited: 0, cancelled: 0, skipped: 0, errors: 0,
      });

      try {
        const outcome = await reconcilePurchaseRow({ row });
        results.processed++;
        tenantBucket.processed++;
        if (outcome.transitioned && outcome.outcome === 'credited') {
          results.credited++;
          tenantBucket.credited++;
          results.details.push({ tenantId, purchaseId: row.id, outcome: 'credited' });
        } else if (outcome.transitioned && outcome.outcome === 'cancelled') {
          results.cancelled++;
          tenantBucket.cancelled++;
          results.details.push({ tenantId, purchaseId: row.id, outcome: 'cancelled' });
        } else {
          results.skipped++;
          tenantBucket.skipped++;
        }
      } catch (err) {
        results.errors++;
        tenantBucket.errors++;
        results.details.push({ tenantId, purchaseId: row.id, error: err.message });
        console.error(`[cron/reconcile-training-fund-purchases] tenant=${tenantId} purchase=${row.id} error: ${err.message}`);
      }
      totalProcessed++;

      if (Date.now() - startTime > 50_000) {
        console.warn('[cron/reconcile-training-fund-purchases] time budget exceeded, deferring remaining rows to next run');
        break outer;
      }
    }

    return res.status(200).json({
      ok: true,
      durationMs: Date.now() - startTime,
      ...results,
    });
  } catch (err) {
    console.error('[cron/reconcile-training-fund-purchases] fatal:', err);
    return res.status(500).json({ ok: false, error: err.message, ...results });
  }
}

async function fetchPendingInvoicePurchases() {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('status', 'pending')
    .eq('payment_method', 'invoice')
    .or('accounting_invoice_id.not.is.null,xero_invoice_id.not.is.null')
    .order('created_date', { ascending: true })
    .limit(MAX_ROWS_PER_RUN);

  if (error) {
    console.error(`[cron/reconcile-training-fund-purchases] failed to load ${TABLE}: ${error.message}`);
    return [];
  }
  return data || [];
}
