// GoCardless Phase 2 — individual membership monthly Direct Debit.
//
// Pure decision logic (exported for node --test):
//   - resolveDdOffer(simResult)           tier config -> DD offer or null
//   - computeFirstCollectionDate(...)     first-collection rule -> date | null
//   - buildAgreementSnapshot(...)         immutable terms snapshot at consent
//   - decideMembershipActivation(...)     dd_activation_rule -> activate?
//
// Impure orchestration (deps-injectable { db, gc } like the webhook processor):
//   - ensureSubscriptionForAgreement(...) mandate active -> plan row + GC sub
//   - activateMembershipForAgreement(...) flip the member's history row
//
// Rules:
//   - The agreement snapshot in membership_billing_agreements.metadata.dd is
//     written ONCE at consent and never recomputed. Later tier-config edits
//     never change an in-flight agreement.
//   - All amounts are integer minor units in GC calls; the snapshot stores
//     both the decimal monthly amount and its minor-unit equivalent.

import { supabase } from './database.js';
import * as gocardless from './gocardless.js';
import { buildIdempotencyKey } from './gocardless.js';
import { applyStatusTransition, STATUS } from './gocardlessState.js';

export const FIRST_COLLECTION_RULES = ['earliest', 'nominated_day', 'anniversary'];
export const ACTIVATION_RULES = ['mandate', 'first_payment', 'manual'];

export function toMinorUnits(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

/**
 * Given a membership simulation result, decide whether a monthly Direct
 * Debit option is available and what its terms are. Returns null when DD is
 * not offered (config disabled, no stored monthly amount, or org-scoped).
 */
export function resolveDdOffer(simResult) {
  if (!simResult?.success) return null;
  const config = simResult.config;
  if (!config?.dd_enabled) return null;

  let monthlyAmount = null;
  if ((config.pricing_model || 'tiered') === 'flat') {
    monthlyAmount = config.dd_monthly_amount != null ? Number(config.dd_monthly_amount) : null;
  } else {
    const band = simResult.matchedBand;
    monthlyAmount = band?.dd_monthly_amount != null ? Number(band.dd_monthly_amount) : null;
  }
  if (!Number.isFinite(monthlyAmount) || monthlyAmount <= 0) return null;

  const instalmentCount = Math.min(12, Math.max(1, parseInt(config.dd_instalment_count, 10) || 12));
  const monthlyAmountMinor = toMinorUnits(monthlyAmount);
  if (!monthlyAmountMinor) return null;

  return {
    monthlyAmount: parseFloat(monthlyAmount.toFixed(2)),
    monthlyAmountMinor,
    instalmentCount,
    planTotal: parseFloat(((monthlyAmountMinor * instalmentCount) / 100).toFixed(2)),
    currency: simResult.currency || config.currency || 'GBP',
    firstCollectionRule: FIRST_COLLECTION_RULES.includes(config.dd_first_collection_rule)
      ? config.dd_first_collection_rule : 'earliest',
    collectionDay: config.dd_collection_day || null,
    activationRule: ACTIVATION_RULES.includes(config.dd_activation_rule)
      ? config.dd_activation_rule : 'first_payment',
    autoRenew: config.dd_auto_renew !== false,
    graceDays: Number.isInteger(config.dd_grace_days) ? config.dd_grace_days : 7,
    termsVersion: config.dd_terms_version || 'v1',
  };
}

function toDateOnly(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function fmt(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * Compute the subscription start_date / day_of_month for a first-collection
 * rule. Returns { startDate: 'YYYY-MM-DD'|null, dayOfMonth: number|null }.
 *
 * - 'earliest': no constraints — GoCardless charges as soon as the mandate
 *   allows. { startDate: null, dayOfMonth: null }.
 * - 'nominated_day': collect on config.dd_collection_day each month (1-28).
 *   GC picks the first eligible occurrence itself, so no startDate needed.
 * - 'anniversary': collect on the membership-year start day-of-month
 *   (clamped to 28). startDate is the first occurrence of that day on/after
 *   earliestChargeDate (so a mid-month signup doesn't backdate).
 */
export function computeFirstCollectionDate({ rule, collectionDay = null, membershipYearStart = null, earliestChargeDate = null }) {
  if (rule === 'nominated_day') {
    const day = Math.min(28, Math.max(1, parseInt(collectionDay, 10) || 1));
    return { startDate: null, dayOfMonth: day };
  }
  if (rule === 'anniversary') {
    const yearStart = toDateOnly(membershipYearStart);
    if (!yearStart) return { startDate: null, dayOfMonth: null };
    const day = Math.min(28, yearStart.getUTCDate());
    const earliest = toDateOnly(earliestChargeDate) || toDateOnly(new Date());
    let candidate = new Date(Date.UTC(earliest.getUTCFullYear(), earliest.getUTCMonth(), day));
    if (candidate < earliest) {
      candidate = new Date(Date.UTC(earliest.getUTCFullYear(), earliest.getUTCMonth() + 1, day));
    }
    return { startDate: fmt(candidate), dayOfMonth: day };
  }
  // 'earliest' (default)
  return { startDate: null, dayOfMonth: null };
}

/**
 * Build the immutable terms snapshot stored on the billing agreement at the
 * moment of member consent. Everything the webhook path later needs to
 * create the subscription and activate the membership lives here.
 */
export function buildAgreementSnapshot({ offer, simResult, acceptedAt = new Date().toISOString() }) {
  if (!offer) throw new Error('offer is required');
  return {
    kind: 'monthly_direct_debit',
    monthly_amount: offer.monthlyAmount,
    monthly_amount_minor: offer.monthlyAmountMinor,
    instalment_count: offer.instalmentCount,
    plan_total: offer.planTotal,
    currency: offer.currency,
    first_collection_rule: offer.firstCollectionRule,
    collection_day: offer.collectionDay,
    activation_rule: offer.activationRule,
    auto_renew: offer.autoRenew,
    grace_days: offer.graceDays,
    terms_version: offer.termsVersion,
    accepted_at: acceptedAt,
    membership_year: simResult?.membershipYear?.label || null,
    membership_year_start: simResult?.membershipYear?.start
      ? fmt(toDateOnly(simResult.membershipYear.start)) : null,
    config_id: simResult?.config?.id || null,
    band_id: simResult?.matchedBand?.id || null,
    tier_label: simResult?.tierLabel || null,
    annual_cost: simResult?.annualCost ?? null,
    final_cost: simResult?.finalCost ?? null,
  };
}

/**
 * Should the membership be activated for this trigger, per the tier's
 * dd_activation_rule?
 *   - 'mandate':       activate when the mandate becomes active
 *   - 'first_payment': activate when the first payment is confirmed
 *   - 'manual':        never auto-activate (admin flips it)
 * Approval gating (membership_require_approval) is enforced by the CALLER
 * before the agreement is ever created, so it does not appear here.
 */
export function decideMembershipActivation({ activationRule, trigger }) {
  if (activationRule === 'manual') return false;
  if (activationRule === 'mandate') return trigger === 'mandate_active' || trigger === 'first_payment_confirmed';
  // first_payment (default)
  return trigger === 'first_payment_confirmed';
}

// ---------------------------------------------------------------------------
// Impure orchestration
// ---------------------------------------------------------------------------

function defaultDeps(deps) {
  return { db: deps.db || supabase, gc: deps.gc || gocardless };
}

/**
 * Called when a mandate becomes active for a DD billing agreement: create
 * the local plan row and the GoCardless subscription from the agreement's
 * stored snapshot. Idempotent — keyed on the agreement id.
 *
 * Returns { created: boolean, plan, detail }.
 */
export async function ensureSubscriptionForAgreement(agreement, deps = {}) {
  const { db, gc } = defaultDeps(deps);
  const snapshot = agreement?.metadata?.dd;
  if (!snapshot || snapshot.kind !== 'monthly_direct_debit') {
    return { created: false, plan: null, detail: 'agreement has no DD snapshot' };
  }
  if (!agreement.gocardless_mandate_id) {
    return { created: false, plan: null, detail: 'agreement has no mandate' };
  }

  const idempotencyKey = buildIdempotencyKey('dd-sub', agreement.id, snapshot.membership_year || 'year');

  // Existing plan for this agreement? (idempotent re-entry)
  const { data: existingPlan, error: planErr } = await db
    .from('membership_payment_plans')
    .select('*')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();
  if (planErr) throw new Error(`load existing plan failed: ${planErr.message}`);
  if (existingPlan?.gocardless_subscription_id) {
    return { created: false, plan: existingPlan, detail: 'plan already has subscription' };
  }

  // Mandate's earliest possible charge date (may be null if not mirrored yet).
  let earliestChargeDate = null;
  const { data: mandateRow } = await db
    .from('gocardless_mandates')
    .select('next_possible_charge_date')
    .eq('gocardless_mandate_id', agreement.gocardless_mandate_id)
    .maybeSingle();
  earliestChargeDate = mandateRow?.next_possible_charge_date || null;

  const { startDate, dayOfMonth } = computeFirstCollectionDate({
    rule: snapshot.first_collection_rule,
    collectionDay: snapshot.collection_day,
    membershipYearStart: snapshot.membership_year_start,
    earliestChargeDate,
  });

  let plan = existingPlan;
  if (!plan) {
    const { data: inserted, error: insErr } = await db
      .from('membership_payment_plans')
      .insert({
        tenant_id: agreement.tenant_id,
        billing_agreement_id: agreement.id,
        member_id: agreement.member_id || null,
        organization_id: agreement.organization_id || null,
        gocardless_mandate_id: agreement.gocardless_mandate_id,
        amount_minor: snapshot.monthly_amount_minor,
        currency: snapshot.currency || 'GBP',
        interval_unit: 'monthly',
        day_of_month: dayOfMonth,
        status: STATUS.MANDATE_PENDING,
        membership_year: snapshot.membership_year,
        start_date: startDate,
        instalments_total: snapshot.instalment_count,
        idempotency_key: idempotencyKey,
        environment: gc.getGocardlessEnvironment ? gc.getGocardlessEnvironment() : 'sandbox',
        metadata: { source: 'phase2_dd', agreement_id: agreement.id },
      })
      .select()
      .single();
    if (insErr) {
      if (insErr.code === '23505') {
        const { data: raced } = await db
          .from('membership_payment_plans')
          .select('*')
          .eq('idempotency_key', idempotencyKey)
          .maybeSingle();
        if (raced?.gocardless_subscription_id) {
          return { created: false, plan: raced, detail: 'plan created concurrently' };
        }
        plan = raced;
      } else {
        throw new Error(`insert payment plan failed: ${insErr.message}`);
      }
    } else {
      plan = inserted;
    }
  }
  if (!plan) throw new Error('could not create or load payment plan row');

  const client = await gc.gocardlessForTenant(agreement.tenant_id, { db });
  const subscription = await client.createSubscription({
    mandateId: agreement.gocardless_mandate_id,
    amountMinor: snapshot.monthly_amount_minor,
    currency: snapshot.currency || 'GBP',
    intervalUnit: 'monthly',
    dayOfMonth,
    startDate,
    count: snapshot.instalment_count,
    name: `Membership ${snapshot.membership_year || ''}`.trim(),
    metadata: {
      tenant_id: agreement.tenant_id,
      agreement_id: agreement.id,
      plan_id: plan.id,
    },
    idempotencyKey,
  });

  const { error: upErr } = await db
    .from('membership_payment_plans')
    .update({
      gocardless_subscription_id: subscription.id,
      next_charge_date: subscription.upcoming_payments?.[0]?.charge_date || subscription.start_date || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', plan.id);
  if (upErr) throw new Error(`attach subscription to plan failed: ${upErr.message}`);

  await applyStatusTransition({
    entityType: 'payment_plan',
    entityId: plan.id,
    toStatus: STATUS.FIRST_PAYMENT_PENDING,
    reason: 'subscription created from mandate activation',
    source: 'webhook',
  }, { db });

  return { created: true, plan: { ...plan, gocardless_subscription_id: subscription.id }, detail: `subscription ${subscription.id} created` };
}

/**
 * Apply the tier's activation rule to the member's membership-history row.
 * The history row is created at DD start with status 'pending_payment_setup';
 * this flips it to 'active' (auto rules) or 'pending_activation' (manual).
 * Idempotent — no-op when already active.
 */
export async function activateMembershipForAgreement(agreement, { trigger, db: dbArg } = {}) {
  const db = dbArg || supabase;
  const snapshot = agreement?.metadata?.dd;
  if (!snapshot || !agreement.member_id) return { updated: false, detail: 'no DD snapshot or member' };

  const { data: row, error } = await db
    .from('member_membership_history')
    .select('id, status')
    .eq('billing_agreement_id', agreement.id)
    .maybeSingle();
  if (error) throw new Error(`load membership history for agreement failed: ${error.message}`);
  if (!row) return { updated: false, detail: 'no membership history row linked to agreement' };
  if (row.status === 'active') return { updated: false, detail: 'membership already active' };

  const activate = decideMembershipActivation({ activationRule: snapshot.activation_rule, trigger });
  const nextStatus = activate ? 'active' : (snapshot.activation_rule === 'manual' ? 'pending_activation' : null);
  if (!nextStatus || nextStatus === row.status) {
    return { updated: false, detail: `no status change for trigger=${trigger} rule=${snapshot.activation_rule}` };
  }

  const { error: upErr } = await db
    .from('member_membership_history')
    .update({ status: nextStatus })
    .eq('id', row.id)
    .eq('status', row.status);
  if (upErr) throw new Error(`update membership history failed: ${upErr.message}`);
  return { updated: true, activated: nextStatus === 'active', detail: `membership history -> ${nextStatus} (trigger=${trigger})` };
}

/**
 * Mark the linked membership history row's payment progress when a DD
 * payment is confirmed. First confirmed payment -> payment_status 'partial'
 * (the year isn't settled until the plan completes — later phases handle
 * full settlement).
 */
export async function recordDdPaymentProgress(agreement, { db: dbArg } = {}) {
  const db = dbArg || supabase;
  if (!agreement?.member_id) return { updated: false };
  const { data: row } = await db
    .from('member_membership_history')
    .select('id, payment_status')
    .eq('billing_agreement_id', agreement.id)
    .maybeSingle();
  if (!row || row.payment_status === 'paid' || row.payment_status === 'partial') {
    return { updated: false };
  }
  const { error } = await db
    .from('member_membership_history')
    .update({ payment_status: 'partial' })
    .eq('id', row.id);
  if (error) throw new Error(`update payment_status failed: ${error.message}`);
  return { updated: true };
}

/**
 * Find a reusable active mandate for a member (renewal path). Returns
 * { mandateId, customerId } or null.
 */
export async function findReusableMandate({ tenantId, memberId, db: dbArg } = {}) {
  const db = dbArg || supabase;
  const { data: customers, error } = await db
    .from('gocardless_customers')
    .select('gocardless_customer_id')
    .eq('tenant_id', tenantId)
    .eq('member_id', memberId);
  if (error || !customers?.length) return null;
  const customerIds = customers.map((c) => c.gocardless_customer_id);
  const { data: mandates, error: mErr } = await db
    .from('gocardless_mandates')
    .select('gocardless_mandate_id, gocardless_customer_id, status')
    .in('gocardless_customer_id', customerIds)
    .eq('status', 'active')
    .order('updated_at', { ascending: false })
    .limit(1);
  if (mErr || !mandates?.length) return null;
  return { mandateId: mandates[0].gocardless_mandate_id, customerId: mandates[0].gocardless_customer_id };
}
