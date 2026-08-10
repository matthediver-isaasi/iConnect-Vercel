// Task #3483 — cron that reconciles form_submission rows stuck in
// payment_status='pending' whose Stripe PaymentIntent / GoCardless billing
// request actually succeeded, plus paid rows whose finalisation never ran.
//
// Mirrors reconcile-job-posting-payments: bounded lookback, per-row
// try/catch inside the shared helper, and the CAS in markFormSubmissionPaid
// keeps everything idempotent against the browser confirm path.

import { supabase } from '../_lib/database.js';
import { reconcileFormPayments } from '../_lib/formPaymentReconciliation.js';

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    console.log('[cron/reconcile-form-payments] Unauthorized request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  const startTime = Date.now();
  try {
    const results = await reconcileFormPayments(supabase, { limit: 100 });
    return res.status(200).json({ ok: true, durationMs: Date.now() - startTime, ...results });
  } catch (err) {
    console.error('[cron/reconcile-form-payments] fatal:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
