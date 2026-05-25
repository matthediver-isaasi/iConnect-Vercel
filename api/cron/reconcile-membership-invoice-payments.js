// Task #1017 — 3-hourly cron that reconciles outstanding membership
// invoice payment state from Xero/QBO and fires workflows on transition.
//
// Each tenant is processed independently inside a try/catch so a single
// broken accounting token cannot block the rest of the batch. The total
// number of rows processed per run is capped to stay well within the
// 60s Vercel function ceiling; unprocessed rows are picked up on the
// next tick (oldest first).

import { supabase } from '../_lib/database.js';
import { reconcileRow } from '../_lib/membershipPaymentReconciliation.js';

const MAX_ROWS_PER_RUN = 500;
const ORG_TABLE = 'organisation_membership_history';
const MEMBER_TABLE = 'member_membership_history';

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    console.log('[cron/reconcile-membership-invoice-payments] Unauthorized request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  const startTime = Date.now();
  const baseUrl = req.headers.host
    ? `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`
    : '';
  // Response shape mirrors the renewals cron: { processed, skipped,
  // errors, details } so dashboards/log scrapers can reuse the same
  // parsing logic. `transitioned` and `by_tenant` are additional
  // diagnostic fields.
  const results = {
    processed: 0,
    transitioned: 0,
    skipped: 0,
    errors: 0,
    details: [],
    by_tenant: {},
  };

  try {
    const orgRows = await fetchOutstanding(ORG_TABLE);
    const memberRows = await fetchOutstanding(MEMBER_TABLE);

    // Interleave by tenant so one large tenant doesn't starve others if
    // we hit the row cap. Group → round-robin.
    const byTenant = new Map();
    for (const row of [...orgRows, ...memberRows]) {
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
        // Drain empty tenant queue
        queues.splice(idx, 1);
        cursor--;
        continue;
      }

      const tenantBucket = (results.by_tenant[tenantId] ||= {
        processed: 0, transitioned: 0, skipped: 0, errors: 0,
      });

      try {
        const table = row._sourceTable;
        const outcome = await reconcileRow({ table, row, baseUrl });
        results.processed++;
        tenantBucket.processed++;
        if (outcome.transitioned) {
          results.transitioned++;
          tenantBucket.transitioned++;
          results.details.push({
            tenantId,
            table,
            recordId: row.id,
            before: outcome.beforeStatus,
            after: outcome.afterStatus,
          });
        } else {
          results.skipped++;
          tenantBucket.skipped++;
        }
      } catch (err) {
        results.errors++;
        tenantBucket.errors++;
        results.details.push({ tenantId, table: row._sourceTable, recordId: row.id, error: err.message });
        console.error(`[cron/reconcile-membership-invoice-payments] tenant=${tenantId} row=${row.id} error: ${err.message}`);
        // One bad invoice shouldn't poison the rest of the same tenant's
        // batch — keep going.
      }
      totalProcessed++;

      // Bail early if approaching the function-time limit (50s headroom).
      if (Date.now() - startTime > 50_000) {
        console.warn('[cron/reconcile-membership-invoice-payments] time budget exceeded, deferring remaining rows to next run');
        break outer;
      }
    }

    return res.status(200).json({
      ok: true,
      durationMs: Date.now() - startTime,
      ...results,
    });
  } catch (err) {
    console.error('[cron/reconcile-membership-invoice-payments] fatal:', err);
    return res.status(500).json({ ok: false, error: err.message, ...results });
  }
}

async function fetchOutstanding(table) {
  // Non-terminal payment statuses: `unpaid` and `partial` both need
  // continued polling until they settle as `paid` (or `voided`).
  const { data, error } = await supabase
    .from(table)
    .select('*')
    .in('payment_status', ['unpaid', 'partial'])
    .or('accounting_invoice_id.not.is.null,xero_invoice_id.not.is.null')
    .order('created_at', { ascending: true })
    .limit(MAX_ROWS_PER_RUN);

  if (error) {
    console.error(`[cron/reconcile-membership-invoice-payments] failed to load ${table}: ${error.message}`);
    return [];
  }
  return (data || []).map((row) => ({ ...row, _sourceTable: table }));
}
