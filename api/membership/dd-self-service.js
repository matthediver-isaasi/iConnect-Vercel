// GoCardless Phase 4 — member self-service for an existing DD plan.
//
//   GET  ?memberId=...   -> current plan + arrears state + pending
//                           cancellation request for the member's latest
//                           agreement (used by DirectDebitPlanCard).
//   POST { action, memberId, ... }
//     - 'request-cancellation'  { reason?, effectivePreference? }
//         Creates a pending membership_dd_cancellation_requests row for
//         admin review. Nothing is cancelled until an admin approves.
//     - 'withdraw-cancellation' { requestId }
//     - 'resolve-payment'
//         Failed-payment recovery: if the mandate is still usable, retries
//         the failed payment at GoCardless (idempotency-keyed, and only if
//         the API confirms the payment is 'failed' — never a double charge).
//         If the mandate is dead, starts a fresh hosted Billing Request Flow
//         to set up a replacement mandate and returns { authorisationUrl }.
//
// Auth: the member themself (session) or a tenant admin (authorizeMemberAccess).

import { supabase } from '../_lib/database.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { gocardlessForTenant, buildIdempotencyKey } from '../_lib/gocardless.js';
import { assertRetryablePayment } from '../_lib/gocardlessArrears.js';
import { applyStatusTransition, STATUS } from '../_lib/gocardlessState.js';
import { authorizeMemberAccess } from './payment-plan.js';

export default async function handler(req, res) {
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  try {
    let resolvedTenantId = null;
    try {
      const tenantData = await resolveTenantFromRequest(req);
      resolvedTenantId = tenantData?.id || null;
    } catch { /* fall back to member tenant below */ }

    const memberId = req.method === 'GET' ? req.query.memberId : req.body?.memberId;
    if (!memberId) return res.status(400).json({ error: 'memberId is required' });

    const auth = await authorizeMemberAccess(req, memberId);
    if (!auth.ok) return res.status(403).json({ error: 'Not authorized for this member' });

    const { data: member } = await supabase
      .from('member')
      .select('id, organization_id, tenant_id, email, first_name, last_name')
      .eq('id', memberId)
      .maybeSingle();
    if (!member?.tenant_id) return res.status(404).json({ error: 'Member not found' });
    if (resolvedTenantId && member.tenant_id !== resolvedTenantId) {
      return res.status(403).json({ error: 'Member does not belong to this tenant' });
    }

    const ctx = await loadPlanContext(member);
    if (req.method === 'GET') return handleGet(res, ctx);
    if (req.method === 'POST') return handlePost(req, res, member, ctx);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('[DdSelfService] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// Latest DD agreement for this member (member-type or their org's), plus its
// plan, pending cancellation request, and last failed payment.
async function loadPlanContext(member) {
  let query = supabase
    .from('membership_billing_agreements')
    .select('*')
    .eq('tenant_id', member.tenant_id)
    // Scope to GoCardless monthly Direct Debit agreements only — a newer
    // non-DD agreement must not hijack the self-service journey.
    .eq('metadata->dd->>kind', 'monthly_direct_debit')
    .order('created_at', { ascending: false })
    .limit(1);
  query = member.organization_id
    ? query.eq('organization_id', member.organization_id)
    : query.eq('member_id', member.id);
  const { data: agreements } = await query;
  const agreement = agreements?.[0] || null;
  if (!agreement) return { agreement: null, plan: null, pendingRequest: null, lastFailedPayment: null };

  const { data: plans } = await supabase
    .from('membership_payment_plans')
    .select('*')
    .eq('billing_agreement_id', agreement.id)
    .order('created_at', { ascending: false })
    .limit(1);
  const plan = plans?.[0] || null;

  let pendingRequest = null;
  if (plan) {
    const { data } = await supabase
      .from('membership_dd_cancellation_requests')
      .select('*')
      .eq('plan_id', plan.id)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(1);
    pendingRequest = data?.[0] || null;
  }

  let lastFailedPayment = null;
  if (plan) {
    const { data } = await supabase
      .from('gocardless_payments')
      .select('*')
      .eq('plan_id', plan.id)
      .eq('status', 'failed')
      .order('created_at', { ascending: false })
      .limit(1);
    lastFailedPayment = data?.[0] || null;
  }

  return { agreement, plan, pendingRequest, lastFailedPayment };
}

function handleGet(res, { agreement, plan, pendingRequest, lastFailedPayment }) {
  if (!agreement) return res.json({ agreement: null, plan: null });
  return res.json({
    agreement: {
      id: agreement.id,
      status: agreement.status,
      hasMandate: !!agreement.gocardless_mandate_id,
      terms: agreement.metadata?.dd || null,
    },
    plan: plan ? {
      id: plan.id,
      status: plan.status,
      amount_minor: plan.amount_minor,
      currency: plan.currency,
      next_charge_date: plan.next_charge_date,
      grace_expires_at: plan.grace_expires_at,
      retry_count: plan.retry_count,
      arrears_policy_applied: plan.arrears_policy_applied,
      in_arrears: [STATUS.PAYMENT_GRACE_PERIOD, STATUS.PAYMENT_OVERDUE].includes(plan.status),
    } : null,
    pendingCancellationRequest: pendingRequest ? {
      id: pendingRequest.id,
      status: pendingRequest.status,
      reason: pendingRequest.reason,
      effective_preference: pendingRequest.effective_preference,
      created_at: pendingRequest.created_at,
    } : null,
    lastFailedPayment: lastFailedPayment ? {
      gocardless_payment_id: lastFailedPayment.gocardless_payment_id,
      amount_minor: lastFailedPayment.amount_minor,
      currency: lastFailedPayment.currency,
      charge_date: lastFailedPayment.charge_date,
    } : null,
  });
}

async function handlePost(req, res, member, ctx) {
  const { action } = req.body || {};
  const { agreement, plan, pendingRequest, lastFailedPayment } = ctx;

  if (action === 'request-cancellation') {
    if (!plan) return res.status(400).json({ error: 'No Direct Debit plan to cancel' });
    if (plan.status === STATUS.PAYMENT_PLAN_CANCELLED) {
      return res.status(409).json({ error: 'This plan is already cancelled' });
    }
    if (pendingRequest) {
      return res.status(409).json({ error: 'A cancellation request is already pending review', requestId: pendingRequest.id });
    }
    const effectivePreference = req.body.effectivePreference === 'period_end' ? 'period_end' : 'immediate';
    const snap = agreement?.metadata?.dd || {};
    const { data: request, error } = await supabase
      .from('membership_dd_cancellation_requests')
      .insert({
        tenant_id: member.tenant_id,
        plan_id: plan.id,
        billing_agreement_id: agreement?.id || null,
        member_id: member.id,
        organization_id: member.organization_id || null,
        requested_by_email: member.email || null,
        reason: req.body.reason || null,
        effective_preference: effectivePreference,
        snapshot: {
          plan_status: plan.status,
          instalment_count: snap.instalment_count || null,
          monthly_amount: snap.monthly_amount || null,
          currency: plan.currency,
          membership_year: snap.membership_year || plan.membership_year || null,
        },
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: 'Failed to record cancellation request' });
    return res.json({ ok: true, request });
  }

  if (action === 'withdraw-cancellation') {
    const requestId = req.body.requestId || pendingRequest?.id;
    if (!requestId) return res.status(400).json({ error: 'No pending cancellation request' });
    const { data: updated, error } = await supabase
      .from('membership_dd_cancellation_requests')
      .update({ status: 'withdrawn', updated_at: new Date().toISOString() })
      .eq('id', requestId)
      .eq('tenant_id', member.tenant_id)
      .eq('status', 'pending')
      .select()
      .maybeSingle();
    if (error) return res.status(500).json({ error: 'Failed to withdraw request' });
    if (!updated) return res.status(409).json({ error: 'Request is no longer pending' });
    return res.json({ ok: true, request: updated });
  }

  if (action === 'resolve-payment') {
    if (!plan || !agreement) return res.status(400).json({ error: 'No Direct Debit plan found' });
    if (![STATUS.PAYMENT_GRACE_PERIOD, STATUS.PAYMENT_OVERDUE].includes(plan.status)) {
      return res.status(409).json({ error: 'This plan has no payment problem to resolve' });
    }
    const gc = await gocardlessForTenant(member.tenant_id);

    // Is the mandate still usable?
    const mandateId = plan.gocardless_mandate_id || agreement.gocardless_mandate_id;
    let mandateUsable = false;
    if (mandateId) {
      try {
        const mandate = await gc.getMandate(mandateId);
        mandateUsable = ['pending_submission', 'submitted', 'active'].includes(mandate?.status);
      } catch { mandateUsable = false; }
    }

    if (mandateUsable) {
      const paymentId = lastFailedPayment?.gocardless_payment_id || plan.last_payment_id;
      if (!paymentId) return res.status(409).json({ error: 'No failed payment found to retry — please contact us' });
      // Never-double-charge: GC must confirm 'failed', and the retry is
      // idempotency-keyed on the payment id.
      const current = await gc.getPayment(paymentId);
      try {
        assertRetryablePayment(current);
      } catch (err) {
        return res.status(409).json({ error: 'This payment cannot be retried right now — it may already be in progress', detail: err.message });
      }
      const retried = await gc.retryPayment(paymentId, { idempotencyKey: `dd-retry-${paymentId}` });
      return res.json({ ok: true, mode: 'retry', payment: { id: retried?.id || paymentId, status: retried?.status || null } });
    }

    // Mandate is dead — replacement-mandate flow via a fresh hosted flow.
    // The plan moves to mandate_pending; the old subscription is already
    // unable to collect (mandate dead), so no parallel-charge risk.
    const runKey = `${plan.id}-${plan.retry_count || 0}-${Date.now().toString(36).slice(0, 6)}`;
    const billingRequest = await gc.createBillingRequest({
      idempotencyKey: buildIdempotencyKey('dd-remandate-br', member.tenant_id, plan.id, String(plan.retry_count || 0)),
      currency: plan.currency || 'GBP',
      metadata: { tenant_id: member.tenant_id, plan_id: plan.id, kind: 'replacement_mandate' },
    });
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const origin = host ? `${proto}://${host}` : null;
    const flow = await gc.createBillingRequestFlow({
      billingRequestId: billingRequest.id,
      redirectUri: origin ? `${origin}/membership/direct-debit/complete?member_id=${member.id}` : undefined,
      exitUri: origin ? `${origin}/membership/direct-debit/cancelled?member_id=${member.id}` : undefined,
      idempotencyKey: buildIdempotencyKey('dd-remandate-brf', member.tenant_id, plan.id, String(plan.retry_count || 0)),
      prefilledCustomer: {
        email: member.email || undefined,
        given_name: member.first_name || undefined,
        family_name: member.last_name || undefined,
      },
    });
    await supabase
      .from('membership_billing_agreements')
      .update({
        gocardless_billing_request_id: billingRequest.id,
        gocardless_billing_request_flow_id: flow.id,
        redirect_url: flow.authorisation_url,
        updated_at: new Date().toISOString(),
      })
      .eq('id', agreement.id);
    await applyStatusTransition({
      entityType: 'payment_plan',
      entityId: plan.id,
      toStatus: STATUS.MANDATE_PENDING,
      reason: `member started replacement mandate (run ${runKey})`,
      source: 'system',
    });
    return res.json({ ok: true, mode: 'new_mandate', authorisationUrl: flow.authorisation_url, flowId: flow.id || null, environment: gc.getGocardlessEnvironment() });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
