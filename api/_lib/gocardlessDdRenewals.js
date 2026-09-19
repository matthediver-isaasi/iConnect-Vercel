// GoCardless Phase 5 — renewals for monthly Direct Debit memberships.
//
// Model:
//   - A DD subscription is created for ONE membership year and finishes after
//     its final instalment (webhook flips the plan to EXPIRED and stamps
//     completed_at). The mandate stays active and is reused for renewal.
//   - Renewal NEVER alters the completed subscription/plan/agreement: each
//     renewal year gets a brand-new billing agreement with a fresh immutable
//     terms snapshot (current tier price), a new history row and a new
//     GoCardless subscription.
//   - Tier `dd_auto_renew` (read from the LIVE tier config at renewal time)
//     decides the mode:
//       auto    -> advance notice email, then the cron creates the renewal
//                  agreement + subscription when the new year starts.
//       confirm -> notice email asks the member to confirm; the member's
//                  confirmation goes through the existing
//                  POST /api/membership/direct-debit start action (which
//                  reuses the active mandate), and the renewal row is marked
//                  confirmed.
//   - State lives in membership_dd_renewals, one row per
//     (previous agreement, renewal year).
//
// Pure decision helpers are exported for tests; orchestration takes
// injectable deps ({ db, send, simulate, findMandate, ensureSubscription,
// activateMembership, now }).

import { supabase } from './database.js';
import { buildIdempotencyKey } from './gocardless.js';
import { simulateMembershipForMember, simulateMembershipForOrg } from './membershipSimulation.js';
import {
  resolveDdOffer,
  buildAgreementSnapshot,
  findReusableMandate,
  ensureSubscriptionForAgreement,
  activateMembershipForAgreement,
} from './gocardlessDirectDebit.js';
import { sendDdLifecycleEmail } from './gocardlessDdEmails.js';
import { STATUS } from './gocardlessState.js';
import { assertBnmsPilotAccountingContext } from './xero.js';
import { getPausedMemberIdSet } from './memberPause.js';
import { renewalRows } from './membershipRenewalBudget.js';
import { assertNoOpenMonthlyArrears } from './monthlyArrearsCollection.js';
import { resolveSavedCollectionPolicy } from '../../shared/gocardlessCollectionPolicy.js';
import {
  monthlySnapshotCommitment, monthlyRenewalIdentity, simulateMonthlySuccessor,
  reserveRollingMonthlyRenewal, completeRollingMonthlySetup, assertTrustedMonthlyTerm, sendRollingMonthlyNotice,
} from './rollingMonthlyRenewal.js';

export const RENEWAL_NOTICE_DAYS = 30;

// The pilot's immutable accounting and nominated-day approval is not a
// shared structure default. Restamp current prices/term, but carry only the
// explicitly pinned pilot authority across subsequent management terms.
export function buildDdRenewalSnapshot({ previousAgreement, offer, simResult, acceptedAt }) {
  const prior = previousAgreement.metadata?.dd;
  if (!prior?.accounting_migration) return buildAgreementSnapshot({ offer, simResult, acceptedAt });
  const mapping = assertBnmsPilotAccountingContext(previousAgreement.tenant_id, {
    snapshot: prior.accounting_migration, memberId: previousAgreement.member_id,
    environment: previousAgreement.environment, provider: previousAgreement.provider,
  });
  if (previousAgreement.organization_id || prior.first_collection_rule !== 'nominated_day'
    || prior.collection_day !== 1 || prior.currency !== 'GBP' || prior.invoicing_mode !== 'per_instalment'
    || prior.collection_policy?.version !== 1 || prior.collection_policy.pricing_policy !== 'dynamic'
    || prior.collection_policy.end_policy !== 'continue'
    || offer.currency !== 'GBP' || offer.invoicingMode !== 'per_instalment'
    || offer.collectionPolicy?.version !== 1 || offer.collectionPolicy.pricing_policy !== 'dynamic'
    || offer.collectionPolicy.end_policy !== 'continue') {
    throw new Error('BNMS pilot renewal requires immutable dynamic/continue, GBP, per-instalment and nominated day 1 authority');
  }
  const snapshot = buildAgreementSnapshot({
    offer: { ...offer, firstCollectionRule: prior.first_collection_rule, collectionDay: prior.collection_day },
    simResult, acceptedAt,
  });
  snapshot.accounting_migration = { ...mapping };
  return snapshot;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Derive the next membership-year label from the current one.
 * Handles "2026/27", "2026-27", "2026/2027", "2026-2027" and plain "2026".
 * Returns null when the label can't be parsed.
 */
export function deriveNextYearLabel(label) {
  if (!label || typeof label !== 'string') return null;
  const m = label.match(/^(\d{4})([\/-])(\d{2,4})$/);
  if (m) {
    const start = parseInt(m[1], 10) + 1;
    const sep = m[2];
    const endLen = m[3].length;
    const end = (endLen === 4 ? start + 1 : (start + 1) % 100);
    return `${start}${sep}${String(end).padStart(endLen, '0')}`;
  }
  if (/^\d{4}$/.test(label)) return String(parseInt(label, 10) + 1);
  return null;
}

/**
 * Year boundaries for a DD agreement snapshot.
 * Returns { yearEnd: Date, noticeDate: Date } or null when the snapshot has
 * no membership_year_start.
 */
export function computeRenewalWindow(snapshot, noticeDays = RENEWAL_NOTICE_DAYS) {
  const commitment = monthlySnapshotCommitment(snapshot);
  if (commitment) {
    const yearEnd = new Date(`${commitment.membership_renewal_date}T00:00:00.000Z`);
    if (!Number.isFinite(yearEnd.getTime())) return null;
    return { yearEnd, noticeDate: new Date(yearEnd.getTime() - noticeDays * 86_400_000) };
  }
  if (snapshot?.membership_renewal_date) {
    const yearEnd = new Date(`${snapshot.membership_renewal_date}T00:00:00.000Z`);
    if (!Number.isFinite(yearEnd.getTime())) return null;
    return { yearEnd, noticeDate: new Date(yearEnd.getTime() - noticeDays * 86_400_000) };
  }
  if (snapshot?.start_mode === 'immediate') return null;
  const start = snapshot?.membership_year_start ? new Date(snapshot.membership_year_start) : null;
  if (!start || Number.isNaN(start.getTime())) return null;
  const yearEnd = new Date(Date.UTC(start.getUTCFullYear() + 1, start.getUTCMonth(), start.getUTCDate()));
  const noticeDate = new Date(yearEnd.getTime() - noticeDays * 86_400_000);
  return { yearEnd, noticeDate };
}

/**
 * Decide what (if anything) the renewal cron should do for one agreement.
 *
 *   { action: 'none' | 'send_notice' | 'renew_auto' | 'await_confirmation', reason }
 *
 * Inputs:
 *   snapshot     — the PREVIOUS agreement's immutable dd snapshot
 *   planStatus   — the previous plan's status (only ACTIVE/EXPIRED renew)
 *   autoRenew    — the CURRENT tier config's dd_auto_renew (live, not snapshot)
 *   renewalRow   — existing membership_dd_renewals row or null
 *   hasNextYearRecord — a membership-history row for the renewal year already
 *                       exists via another payment method
 *   today        — Date
 *   expectedKind — agreement snapshot kind this decision applies to
 *                  (default 'monthly_direct_debit'; the Stripe card renewal
 *                  engine reuses this logic with 'monthly_card').
 */
export function decideRenewalAction({ snapshot, planStatus, autoRenew, renewalRow, hasNextYearRecord = false, today = new Date(), expectedKind = 'monthly_direct_debit' }) {
  if (!snapshot || snapshot.kind !== expectedKind) {
    return { action: 'none', reason: `not a ${expectedKind} agreement` };
  }
  if (expectedKind === 'monthly_direct_debit') {
    const policy = resolveSavedCollectionPolicy(snapshot);
    if (policy.needs_review) return { action: 'none', reason: 'Direct Debit continuation consent needs review' };
    autoRenew = policy.end_policy === 'continue';
  }
  if (![STATUS.ACTIVE, STATUS.EXPIRED].includes(planStatus)) {
    return { action: 'none', reason: `plan status ${planStatus} not renewable` };
  }
  const window = computeRenewalWindow(snapshot);
  if (!window) return { action: 'none', reason: 'no membership_year_start in snapshot' };
  if (renewalRow && ['renewed', 'confirmed', 'declined', 'failed'].includes(renewalRow.status)) {
    return { action: 'none', reason: `renewal already ${renewalRow.status}` };
  }
  if (hasNextYearRecord) {
    return { action: 'none', reason: 'next-year membership already recorded elsewhere' };
  }
  if (today < window.noticeDate) {
    return { action: 'none', reason: 'before notice window' };
  }
  if (monthlySnapshotCommitment(snapshot) && ['notice_processing', 'notice_error'].includes(renewalRow?.status)) {
    return { action: 'send_notice', mode: autoRenew ? 'auto' : 'confirm' };
  }
  if (!renewalRow) {
    return { action: 'send_notice', mode: autoRenew ? 'auto' : 'confirm' };
  }
  // Notice already sent.
  if (today < window.yearEnd) {
    return { action: 'none', reason: 'notice sent; waiting for year end' };
  }
  if (renewalRow.mode === 'auto' && autoRenew !== false) {
    return { action: 'renew_auto' };
  }
  return { action: 'await_confirmation', reason: 'confirmation-required renewal awaiting member' };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function defaultDeps(deps = {}) {
  return {
    db: deps.db || supabase,
    send: deps.send, // passed through to sendDdLifecycleEmail when set
    simulate: deps.simulate || simulateMembershipForMember,
    findMandate: deps.findMandate || findReusableMandate,
    ensureSubscription: deps.ensureSubscription || ensureSubscriptionForAgreement,
    activateMembership: deps.activateMembership || activateMembershipForAgreement,
    sendEmail: deps.sendEmail || sendDdLifecycleEmail,
    now: deps.now || (() => new Date()),
  };
}

async function upsertRenewalRow(db, row) {
  const { data, error } = await db
    .from('membership_dd_renewals')
    .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: 'previous_agreement_id,renewal_year' })
    .select()
    .maybeSingle();
  if (error) throw new Error(`upsert renewal row failed: ${error.message}`);
  return data;
}

/**
 * Create the renewal agreement + history row + subscription for an
 * auto-renew member, reusing the active mandate. Never touches the previous
 * agreement/plan. Returns { renewed, agreement?, detail }.
 */
export async function executeAutoRenewal({ tenantId, memberId, organizationId, previousAgreement, renewalRow, deps = {} }) {
  const d = defaultDeps(deps);
  const db = d.db;
  const ownerId = organizationId || memberId;
  const ownerColumn = organizationId ? 'organization_id' : 'member_id';
  if (previousAgreement.tenant_id !== tenantId || previousAgreement[ownerColumn] !== ownerId
      || (organizationId ? previousAgreement.member_id : previousAgreement.organization_id)) {
    throw new Error('Renewal agreement does not belong to the requested membership owner.');
  }

  const priorSnapshot = previousAgreement.metadata?.dd;
  const authority = resolveSavedCollectionPolicy(priorSnapshot);
  const boundary = computeRenewalWindow(priorSnapshot)?.yearEnd;
  if (authority.needs_review || authority.end_policy !== 'continue' || !boundary
      || d.now() < boundary || renewalRow?.mode !== 'auto') {
    return { renewed: false, detail: 'Renewal is not due or saved continuation consent is absent.' };
  }
  const rolling = monthlySnapshotCommitment(priorSnapshot);
  if (rolling && (d.now() < new Date(`${rolling.membership_renewal_date}T00:00:00.000Z`)
      || authority.end_policy !== 'continue' || renewalRow?.mode !== 'auto')) {
    return { renewed: false, detail: 'Rolling renewal is not due or automatic renewal consent is absent.' };
  }
  const simResult = await simulateMonthlySuccessor({
    tenantId, memberId, organizationId, snapshot: priorSnapshot,
    simulate: deps.simulate || (organizationId ? simulateMembershipForOrg : d.simulate),
    source: 'dd-renewal', resolveConfig: deps.resolveConfig, db, provider: 'gocardless',
  });
  if (!simResult?.success) return { renewed: false, detail: `simulation failed: ${simResult?.error || 'unknown'}` };
  const yearLabel = simResult.membershipYear?.label;
  if (!yearLabel || yearLabel === previousAgreement.metadata?.dd?.membership_year) {
    return { renewed: false, detail: `membership year has not rolled over yet (${yearLabel})` };
  }
  if (simResult.existingRecord && !rolling && !simResult.previousTerm) {
    return { renewed: false, detail: `record for ${yearLabel} already exists` };
  }
  // A successor restamps price, never continuation/variable-price authority.
  const offer = resolveDdOffer({
    ...simResult, config: { ...simResult.config,
      dd_policy_version: 1, dd_collection_end_policy: authority.end_policy,
      dd_pricing_policy: authority.pricing_policy,
    },
  });
  if (!offer) return { renewed: false, detail: 'DD no longer offered for this tier' };
  if (rolling || simResult.previousTerm) {
    const reservation = await reserveRollingMonthlyRenewal({
      db, tenantId, memberId, organizationId, previousAgreement,
      snapshot: buildDdRenewalSnapshot({ previousAgreement, offer, simResult, acceptedAt: d.now().toISOString() }),
      provider: 'gocardless', idempotencyKey: buildIdempotencyKey(organizationId ? 'dd-agree-org' : 'dd-agree', tenantId, ownerId, yearLabel),
    });
    let { agreement } = reservation;
    const mandate = agreement.gocardless_mandate_id
      ? { mandateId: agreement.gocardless_mandate_id, customerId: agreement.gocardless_customer_id }
      : await d.findMandate({ tenantId, memberId, organizationId, db });
    if (!mandate) return { renewed: false, detail: 'no reusable active mandate' };
    const mandateFields = {
      gocardless_mandate_id: mandate.mandateId, gocardless_customer_id: mandate.customerId,
      // The reservation is not collectible until its reusable mandate is
      // attached. Advance only setup-required, never a paused/held lifecycle.
      ...(agreement.status === STATUS.PAYMENT_SETUP_REQUIRED ? { status: STATUS.MANDATE_PENDING } : {}),
    };
    const { data: attached, error } = await db.from('membership_billing_agreements').update(mandateFields)
      .eq('id', agreement.id).eq('tenant_id', tenantId).eq('status', agreement.status)
      .select('*').maybeSingle();
    if (error) throw new Error(`Could not attach renewal mandate: ${error.message}`);
    if (!attached) throw new Error('Renewal agreement lifecycle changed while attaching its mandate; retry required.');
    agreement = attached;
    await d.ensureSubscription(agreement, { db, gc: deps.gc, now: d.now });
    await d.activateMembership(agreement, { trigger: 'mandate_active', db });
    await completeRollingMonthlySetup(db, agreement);
    await upsertRenewalRow(db, {
      tenant_id: tenantId, [ownerColumn]: ownerId, previous_agreement_id: previousAgreement.id,
      renewal_year: yearLabel, mode: 'auto', status: 'renewed',
      new_agreement_id: agreement.id, notice_sent_at: renewalRow?.notice_sent_at,
    });
    if (agreement.metadata?.renewal_setup_pending) {
      await d.sendEmail('renewal_confirmed', agreement, {
        db, ...(d.send ? { send: d.send } : {}),
      });
    }
    return { renewed: true, agreement, detail: `renewed into ${yearLabel}` };
  }

  const mandate = await d.findMandate({ tenantId, memberId, db });
  if (!mandate) return { renewed: false, detail: 'no reusable active mandate' };

  const idempotencyKey = buildIdempotencyKey('dd-agree', tenantId, memberId, yearLabel);
  const { data: existingAgreement } = await db
    .from('membership_billing_agreements')
    .select('*')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();
  if (existingAgreement) {
    return { renewed: false, agreement: existingAgreement, detail: 'renewal agreement already exists' };
  }

  // Fresh immutable snapshot at CURRENT tier terms — never copied from the
  // previous agreement.
  const snapshot = buildDdRenewalSnapshot({ previousAgreement, offer, simResult });

  const { data: agreement, error: agreeErr } = await db
    .from('membership_billing_agreements')
    .insert({
      tenant_id: tenantId,
      member_id: memberId,
      agreement_type: 'member',
      status: STATUS.MANDATE_PENDING,
      idempotency_key: idempotencyKey,
      gocardless_mandate_id: mandate.mandateId,
      gocardless_customer_id: mandate.customerId,
      environment: previousAgreement.environment || 'sandbox',
      metadata: { dd: { ...snapshot, renewal_of_agreement_id: previousAgreement.id, renewal_mode: 'auto' } },
    })
    .select()
    .single();
  if (agreeErr) {
    if (agreeErr.code === '23505') {
      const { data: raced } = await db
        .from('membership_billing_agreements')
        .select('*').eq('idempotency_key', idempotencyKey).maybeSingle();
      return { renewed: false, agreement: raced || null, detail: 'renewal agreement created concurrently' };
    }
    throw new Error(`insert renewal agreement failed: ${agreeErr.message}`);
  }

  const { error: histErr } = await db.from('member_membership_history').insert({
    tenant_id: tenantId,
    member_id: memberId,
    membership_year: yearLabel,
    config_id: simResult.config?.id || null,
    band_id: simResult.matchedBand?.id || null,
    tier_label: simResult.tierLabel,
    field_value: simResult.fieldValue,
    annual_cost: simResult.annualCost,
    final_cost: snapshot.plan_total,
    currency: offer.currency,
    billing_period: 'monthly_direct_debit',
    vat_rate_percent: simResult.vatRatePercent || null,
    vat_amount: simResult.vatAmount || 0,
    total_with_vat: snapshot.plan_total,
    payment_method: 'direct_debit',
    status: 'pending_payment_setup',
    payment_status: 'unpaid',
    billing_agreement_id: agreement.id,
    notes: `Automatic Direct Debit renewal: ${offer.instalmentCount} x ${offer.currency} ${offer.monthlyAmount}`,
  });
  if (histErr && histErr.code !== '23505') {
    console.error('[DD Renewals] history insert failed:', histErr.message);
  }

  const subResult = await d.ensureSubscription(agreement, { db: deps.db ? db : undefined, gc: deps.gc });
  await d.activateMembership(agreement, { trigger: 'mandate_active', db });

  if (renewalRow) {
    await upsertRenewalRow(db, {
      tenant_id: tenantId,
      member_id: memberId,
      previous_agreement_id: previousAgreement.id,
      renewal_year: renewalRow.renewal_year,
      mode: 'auto',
      status: 'renewed',
      notice_sent_at: renewalRow.notice_sent_at,
      new_agreement_id: agreement.id,
      confirmed_at: new Date().toISOString(),
    });
  }

  await d.sendEmail('renewal_confirmed', agreement, {
    db,
    ...(d.send ? { send: d.send } : {}),
    extraContext: { firstChargeDate: subResult?.plan?.next_charge_date || subResult?.plan?.start_date || null },
  });

  return { renewed: true, agreement, detail: `renewed into ${yearLabel}` };
}

/**
 * Cron entry point: process DD renewals for one tenant's member agreements.
 * Mutates `results` ({ ddRenewalsProcessed, ddRenewalNotices, ddRenewed,
 * details[] } counters are created on demand).
 */
export async function processTenantDdRenewals(tenantId, results, deps = {}) {
  const d = defaultDeps(deps);
  const db = d.db;
  const today = d.now();
  results.details = results.details || [];
  const control = results.__renewalControl;
  const agreementQuery = () => db.from('membership_billing_agreements')
    .select('*').eq('tenant_id', tenantId)
    .eq('metadata->dd->>kind', 'monthly_direct_debit');

  const { data: agreements, error } = control
    ? { data: [], error: null }
    : await agreementQuery();
  if (error) {
    results.errors = (results.errors || 0) + 1;
    results.details.push({ tenantId, step: 'dd-renewals', status: 'error', reason: error.message });
    return;
  }
  if (!control && !agreements?.length) return;

  // Only consider the latest agreement per member (earlier years superseded).
  const latestByMember = new Map();
  for (const a of agreements) {
    if (a.metadata?.renewal_setup_pending) continue;
    const ownerKey = a.organization_id ? `org:${a.organization_id}` : `member:${a.member_id}`;
    const prev = latestByMember.get(ownerKey);
    if (!prev || new Date(a.created_at) > new Date(prev.created_at)) latestByMember.set(ownerKey, a);
  }

  // Task #3586: paused members are excluded from DD renewal processing.
  const pausedMemberIds = control ? null : await getPausedMemberIdSet(tenantId, db);

  const candidates = control
    ? renewalRows(agreementQuery, { control, results })
    : latestByMember.values();
  for await (const agreement of candidates) {
    try {
      const ownerColumn = agreement.organization_id ? 'organization_id' : 'member_id';
      const ownerId = agreement.organization_id || agreement.member_id;
      if (!ownerId || (agreement.organization_id && agreement.member_id)) {
        throw new Error('Direct Debit renewal has an ambiguous membership owner.');
      }
      if (control) {
        if (agreement.metadata?.renewal_setup_pending) continue;
        // A page must not redefine "latest": an older agreement's successor may
        // be on another page. Resolve against the whole tenant/member scope.
        const { data: latest, error: latestError } = await agreementQuery()
          .eq(ownerColumn, ownerId)
          .or('metadata->>renewal_setup_pending.is.null,metadata->>renewal_setup_pending.eq.false')
          .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1);
        if (latestError) throw new Error(`Could not check latest DD agreement: ${latestError.message}`);
        if (latest?.[0]?.id !== agreement.id) continue;
      }
      const paused = pausedMemberIds || (agreement.member_id ? await getPausedMemberIdSet(tenantId, db, [agreement.member_id]) : new Set());
      if (paused.has(agreement.member_id)) {
        results.details.push({ tenantId, agreementId: agreement.id, step: 'dd-renewals', status: 'skipped', reason: 'Membership paused' });
        continue;
      }
      const snapshot = agreement.metadata?.dd;
      await assertTrustedMonthlyTerm(db, tenantId, snapshot);
      const window = computeRenewalWindow(snapshot);
      if (!window || today < window.noticeDate) continue;

      const { data: plans, error: planError } = await db
        .from('membership_payment_plans')
        .select('id, status')
        .eq('billing_agreement_id', agreement.id)
        .order('created_at', { ascending: false })
        .limit(1);
      if (planError) throw new Error(`Could not load DD payment plan: ${planError.message}`);
      const planStatus = plans?.[0]?.status || null;
      // Fail closed before notices or renewal creation: a query failure and
      // genuine debt are both blockers, never permission to renew.
      if (!plans?.[0]?.id) {
        results.details.push({ tenantId, agreementId: agreement.id, step: 'dd-renewals', status: 'blocked', reason: 'missing payment plan' });
        continue;
      }
      try {
        await assertNoOpenMonthlyArrears({ tenantId, planId: plans[0].id, db });
      } catch (arrearsErr) {
        if (arrearsErr.code === 'RENEWAL_BUDGET_EXHAUSTED') throw arrearsErr;
        results.details.push({ tenantId, agreementId: agreement.id, step: 'dd-renewals', status: 'blocked', reason: arrearsErr.message });
        continue;
      }

      const renewalYear = monthlyRenewalIdentity(snapshot) || deriveNextYearLabel(snapshot.membership_year) || `after ${snapshot.membership_year}`;

      const { data: renewalRow, error: renewalError } = await db
        .from('membership_dd_renewals')
        .select('*')
        .eq('previous_agreement_id', agreement.id)
        .eq('renewal_year', renewalYear)
        .maybeSingle();
      if (renewalError) throw new Error(`Could not check DD renewal: ${renewalError.message}`);

      // Renewal year already recorded via a different payment method?
      const { data: nextYearRows, error: historyError } = await db
        .from(agreement.organization_id ? 'organisation_membership_history' : 'member_membership_history')
        .select('id, payment_method, billing_agreement_id')
        .eq('tenant_id', tenantId)
        .eq(ownerColumn, ownerId)
        .eq('membership_year', renewalYear)
        .limit(1);
      if (historyError) throw new Error(`Could not check DD renewal history: ${historyError.message}`);
      const nextRecord = nextYearRows?.[0] || null;
      const hasNextYearRecord = !!nextRecord && nextRecord.payment_method !== 'direct_debit';

      // Live pricing is consulted; collection authority remains saved consent.
      const simResult = await simulateMonthlySuccessor({
        tenantId, memberId: agreement.member_id, organizationId: agreement.organization_id, snapshot,
        simulate: deps.simulate || (agreement.organization_id ? simulateMembershipForOrg : d.simulate),
        source: 'dd-renewal', resolveConfig: deps.resolveConfig, db, provider: 'gocardless',
      });
      const authority = resolveSavedCollectionPolicy(snapshot);
      const offer = simResult?.success && !authority.needs_review ? resolveDdOffer({
        ...simResult, config: { ...simResult.config, dd_policy_version: 1,
          dd_collection_end_policy: authority.end_policy, dd_pricing_policy: authority.pricing_policy },
      }) : null;

      const decision = decideRenewalAction({
        snapshot,
        planStatus,
        autoRenew: resolveSavedCollectionPolicy(snapshot).end_policy === 'continue',
        renewalRow,
        hasNextYearRecord,
        today,
      });

      if (decision.action === 'send_notice') {
        if (!offer) {
          results.details.push({ tenantId, agreementId: agreement.id, step: 'dd-renewal-notice', status: 'skipped', reason: 'DD not offered for renewal year' });
          continue;
        }
        const eventKey = decision.mode === 'auto' ? 'renewal_notice' : 'renewal_confirmation_required';
        if (monthlySnapshotCommitment(snapshot)) {
          const outcome = await sendRollingMonthlyNotice({
            db, tenantId, agreement, renewalYear, mode: decision.mode, eventKey, now: today,
            sendEmail: (key, row, options) => d.sendEmail(key, row, { ...options, ...(d.send ? { send: d.send } : {}) }),
            extraContext: {
              renewalYear: `${new Date(simResult.membershipYear.start).toISOString().slice(0, 10)} – ${new Date(simResult.membershipYear.end).toISOString().slice(0, 10)}`,
              newMonthlyAmount: Number(offer.monthlyAmount).toFixed(2),
              newInstalmentCount: offer.instalmentCount, newPlanTotal: offer.planTotal == null ? null : Number(offer.planTotal).toFixed(2),
              newCurrency: offer.currency,
            },
          });
          if (outcome.sent) results.ddRenewalNotices = (results.ddRenewalNotices || 0) + 1;
          continue;
        }
        await d.sendEmail(eventKey, agreement, {
          db,
          ...(d.send ? { send: d.send } : {}),
          extraContext: {
            renewalYear,
            newMonthlyAmount: Number(offer.monthlyAmount).toFixed(2),
            newInstalmentCount: offer.instalmentCount,
            newPlanTotal: offer.planTotal == null ? null : Number(offer.planTotal).toFixed(2),
            newCurrency: offer.currency,
          },
        });
        await upsertRenewalRow(db, {
          tenant_id: tenantId,
          [ownerColumn]: ownerId,
          previous_agreement_id: agreement.id,
          renewal_year: renewalYear,
          mode: decision.mode,
          status: 'notice_sent',
          notice_sent_at: new Date().toISOString(),
        });
        results.ddRenewalNotices = (results.ddRenewalNotices || 0) + 1;
        results.details.push({ tenantId, agreementId: agreement.id, step: 'dd-renewal-notice', status: 'sent', mode: decision.mode, renewalYear });
      } else if (decision.action === 'renew_auto') {
        const outcome = await executeAutoRenewal({
          tenantId,
          memberId: agreement.member_id,
          organizationId: agreement.organization_id,
          previousAgreement: agreement,
          renewalRow,
          deps,
        });
        if (outcome.renewed) results.ddRenewed = (results.ddRenewed || 0) + 1;
        results.details.push({ tenantId, agreementId: agreement.id, step: 'dd-auto-renewal', status: outcome.renewed ? 'renewed' : 'skipped', reason: outcome.detail });
      }
      results.ddRenewalsProcessed = (results.ddRenewalsProcessed || 0) + 1;
    } catch (err) {
      if (err.code === 'RENEWAL_BUDGET_EXHAUSTED') throw err;
      console.error(`[DD Renewals] tenant ${tenantId} agreement ${agreement.id} failed:`, err.message);
      results.errors = (results.errors || 0) + 1;
      results.details.push({ tenantId, agreementId: agreement.id, step: 'dd-renewals', status: 'error', reason: err.message });
    }
  }
}

/**
 * Best-effort: mark a pending confirmation-required renewal as confirmed
 * when the member starts DD for the renewal year themselves (via the
 * existing direct-debit start endpoint).
 */
export async function markRenewalConfirmed({ tenantId, memberId, yearLabel, newAgreementId, db: dbArg } = {}) {
  const db = dbArg || supabase;
  try {
    const { error } = await db
      .from('membership_dd_renewals')
      .update({
        status: 'confirmed',
        confirmed_at: new Date().toISOString(),
        new_agreement_id: newAgreementId || null,
        updated_at: new Date().toISOString(),
      })
      .eq('tenant_id', tenantId)
      .eq('member_id', memberId)
      .eq('renewal_year', yearLabel)
      .eq('status', 'notice_sent');
    if (error) console.error('[DD Renewals] markRenewalConfirmed failed:', error.message);
  } catch (err) {
    console.error('[DD Renewals] markRenewalConfirmed failed:', err.message);
  }
}
