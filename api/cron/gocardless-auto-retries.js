// Bounded GoCardless automatic collection retry sweep.
//
// Due plans are ordered deterministically and every row is revalidated by the
// shared retry service immediately before the provider call. The service's
// plan claim serializes this cron with member/admin retries.

import { supabase } from '../_lib/database.js';
import { gocardlessForTenant } from '../_lib/gocardless.js';
import { createLiveRetryEffects } from '../_lib/gocardlessAutoRetry.js';
import { runRetries, selectDueRetries } from '../_lib/directDebitRetryPipeline.js';

const MAX_ROWS = 100;
const MAX_RUNTIME_MS = 45_000;

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) {
    console.log('[cron/gocardless-auto-retries] Unauthorized request');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!supabase) return res.status(500).json({ error: 'Database not configured' });

  const startedAt = Date.now();
  const now = new Date();
  const results = { scanned: 0, requested: 0, refused: 0, raced: 0, errors: 0, timedOut: false, details: [] };
  const clients = new Map();
  const getGc = async (tenantId) => {
    if (!clients.has(tenantId)) clients.set(tenantId, await gocardlessForTenant(tenantId));
    return clients.get(tenantId);
  };
  const effects = createLiveRetryEffects({ db: supabase, getGc });

  try {
    const { data: plans, error } = await selectDueRetries(supabase
      .from('membership_payment_plans')
      .select('*'), now)
      .order('auto_retry_next_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(MAX_ROWS);
    if (error) throw new Error(`load due GoCardless retries failed: ${error.message}`);

    for (const plan of plans || []) {
      if (Date.now() - startedAt >= MAX_RUNTIME_MS) {
        results.timedOut = true;
        break;
      }
      results.scanned++;
      try {
        const outcome = await runRetries({ db: supabase, plan, now, getGc, effects });
        if (outcome.ok) {
          results.requested++;
          results.details.push({
            planId: plan.id,
            paymentId: plan.auto_retry_payment_id,
            outcome: outcome.duplicate ? 'already_requested' : 'requested',
          });
        } else if (outcome.reason === 'retry_in_progress') {
          results.raced++;
          results.details.push({ planId: plan.id, outcome: outcome.reason });
        } else {
          results.refused++;
          results.details.push({ planId: plan.id, outcome: outcome.reason, gcStatus: outcome.gcStatus || null });
        }
      } catch (error) {
        results.errors++;
        results.details.push({ planId: plan.id, outcome: 'error', error: error.message });
        console.error(`[cron/gocardless-auto-retries] plan ${plan.id} failed:`, error.message);
      }
    }
  } catch (error) {
    results.errors++;
    results.details.push({ outcome: 'fatal', error: error.message });
    console.error('[cron/gocardless-auto-retries] fatal:', error);
  }

  const durationMs = Date.now() - startedAt;
  const { error: logError } = await supabase.from('scheduled_task_log').insert({
    tenant_id: null,
    task_name: 'gocardless_auto_retries',
    task_display_name: 'GoCardless Automatic Collection Retries',
    status: results.errors > 0 || results.timedOut ? 'partial' : 'success',
    details: JSON.stringify({ ...results, duration_ms: durationMs, max_rows: MAX_ROWS }),
    executed_at: new Date().toISOString(),
  });
  if (logError) console.error('[cron/gocardless-auto-retries] failed to write task log:', logError.message);

  console.log(`[cron/gocardless-auto-retries] done in ${durationMs}ms:`, JSON.stringify({ ...results, details: undefined }));
  return res.status(200).json({ ...results, durationMs });
}