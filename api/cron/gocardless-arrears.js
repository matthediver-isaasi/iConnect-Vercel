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
import {
  sendDdLifecycleEmail,
  sendRecurringPaymentAdminEscalation,
} from '../_lib/gocardlessDdEmails.js';

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
      .or('arrears_policy_applied.is.null,arrears_policy_applied.eq.restrict')
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
        const configId = agreement?.metadata?.dd?.config_id
          || agreement?.metadata?.card?.config_id
          || null;
        if (configId) {
          const { data } = await supabase
            .from('membership_tier_config')
            .select('id, tenant_id, dd_arrears_policy, dd_arrears_fallback_role_id')
            .eq('id', configId)
            .eq('tenant_id', plan.tenant_id)
            .maybeSingle();
          tierConfig = data;
        }

        const outcome = await applyArrearsPolicy({ plan, agreement, tierConfig, source: 'system' });
        const restrictionRoleAssigned = outcome.policy === 'restrict'
          && (outcome.roleAssignment?.assigned || 0) > 0;
        if (outcome.applied || restrictionRoleAssigned) {
          results.policiesApplied++;
          results.details.push({
            planId: plan.id,
            policy: outcome.policy,
            roleAssignment: outcome.roleAssignment || null,
          });
          if (agreement) {
            // Legacy restrict rows with no role must not tell a member that
            // their role changed. A corrected row is emailed on the later run
            // that actually performs the assignment.
            if (outcome.policy !== 'restrict' || restrictionRoleAssigned) {
              try {
                const policyEvent = {
                  restrict: 'payment_access_restricted',
                  suspend: 'payment_access_suspended',
                  manual_review: 'payment_manual_review',
                  cancel_at_period_end: 'payment_cancel_at_period_end',
                  keep_active: 'payment_overdue',
                }[outcome.policy] || 'payment_overdue';
                const sent = await sendDdLifecycleEmail(policyEvent, agreement, {
                  extraContext: { fallbackRoleName: outcome.fallbackRoleName || null },
                });
                if (sent?.sent) results.emailed++;
              } catch (emailErr) {
                console.error(`[cron/gocardless-arrears] escalation email failed for plan ${plan.id}:`, emailErr.message);
              }
            }
            if (outcome.applied && outcome.policy !== 'keep_active') {
              try {
                const adminSent = await sendRecurringPaymentAdminEscalation({
                  agreement,
                  plan,
                  policy: outcome.policy,
                });
                if (adminSent?.sent) results.emailed++;
              } catch (adminEmailErr) {
                console.error(`[cron/gocardless-arrears] admin escalation failed for plan ${plan.id}:`, adminEmailErr.message);
              }
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
