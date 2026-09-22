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
//        new_mandate_link | manual_activate
//
// Auth: tenant admin (getTenantContext + hasAdminAccess) PLUS server-side
// feature RBAC: member-role admins must hold 'commerce.gocardless-dd' for any
// access, and 'commerce.monthly-finance-report' (finance) for refunds.
// Tenant-user dashboard sessions (no roleId) pass both. Refunds are also
// double-confirmed client-side.

import { supabase } from '../_lib/database.js';
import { loadMigratedMandatePresentation, migratedMandatePresentation } from '../_lib/migratedMandatePresentation.js';
import { directDebitCollectionPresentation, loadDirectDebitMembershipPresentations } from '../_lib/directDebitMembershipPresentation.js';
import { getTenantContext, hasAdminAccess, hasFeatureAccess } from '../_lib/tenantContext.js';
import { gocardlessForTenant } from '../_lib/gocardless.js';
import { applyStatusTransition, STATUS } from '../_lib/gocardlessState.js';
import {
  computeGraceExpiry,
  graceDaysForAgreement,
  recoveryPlanUpdate,
  clearAgreementArrearsFlag,
  restoreArrearsRoleAssignments,
} from '../_lib/gocardlessArrears.js';
import {
  retryPaymentSafely,
  closeAutomaticRetrySchedule,
  claimPlanForCancellation,
  releaseCancellationClaim,
  completeCancellationClaim,
} from '../_lib/gocardlessAutoRetry.js';
import { sendDdLifecycleEmail } from '../_lib/gocardlessDdEmails.js';
import { createInvitation } from '../_lib/gocardlessDdInvitations.js';
import { createMigrationInvite, migrationFunnelStage } from '../_lib/gocardlessDdMigration.js';
import { sendDdMigrationInviteEmail } from '../_lib/gocardlessDdEmails.js';
import { simulateMembershipForMember } from '../_lib/membershipSimulation.js';
import { resolveDdOffer } from '../_lib/gocardlessDirectDebit.js';
import { postDdInstalmentToAccounting } from '../_lib/gocardlessAccounting.js';
import { changeGoCardlessCollectionDay } from '../_lib/gocardlessCollectionScheduleChange.js';
import { filterConsoleRows, filterDirectDebitRows, readConsoleRows, paginateConsolePlans, lookupConsoleRows } from '../_lib/directDebitConsoleEligibility.js';
const consoleDatabase = supabase;

export default async function handler(req, res) {
  if (req.method === 'POST' && ['preview_collection_day', 'change_collection_day'].includes(req.body?.action)) {
    return handleCollectionDayAction(req, res);
  }
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
        return res.status(403).json({ error: 'This action requires finance permission' });
      }
      return await handlePost(req, res, tenantId, actorEmail);
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[admin/gocardless-dd] error:', err);
    return res.status(err.statusCode === 400 ? 400 : 500).json({ error: err.message || 'Internal server error' });
  }
}

// This is the actual route used by collection-day requests. Dependencies are
// injectable for authorization/tenant-boundary tests without real credentials.
export async function handleCollectionDayAction(req, res, {
  db = supabase, getContext = getTenantContext, adminAccess = hasAdminAccess,
  featureAccess = hasFeatureAccess, gc,
} = {}) {
  if (!db) return res.status(503).json({ error: 'Database not configured' });
  if (req.method !== 'POST' || !['preview_collection_day', 'change_collection_day'].includes(req.body?.action)) {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  let context;
  try { context = await getContext(req); } catch {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  if (!context?.tenantId || !(await adminAccess(context))) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  if (context.roleId && (!(await featureAccess(context.roleId, 'commerce.gocardless-dd'))
    || !(await featureAccess(context.roleId, 'commerce.monthly-finance-report')))) {
    return res.status(403).json({ error: 'Direct Debit and finance permissions are required' });
  }
  if (!req.body.planId) return res.status(400).json({ error: 'planId required' });
  try {
    const { data: plan, error } = await db.from('membership_payment_plans').select('*')
      .eq('tenant_id', context.tenantId).eq('id', req.body.planId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    if (!(await filterDirectDebitRows(db, context.tenantId, [plan], { plans: true })).length) return res.status(404).json({ error: 'Plan not found' });
    const result = await db.from('membership_billing_agreements').select('*')
      .eq('tenant_id', context.tenantId).eq('id', plan.billing_agreement_id).maybeSingle();
    if (result.error) throw new Error(result.error.message);
    return res.json(await changeGoCardlessCollectionDay({
      db, tenantId: context.tenantId, agreement: result.data, plan,
      actorEmail: context.member?.email || context.email || null, body: req.body, gc,
    }));
  } catch (error) {
    return res.status(409).json({ error: error.message });
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
  if (view === 'migration') return res.json(await consoleMigrationFunnel(tenantId));
  if (view === 'renewals') return res.json(await listRenewals(tenantId, req.query));
  return res.status(400).json({ error: `Unknown view '${view}'` });
}

// Phase 5 — renewal ledger view (membership_dd_renewals rows + member names).
async function visibleMigrationInvite(tenantId, inviteId) {
  const { data, error } = await supabase.from('membership_dd_migration_invites')
    .select('*').eq('tenant_id', tenantId).eq('id', inviteId).maybeSingle();
  if (error) throw new Error(error.message);
  return data && (await filterConsoleRows(supabase, tenantId, [data])).length > 0;
}

async function consoleMigrationFunnel(tenantId) {
  const rows = await filterConsoleRows(supabase, tenantId, await readConsoleRows(() =>
    supabase.from('membership_dd_migration_invites').select('*').eq('tenant_id', tenantId)
      .order('created_at', { ascending: false }).order('id')));
  const agreements = await lookupConsoleRows(supabase, tenantId, 'membership_billing_agreements', rows.map(r => r.billing_agreement_id));
  const members = await lookupConsoleRows(supabase, tenantId, 'member', rows.map(r => r.member_id));
  const plans = await filterDirectDebitRows(supabase, tenantId, await readConsoleRows(() =>
    supabase.from('membership_payment_plans').select('*').eq('tenant_id', tenantId).order('id')), { plans: true });
  const byAgreement = new Map(plans.map(p => [p.billing_agreement_id, p]));
  const counts = Object.fromEntries(['invited', 'accepted', 'mandate_active', 'subscription_active', 'declined', 'expired', 'revoked', 'superseded', 'failed'].map(k => [k, 0]));
  const invites = rows.map(row => {
    const agreement = agreements.get(row.billing_agreement_id);
    const plan = byAgreement.get(row.billing_agreement_id);
    const member = members.get(row.member_id);
    const stage = migrationFunnelStage(row, { agreement, plan });
    if (stage in counts) counts[stage]++;
    return { ...row, token: undefined, stage, memberName: member ? `${member.first_name || ''} ${member.last_name || ''}`.trim() : null,
      memberEmail: member?.email || null, hasMandate: !!agreement?.gocardless_mandate_id, planStatus: plan?.status || null };
  });
  return { counts, invites };
}

async function listRenewals(tenantId, query = {}) {
  const renewals = await readConsoleRows(() => {
    let q = supabase
    .from('membership_dd_renewals')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false }).order('id');
  if (query.status) q = q.eq('status', query.status);
    return q;
  });
  const rows = await filterConsoleRows(supabase, tenantId, renewals);
  const memberIds = [...new Set(rows.map((r) => r.member_id).filter(Boolean))];
  const membersById = await lookupConsoleRows(supabase, tenantId, 'member', memberIds);
  // Task #3621 — the ledger holds both DD and monthly-card renewals; the
  // previous agreement's provider tells them apart.
  const prevAgreementIds = [...new Set(rows.map((r) => r.previous_agreement_id).filter(Boolean))];
  const prevAgreements = await lookupConsoleRows(supabase, tenantId, 'membership_billing_agreements', prevAgreementIds);
  const providerByAgreement = new Map([...prevAgreements.values()].map(a => [a.id, a.provider || 'gocardless']));
  return {
    renewals: rows.map((r) => {
      const m = membersById.get(r.member_id);
      return {
        ...r,
        provider: providerByAgreement.get(r.previous_agreement_id) || 'gocardless',
        memberName: m ? `${m.first_name || ''} ${m.last_name || ''}`.trim() : null,
        memberEmail: m?.email || null,
      };
    }),
  };
}

export async function buildSummary(tenantId, { db: supabase = consoleDatabase } = {}) {
  const plans = await filterDirectDebitRows(supabase, tenantId, await readConsoleRows(() => supabase
    .from('membership_payment_plans')
    .select('*')
    .eq('tenant_id', tenantId).order('id')), { plans: true });
  const byStatus = {};
  const presentations = await loadDirectDebitMembershipPresentations(supabase, tenantId, plans);
  const byDisplayStatus = {};
  const attention = [];
  const now = Date.now();
  for (const p of plans || []) {
    byStatus[p.status] = (byStatus[p.status] || 0) + 1;
    const displayStatus = presentations.get(p.id).displayStatus;
    byDisplayStatus[displayStatus] = (byDisplayStatus[displayStatus] || 0) + 1;
    if (p.status === STATUS.PAYMENT_GRACE_PERIOD || p.status === STATUS.PAYMENT_OVERDUE) {
      attention.push({
        ...p,
        grace_expired: p.grace_expires_at ? new Date(p.grace_expires_at).getTime() <= now : false,
      });
    }
  }
  const visibleCount = async (makeQuery) => (await filterDirectDebitRows(supabase, tenantId, await readConsoleRows(makeQuery))).length;
  const pendingCancellations = await visibleCount(() => supabase
    .from('membership_dd_cancellation_requests')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('status', 'pending').order('id'));
  const failedAccounting = await visibleCount(() => supabase
    .from('gocardless_payments')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('accounting_sync_status', 'failed').order('id'));
  const chargebacksAfterPayout = await visibleCount(() => supabase
    .from('gocardless_payments')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('chargeback_reversed_after_payout', true).order('id'));
  return {
    byStatus,
    byDisplayStatus,
    currentMembers: byDisplayStatus.current || 0,
    currentPlans: byDisplayStatus.current || 0,
    attention,
    pendingCancellations: pendingCancellations || 0,
    failedAccounting: failedAccounting || 0,
    chargebacksAfterPayout: chargebacksAfterPayout || 0,
    pendingActivations: [...presentations.values()].filter(p => p.pendingActivation).length,
  };
}

export async function listPlans(tenantId, query = {}, db = supabase) {
  paginateConsolePlans([], query); // Reject invalid paging before database work.
  const rawPlans = await readConsoleRows(() => {
    let q = db
    .from('membership_payment_plans')
    .select('*, membership_billing_agreements!membership_payment_plans_billing_agreement_id_fkey(id, member_id, organization_id, status, metadata)')
    .eq('tenant_id', tenantId)
    .order('updated_at', { ascending: false }).order('id');
  if (query.status && !['all', 'current', 'pending_activation'].includes(query.status)) q = q.eq('status', query.status);
    return q;
  });
  const plans = await filterDirectDebitRows(db, tenantId, rawPlans, { plans: true });
  const presentations = await loadDirectDebitMembershipPresentations(db, tenantId, plans);

  // Resolve display names (member/org) in bulk.
  const memberIds = [...new Set((plans || []).map((p) => p.membership_billing_agreements?.member_id || p.member_id).filter(Boolean))];
  const orgIds = [...new Set((plans || []).map((p) => p.membership_billing_agreements?.organization_id || p.organization_id).filter(Boolean))];
  const [memberMap, orgMap] = await Promise.all([
    lookupConsoleRows(db, tenantId, 'member', memberIds),
    lookupConsoleRows(db, tenantId, 'organization', orgIds),
  ]);
  const [memberHistory, organisationHistory] = await Promise.all([
    readConsoleRows(() => db.from('member_membership_history').select('id, billing_agreement_id, status')
      .eq('tenant_id', tenantId).order('id')),
    readConsoleRows(() => db.from('organisation_membership_history').select('id, billing_agreement_id, status')
      .eq('tenant_id', tenantId).order('id')),
  ]);
  const activationByAgreement = new Map(
    [...memberHistory, ...organisationHistory]
      .filter((h) => h.billing_agreement_id)
      .map((h) => [h.billing_agreement_id, h.status]),
  );

  let rows = plans.map((p) => {
    const ag = p.membership_billing_agreements;
    const member = memberMap.get(ag?.member_id || p.member_id);
    const org = orgMap.get(ag?.organization_id || p.organization_id);
    return {
      ...p,
      membershipPresentation: presentations.get(p.id),
      collectionPresentation: directDebitCollectionPresentation(p),
      mandatePresentation: migratedMandatePresentation(p),
      membership_billing_agreements: undefined,
      agreement: ag ? { id: ag.id, status: ag.status, member_id: ag.member_id, organization_id: ag.organization_id, dd: ag.metadata?.dd || null } : null,
      activation_status: activationByAgreement.get(ag?.id) || null,
      activation_pending: presentations.get(p.id).pendingActivation,
      payer_name: org?.name || (member ? `${member.first_name || ''} ${member.last_name || ''}`.trim() : null),
      payer_email: member?.email || null,
    };
  });
  if (query.status === 'pending_activation') {
    rows = rows.filter((r) => r.activation_pending);
  }
  if (query.status === 'current') rows = rows.filter(r => r.membershipPresentation.displayStatus === 'current');
  // Legacy status remains the raw financial filter. The console explicitly
  // opts into presentation filtering; both filters run before pagination.
  if (query.displayStatus && query.displayStatus !== 'all') {
    rows = rows.filter(r => query.displayStatus === 'pending_activation'
      ? r.activation_pending : r.membershipPresentation.displayStatus === query.displayStatus);
  }
  const qText = (query.q || '').toLowerCase().trim();
  if (qText) {
    rows = rows.filter((r) =>
      (r.payer_name || '').toLowerCase().includes(qText) ||
      (r.payer_email || '').toLowerCase().includes(qText) ||
      (r.gocardless_subscription_id || '').toLowerCase().includes(qText));
  }
  const result = paginateConsolePlans(rows, query);
  const originals = new Map(plans.map(p => [p.id, p]));
  // Evidence is presentation only; fetch it after eligibility/search/paging.
  for (let offset = 0; offset < result.plans.length; offset += 10) {
    const batch = await Promise.all(result.plans.slice(offset, offset + 10).map(async row => ({
      ...row,
      mandatePresentation: migratedMandatePresentation(await loadMigratedMandatePresentation(db, originals.get(row.id))),
    })));
    result.plans.splice(offset, batch.length, ...batch);
  }
  return result;
}

export async function planDetail(tenantId, planId, res, { db: supabase = consoleDatabase } = {}) {
  if (!planId) { res.status(400); return { error: 'planId required' }; }
  const { data: plan, error } = await supabase
    .from('membership_payment_plans')
    .select('*')
    .eq('id', planId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!plan) { res.status(404); return { error: 'Plan not found' }; }
  if (!(await filterDirectDebitRows(supabase, tenantId, [plan], { plans: true })).length) { res.status(404); return { error: 'Plan not found' }; }

  const agreement = (await lookupConsoleRows(supabase, tenantId, 'membership_billing_agreements', [plan.billing_agreement_id])).get(plan.billing_agreement_id) || null;
  const presentations = await loadDirectDebitMembershipPresentations(supabase, tenantId, [plan]);
  const membershipHistoryTable = agreement?.member_id
    ? 'member_membership_history'
    : (agreement?.organization_id ? 'organisation_membership_history' : null);
  const membershipActivationPromise = membershipHistoryTable
    ? supabase.from(membershipHistoryTable).select('id, status, payment_status')
      .eq('tenant_id', tenantId).eq('billing_agreement_id', agreement.id).maybeSingle()
    : Promise.resolve({ data: null });

  const [paymentsRes, historyRes, actionsRes, cancellationsRes, retryAttemptsRes, membershipActivationRes] = await Promise.all([
    supabase.from('gocardless_payments').select('*').eq('tenant_id', tenantId).eq('plan_id', plan.id).order('created_at', { ascending: false }).limit(100),
    supabase.from('membership_payment_status_history').select('*').eq('tenant_id', tenantId).eq('entity_id', plan.id).order('created_at', { ascending: false }).limit(100),
    supabase.from('membership_dd_admin_actions').select('*').eq('tenant_id', tenantId).eq('plan_id', plan.id).order('created_at', { ascending: false }).limit(100),
    supabase.from('membership_dd_cancellation_requests').select('*').eq('tenant_id', tenantId).eq('plan_id', plan.id).order('created_at', { ascending: false }).limit(20),
    supabase.from('gocardless_payment_retry_attempts').select('*').eq('plan_id', plan.id).eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(100),
    membershipActivationPromise,
  ]);
  for (const result of [paymentsRes, historyRes, actionsRes, cancellationsRes, retryAttemptsRes, membershipActivationRes]) {
    if (result.error) throw new Error(`Plan detail lookup failed: ${result.error.message}`);
  }
  const payments = await filterDirectDebitRows(supabase, tenantId, paymentsRes.data || []);
  const cancellationRequests = await filterDirectDebitRows(supabase, tenantId, cancellationsRes.data || []);
  const paymentIds = payments.map((p) => p.gocardless_payment_id).filter(Boolean);
  let refunds = [];
  if (paymentIds.length) {
    const { data, error } = await supabase.from('gocardless_refunds').select('*').eq('tenant_id', tenantId).in('gocardless_payment_id', paymentIds).order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    refunds = data || [];
  }

  return {
    plan: {
      ...plan,
      membershipPresentation: presentations.get(plan.id),
      collectionPresentation: directDebitCollectionPresentation(plan),
      mandatePresentation: migratedMandatePresentation(await loadMigratedMandatePresentation(supabase, {
        ...plan, membership_billing_agreements: agreement,
      })),
    },
    agreement,
    payments,
    statusHistory: historyRes.data || [],
    adminActions: actionsRes.data || [],
    cancellationRequests,
    retryAttempts: retryAttemptsRes.data || [],
    membershipActivation: membershipActivationRes.data || null,
    refunds,
  };
}

async function reconciliationView(tenantId, query) {
  const bucket = query.bucket || 'all';
  const rawPayments = await readConsoleRows(() => {
    let q = supabase
    .from('gocardless_payments')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('updated_at', { ascending: false }).order('id');
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
    return q;
  });
  const payments = await filterDirectDebitRows(supabase, tenantId, rawPayments);
  const { data: payouts, error: payoutError } = await supabase
    .from('gocardless_payouts')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (payoutError) throw new Error(payoutError.message);
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

async function loadPlanForAction(tenantId, planId, res, db = supabase) {
  const { data: plan, error } = await db
    .from('membership_payment_plans')
    .select('*')
    .eq('id', planId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!plan) { res.status(404).json({ error: 'Plan not found' }); return null; }
  if (!(await filterDirectDebitRows(db, tenantId, [plan], { plans: true })).length) { res.status(404).json({ error: 'Plan not found' }); return null; }
  let agreement = null;
  if (plan.billing_agreement_id) {
    const { data, error: agreementError } = await db
      .from('membership_billing_agreements')
      .select('*')
      .eq('id', plan.billing_agreement_id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (agreementError) throw new Error(agreementError.message);
    agreement = data;
  }
  return { plan, agreement };
}

export async function handlePost(req, res, tenantId, actorEmail, { db: supabase = consoleDatabase, getProvider = gocardlessForTenant } = {}) {
  const db = supabase;
  const { action, planId } = req.body || {};
  if (!action) return res.status(400).json({ error: 'action required' });

  if (action === 'note') {
    if (!planId || !req.body.note) return res.status(400).json({ error: 'planId and note required' });
    if (!(await loadPlanForAction(tenantId, planId, res, db))) return;
    await recordAdminAction(tenantId, { planId, action: 'note', actorEmail, details: { note: req.body.note } });
    return res.json({ ok: true });
  }

  // ---- Phase 5: migration actions (no planId — keyed by member/invite) ----
  if (action === 'migration_invite') {
    const memberId = req.body.memberId;
    if (!memberId) return res.status(400).json({ error: 'memberId required' });
    const { data: member } = await supabase
      .from('member')
      .select('id, first_name, last_name, email, tenant_id')
      .eq('id', memberId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (!member) return res.status(404).json({ error: 'Member not found' });
    if (!(await filterConsoleRows(supabase, tenantId, [{ member_id: member.id }])).length) return res.status(404).json({ error: 'Member not found' });
    if (!member.email) return res.status(400).json({ error: 'Member has no email address' });

    // Eligibility: tier must have DD enabled + migration opted in, and an
    // offer must exist for the switch year (defaults to the NEXT membership
    // year via source 'simulate' — the current paid year is never touched).
    const simResult = await simulateMembershipForMember(tenantId, member.id, {
      source: 'simulate',
      mode: 'manual',
      targetYear: req.body.switchFromYear || null,
    });
    if (!simResult?.success) {
      return res.status(400).json({ error: simResult?.error || 'Could not calculate membership fees for this member' });
    }
    if (simResult.config?.dd_migration_enabled !== true) {
      return res.status(400).json({ error: 'Direct Debit migration is not enabled for this member\'s tier' });
    }
    const offer = resolveDdOffer(simResult);
    if (!offer) return res.status(400).json({ error: 'Monthly Direct Debit is not available for this membership' });

    const switchFromYear = simResult.membershipYear?.label;
    if (!switchFromYear) return res.status(400).json({ error: 'Could not resolve the membership year to switch from' });

    // Already paying by DD for that year? Nothing to migrate.
    const { data: existingHistory } = await supabase
      .from('member_membership_history')
      .select('id, payment_method')
      .eq('tenant_id', tenantId)
      .eq('member_id', member.id)
      .eq('membership_year', switchFromYear)
      .maybeSingle();
    if (existingHistory?.payment_method === 'direct_debit') {
      return res.status(400).json({ error: `This member is already on Direct Debit for ${switchFromYear}` });
    }
    // Task #3620: a monthly card plan for the year also blocks DD migration.
    if (existingHistory?.payment_method === 'card_monthly') {
      return res.status(400).json({ error: `This member is already on a monthly card plan for ${switchFromYear}` });
    }

    const invite = await createMigrationInvite({
      tenantId,
      memberId: member.id,
      invitedEmail: member.email,
      invitedBy: actorEmail,
      switchFromYear,
    });
    const origin = req.headers.origin || (req.headers.host ? `https://${req.headers.host}` : '');
    const setupUrl = `${origin}/dd-migrate/${invite.token}`;
    const emailResult = await sendDdMigrationInviteEmail({ tenantId, member, invite, offer, setupUrl });
    await recordAdminAction(tenantId, {
      action: 'migration_invite', actorEmail,
      details: { inviteId: invite.id, memberId: member.id, switchFromYear, emailSent: !!emailResult.sent },
    });
    return res.json({ ok: true, invite: { ...invite, token: undefined }, emailSent: !!emailResult.sent, emailError: emailResult.sent ? null : emailResult.reason });
  }

  if (action === 'migration_revoke') {
    const inviteId = req.body.inviteId;
    if (!inviteId) return res.status(400).json({ error: 'inviteId required' });
    if (!(await visibleMigrationInvite(tenantId, inviteId))) return res.status(404).json({ error: 'Invitation not found' });
    const { data: revoked, error: revokeErr } = await supabase
      .from('membership_dd_migration_invites')
      .update({ status: 'revoked', updated_at: new Date().toISOString() })
      .eq('id', inviteId)
      .eq('tenant_id', tenantId)
      .eq('status', 'invited')
      .select()
      .maybeSingle();
    if (revokeErr) return res.status(500).json({ error: 'Failed to revoke invitation' });
    if (!revoked) return res.status(409).json({ error: 'Invitation is not live (already used, expired, or revoked)' });
    await recordAdminAction(tenantId, { action: 'migration_revoke', actorEmail, details: { inviteId } });
    return res.json({ ok: true });
  }

  if (action === 'migration_note') {
    const { inviteId, note } = req.body;
    if (!inviteId || !note) return res.status(400).json({ error: 'inviteId and note required' });
    if (!(await visibleMigrationInvite(tenantId, inviteId))) return res.status(404).json({ error: 'Invitation not found' });
    await recordAdminAction(tenantId, { action: 'migration_note', actorEmail, details: { inviteId, note } });
    return res.json({ ok: true });
  }

  if (!planId) return res.status(400).json({ error: 'planId required' });
  const loaded = await loadPlanForAction(tenantId, planId, res, db);
  if (!loaded) return;
  const { plan, agreement } = loaded;
  if (action === 'manual_activate') {
    if (!agreement) return res.status(400).json({ error: 'No billing agreement on this plan' });
    const { data: result, error } = await supabase.rpc('approve_manual_dd_membership_activation', {
      p_tenant_id: tenantId,
      p_plan_id: planId,
      p_actor_email: actorEmail,
    });
    if (error) throw new Error(`manual membership activation failed: ${error.message}`);
    if (!result?.ok) {
      const status = result?.reason === 'not_found' ? 404 : 409;
      return res.status(status).json({ error: result?.detail || 'Membership cannot be activated', result });
    }
    return res.json({ ok: true, result });
  }
  const gc = await getProvider(tenantId);

  switch (action) {
    case 'retry': {
      const paymentId = req.body.paymentId || plan.last_payment_id;
      if (!paymentId) return res.status(400).json({ error: 'No failed payment to retry' });
      const retry = await retryPaymentSafely({
        tenantId, plan, agreement, paymentId, mode: 'manual', actor: actorEmail, gc,
      });
      if (!retry.ok) {
        return res.status(409).json({
          error: retry.error || `Payment cannot be retried (${retry.reason})`,
          reason: retry.reason,
          gcStatus: retry.gcStatus,
        });
      }
      const retried = retry.payment;
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
      if (payRow.plan_id !== plan.id || !(await filterDirectDebitRows(supabase, tenantId, [payRow])).length) return res.status(404).json({ error: 'Payment not found' });
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
      const cancellationClaim = await claimPlanForCancellation(plan, { actor: actorEmail || 'admin' });
      if (!cancellationClaim) return res.status(409).json({ error: 'A payment retry is currently in progress; try cancelling again shortly' });
      let providerAccepted = !plan.gocardless_subscription_id;
      let result;
      try {
        if (plan.gocardless_subscription_id) {
          await gc.cancelSubscription(plan.gocardless_subscription_id);
          providerAccepted = true;
        }
        result = await applyStatusTransition({
          entityType: 'payment_plan',
          entityId: plan.id,
          toStatus: STATUS.PAYMENT_PLAN_CANCELLED,
          reason: `admin cancelled subscription${req.body.reason ? `: ${req.body.reason}` : ''}`,
          source: 'admin',
        });
        await closeAutomaticRetrySchedule(plan, 'cancelled');
        await completeCancellationClaim(plan, cancellationClaim);
      } catch (error) {
        if (!providerAccepted) await releaseCancellationClaim(plan, cancellationClaim);
        throw error;
      }
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
      const cancellationClaim = await claimPlanForCancellation(plan, { actor: actorEmail || 'admin' });
      if (!cancellationClaim) return res.status(409).json({ error: 'A payment retry is currently in progress; try cancelling again shortly' });
      try {
        await gc.cancelMandate(mandateId);
      } catch (error) {
        await releaseCancellationClaim(plan, cancellationClaim);
        throw error;
      }
      // Local state is settled by the mandate-cancelled webhook (single
      // source of truth). Keep the cancellation claim until that terminal
      // webhook arrives so no retry can start while provider state propagates.
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
      if (payRow.plan_id !== plan.id || !(await filterDirectDebitRows(supabase, tenantId, [payRow])).length) return res.status(404).json({ error: 'Payment not found' });
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
      // Extending grace withdraws any role restriction already applied. Do
      // this before clearing policy state so a transient failure is retryable.
      const roleRecovery = await restoreArrearsRoleAssignments({
        plan,
        agreement,
        db: supabase,
      });
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
      if (agreement?.metadata?.dd?.arrears_state) {
        await clearAgreementArrearsFlag(agreement);
      }
      await recordAdminAction(tenantId, { planId, agreementId: agreement?.id, action: 'extend_grace', actorEmail, details: { days, graceExpiresAt: extended.toISOString(), roleRecovery } });
      return res.json({ ok: true, graceExpiresAt: extended.toISOString(), roleRecovery });
    }

    case 'manual_resolve': {
      // Admin confirms payment was resolved outside GC (or accepts the loss):
      // plan returns to active, arrears bookkeeping cleared.
      const roleRecovery = await restoreArrearsRoleAssignments({
        plan,
        agreement,
        db: supabase,
      });
      await closeAutomaticRetrySchedule(plan, 'manually_resolved');
      const result = await applyStatusTransition({
        entityType: 'payment_plan',
        entityId: plan.id,
        toStatus: STATUS.ACTIVE,
        reason: `admin manual resolution${req.body.note ? `: ${req.body.note}` : ''}`,
        source: 'admin',
        extraUpdate: recoveryPlanUpdate(),
      });
      if (agreement?.metadata?.dd?.arrears_state) {
        await clearAgreementArrearsFlag(agreement);
      }
      if (agreement && result.applied) {
        await sendDdLifecycleEmail('payment_recovered', agreement);
      }
      await recordAdminAction(tenantId, { planId, agreementId: agreement?.id, action: 'manual_resolve', actorEmail, details: { note: req.body.note || null, result, roleRecovery } });
      return res.json({ ok: true, result, roleRecovery });
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
