// Owner processing uses injected read and effect capabilities only. The same
// entries are used by the scheduled workers; preview never simulates a claim.
import { processTenantAnnualExpirySweep } from './annualMembershipExpiryEnforcement.js';
import { createMembershipReminders } from './membershipReminders.js';
import { createMembershipSimulator } from './membershipSimulationCore.js';
import { loadApprovedAddonLines, computeAddonTotals, buildAddonDisplayLines, readPausedOwners } from './membershipOwnerReadHelpers.js';
import { replacePlaceholders } from './emailPlaceholderCore.js';
import { readStripeCredentials } from './stripeCredentialReadCore.js';
export { runOwnerAnnualRenewals } from './annualOwnerRenewalPipeline.js';

function ownerReminders(context) {
  const { db, plan, agreement, now, effects, trace } = context;
  const memberId = agreement.member_id || plan.member_id;
  return createMembershipReminders({
    db, ...createMembershipSimulator(db, () => now), now, effects, trace,
    owner: { member_id: memberId, organization_id: memberId ? null : agreement.organization_id || plan.organization_id },
    replacePlaceholders,
    getPausedMemberIdSet: (tenantId, client = db, ids = null) => readPausedOwners(client, tenantId, ids),
    loadAddonLines: (...args) => loadApprovedAddonLines(db, ...args),
    computeAddonTotals, buildAddonDisplayLines,
    getStripeCredentials: context.getStripeCredentials
      || ((tenantId, feature) => readStripeCredentials(db, tenantId, feature, { encryptionKey: context.stripeEncryptionKey })),
  });
}
export async function runOwnerPaymentLinkReminders(context) {
  const results = { details: [] };
  await ownerReminders(context).processPaymentLinkReminders(context.plan.tenant_id, results, new Date(`${context.now.toISOString().slice(0, 10)}T00:00:00Z`));
  for (const detail of results.details) context.trace({ stage: 'payment-link-reminders', status: detail.status, reason: detail.reason || detail.code });
  context.trace({ stage: 'payment-link-reminders', status: 'skipped', reason: 'Finished selected-owner payment-link reminder evaluation without a pending effect.' });
}
export async function runOwnerRollingReminders(context) {
  await ownerReminders(context).processRollingReminders(context.plan.tenant_id, { details: [] }, new Date(`${context.now.toISOString().slice(0, 10)}T00:00:00Z`));
  context.trace({ stage: 'rolling-reminders', status: 'skipped', reason: 'Finished selected-owner rolling reminder evaluation without a pending effect.' });
}
export async function runOwnerReminders(context) {
  // The three reminder streams are exposed independently to the coordinator.
  await ownerReminders(context).processFixedReminders(context.plan.tenant_id, { details: [] });
  context.trace({ stage: 'fixed-reminders', status: 'skipped', reason: 'Finished selected-owner fixed-cycle reminder evaluation without a pending effect.' });
}

export async function runOwnerExpiry({ db, plan, agreement, now, effects, trace }) {
  const owner = { member_id: agreement.member_id || plan.member_id,
    organization_id: agreement.organization_id || plan.organization_id };
  const result = await processTenantAnnualExpirySweep(db, plan.tenant_id, null, now, { owner, effects, trace });
  if (!result.examined) trace({ stage: 'annual-expiry', status: 'skipped', reason: 'No owner membership history remains eligible for expiry evaluation.' });
  return result;
}

export function isRestartDue(member, now = new Date()) {
  if (member?.membership_paused !== true || !member.membership_pause_restart_date) return false;
  const restart = new Date(`${String(member.membership_pause_restart_date).slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(restart.getTime()) && now.getTime() >= restart.getTime();
}

export function selectScheduledActivations(db, tenantId, scope, now) {
  const table = scope === 'member' ? 'member_membership_history' : 'organisation_membership_history';
  const date = new Date(now);
  if (scope !== 'member') date.setHours(0, 0, 0, 0);
  return db.from(table).select('*').eq('tenant_id', tenantId)
    .eq('status', 'scheduled').lte('scheduled_activation_date', date.toISOString().slice(0, 10));
}

export async function runScheduledActivation({ row, tenantId, scope, now, effects, trace = () => {} }) {
  const stage = `${scope}-scheduled-activation`;
  const memberScope = scope === 'member';
  const table = memberScope ? 'member_membership_history' : 'organisation_membership_history';
  const skip = reason => { trace({ stage, status: 'skipped', reason }); return { skipped: true, reason }; };
  const total = row.total_with_vat ?? row.final_cost;
  const zeroDue = total != null && Number.isFinite(Number(total)) && Math.round(Number(total) * 100) === 0;
  const invoiceLessZeroDue = !row.xero_invoice_id && !row.accounting_invoice_id
    && row.payment_status === 'paid' && zeroDue;
  if (memberScope) {
    const paid = row.payment_status === 'paid' || !!row.paid_at || Number(total ?? 0) <= 0;
    if (!paid) return skip(`Scheduled membership for ${row.membership_year} is not paid — not activated`);
  } else {
    if (invoiceLessZeroDue) {
      await effects.perform({
        type: 'owner.zero_due_workflow', stage,
        description: 'Retry durable paid workflow delivery for the zero-due scheduled membership before activation.',
        conditional: 'Activation depends on successful durable workflow delivery.',
        payload: { table, row, paidAt: row.paid_at, source: 'cron_org_membership_zero_due' },
      });
    }
    if (!row.xero_invoice_id && !row.accounting_invoice_id && !invoiceLessZeroDue) {
      return skip(`Scheduled membership for ${row.membership_year} has no linked invoice — not activated (needs attention)`);
    }
  }
  const values = { status: 'active', ...(memberScope ? { annual_renewal_state: 'renewed' } : {}), updated_at: now.toISOString() };
  const result = await effects.perform({
    type: 'owner.activate_scheduled', stage,
    description: `Activate scheduled ${scope} membership ${row.membership_year}; no new invoice.`,
    date: row.scheduled_activation_date,
    conditional: 'The still-scheduled compare-and-set must succeed; concurrent activation may make this a no-op.',
    payload: { table, id: row.id, tenantId, values },
  });
  if (result.error) throw new Error(result.error.message);
  if (!result.data?.length) return { raced: true };
  if (!memberScope) await effects.perform({
    type: 'owner.activation_note', stage, description: 'Record successful scheduled membership activation.',
    payload: {
      organization_id: row.organization_id, member_id: null,
      content: `[Membership Renewal - Scheduled Activation] Advance-invoiced membership for ${row.membership_year} activated on its start date. No new invoice was generated.`,
      attachments: [],
    },
  });
  return { activated: true };
}

export async function prepareOwnerResume({ db, tenantId, memberId, effects, auto = false, now = new Date(), trace = () => {} }) {
  const { data: member, error } = await db.from('member').select('*')
    .eq('id', memberId).eq('tenant_id', tenantId).maybeSingle();
  if (error) throw new Error(`Failed to load member: ${error.message}`);
  if (!member) return { ok: false, error: 'Member not found' };
  if (member.membership_paused !== true || (auto && !isRestartDue(member, now))) {
    trace({ stage: 'pause-auto-restart', status: 'skipped', reason: member.membership_paused !== true ? 'Membership is not paused.' : 'Scheduled restart date has not arrived.' });
    return { ok: true, alreadyResumed: true, warnings: [] };
  }
  let subscriptionIds = Array.isArray(member.membership_pause_gc_subscriptions) ? member.membership_pause_gc_subscriptions : [];
  if (!subscriptionIds.length) {
    const result = await db.from('membership_payment_plans').select('gocardless_subscription_id')
      .eq('tenant_id', tenantId).eq('member_id', memberId)
      .not('gocardless_subscription_id', 'is', null)
      .in('status', ['active', 'first_payment_pending', 'payment_grace_period', 'payment_overdue']);
    if (result.error) throw new Error(`Could not load paused subscriptions: ${result.error.message}`);
    subscriptionIds = (result.data || []).map(p => p.gocardless_subscription_id);
  }
  const result = await effects.perform({
    type: 'owner.resume_claim', stage: 'pause-auto-restart',
    description: `Clear membership pause for ${memberId}.`,
    conditional: `Only after the still-paused compare-and-set succeeds: resume ${subscriptionIds.length} recorded/fallback GoCardless subscription(s) and add a member note. Login-enabled is not changed.`,
    payload: {
      tenantId, memberId, subscriptionIds,
      values: { membership_paused: false, membership_paused_at: null, membership_pause_restart_date: null,
        membership_paused_by: null, membership_pause_reason: null, membership_pause_gc_subscriptions: [] },
    },
  });
  if (result.error) return { ok: false, error: `Failed to clear pause: ${result.error.message}` };
  if (!result.data?.length) return { ok: true, alreadyResumed: true, warnings: [] };
  return { ok: true, member, subscriptionIds };
}

export async function runOwnerPause({ db, plan, agreement, now, effects, trace }) {
  const memberId = agreement.member_id || plan.member_id;
  if (!memberId) return trace({ stage: 'pause-auto-restart', status: 'skipped', reason: 'Organisation-owned plan has no personal pause to restart.' });
  return prepareOwnerResume({ db, tenantId: plan.tenant_id, memberId, now, effects, trace, auto: true });
}

export async function runOwnerActivation({ db, plan, agreement, now, effects, trace }) {
  const memberId = agreement.member_id || plan.member_id;
  const scope = memberId ? 'member' : 'organisation';
  const ownerId = memberId || agreement.organization_id || plan.organization_id;
  const column = memberId ? 'member_id' : 'organization_id';
  const { data, error } = await selectScheduledActivations(db, plan.tenant_id, scope, now).eq(column, ownerId).order('id');
  if (error) throw new Error(`Could not load owner scheduled memberships: ${error.message}`);
  if (!data?.length) return trace({ stage: `${scope}-scheduled-activation`, status: 'skipped', reason: 'No scheduled membership has reached its activation date.' });
  for (const row of data) await runScheduledActivation({ row, tenantId: plan.tenant_id, scope, now, effects, trace });
}