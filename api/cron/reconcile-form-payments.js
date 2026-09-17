// Task #3483 — cron that reconciles form_submission rows stuck in
// payment_status='pending' whose Stripe PaymentIntent / GoCardless billing
// request actually succeeded, plus paid rows whose finalisation never ran.
// New completion receipts are eligible on the next one-minute sweep; an
// interrupted owner is eligible again after its two-minute lease expires.
// These are scheduling targets, not a hard execution or delivery guarantee.
//
// Mirrors reconcile-job-posting-payments: bounded lookback, per-row
// try/catch inside the shared helper, and the CAS in markFormSubmissionPaid
// keeps everything idempotent against the browser confirm path.

import { supabase } from '../_lib/database.js';
import { reconcileFormPayments } from '../_lib/formPaymentReconciliation.js';
import { createHeartbeatReporter, HEARTBEAT_ENV_VARS } from '../_lib/heartbeat.js';

export function isFormPaymentReconciliationHeartbeatHealthy(results) {
  if ((results?.addressRecovery?.failed || 0) > 0
      || (results?.completion?.failed || 0) > 0) return false;
  return Array.isArray(results?.errors)
    ? results.errors.length === 0 && !(results.__heartbeatFailures?.length)
    : results?.errors === 0 && !(results?.__heartbeatFailures?.length);
}

export function formPaymentReconciliationResponse(results, durationMs) {
  const ok = isFormPaymentReconciliationHeartbeatHealthy(results);
  return {
    ...results,
    ok,
    partial: !ok || results.partial === true || results.budgetExhausted === true
      || (results.completion?.waitingForAddress || 0) > 0
      || (results.completion?.waitingForAccess || 0) > 0
      || (results.issues?.length || 0) > 0,
    durationMs,
  };
}

export function createFormPaymentReconciliationHandler({
  db = supabase,
  reconcile = reconcileFormPayments,
  createReporter = createHeartbeatReporter,
} = {}) {
  return async function handler(req, res) {
    const authHeader = req.headers.authorization;
    const cronSecret = process.env.CRON_SECRET;

    // This endpoint performs cross-tenant work and now returns recovery
    // diagnostics. An unset secret must never make it publicly executable.
    if (!cronSecret) {
      return res.status(503).json({ ok: false, error: 'Cron authentication is not configured' });
    }
    if (authHeader !== `Bearer ${cronSecret}`) {
      console.log('[cron/reconcile-form-payments] Unauthorized request');
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!['GET', 'POST'].includes(req.method)) {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    const reportHeartbeat = createReporter({
      envVar: HEARTBEAT_ENV_VARS.formPaymentReconciliation,
    });

    if (!db) {
      await reportHeartbeat(false);
      return res.status(500).json({ error: 'Database not configured' });
    }

    const startTime = Date.now();
    try {
      // One small slice per minute reduces contention with slow integrations.
      // It is an advisory scheduling budget; interrupted leases become eligible
      // again after two minutes.
      const results = await reconcile(db, {
        limit: 20,
        timeBudgetMs: 40 * 1000,
      });
      await reportHeartbeat(isFormPaymentReconciliationHeartbeatHealthy(results));
      return res.status(200).json(formPaymentReconciliationResponse(results, Date.now() - startTime));
    } catch (err) {
      console.error('[cron/reconcile-form-payments] fatal:', err);
      await reportHeartbeat(false);
      return res.status(500).json({ ok: false, error: 'Form payment reconciliation failed; check server logs.' });
    }
  };
}

export default createFormPaymentReconciliationHandler();
