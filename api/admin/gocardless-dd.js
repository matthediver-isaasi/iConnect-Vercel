// GoCardless Phase 4 — admin Direct Debit console API.
//
// GET  ?view=summary                — dashboard counts + attention queue
// GET  ?view=plans&status=&q=       — filterable plan list
// GET  ?view=plan&planId=           — plan detail: payments, provider events,
//                                     emails sent, admin actions, refunds
// GET  ?view=reconciliation&bucket= — finance reconciliation buckets
// GET  ?view=export&bucket=         — reconciliation bucket as CSV download
// POST { action, planId, ... }      — admin actions (audited):
//        retry | refund | cancel_subscription | cancel_mandate |
//        pause_subscription | resume_subscription | reconcile |
//        extend_grace | manual_resolve | remind | resend_link | note |
//        new_mandate_link
//
// Auth: tenant admin (getTenantContext + hasAdminAccess) PLUS server-side
// feature RBAC: member-role admins must hold 'commerce.gocardless-dd' for any
// access, and 'commerce.monthly-finance-report' (finance) for refunds.
// Tenant-user dashboard sessions (no roleId) pass both. Refunds are also
// double-confirmed client-side.

import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess, hasFeatureAccess } from '../_lib/tenantContext.js';
import { gocardlessForTenant } from '../_lib/gocardless.js';
import { applyStatusTransition, STATUS } from '../_lib/gocardlessState.js';
import {
  assertRetryablePayment,
  computeGraceExpiry,
  graceDaysForAgreement,
  recoveryPlanUpdate,
} from '../_lib/gocardlessArrears.js';
import { sendDdLifecycleEmail } from '../_lib/gocardlessDdEmails.js';
import { createInvitation } from '../_lib/gocardlessDdInvitations.js';
import { postDdInstalmentToAccounting } from '../_lib/gocardlessAccounting.js';

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
  // Feature-level RBAC (server-side, not just client gating): member-role
  // admins must hold the Direct Debit Console feature key.
  if (context.roleId && !(await hasFeatureAccess(context.roleId, 'commerce.gocardless-dd'))) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const tenantId = context.tenantId;
  const actorEmail = context.member?.email || context.email || null;

  try {
    if (req.method === 'GET') return await handleGet(req, res, tenantId);
    if (req.method === 'POST') {
      // Refunds move money — restrict to finance-authorized admins.
      if (req.body?.action === 'refund' && context.roleId
          && !(await hasFeatureAccess(context.roleId, 'commerce.monthly-finance-report'))) {
        return res.status(403).json({ error: 'Refunds require finance permission' });
      }
      return await handlePost(req, res, tenantId, actorEmail);
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[admin/gocardless-dd] error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

// ---------------------------------------------------------------------------
// GET views

async function handleGet(req, res, tenantId) {
  const view = req.query.view || 'summary';
  if (view === 'summary') return res.json(await buildSummary(tenantId));
  if (view === 'plans') return res.json(await listPlans(tenantId, req.query));
  if (view === 'plan') return res.json(await planDetail(tenantId, req.query.planId, res));
  if (view === 'reconciliation') return res.json(await reconciliationView(tenantId, req.query));
  if (view === 'export') return exportReconciliationCsv(res, tenantId, req.query);
  return res.status(400).json({ error: `Unknown view '${view}'` });
}

async function buildSummary(tenantId) {
  const { data: plans } = await supabase
    .from('membership_payment_plans')
    .select('id, status, grace_expires_at, arrears_policy_applied, retry_count, next_charge_date, amount_minor, currency')
    .eq('tenant_id', tenantId);
  const byStatus = {};
  const attention = [];
  const now = Date.now();
  for (const p of plans || []) {
    byStatus[p.status] = (byStatus[p.status] || 0) + 1;
    if (p.status === STATUS.PAYMENT_GRACE_PERIOD || p.status === STATUS.PAYMENT_OVERDUE) {
      attention.push({
        ...p,
        grace_expired: p.grace_expires_at ? new Date(p.grace_expires_at).getTime() <= now : false,
      });
    }
  }
  const { count: pendingCancellations } = await supabase
    .from('membership_dd_cancellation_requests')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('status', 'pending');
  const { count: failedAccounting } = await supabase
    .from('gocardless_payments')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('accounting_sync_status', 'failed');
  const { count: chargebacksAfterPayout } = await supabase
    .from('gocardless_payments')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('chargeback_reversed_after_payout', true);
  return {
    byStatus,
    attention,
    pendingCancellations: pendingCancellations || 0,
    failedAccounting: failedAccounting || 0,
    chargebacksAfterPayout: chargebacksAfterPayout || 0,
  };
}

async function listPlans(tenantId, query) {
  let q = supabase
    .from('membership_payment_plans')
    .select('*, membership_billing_agreements!membership_payment_plans_billing_agreement_id_fkey(id, member_id, organization_id, status, metadata)')
    .eq('tenant_id', tenantId)
    .order('updated_at', { ascending: false })
    .limit(200);
  if (query.status) q = q.eq('status', query.status);
  const { data: plans, error } = await q;
  if (error) throw new Error(`list plans failed: ${error.message}`);

  // Resolve display names (member/org) in bulk.
  const memberIds = [...new Set((plans || []).map((p) => p.membership_billing_agreements?.member_id).filter(Boolean))];
  const orgIds = [...new Set((plans || []).map((p) => p.membership_billing_agreements?.organization_id).filter(Boolean))];
  const [membersRes, orgsRes] = await Promise.all([
    memberIds.length ? supabase.from('member').select('id, first_name, last_name, email').in('id', memberIds) : { data: [] },
    orgIds.length ? supabase.from('organization').select('id, name').in('id', orgIds) : { data: [] },
  ]);
  const memberMap = new Map((membersRes.data || []).map((m) => [m.id, m]));
  const orgMap = new Map((orgsRes.data || []).map((o) => [o.id, o]));

  let rows = (plans || []).map((p) => {
    const ag = p.membership_billing_agreements;
    const member = ag?.member_id ? memberMap.get(ag.member_id) : null;
    const org = ag?.organization_id ? orgMap.get(ag.organization_id) : null;
    return {
      ...p,
      membership_billing_agreements: undefined,
      agreement: ag ? { id: ag.id, status: ag.status, member_id: ag.member_id, organization_id: ag.organization_id, dd: ag.metadata?.dd || null } : null,
      payer_name: org?.name || (member ? `${member.first_name || ''} ${member.last_name || ''}`.trim() : null),
      payer_email: member?.email || null,
    };
  });
  const qText = (query.q || '').toLowerCase().trim();
  if (qText) {
    rows = rows.filter((r) =>
      (r.payer_name || '').toLowerCase().includes(qText) ||
      (r.payer_email || '').toLowerCase().includes(qText) ||
      (r.gocardless_subscription_id || '').toLowerCase().includes(qText));
  }
  return { plans: rows };
}

async function planDetail(tenantId, planId, res) {
  if (!planId) { res.status(400); return { error: 'planId required' }; }
  const { data: plan, error } = await supabase
    .from('membership_payment_plans')
    .select('*')
    .eq('id', planId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!plan) { res.status(404); return { error: 'Plan not found' }; }

  const agreement = plan.billing_agreement_id
    ? (await supabase.from('membership_billing_agreements').select('*').eq('id', plan.billing_agreement_id).maybeSingle()).data
    : null;

  const [paymentsRes, historyRes, actionsRes, cancellationsRes] = await Promise.all([
    supabase.from('gocardless_payments').select('*').eq('plan_id', plan.id).order('created_at', { ascending: false }).limit(100),
    supabase.from('membership_payment_status_history').select('*').eq('entity_id', plan.id).order('created_at', { ascending: false }).limit(100),
    supabase.from('membership_dd_admin_actions').select('*').eq('plan_id', plan.id).order('created_at', { ascending: false }).limit(100),
    supabase.from('membership_dd_cancellation_requests').select('*').eq('plan_id', plan.id).order('created_at', { ascending: false }).limit(20),
  ]);
  const payments = paymentsRes.data || [];
  const paymentIds = payments.map((p) => p.gocardless_payment_id).filter(Boolean);
  let refunds = [];
  if (paymentIds.length) {
    const { data } = await supabase.from('gocardless_refunds').select('*').in('gocardless_payment_id', paymentIds).order('created_at', { ascending: false });
    refunds = data || [];
  }

  return {
    plan,
    agreement,
    payments,
    statusHistory: historyRes.data || [],
    adminActions: actionsRes.data || [],
    cancellationRequests: cancellationsRes.data || [],
    refunds,
  };
}

async function reconciliationView(tenantId, query) {
  const bucket = query.bucket || 'all';
  let q = supabase
    .from('gocardless_payments')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('updated_at', { ascending: false })
    .limit(300);
  const filters = {
    awaiting_confirmation: (b) => b.in('status', ['pending_submission', 'submitted']),
    confirmed_not_paid_out: (b) => b.eq('status', 'confirmed').is('paid_out_at', null),
    paid_out: (b) => b.eq('status', 'paid_out'),
    failed: (b) => b.eq('status', 'failed'),
    charged_back: (b) => b.eq('status', 'charged_back'),
    refunded: (b) => b.not('refund_status', 'is', null),
    accounting_failed: (b) => b.eq('accounting_sync_status', 'failed'),
    chargeback_after_payout: (b) => b.eq('chargeback_reversed_after_payout', true),
  };
  if (filters[bucket]) q = filters[bucket](q);
  const { data: payments, error } = await q;
  if (error) throw new Error(error.message);
  const { data: payouts } = await supabase
    .from('gocardless_payouts')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(50);
  return { payments: payments || [], payouts: payouts || [] };
}

// CSV export of a reconciliation bucket (finance handoff).
async function exportReconciliationCsv(res, tenantId, query) {
  const { payments } = await reconciliationView(tenantId, query);
  const cols = [
    'gocardless_payment_id', 'status', 'charge_date', 'currency',
    'amount_minor', 'fee_minor', 'net_minor', 'amount_refunded_minor',
    'refund_status', 'confirmed_at', 'paid_out_at', 'gocardless_payout_id',
    'payout_reference', 'payout_date', 'accounting_provider',
    'accounting_invoice_number', 'accounting_sync_status', 'description',
  ];
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(',')];
  for (const p of payments) lines.push(cols.map((c) => esc(p[c])).join(','));
  const bucket = query.bucket || 'all';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="dd-reconciliation-${bucket}-${new Date().toISOString().slice(0, 10)}.csv"`);
  return res.status(200).send(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// POST actions

async function recordAdminAction(tenantId, { planId = null, agreementId = null, paymentId = null, action, actorEmail, details = {} }) {
  const { error } = await supabase.from('membership_dd_admin_actions').insert({
    tenant_id: tenantId,
    plan_id: planId,
    billing_agreement_id: agreementId,
    gocardless_payment_id: paymentId,
    action,
    actor_email: actorEmail,
    details,
  });
  if (error) console.error('[admin/gocardless-dd] audit insert failed:', error.message);
}

async function loadPlanForAction(tenantId, planId, res) {
  const { data: plan } = await supabase
    .from('membership_payment_plans')
    .select('*')
    .eq('id', planId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (!plan) { res.status(404).json({ error: 'Plan not found' }); return null; }
  let agreement = null;
  if (plan.billing_agreement_id) {
    const { data } = await supabase
      .from('membership_billing_agreements')
      .select('*')
      .eq('id', plan.billing_agreement_id)
      .maybeSingle();
    agreement = data;
  }
  return { plan, agreement };
}

async function handlePost(req, res, tenantId, actorEmail) {
  const { action, planId } = req.body || {};
  if (!action) return res.status(400).json({ error: 'action required' });

  if (action === 'note') {
    if (!planId || !req.body.note) return res.status(400).json({ error: 'planId and note required' });
    await recordAdminAction(tenantId, { planId, action: 'note', actorEmail, details: { note: req.body.note } });
    return res.json({ ok: true });
  }

  if (!planId) return res.status(400).json({ error: 'planId required' });
  const loaded = await loadPlanForAction(tenantId, planId, res);
  if (!loaded) return;
  const { plan, agreement } = loaded;
  const gc = await gocardlessForTenant(tenantId);

  switch (action) {
    case 'retry': {
      // Never-double-charge: the GC API must say the payment is 'failed'
      // before we retry, and the retry itself is idempotency-keyed so a
      // double-click can only ever produce one retry.
      const paymentId = req.body.paymentId || plan.last_payment_id;
      if (!paymentId) return res.status(400).json({ error: 'No failed payment to retry' });
      const current = await gc.getPayment(paymentId);
      try {
        assertRetryablePayment(current);
      } catch (err) {
        return res.status(409).json({ error: err.message, gcStatus: current?.status });
      }
      const retried = await gc.retryPayment(paymentId, { idempotencyKey: `dd-retry-${paymentId}` });
      await recordAdminAction(tenantId, { planId, agreementId: agreement?.id, paymentId, action: 'retry', actorEmail, details: { gcStatus: retried?.status } });
      if (agreement?.metadata?.dd?.kind === 'monthly_direct_debit') {
        await sendDdLifecycleEmail('retry_scheduled', agreement).catch(() => {});
      }
      return res.json({ ok: true, payment: retried });
    }

    case 'refund': {
      const { paymentId, amountMinor, reason } = req.body;
      if (!paymentId || !Number.isInteger(amountMinor) || amountMinor <= 0) {
        return res.status(400).json({ error: 'paymentId and positive integer amountMinor required' });
      }
      const { data: payRow } = await supabase
        .from('gocardless_payments')
        .select('*')
        .eq('gocardless_payment_id', paymentId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (!payRow) return res.status(404).json({ error: 'Payment not found' });
      if (!['confirmed', 'paid_out'].includes(payRow.status)) {
        return res.status(409).json({ error: `Payment status '${payRow.status}' is not refundable` });
      }
      const alreadyRefunded = payRow.amount_refunded_minor || 0;
      if (payRow.amount_minor && alreadyRefunded + amountMinor > payRow.amount_minor) {
        return res.status(409).json({ error: 'Refund would exceed the collected amount' });
      }
      // total_amount_confirmation guards against concurrent refunds server-side.
      const idempotencyKey = `dd-refund-${paymentId}-${alreadyRefunded + amountMinor}`;
      const refund = await gc.createRefund({
        paymentId,
        amountMinor,
        totalAmountConfirmationMinor: alreadyRefunded + amountMinor,
        metadata: { tenant: String(tenantId).slice(0, 50) },
        idempotencyKey,
      });
      await supabase.from('gocardless_refunds').upsert({
        tenant_id: tenantId,
        gocardless_refund_id: refund.id,
        gocardless_payment_id: paymentId,
        payment_row_id: payRow.id,
        amount_minor: amountMinor,
        currency: refund.currency || payRow.currency,
        status: refund.status || 'created',
        reason: reason || null,
        initiated_by: actorEmail,
        idempotency_key: idempotencyKey,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'gocardless_refund_id' });
      await recordAdminAction(tenantId, { planId, agreementId: agreement?.id, paymentId, action: 'refund', actorEmail, details: { amountMinor, reason: reason || null, refundId: refund.id } });
      return res.json({ ok: true, refund });
    }

    case 'cancel_subscription': {
      // Stops future collections; mandate stays usable for a new plan.
      if (plan.gocardless_subscription_id) {
        await gc.cancelSubscription(plan.gocardless_subscription_id);
      }
      const result = await applyStatusTransition({
        entityType: 'payment_plan',
        entityId: plan.id,
        toStatus: STATUS.PAYMENT_PLAN_CANCELLED,
        reason: `admin cancelled subscription${req.body.reason ? `: ${req.body.reason}` : ''}`,
        source: 'admin',
      });
      await recordAdminAction(tenantId, { planId, agreementId: agreement?.id, action: 'cancel_subscription', actorEmail, details: { reason: req.body.reason || null, result } });
      if (agreement?.metadata?.dd?.kind === 'monthly_direct_debit') {
        await sendDdLifecycleEmail('plan_cancelled', agreement).catch(() => {});
      }
      return res.json({ ok: true, result });
    }

    case 'cancel_mandate': {
      // Separate, more destructive action: kills the mandate itself.
      const mandateId = req.body.mandateId || plan.gocardless_mandate_id || agreement?.gocardless_mandate_id;
      if (!mandateId) return res.status(400).json({ error: 'No mandate on this plan' });
      await gc.cancelMandate(mandateId);
      // Local state is settled by the mandate-cancelled webhook (single
      // source of truth); just audit here.
      await recordAdminAction(tenantId, { planId, agreementId: agreement?.id, action: 'cancel_mandate', actorEmail, details: { mandateId, reason: req.body.reason || null } });
      return res.json({ ok: true });
    }

    case 'pause_subscription': {
      // Temporarily stops collections at GoCardless; the mandate and plan
      // stay intact and 'resume_subscription' restarts charging.
      if (!plan.gocardless_subscription_id) return res.status(400).json({ error: 'No subscription on this plan' });
      const paused = await gc.pauseSubscription(plan.gocardless_subscription_id, {
        pauseCycles: Number.isInteger(req.body.pauseCycles) ? req.body.pauseCycles : null,
      });
      await recordAdminAction(tenantId, { planId, agreementId: agreement?.id, action: 'pause_subscription', actorEmail, details: { reason: req.body.reason || null, pauseCycles: req.body.pauseCycles || null, gcStatus: paused?.status } });
      return res.json({ ok: true, subscription: paused });
    }

    case 'resume_subscription': {
      if (!plan.gocardless_subscription_id) return res.status(400).json({ error: 'No subscription on this plan' });
      const resumed = await gc.resumeSubscription(plan.gocardless_subscription_id);
      await recordAdminAction(tenantId, { planId, agreementId: agreement?.id, action: 'resume_subscription', actorEmail, details: { gcStatus: resumed?.status } });
      return res.json({ ok: true, subscription: resumed });
    }

    case 'reconcile': {
      // Refresh a payment row from GoCardless (status/fee drift) and re-run
      // the accounting posting if it previously failed or never ran.
      const paymentId = req.body.paymentId;
      if (!paymentId) return res.status(400).json({ error: 'paymentId required' });
      const { data: payRow } = await supabase
        .from('gocardless_payments')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('gocardless_payment_id', paymentId)
        .maybeSingle();
      if (!payRow) return res.status(404).json({ error: 'Payment not found' });
      const live = await gc.getPayment(paymentId);
      const patch = { updated_at: new Date().toISOString() };
      if (live?.status && live.status !== payRow.status) patch.status = live.status;
      if (live?.charge_date) patch.charge_date = live.charge_date;
      const { error: upErr } = await supabase
        .from('gocardless_payments').update(patch).eq('id', payRow.id);
      if (upErr) return res.status(500).json({ error: upErr.message });
      let accounting = null;
      if (agreement && payRow.accounting_sync_status !== 'posted') {
        accounting = await postDdInstalmentToAccounting({ agreement, paymentRow: { ...payRow, ...patch } })
          .catch((err) => ({ posted: false, error: err.message }));
      }
      await recordAdminAction(tenantId, { planId, agreementId: agreement?.id, paymentId, action: 'reconcile', actorEmail, details: { gcStatus: live?.status || null, statusChanged: !!patch.status, accounting } });
      return res.json({ ok: true, gcStatus: live?.status || null, statusChanged: !!patch.status, accounting });
    }

    case 'extend_grace': {
      const days = Number(req.body.days);
      if (!Number.isInteger(days) || days < 1 || days > 90) {
        return res.status(400).json({ error: 'days must be an integer 1-90' });
      }
      const base = plan.grace_expires_at ? new Date(plan.grace_expires_at) : computeGraceExpiry(new Date(), graceDaysForAgreement(agreement));
      const extended = new Date(base.getTime() + days * 86_400_000);
      const { error } = await supabase
        .from('membership_payment_plans')
        .update({
          grace_expires_at: extended.toISOString(),
          grace_extended_days: (plan.grace_extended_days || 0) + days,
          arrears_policy_applied: null,
          arrears_policy_applied_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', plan.id);
      if (error) return res.status(500).json({ error: error.message });
      await recordAdminAction(tenantId, { planId, agreementId: agreement?.id, action: 'extend_grace', actorEmail, details: { days, graceExpiresAt: extended.toISOString() } });
      return res.json({ ok: true, graceExpiresAt: extended.toISOString() });
    }

    case 'manual_resolve': {
      // Admin confirms payment was resolved outside GC (or accepts the loss):
      // plan returns to active, arrears bookkeeping cleared.
      const result = await applyStatusTransition({
        entityType: 'payment_plan',
        entityId: plan.id,
        toStatus: STATUS.ACTIVE,
        reason: `admin manual resolution${req.body.note ? `: ${req.body.note}` : ''}`,
        source: 'admin',
        extraUpdate: recoveryPlanUpdate(),
      });
      await recordAdminAction(tenantId, { planId, agreementId: agreement?.id, action: 'manual_resolve', actorEmail, details: { note: req.body.note || null, result } });
      return res.json({ ok: true, result });
    }

    case 'remind': {
      if (!agreement) return res.status(400).json({ error: 'No agreement on this plan' });
      const eventKey = plan.status === STATUS.PAYMENT_OVERDUE ? 'payment_overdue' : 'payment_failed';
      const sent = await sendDdLifecycleEmail(eventKey, agreement);
      await recordAdminAction(tenantId, { planId, agreementId: agreement.id, action: 'remind', actorEmail, details: { eventKey, sent: !!sent?.sent } });
      return res.json({ ok: true, sent });
    }

    case 'new_mandate_link': {
      // Replacement-mandate flow: issue a fresh single-use DD invitation for
      // the agreement's org billing contact (reuses Phase 3 plumbing). The
      // old plan/subscription is left untouched until the new mandate is
      // active — never a parallel charge.
      if (!agreement) return res.status(400).json({ error: 'No agreement on this plan' });
      let invitation = null;
      let setupUrl = null;
      if (agreement.organization_id) {
        // Org agreements: reuse the Phase 3 billing-contact invitation flow.
        const invitedEmail = req.body.invitedEmail
          || (await supabase.from('organization').select('invoicing_email, email').eq('id', agreement.organization_id).maybeSingle()).data?.invoicing_email
          || null;
        if (!invitedEmail) return res.status(400).json({ error: 'No billing contact email — pass invitedEmail' });
        invitation = await createInvitation({
          tenantId,
          organizationId: agreement.organization_id,
          billingAgreementId: agreement.id,
          invitedEmail,
        });
        const origin = req.headers.origin || (req.headers.host ? `https://${req.headers.host}` : '');
        setupUrl = `${origin}/dd-setup/${invitation.token}`;
      }
      await recordAdminAction(tenantId, { planId, agreementId: agreement.id, action: 'resend_link', actorEmail, details: { invitationId: invitation?.id || null, purpose: 'replacement_mandate' } });
      if (agreement.metadata?.dd?.kind === 'monthly_direct_debit') {
        await sendDdLifecycleEmail('new_mandate_required', agreement, { extraContext: { setupUrl } }).catch(() => {});
      }
      return res.json({ ok: true, invitation, setupUrl });
    }

    default:
      return res.status(400).json({ error: `Unknown action '${action}'` });
  }
}
