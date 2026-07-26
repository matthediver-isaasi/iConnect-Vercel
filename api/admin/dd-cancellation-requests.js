// GoCardless Phase 4 — admin review of member DD cancellation requests.
//
// GET  ?status=pending|approved|rejected|withdrawn (default pending)
// POST { requestId, decision: 'approve'|'reject', notes?,
//        cancelScope?: 'subscription'|'mandate'|'none' }  (approve only)
//
// Deciding a request is separate from the actual cancel actions: approving
// with cancelScope 'subscription' stops future collections but keeps the
// mandate; 'mandate' also cancels the mandate at GoCardless; 'none' records
// the approval only (admin will act manually).

import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess, hasFeatureAccess } from '../_lib/tenantContext.js';
import { gocardlessForTenant } from '../_lib/gocardless.js';
import { applyStatusTransition, STATUS } from '../_lib/gocardlessState.js';
import { sendDdLifecycleEmail } from '../_lib/gocardlessDdEmails.js';

export default async function handler(req, res) {
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  let context;
  try {
    context = await getTenantContext(req);
  } catch {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  if (!context?.tenantId || !(await hasAdminAccess(context))) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  // Same server-side feature RBAC as the DD console: member-role admins must
  // hold the Direct Debit Console key to review cancellation requests.
  if (context.roleId && !(await hasFeatureAccess(context.roleId, 'commerce.gocardless-dd'))) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const tenantId = context.tenantId;
  const actorEmail = context.member?.email || context.email || null;

  try {
    if (req.method === 'GET') {
      const status = req.query.status || 'pending';
      const { data, error } = await supabase
        .from('membership_dd_cancellation_requests')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('status', status)
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw new Error(error.message);
      return res.json({ requests: data || [] });
    }

    if (req.method === 'POST') {
      const { requestId, decision, notes, cancelScope = 'subscription' } = req.body || {};
      if (!requestId || !['approve', 'reject'].includes(decision)) {
        return res.status(400).json({ error: "requestId and decision ('approve'|'reject') required" });
      }
      const { data: request } = await supabase
        .from('membership_dd_cancellation_requests')
        .select('*')
        .eq('id', requestId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (!request) return res.status(404).json({ error: 'Request not found' });
      if (request.status !== 'pending') {
        return res.status(409).json({ error: `Request already ${request.status}` });
      }

      const details = [];
      if (decision === 'approve' && cancelScope !== 'none' && request.plan_id) {
        const { data: plan } = await supabase
          .from('membership_payment_plans')
          .select('*')
          .eq('id', request.plan_id)
          .eq('tenant_id', tenantId)
          .maybeSingle();
        if (plan) {
          const gc = await gocardlessForTenant(tenantId);
          if (plan.gocardless_subscription_id) {
            await gc.cancelSubscription(plan.gocardless_subscription_id);
            details.push(`subscription ${plan.gocardless_subscription_id} cancelled`);
          }
          if (cancelScope === 'mandate' && plan.gocardless_mandate_id) {
            await gc.cancelMandate(plan.gocardless_mandate_id);
            details.push(`mandate ${plan.gocardless_mandate_id} cancelled`);
          }
          const result = await applyStatusTransition({
            entityType: 'payment_plan',
            entityId: plan.id,
            toStatus: STATUS.PAYMENT_PLAN_CANCELLED,
            reason: `cancellation request approved by ${actorEmail || 'admin'}`,
            source: 'admin',
          });
          details.push(`plan: ${JSON.stringify(result)}`);
          if (plan.billing_agreement_id) {
            const { data: agreement } = await supabase
              .from('membership_billing_agreements')
              .select('*')
              .eq('id', plan.billing_agreement_id)
              .maybeSingle();
            if (agreement) {
              await applyStatusTransition({
                entityType: 'billing_agreement',
                entityId: agreement.id,
                toStatus: STATUS.PAYMENT_PLAN_CANCELLED,
                reason: `cancellation request approved by ${actorEmail || 'admin'}`,
                source: 'admin',
              });
              if (agreement.metadata?.dd?.kind === 'monthly_direct_debit') {
                await sendDdLifecycleEmail('plan_cancelled', agreement).catch(() => {});
              }
            }
          }
        }
      }

      const { data: updated, error: updErr } = await supabase
        .from('membership_dd_cancellation_requests')
        .update({
          status: decision === 'approve' ? 'approved' : 'rejected',
          decided_by: actorEmail,
          decided_at: new Date().toISOString(),
          decision_notes: notes || null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', requestId)
        .eq('status', 'pending')
        .select()
        .maybeSingle();
      if (updErr) throw new Error(updErr.message);
      if (!updated) return res.status(409).json({ error: 'Request was decided concurrently' });

      await supabase.from('membership_dd_admin_actions').insert({
        tenant_id: tenantId,
        plan_id: request.plan_id,
        billing_agreement_id: request.billing_agreement_id,
        action: 'cancellation_decision',
        actor_email: actorEmail,
        details: { requestId, decision, cancelScope, notes: notes || null, effects: details },
      });

      return res.json({ ok: true, request: updated, effects: details });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[admin/dd-cancellation-requests] error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
