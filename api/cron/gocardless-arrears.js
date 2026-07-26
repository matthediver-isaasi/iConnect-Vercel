// GoCardless Phase 4 — arrears grace-expiry sweep.
//
// Finds plans sitting in payment_grace_period whose grace window (opened by
// handlePaymentFailure using the SNAPSHOT grace_days) has expired, applies
// the tenant's live arrears policy via applyArrearsPolicy, and sends the
// at_risk_of_suspension escalation email once (arrears_policy_applied is the
// idempotency guard — the sweep never re-applies a policy).
//
// Guarded by CRON_SECRET; logs a scheduled_task_log row per run.

import { supabase } from '../_lib/database.js';
import { applyArrearsPolicy } from '../_lib/gocardlessArrears.js';
import { STATUS } from '../_lib/gocardlessState.js';
import { sendDdLifecycleEmail } from '../_lib/gocardlessDdEmails.js';

const MAX_ROWS = 200;

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    console.log('[cron/gocardless-arrears] Unauthorized request');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!supabase) return res.status(500).json({ error: 'Database not configured' });

  const startTime = Date.now();
  const results = { policiesApplied: 0, emailed: 0, skipped: 0, errors: 0, details: [] };
  const nowIso = new Date().toISOString();

  try {
    const { data: plans, error } = await supabase
      .from('membership_payment_plans')
      .select('*')
      .in('status', [STATUS.PAYMENT_GRACE_PERIOD, STATUS.PAYMENT_OVERDUE])
      .is('arrears_policy_applied', null)
      .not('grace_expires_at', 'is', null)
      .lte('grace_expires_at', nowIso)
      .order('grace_expires_at', { ascending: true })
      .limit(MAX_ROWS);
    if (error) throw new Error(`load expired-grace plans failed: ${error.message}`);

    for (const plan of plans || []) {
      try {
        let agreement = null;
        if (plan.billing_agreement_id) {
          const { data } = await supabase
            .from('membership_billing_agreements')
            .select('*')
            .eq('id', plan.billing_agreement_id)
            .maybeSingle();
          agreement = data;
        }

        // Live tier config (policy is operational, unlike snapshot grace).
        let tierConfig = null;
        const configId = agreement?.metadata?.dd?.config_id || null;
        if (configId) {
          const { data } = await supabase
            .from('membership_tier_config')
            .select('id, dd_arrears_policy')
            .eq('id', configId)
            .maybeSingle();
          tierConfig = data;
        }

        const outcome = await applyArrearsPolicy({ plan, agreement, tierConfig, source: 'system' });
        if (outcome.applied) {
          results.policiesApplied++;
          results.details.push({ planId: plan.id, policy: outcome.policy });
          if (agreement?.metadata?.dd?.kind === 'monthly_direct_debit') {
            try {
              const sent = await sendDdLifecycleEmail('at_risk_of_suspension', agreement);
              if (sent?.sent) results.emailed++;
            } catch (emailErr) {
              console.error(`[cron/gocardless-arrears] escalation email failed for plan ${plan.id}:`, emailErr.message);
            }
          }
        } else {
          results.skipped++;
        }
      } catch (planErr) {
        console.error(`[cron/gocardless-arrears] plan ${plan.id} failed:`, planErr);
        results.errors++;
        results.details.push({ planId: plan.id, error: planErr.message });
      }
    }
  } catch (err) {
    console.error('[cron/gocardless-arrears] fatal:', err);
    results.errors++;
    results.details.push({ error: err.message });
  }

  const durationMs = Date.now() - startTime;
  try {
    const { error: logError } = await supabase.from('scheduled_task_log').insert({
      tenant_id: null,
      task_name: 'gocardless_arrears',
      task_display_name: 'GoCardless Arrears Sweep',
      status: results.errors > 0 ? 'partial' : 'success',
      details: JSON.stringify({ ...results, duration_ms: durationMs }),
      executed_at: new Date().toISOString(),
    });
    if (logError) console.error('[cron/gocardless-arrears] failed to write task log:', logError.message);
  } catch (logErr) {
    console.error('[cron/gocardless-arrears] failed to write task log:', logErr.message);
  }

  console.log(`[cron/gocardless-arrears] done in ${durationMs}ms:`, JSON.stringify({ ...results, details: undefined }));
  return res.status(200).json({ ...results, durationMs });
}
