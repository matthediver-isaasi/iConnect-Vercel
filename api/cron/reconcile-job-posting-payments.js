// Task #2995 — cron that reconciles job postings stuck in
// `pending_payment` whose Stripe PaymentIntent actually succeeded.
//
// Mirrors the training-fund purchase reconciliation cron: each posting is
// processed independently inside a try/catch, the run is bounded by a
// lookback window (postings created in the last 30 days) plus a wall-clock
// budget, and the shared helper's compare-and-set claim keeps everything
// idempotent against the browser confirm path and repeat runs.

import { supabase } from '../_lib/database.js';
import { reconcileJobPostingRow } from '../_lib/jobPostingPaymentReconciliation.js';

const MAX_ROWS_PER_RUN = 200;
const LOOKBACK_DAYS = 30;

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    console.log('[cron/reconcile-job-posting-payments] Unauthorized request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  const startTime = Date.now();
  const results = {
    processed: 0,
    reconciled: 0,
    skipped: 0,
    errors: 0,
    details: [],
  };

  try {
    const rows = await fetchStuckPostings();

    for (const row of rows) {
      try {
        const outcome = await reconcileJobPostingRow({ row });
        results.processed++;
        if (outcome.transitioned) {
          results.reconciled++;
          results.details.push({ postingId: row.id, tenantId: outcome.tenantId, outcome: 'reconciled' });
        } else {
          results.skipped++;
          results.details.push({ postingId: row.id, skippedReason: outcome.skippedReason });
        }
      } catch (err) {
        results.errors++;
        results.details.push({ postingId: row.id, error: err.message });
        console.error(`[cron/reconcile-job-posting-payments] posting=${row.id} error: ${err.message}`);
      }

      if (Date.now() - startTime > 50_000) {
        console.warn('[cron/reconcile-job-posting-payments] time budget exceeded, deferring remaining rows to next run');
        break;
      }
    }

    return res.status(200).json({
      ok: true,
      durationMs: Date.now() - startTime,
      ...results,
    });
  } catch (err) {
    console.error('[cron/reconcile-job-posting-payments] fatal:', err);
    return res.status(500).json({ ok: false, error: err.message, ...results });
  }
}

async function fetchStuckPostings() {
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('job_posting')
    .select('*')
    .eq('status', 'pending_payment')
    .not('stripe_payment_intent_id', 'is', null)
    .gte('created_date', cutoff)
    .order('created_date', { ascending: true })
    .limit(MAX_ROWS_PER_RUN);

  if (error) {
    console.error(`[cron/reconcile-job-posting-payments] failed to load job_posting rows: ${error.message}`);
    return [];
  }
  return data || [];
}
