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
export const MONTHLY_POST_GRACE_COLLECTION_POLICIES = ['stop_collecting', 'continue_catch_up'];
export const MANDATE_ONLY_CONSENT_VERSION = 'mandate-only-v2';

export function monthlyConsentReplacementKey(baseIdempotencyKey) {
  if (!baseIdempotencyKey) throw new Error('base consent idempotency key is required');
  if (baseIdempotencyKey.endsWith(`:${MANDATE_ONLY_CONSENT_VERSION}`)) {
    return baseIdempotencyKey;
  }
  return `${baseIdempotencyKey}:${MANDATE_ONLY_CONSENT_VERSION}`;
}

export function classifyMonthlyConsentAgreement(agreement) {
  if (!agreement) return { kind: 'missing', resumable: false, rotatable: false };
  const snapshot = agreement.metadata?.dd;
  const pending = agreement.status === STATUS.PAYMENT_SETUP_REQUIRED;
  const hasMandate = !!agreement.gocardless_mandate_id;
  const hasProviderPayment = !!agreement.metadata?.gocardless_initial_payment?.id;
  if (!pending || hasMandate || hasProviderPayment) {
    return { kind: 'protected', resumable: false, rotatable: false };
  }

  const refs = [
    agreement.gocardless_billing_request_id,
    agreement.gocardless_billing_request_flow_id,
    agreement.redirect_url,
  ];
  const refCount = refs.filter(Boolean).length;
  const refsCoherent = refCount === 0 || refCount === refs.length;
  const providerStateVerifiable = refCount === 0 || !!agreement.gocardless_billing_request_id;
  const scheduleComplete = snapshot?.kind === 'monthly_direct_debit'
    && Number.isInteger(snapshot.monthly_amount_minor)
    && snapshot.monthly_amount_minor > 0
    && Number.isInteger(snapshot.instalment_count)
    && snapshot.instalment_count > 0;
  const current = snapshot?.billing_request_mode === 'mandate_only'
    && !snapshot.billing_request_payment
    && scheduleComplete
    && refsCoherent;
  if (current) {
    return {
      kind: refCount === 0 ? 'current_unstarted' : 'current_flow',
      resumable: refCount === refs.length,
      rotatable: false,
    };
  }
  if (!providerStateVerifiable) {
    return { kind: 'protected', resumable: false, rotatable: false };
  }
  return { kind: refsCoherent ? 'legacy' : 'ambiguous', resumable: false, rotatable: true };
}

export async function rotateStaleMonthlyConsentAgreement({
  db = supabase,
  agreement,
  replacementIdempotencyKey,
  snapshot,
  gc,
}) {
  const classification = classifyMonthlyConsentAgreement(agreement);
  if (!classification.rotatable) throw new Error('billing agreement is not safe to replace');
  if (replacementIdempotencyKey === agreement.idempotency_key) {
    throw new Error('billing agreement replacement generation is already current');
  }
  const replacementContract = classifyMonthlyConsentAgreement({
    status: STATUS.PAYMENT_SETUP_REQUIRED,
    metadata: { dd: snapshot },
  });
  if (replacementContract.kind !== 'current_unstarted') {
    throw new Error('replacement consent snapshot is incomplete');
  }
  if (agreement.gocardless_billing_request_id) {
    if (typeof gc?.getBillingRequest !== 'function') {
      throw new Error('cannot verify stale GoCardless billing request before replacement');
    }
    const providerRequest = await gc.getBillingRequest(agreement.gocardless_billing_request_id);
    if (providerRequest?.status === 'fulfilled'
      || providerRequest?.links?.mandate_request_mandate
      || providerRequest?.links?.payment_request_payment) {
      throw new Error('GoCardless billing request is already tied to a mandate or payment');
    }
    if (providerRequest?.status !== 'cancelled') {
      if (typeof gc.cancelBillingRequest !== 'function') {
        throw new Error('cannot retire stale GoCardless billing request before replacement');
      }
      const cancelled = await gc.cancelBillingRequest(agreement.gocardless_billing_request_id);
      if (cancelled?.status !== 'cancelled') {
        throw new Error('stale GoCardless billing request could not be cancelled');
      }
    }
  }
  const metadata = {
    ...(agreement.metadata || {}),
    dd: snapshot,
    consent_replaces_agreement_id: agreement.id,
  };
  delete metadata.gocardless_initial_payment;
  const { data, error } = await db.rpc('rotate_stale_gocardless_consent', {
    p_source_agreement_id: agreement.id,
    p_replacement_idempotency_key: replacementIdempotencyKey,
    p_replacement_metadata: metadata,
  });
  if (error) throw new Error(`replace stale DD consent failed: ${error.message}`);
  if (!data?.id) throw new Error('replace stale DD consent returned no agreement');
  return data;
}

export async function isAgreementMandateActive(agreement, { gc } = {}) {
  if (!agreement?.gocardless_mandate_id || typeof gc?.getMandate !== 'function') return false;
  const mandate = await gc.getMandate(agreement.gocardless_mandate_id);
  return mandate?.status === 'active';
}

export async function claimMonthlyConsentAgreement({ db = supabase, agreementInsert }) {
  const { data, error } = await db
    .from('membership_billing_agreements')
    .insert(agreementInsert)
    .select()
    .single();
  if (!error) return { agreement: data, created: true };
  if (error.code !== '23505') throw new Error(`claim DD agreement failed: ${error.message}`);
  const { data: raced, error: racedError } = await db
    .from('membership_billing_agreements')
    .select('*')
    .eq('idempotency_key', agreementInsert.idempotency_key)
    .maybeSingle();
  if (racedError || !raced) {
    throw new Error(`load claimed DD agreement failed: ${racedError?.message || 'missing agreement'}`);
  }
  return { agreement: raced, created: false };
}

export async function attachMonthlyConsentFlow({
  db = supabase,
  agreement,
  billingRequest,
  flow,
  extraUpdate = {},
}) {
  const patch = {
    gocardless_billing_request_id: billingRequest.id,
    gocardless_billing_request_flow_id: flow.id,
    redirect_url: flow.authorisation_url,
    updated_at: new Date().toISOString(),
    ...extraUpdate,
  };
  const { data: attached, error } = await db
    .from('membership_billing_agreements')
    .update(patch)
    .eq('id', agreement.id)
    .is('gocardless_billing_request_id', null)
    .select()
    .maybeSingle();
  if (error) throw new Error(`attach DD consent flow failed: ${error.message}`);
  if (attached) return attached;
  const { data: winner, error: winnerError } = await db
    .from('membership_billing_agreements')
    .select('*')
    .eq('id', agreement.id)
    .maybeSingle();
  if (winnerError || !winner) {
    throw new Error(`load attached DD consent flow failed: ${winnerError?.message || 'missing agreement'}`);
  }
  if (winner.gocardless_billing_request_id !== billingRequest.id
    || winner.gocardless_billing_request_flow_id !== flow.id
    || winner.redirect_url !== flow.authorisation_url) {
    throw new Error('concurrent DD consent flow does not match the claimed agreement');
  }
  return winner;
}

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
    // Task #3633: 'annual' (default) or 'per_instalment'. Snapshotted at
    // consent — later config edits never change an in-flight agreement.
    invoicingMode: config.dd_invoicing_mode === 'per_instalment' ? 'per_instalment' : 'annual',
    monthlyPostGraceCollectionPolicy: MONTHLY_POST_GRACE_COLLECTION_POLICIES
      .includes(config.monthly_post_grace_collection_policy)
      ? config.monthly_post_grace_collection_policy : 'stop_collecting',
  };
}

function addOneCalendarMonth(value) {
  const date = toDateOnly(value);
  if (!date) return null;
  const day = Math.min(28, date.getUTCDate());
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, day));
}

function laterDate(a, b) {
  const left = toDateOnly(a);
  const right = toDateOnly(b);
  if (!left) return right;
  if (!right) return left;
  return left > right ? left : right;
}

function monthlyPaymentDescription({ membershipYear, instalmentCount, monthlyAmount, currency }) {
  const remaining = Math.max(0, instalmentCount - 1);
  const amount = `${currency} ${Number(monthlyAmount).toFixed(2)}`;
  const schedule = remaining === 0
    ? 'No further collections.'
    : `${remaining} further monthly Direct Debit ${remaining === 1 ? 'collection' : 'collections'} of ${amount}.`;
  return `Membership ${membershipYear || ''}: first instalment of ${amount} paid now. ${schedule}`
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 255);
}

/**
 * Build the provider request for monthly membership consent.
 *
 * New Bacs setups are mandate-only because GoCardless rejects Billing Request
 * subscription/instalment requests for that scheme. Legacy snapshots with a
 * billing_request_payment retain their original first-payment contract.
 */
export function buildMonthlyBillingRequest({ snapshot, metadata = {} }) {
  const payment = snapshot?.billing_request_payment;
  if (snapshot?.kind !== 'monthly_direct_debit') {
    throw new Error('monthly DD snapshot is required');
  }
  if (!Number.isInteger(snapshot.monthly_amount_minor) || snapshot.monthly_amount_minor <= 0
    || !Number.isInteger(snapshot.instalment_count) || snapshot.instalment_count <= 0) {
    throw new Error('monthly DD snapshot requires a positive amount and collection count');
  }
  if (Object.keys(metadata).length > 3) {
    throw new Error('GoCardless Billing Request metadata allows at most 3 properties');
  }
  const request = {
    currency: snapshot.currency || 'GBP',
    metadata,
  };
  if (payment?.included) {
    if (!Number.isInteger(payment.amount_minor) || payment.amount_minor <= 0) {
      throw new Error('monthly DD billing request amount must be positive minor units');
    }
    request.paymentAmountMinor = payment.amount_minor;
    request.paymentDescription = payment.description;
  }
  return request;
}

export function monthlyBillingRequestFingerprint(snapshot) {
  const payment = snapshot?.billing_request_payment;
  return JSON.stringify({
    mode: payment?.included ? 'legacy_first_payment' : 'mandate_only',
    amount_minor: snapshot?.monthly_amount_minor,
    currency: snapshot.currency || 'GBP',
    instalment_count: snapshot.instalment_count,
    membership_year: snapshot.membership_year || null,
    first_collection_rule: snapshot.first_collection_rule || 'earliest',
    collection_day: snapshot.collection_day || null,
    terms_version: snapshot.terms_version || null,
    config_id: snapshot.config_id || null,
    band_id: snapshot.band_id || null,
  });
}

export function remainingSubscriptionInstalments(snapshot) {
  const total = Math.max(1, parseInt(snapshot?.instalment_count, 10) || 1);
  return snapshot?.billing_request_payment?.included ? Math.max(0, total - 1) : total;
}

export function publicDdConsentTerms({
  monthlyAmount,
  instalmentCount,
  planTotal,
  currency,
  firstCollectionRule,
  collectionDay,
}) {
  return {
    monthlyAmount: monthlyAmount == null ? null : Number(monthlyAmount),
    instalmentCount: Number.isInteger(Number(instalmentCount)) ? Number(instalmentCount) : null,
    planTotal: planTotal == null ? null : Number(planTotal),
    currency: currency || 'GBP',
    firstCollectionRule: ['nominated_day', 'anniversary'].includes(firstCollectionRule)
      ? firstCollectionRule
      : 'earliest',
    collectionDay: firstCollectionRule === 'nominated_day'
      ? Math.min(28, Math.max(1, Number.parseInt(collectionDay, 10) || 1))
      : null,
  };
}

/**
 * A billing-request payment is collection #1. Keep the finite subscription
 * for the remaining collections at least one calendar month after consent,
 * while retaining the snapshotted nominated-day/anniversary rules.
 */
export function computeSubscriptionCollectionDate(
  snapshot,
  earliestChargeDate = null,
  initialPaymentChargeDate = null,
  currentDate = null,
) {
  const hasInitialPayment = snapshot?.billing_request_payment?.included === true;
  const scheduleLowerBound = hasInitialPayment
    ? laterDate(addOneCalendarMonth(initialPaymentChargeDate || snapshot.accepted_at), earliestChargeDate)
    : toDateOnly(earliestChargeDate);
  const notBefore = laterDate(scheduleLowerBound, currentDate);

  if (hasInitialPayment && snapshot.first_collection_rule === 'earliest') {
    return { startDate: notBefore ? fmt(notBefore) : null, dayOfMonth: null };
  }
  if (hasInitialPayment && snapshot.first_collection_rule === 'nominated_day') {
    const day = Math.min(28, Math.max(1, parseInt(snapshot.collection_day, 10) || 1));
    if (!notBefore) return { startDate: null, dayOfMonth: day };
    let candidate = new Date(Date.UTC(notBefore.getUTCFullYear(), notBefore.getUTCMonth(), day));
    if (candidate < notBefore) {
      candidate = new Date(Date.UTC(notBefore.getUTCFullYear(), notBefore.getUTCMonth() + 1, day));
    }
    return { startDate: fmt(candidate), dayOfMonth: day };
  }
  return computeFirstCollectionDate({
    rule: snapshot?.first_collection_rule,
    collectionDay: snapshot?.collection_day,
    membershipYearStart: snapshot?.membership_year_start,
    earliestChargeDate: notBefore,
  });
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
export function buildAgreementSnapshot({
  offer,
  simResult,
  acceptedAt = new Date().toISOString(),
  includeBillingRequestPayment = false,
  billingRequestMode = null,
}) {
  if (!offer) throw new Error('offer is required');
  const snapshot = {
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
    invoicing_mode: offer.invoicingMode === 'per_instalment' ? 'per_instalment' : 'annual',
    // Collection continuation is a consent-time term, unlike the separate
    // dd_arrears_policy access/escalation behaviour.
    monthly_post_grace_collection_policy: offer.monthlyPostGraceCollectionPolicy,
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
  if (billingRequestMode) snapshot.billing_request_mode = billingRequestMode;
  if (includeBillingRequestPayment) {
    snapshot.billing_request_payment = {
      included: true,
      instalment_number: 1,
      amount_minor: offer.monthlyAmountMinor,
      remaining_instalments: Math.max(0, offer.instalmentCount - 1),
      description: monthlyPaymentDescription({
        membershipYear: simResult?.membershipYear?.label || null,
        instalmentCount: offer.instalmentCount,
        monthlyAmount: offer.monthlyAmount,
        currency: offer.currency,
      }),
    };
  }
  return snapshot;
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
  const client = typeof gc.gocardlessForTenant === 'function'
    ? await gc.gocardlessForTenant(agreement.tenant_id, { db })
    : gc;

  // Existing plan for this agreement? (idempotent re-entry)
  const { data: existingPlan, error: planErr } = await db
    .from('membership_payment_plans')
    .select('*')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();
  if (planErr) throw new Error(`load existing plan failed: ${planErr.message}`);
  if (existingPlan?.gocardless_subscription_id) {
    const existingInitialPaymentId = agreement.metadata?.gocardless_initial_payment?.id || null;
    if (existingInitialPaymentId) {
      const { error: linkExistingPaymentErr } = await db
        .from('gocardless_payments')
        .update({ plan_id: existingPlan.id, updated_at: new Date().toISOString() })
        .eq('gocardless_payment_id', existingInitialPaymentId);
      if (linkExistingPaymentErr) {
        throw new Error(`attach billing request payment to existing plan failed: ${linkExistingPaymentErr.message}`);
      }
    }
    return { created: false, plan: existingPlan, detail: 'plan already has subscription' };
  }

  // Mandate's earliest possible charge date (may be null if not mirrored yet).
  let earliestChargeDate = null;
  const { data: mandateRow, error: mandateRowError } = await db
    .from('gocardless_mandates')
    .select('next_possible_charge_date')
    .eq('gocardless_mandate_id', agreement.gocardless_mandate_id)
    .maybeSingle();
  if (mandateRowError) throw new Error(`load mandate charge date failed: ${mandateRowError.message}`);
  earliestChargeDate = mandateRow?.next_possible_charge_date || null;
  if (snapshot?.billing_request_payment?.included !== true) {
    if (typeof client.getMandate !== 'function') {
      throw new Error('cannot verify the mandate earliest charge date');
    }
    const authoritativeMandate = await client.getMandate(agreement.gocardless_mandate_id);
    earliestChargeDate = authoritativeMandate?.next_possible_charge_date || null;
    if (!earliestChargeDate) {
      throw new Error('active mandate has no earliest charge date');
    }
    const { error: persistChargeDateError } = await db
      .from('gocardless_mandates')
      .update({
        next_possible_charge_date: earliestChargeDate,
        updated_at: new Date().toISOString(),
      })
      .eq('gocardless_mandate_id', agreement.gocardless_mandate_id);
    if (persistChargeDateError) {
      throw new Error(`persist mandate charge date failed: ${persistChargeDateError.message}`);
    }
  }

  const subscriptionInstalments = remainingSubscriptionInstalments(snapshot);
  const billingRequestPaymentId = agreement.metadata?.gocardless_initial_payment?.id || null;
  const initialPaymentChargeDate = agreement.metadata?.gocardless_initial_payment?.charge_date || null;
  const { startDate, dayOfMonth } = computeSubscriptionCollectionDate(
    snapshot,
    earliestChargeDate,
    initialPaymentChargeDate,
    typeof deps.now === 'function' ? deps.now() : new Date(),
  );

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

  let initialPaymentAlreadyConfirmed = false;
  if (billingRequestPaymentId) {
    const { error: linkPaymentErr } = await db
      .from('gocardless_payments')
      .update({ plan_id: plan.id, updated_at: new Date().toISOString() })
      .eq('gocardless_payment_id', billingRequestPaymentId);
    if (linkPaymentErr) throw new Error(`attach billing request payment to plan failed: ${linkPaymentErr.message}`);
    const { data: initialPayment, error: initialPaymentErr } = await db
      .from('gocardless_payments')
      .select('status, charge_date, amount_minor, currency')
      .eq('gocardless_payment_id', billingRequestPaymentId)
      .maybeSingle();
    if (initialPaymentErr) throw new Error(`load billing request payment failed: ${initialPaymentErr.message}`);
    if (initialPayment?.amount_minor != null && initialPayment.amount_minor !== snapshot.monthly_amount_minor) {
      throw new Error('initial billing request payment amount does not match DD snapshot');
    }
    if (initialPayment?.currency
      && initialPayment.currency !== (snapshot.currency || 'GBP')) {
      throw new Error('initial billing request payment currency does not match DD snapshot');
    }
    initialPaymentAlreadyConfirmed = ['confirmed', 'paid_out'].includes(initialPayment?.status);
  }

  // A one-instalment plan is fully represented by the billing-request
  // payment. Do not create a zero-count subscription.
  if (subscriptionInstalments === 0) {
    if (initialPaymentAlreadyConfirmed) {
      await applyStatusTransition({
        entityType: 'payment_plan',
        entityId: plan.id,
        toStatus: STATUS.ACTIVE,
        reason: 'initial billing request payment already confirmed',
        source: 'system',
      }, { db });
    } else {
      await applyStatusTransition({
        entityType: 'payment_plan',
        entityId: plan.id,
        toStatus: STATUS.FIRST_PAYMENT_PENDING,
        reason: 'awaiting initial billing request payment',
        source: 'system',
      }, { db });
    }
    return { created: false, plan, detail: 'initial billing request payment is the only instalment' };
  }

  const subscription = await client.createSubscription({
    mandateId: agreement.gocardless_mandate_id,
    amountMinor: snapshot.monthly_amount_minor,
    currency: snapshot.currency || 'GBP',
    intervalUnit: 'monthly',
    dayOfMonth,
    startDate,
    count: subscriptionInstalments,
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
    toStatus: initialPaymentAlreadyConfirmed ? STATUS.ACTIVE : STATUS.FIRST_PAYMENT_PENDING,
    reason: initialPaymentAlreadyConfirmed
      ? 'subscription created after initial billing request payment confirmed'
      : 'subscription created from mandate activation',
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
export function membershipHistoryTableForAgreement(agreement) {
  if (agreement?.member_id) return 'member_membership_history';
  if (agreement?.organization_id) return 'organisation_membership_history';
  return null;
}

export async function activateMembershipForAgreement(agreement, { trigger, db: dbArg } = {}) {
  const db = dbArg || supabase;
  const snapshot = agreement?.metadata?.dd;
  const table = membershipHistoryTableForAgreement(agreement);
  if (!snapshot || !table) return { updated: false, detail: 'no DD snapshot or member/organisation' };

  const { data: row, error } = await db
    .from(table)
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
    .from(table)
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
  const table = membershipHistoryTableForAgreement(agreement);
  const snapshot = agreement?.metadata?.dd;
  if (!table) return { updated: false };
  const { data: row, error: rowError } = await db
    .from(table)
    .select('id, payment_status')
    .eq('billing_agreement_id', agreement.id)
    .maybeSingle();
  if (rowError) throw new Error(`load membership payment progress failed: ${rowError.message}`);
  const completesPlan = snapshot?.billing_request_payment?.included === true
    && remainingSubscriptionInstalments(snapshot) === 0;
  const nextPaymentStatus = completesPlan ? 'paid' : 'partial';
  if (!row || row.payment_status === 'paid' || row.payment_status === nextPaymentStatus) {
    return { updated: false };
  }
  const { error } = await db
    .from(table)
    .update({
      payment_status: nextPaymentStatus,
      ...(completesPlan ? { paid_at: new Date().toISOString() } : {}),
    })
    .eq('id', row.id);
  if (error) throw new Error(`update payment_status failed: ${error.message}`);
  return { updated: true };
}

/**
 * Find a reusable active mandate for a member (renewal path). Returns
 * { mandateId, customerId } or null.
 */
export async function findReusableMandate({ tenantId, memberId = null, organizationId = null, db: dbArg } = {}) {
  const db = dbArg || supabase;
  let query = db
    .from('gocardless_customers')
    .select('gocardless_customer_id')
    .eq('tenant_id', tenantId);
  query = organizationId ? query.eq('organization_id', organizationId) : query.eq('member_id', memberId);
  const { data: customers, error } = await query;
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
