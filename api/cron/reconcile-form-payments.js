// Task #3483 — cron that reconciles form_submission rows stuck in
// payment_status='pending' whose Stripe PaymentIntent / GoCardless billing
// request actually succeeded, plus paid rows whose finalisation never ran.
//
// Mirrors reconcile-job-posting-payments: bounded lookback, per-row
// try/catch inside the shared helper, and the CAS in markFormSubmissionPaid
// keeps everything idempotent against the browser confirm path.

import { supabase } from '../_lib/database.js';
import { reconcileFormPayments } from '../_lib/formPaymentReconciliation.js';
import { createHeartbeatReporter, HEARTBEAT_ENV_VARS } from '../_lib/heartbeat.js';

export function isFormPaymentReconciliationHeartbeatHealthy(results) {
  return Array.isArray(results?.errors)
    ? results.errors.length === 0 && !(results.__heartbeatFailures?.length)
    : results?.errors === 0 && !(results?.__heartbeatFailures?.length);
}

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    console.log('[cron/reconcile-form-payments] Unauthorized request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const reportHeartbeat = createHeartbeatReporter({
    envVar: HEARTBEAT_ENV_VARS.formPaymentReconciliation,
  });

  if (!supabase) {
    await reportHeartbeat(false);
    return res.status(500).json({ error: 'Database not configured' });
  }

  const startTime = Date.now();
  try {
    const results = await reconcileFormPayments(supabase, { limit: 100 });
    await reportHeartbeat(isFormPaymentReconciliationHeartbeatHealthy(results));
    return res.status(200).json({ ok: true, durationMs: Date.now() - startTime, ...results });
  } catch (err) {
    console.error('[cron/reconcile-form-payments] fatal:', err);
    await reportHeartbeat(false);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
