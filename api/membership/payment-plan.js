// GoCardless Phase 2 — member portal payment-plan view + basic admin list.
//
//   GET /api/membership/payment-plan?memberId=...   member's own DD plan
//   GET /api/membership/payment-plan?admin=1        tenant admin: all plans
//
// The admin list is RBAC-gated (tenant admin), not just tenant membership.

import { supabase } from '../_lib/database.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { getSessionMember } from '../_lib/session.js';

// The member view is authorized only for the member themself (session
// member matches memberId) or a tenant admin — never by memberId alone.
export async function authorizeMemberAccess(req, memberId) {
  try {
    const sessionMember = await getSessionMember(req);
    if (sessionMember?.id && String(sessionMember.id) === String(memberId)) {
      return { ok: true, via: 'self' };
    }
  } catch { /* fall through to admin check */ }
  try {
    const context = await getTenantContext(req);
    if (context?.tenantId && (await hasAdminAccess(context))) {
      return { ok: true, via: 'admin', tenantId: context.tenantId };
    }
  } catch { /* not an admin */ }
  return { ok: false };
}

export default async function handler(req, res) {
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    if (req.query.admin === '1') return handleAdminList(req, res);
    return handleMemberView(req, res);
  } catch (error) {
    console.error('[PaymentPlan] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

function shapePlan(plan) {
  const terms = plan.membership_billing_agreements?.metadata?.dd
    || plan.membership_billing_agreements?.metadata?.card || {};
  const arrears = Array.isArray(plan.membership_monthly_arrears_period)
    ? plan.membership_monthly_arrears_period.filter((p) => !p.settled_at) : [];
  const arrearsAmountMinor = arrears.reduce((sum, p) => sum + (Number(p.amount_minor) || 0), 0);
  const collectionPolicy = terms.monthly_post_grace_collection_policy || 'stop_collecting';
  const collectionStopped = !!plan.collection_stopped_at;
  const activeCatchUp = plan.metadata?.catch_up_intent?.status === 'created'
    ? plan.metadata.catch_up_intent : null;
  return {
    id: plan.id,
    status: plan.status,
    provider: plan.provider || 'gocardless',
    instalmentsPaid: plan.instalments_paid ?? null,
    membershipYear: plan.membership_year,
    monthlyAmount: plan.amount_minor != null ? plan.amount_minor / 100 : null,
    currency: plan.currency,
    dayOfMonth: plan.day_of_month,
    startDate: plan.start_date,
    nextChargeDate: plan.next_charge_date,
    instalmentsTotal: plan.instalments_total,
    lastPaymentStatus: plan.last_payment_status,
    lastPaymentAt: plan.last_payment_at,
    retryCount: plan.retry_count,
    arrearsCount: arrears.length,
    arrearsAmount: arrearsAmountMinor / 100,
    monthlyPostGraceCollectionPolicy: collectionPolicy,
    collectionStopped,
    nextPlannedCollectionAmount: !collectionStopped && collectionPolicy === 'continue_catch_up'
      ? ((Number(plan.amount_minor) || 0) + arrearsAmountMinor) / 100
      : (collectionStopped ? null : (plan.amount_minor != null ? plan.amount_minor / 100 : null)),
    nextPlannedCollectionDate: collectionStopped ? null
      : (activeCatchUp?.provider_charge_date || (arrears.length ? null : plan.next_charge_date)),
  };
}

// Task #3633 — per-instalment invoices for a monthly plan. GC instalments
// live on gocardless_payments (accounting_* columns); Stripe instalments on
// membership_instalment_invoices. Best-effort: table/column drift returns [].
async function loadInstalmentInvoices(shapedPlan) {
  try {
    if (shapedPlan.provider === 'stripe') {
      const { data, error } = await supabase
        .from('membership_instalment_invoices')
        .select('external_payment_id, amount_minor, currency, accounting_invoice_number, accounting_sync_status, accounting_sync_error, accounting_synced_at, created_at')
        .eq('plan_id', shapedPlan.id)
        .order('created_at', { ascending: true });
      if (error) return [];
      return (data || []).map((r) => ({
        paymentRef: r.external_payment_id,
        amount: r.amount_minor != null ? r.amount_minor / 100 : null,
        currency: r.currency,
        invoiceNumber: r.accounting_invoice_number,
        syncStatus: r.accounting_sync_status,
        syncError: r.accounting_sync_status === 'failed' ? r.accounting_sync_error : null,
        date: r.accounting_synced_at || r.created_at,
      }));
    }
    const { data, error } = await supabase
      .from('gocardless_payments')
      .select('gocardless_payment_id, amount_minor, charge_date, confirmed_at, status, accounting_invoice_number, accounting_sync_status, accounting_sync_error, accounting_synced_at')
      .eq('plan_id', shapedPlan.id)
      .in('status', ['confirmed', 'paid_out'])
      .order('charge_date', { ascending: true });
    if (error) return [];
    return (data || []).map((r) => ({
      paymentRef: r.gocardless_payment_id,
      amount: r.amount_minor != null ? r.amount_minor / 100 : null,
      currency: shapedPlan.currency,
      invoiceNumber: r.accounting_invoice_number,
      syncStatus: r.accounting_sync_status,
      syncError: r.accounting_sync_status === 'failed' ? r.accounting_sync_error : null,
      date: r.confirmed_at || r.charge_date,
    }));
  } catch {
    return [];
  }
}

async function handleMemberView(req, res) {
  const { memberId } = req.query;
  if (!memberId) return res.status(400).json({ error: 'memberId is required' });

  const auth = await authorizeMemberAccess(req, memberId);
  if (!auth.ok) return res.status(403).json({ error: 'Not authorized to view this payment plan' });

  let resolvedTenantId = null;
  try {
    const tenantData = await resolveTenantFromRequest(req);
    resolvedTenantId = tenantData?.id || null;
  } catch { /* member row is the fallback tenant source */ }

  const { data: member } = await supabase
    .from('member')
    .select('id, tenant_id')
    .eq('id', memberId)
    .maybeSingle();
  if (!member?.tenant_id) return res.status(404).json({ error: 'Member not found' });
  if (resolvedTenantId && member.tenant_id !== resolvedTenantId) {
    return res.status(403).json({ error: 'Member does not belong to this tenant' });
  }

  const { data: plans, error } = await supabase
    .from('membership_payment_plans')
    .select('*, membership_billing_agreements!billing_agreement_id(id, status, metadata), membership_monthly_arrears_period(due_period, amount_minor, settled_at)')
    .eq('tenant_id', member.tenant_id)
    .eq('member_id', member.id)
    .order('created_at', { ascending: false })
    .limit(3);
  if (error) return res.status(500).json({ error: 'Failed to load payment plan' });

  const shaped = (plans || []).map((plan) => ({
    ...shapePlan(plan),
    agreementStatus: plan.membership_billing_agreements?.status || null,
    terms: plan.membership_billing_agreements?.metadata?.dd
      || plan.membership_billing_agreements?.metadata?.card
      || null,
  }));

  // Task #3633: per-instalment invoicing mode — surface each collection's
  // own accounting invoice (number + sync status) on the plan.
  for (const plan of shaped) {
    if (plan.terms?.invoicing_mode === 'per_instalment') {
      plan.instalmentInvoices = await loadInstalmentInvoices(plan);
    }
  }

  // Count confirmed collections against the newest plan.
  let paymentsMade = 0;
  if (shaped[0]) {
    if (shaped[0].provider === 'stripe') {
      paymentsMade = shaped[0].instalmentsPaid || 0;
    } else {
      const { count } = await supabase
        .from('gocardless_payments')
        .select('id', { count: 'exact', head: true })
        .eq('plan_id', shaped[0].id)
        .in('status', ['confirmed', 'paid_out']);
      paymentsMade = count || 0;
    }
  }

  return res.json({ plans: shaped, currentPlan: shaped[0] || null, paymentsMade });
}

async function handleAdminList(req, res) {
  const context = await getTenantContext(req);
  if (!context?.tenantId || !(await hasAdminAccess(context))) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  // Both individual (member) and organisational plans.
  const { data: plans, error } = await supabase
    .from('membership_payment_plans')
    .select('*, member!member_id(id, first_name, last_name, email), organization!organization_id(id, name), membership_billing_agreements!billing_agreement_id(id, dd_payer, billing_contact_name, billing_contact_email, mandate_completed_by, metadata), membership_monthly_arrears_period(due_period, amount_minor, settled_at)')
    .eq('tenant_id', context.tenantId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) return res.status(500).json({ error: 'Failed to load payment plans' });

  return res.json({
    plans: (plans || []).map((plan) => ({
      ...shapePlan(plan),
      planType: plan.organization_id ? 'organization' : 'member',
      member: plan.member ? {
        id: plan.member.id,
        name: [plan.member.first_name, plan.member.last_name].filter(Boolean).join(' '),
        email: plan.member.email,
      } : null,
      organization: plan.organization ? {
        id: plan.organization.id,
        name: plan.organization.name,
      } : null,
      ddPayer: plan.membership_billing_agreements?.dd_payer || null,
      billingContact: plan.membership_billing_agreements?.billing_contact_email ? {
        name: plan.membership_billing_agreements.billing_contact_name || null,
        email: plan.membership_billing_agreements.billing_contact_email,
      } : null,
      mandateCompletedBy: plan.membership_billing_agreements?.mandate_completed_by || null,
    })),
  });
}
