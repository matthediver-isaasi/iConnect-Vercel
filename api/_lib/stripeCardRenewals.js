// Task #3621 — renewals for monthly card (Stripe subscription) memberships.
//
// Mirrors the GoCardless DD renewal engine (gocardlessDdRenewals.js) for
// Stripe monthly-card plans (Task #3620), reusing the same pure decision
// logic (decideRenewalAction with expectedKind='monthly_card'), the same
// membership_dd_renewals tracking table (one row per previous agreement +
// renewal year) and the same guards:
//   - no renewal before year end (notice window first),
//   - duplicate next-year record -> never a parallel charge,
//   - paused members skipped,
//   - terminal renewal rows are idempotent.
//
// Provider branch: instead of a reusable GC mandate, the Stripe branch needs
// a reusable Stripe Customer with a usable card payment method (the
// mandate-equivalent). Renewal creates a brand-new fixed-instalment Stripe
// subscription OFF-SESSION against the saved customer — no checkout, no new
// card capture. The subscription carries the same metadata.kind =
// 'monthly_card' so the existing webhook/settlement pipeline (#3620) picks
// up its invoices unchanged.
//
// Failure model: the Stripe subscription is created FIRST (with a Stripe
// idempotency key so cron retries reuse the same subscription instead of
// double-charging). If the saved card is unusable the renewal row is marked
// 'failed' with a reason (surfaced on the admin renewals ledger) and NO
// local records are created.

import { supabase } from './database.js';
import { simulateMembershipForMember } from './membershipSimulation.js';
import {
  deriveNextYearLabel,
  computeRenewalWindow,
  decideRenewalAction,
} from './gocardlessDdRenewals.js';
import {
  CARD_PLAN_KIND,
  resolveCardMonthlyOffer,
  buildCardAgreementSnapshot,
  ensureCardPlanForCheckout,
} from './stripeMonthlyCard.js';
import { getStripeCredentials } from './stripeCredentials.js';
import { resolveDdEmailRecipients } from './gocardlessDdEmails.js';
import { sendTenantEmail } from './tenantEmailService.js';
import { STATUS } from './gocardlessState.js';
import { getPausedMemberIdSet } from './memberPause.js';

// ---------------------------------------------------------------------------
// Card renewal lifecycle emails (card-flavoured twins of the DD renewal set;
// context reads metadata.card instead of metadata.dd).
// ---------------------------------------------------------------------------

const CARD_RENEWAL_EVENTS = {
  renewal_notice: {
    subject: (c) => `Your membership renews soon — ${c.renewalYear || 'next year'}`,
    body: (c) => `
      <p>Hi ${c.firstName},</p>
      <p>Your ${c.yearLabel} membership is coming to an end, and your monthly card payment plan is set to renew automatically for ${c.renewalYear || 'the next membership year'}.</p>
      <p>The renewal plan will be <strong>${c.newInstalmentCount || c.instalmentCount} monthly payments of ${c.newCurrency || c.currency} ${c.newMonthlyAmount || c.monthlyAmount}</strong>${c.newPlanTotal ? ` (total ${c.newCurrency || c.currency} ${c.newPlanTotal})` : ''}, charged to your saved card — no action is needed.</p>
      <p>If you do not wish to renew, or your card details have changed, please contact us before the new membership year begins.</p>`,
  },
  renewal_confirmation_required: {
    subject: (c) => `Action needed — confirm your membership renewal for ${c.renewalYear || 'next year'}`,
    body: (c) => `
      <p>Hi ${c.firstName},</p>
      <p>Your ${c.yearLabel} membership is coming to an end. To continue paying by monthly card payments for ${c.renewalYear || 'the next membership year'}, please confirm your renewal.</p>
      <p>The new plan will be <strong>${c.newInstalmentCount || c.instalmentCount} monthly payments of ${c.newCurrency || c.currency} ${c.newMonthlyAmount || c.monthlyAmount}</strong>${c.newPlanTotal ? ` (total ${c.newCurrency || c.currency} ${c.newPlanTotal})` : ''}.</p>
      <p>Confirm from your membership payment page once the new membership year opens.</p>
      <p>If you do nothing, no payment will be taken for the new year.</p>`,
  },
  renewal_confirmed: {
    subject: (c) => `Membership renewal confirmed — ${c.yearLabel}`,
    body: (c) => `
      <p>Hi ${c.firstName},</p>
      <p>Your membership has been renewed for ${c.yearLabel}: ${c.instalmentCount} monthly payments of ${c.currency} ${c.monthlyAmount}, charged to your saved card.</p>
      <p>Your first payment for the new year has been requested. You'll receive a receipt for each monthly payment.</p>`,
  },
  renewal_card_failed: {
    subject: (c) => `Action needed — membership renewal payment problem`,
    body: (c) => `
      <p>Hi ${c.firstName},</p>
      <p>We tried to renew your membership for ${c.renewalYear || 'the new membership year'} using your saved card, but the payment could not be set up${c.failureReason ? ` (${c.failureReason})` : ''}.</p>
      <p>Your membership has NOT been renewed. Please visit your membership payment page to pay with an up-to-date card, or contact us to arrange another payment method.</p>`,
  },
};

function cardContextFromAgreement(agreement, firstName) {
  const snap = agreement?.metadata?.card || {};
  return {
    firstName: firstName || 'Member',
    yearLabel: snap.membership_year || 'this year',
    instalmentCount: snap.instalment_count || 12,
    monthlyAmount: snap.monthly_amount != null ? Number(snap.monthly_amount).toFixed(2) : '',
    currency: snap.currency || 'GBP',
  };
}

/**
 * Send one card-renewal lifecycle email for a card agreement. Recipient
 * resolution is shared with the DD path (member agreements only here).
 * Never throws — returns { sent: boolean }.
 */
export async function sendCardRenewalEmail(eventKey, agreement, { db = supabase, send = sendTenantEmail, extraContext = {} } = {}) {
  try {
    const tpl = CARD_RENEWAL_EVENTS[eventKey];
    if (!tpl) return { sent: false, reason: `unknown event ${eventKey}` };
    const { recipients, reason } = await resolveDdEmailRecipients(agreement, { db });
    if (!recipients.length) return { sent: false, reason: reason || 'no recipients' };
    let sentAny = false;
    let lastError = null;
    for (const recipient of recipients) {
      const ctx = { ...cardContextFromAgreement(agreement, recipient.firstName), ...extraContext };
      const result = await send({
        tenantId: agreement.tenant_id,
        to: recipient.email,
        subject: tpl.subject(ctx),
        html: tpl.body(ctx),
      });
      if (result && result.success === false) {
        console.error(`[Card Renewals] ${eventKey} send failed for agreement ${agreement.id} (${recipient.email}):`, result.error);
        lastError = result.error;
      } else {
        sentAny = true;
      }
    }
    return sentAny ? { sent: true } : { sent: false, reason: lastError || 'send failed' };
  } catch (err) {
    console.error(`[Card Renewals] ${eventKey} failed for agreement ${agreement?.id}:`, err.message);
    return { sent: false, reason: err.message };
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * The tier's renewal mode for card plans. Card plans share the DD renewal
 * setting (dd_auto_renew) — same tier knob drives both providers.
 * Falls back to the previous agreement's snapshot when the live config is
 * unavailable.
 */
export function resolveCardAutoRenew(simResult, snapshot) {
  const config = simResult?.success ? simResult.config : null;
  if (config && 'dd_auto_renew' in config) return config.dd_auto_renew !== false;
  return snapshot?.auto_renew !== false;
}

/**
 * Pick a usable card payment method from a retrieved Stripe customer +
 * its card payment-method list. Preference order: the customer's
 * invoice_settings default, then the subscription-usable first card.
 * Returns the payment-method id or null.
 */
export function pickReusablePaymentMethod(customer, paymentMethods = []) {
  if (!customer || customer.deleted) return null;
  const cards = (paymentMethods || []).filter((pm) => pm?.type === 'card');
  const defaultId = typeof customer.invoice_settings?.default_payment_method === 'string'
    ? customer.invoice_settings.default_payment_method
    : customer.invoice_settings?.default_payment_method?.id || null;
  if (defaultId) {
    const match = cards.find((pm) => pm.id === defaultId);
    if (match) return match.id;
  }
  return cards[0]?.id || null;
}

/**
 * Build the off-session renewal subscription create params. Pure — exported
 * for tests. Mirrors the checkout path's price/cancel_at semantics:
 * cancel_at sits 15 days after the final (Nth) monthly invoice, safely
 * before an (N+1)th could be raised.
 */
export function buildRenewalSubscriptionParams({ customerId, paymentMethodId, offer, tenantId, memberId, yearLabel, previousAgreementId, now = new Date() }) {
  const cancelAt = new Date(now.getTime());
  cancelAt.setUTCMonth(cancelAt.getUTCMonth() + (offer.instalmentCount - 1));
  cancelAt.setUTCDate(cancelAt.getUTCDate() + 15);
  const metadata = {
    kind: CARD_PLAN_KIND,
    tenant_id: tenantId,
    member_id: memberId,
    membership_year: yearLabel || '',
    renewal_of_agreement_id: previousAgreementId || '',
  };
  return {
    customer: customerId,
    default_payment_method: paymentMethodId,
    off_session: true,
    // Hard-fail immediately on an unusable card instead of leaving an
    // incomplete subscription behind — renewal must never partially create.
    payment_behavior: 'error_if_incomplete',
    items: [{
      quantity: 1,
      price_data: {
        currency: (offer.currency || 'GBP').toLowerCase(),
        unit_amount: offer.monthlyAmountMinor,
        recurring: { interval: 'month' },
        product_data: {
          name: `Membership ${yearLabel || ''}`.trim(),
        },
      },
    }],
    cancel_at: Math.floor(cancelAt.getTime() / 1000),
    metadata,
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Resolve Stripe clients for a renewal, honouring the PREVIOUS agreement's
 * recorded environment (test vs live) rather than the currently selected
 * membership mode. A tenant flipping stripe_mode_membership after a plan was
 * created must not strand that plan's saved customer: the customer lives in
 * the account/mode it was created in. Returns the environment-matched client
 * as primary plus the other mode's client (when configured) as an alternate
 * for resource_missing tolerance — same contract as the card-plan webhook/
 * reconcile paths.
 */
async function defaultGetStripe(tenantId, preferredEnvironment) {
  const { getStripeIntegrationCredentials } = await import('./stripeCredentials.js');
  let all = null;
  try {
    all = await getStripeIntegrationCredentials(tenantId);
  } catch {
    all = null;
  }
  if (!all) {
    // Legacy fallback: single feature-selected key.
    const creds = await getStripeCredentials(tenantId, 'membership');
    if (!creds?.secret_key) return null;
    const Stripe = (await import('stripe')).default;
    return {
      stripe: new Stripe(creds.secret_key),
      environment: creds.secret_key.startsWith('sk_test_') ? 'test' : 'live',
      alternate: null,
    };
  }
  const liveKey = all.secret_key || null;
  const testKey = all.test_secret_key || null;
  const wantTest = preferredEnvironment === 'test';
  const primaryKey = wantTest ? (testKey || liveKey) : (liveKey || testKey);
  const otherKey = primaryKey === liveKey ? testKey : liveKey;
  if (!primaryKey) return null;
  const Stripe = (await import('stripe')).default;
  const envOf = (key) => (key.startsWith('sk_test_') ? 'test' : 'live');
  return {
    stripe: new Stripe(primaryKey),
    environment: envOf(primaryKey),
    alternate: otherKey && otherKey !== primaryKey
      ? { stripe: new Stripe(otherKey), environment: envOf(otherKey) }
      : null,
  };
}

function defaultDeps(deps = {}) {
  return {
    db: deps.db || supabase,
    simulate: deps.simulate || simulateMembershipForMember,
    getStripe: deps.getStripe || defaultGetStripe,
    sendEmail: deps.sendEmail || sendCardRenewalEmail,
    send: deps.send, // passed through to sendCardRenewalEmail when set
    ensurePlan: deps.ensurePlan || ensureCardPlanForCheckout,
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
 * Find a reusable Stripe customer + card payment method for renewal — the
 * card analogue of findReusableMandate. Only the customer saved on the
 * previous agreement is considered (renewal must never charge a different
 * customer record). Returns { customerId, paymentMethodId } or null.
 */
export async function findReusableCardPaymentMethod({ stripe, previousAgreement }) {
  const customerId = previousAgreement?.stripe_customer_id || null;
  if (!customerId || !stripe) return null;
  try {
    const customer = await stripe.customers.retrieve(customerId);
    if (!customer || customer.deleted) return null;
    const pms = await stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 10 });
    const paymentMethodId = pickReusablePaymentMethod(customer, pms?.data || []);
    if (!paymentMethodId) return null;
    return { customerId, paymentMethodId };
  } catch (err) {
    console.warn('[Card Renewals] customer/payment-method lookup failed:', err.message);
    return null;
  }
}

/**
 * Create the renewal agreement + history row + off-session subscription for
 * an auto-renew card member. Never touches the previous agreement/plan.
 * Returns { renewed, failed?, agreement?, detail }.
 *
 * `failed: true` marks a hard renewal failure (unusable card / charge
 * declined) that should be recorded on the renewal row and surfaced to
 * admins; plain skips (year not rolled over etc.) return renewed:false only.
 */
export async function executeCardAutoRenewal({ tenantId, memberId, previousAgreement, renewalRow, deps = {} }) {
  const d = defaultDeps(deps);
  const db = d.db;

  const simResult = await d.simulate(tenantId, memberId, { source: 'card-renewal', mode: 'automatic' });
  if (!simResult?.success) return { renewed: false, detail: `simulation failed: ${simResult?.error || 'unknown'}` };
  const yearLabel = simResult.membershipYear?.label;
  if (!yearLabel || yearLabel === previousAgreement.metadata?.card?.membership_year) {
    return { renewed: false, detail: `membership year has not rolled over yet (${yearLabel})` };
  }
  if (simResult.existingRecord) {
    return { renewed: false, detail: `record for ${yearLabel} already exists` };
  }
  const offer = resolveCardMonthlyOffer(simResult);
  if (!offer) return { renewed: false, detail: 'monthly card payment no longer offered for this tier' };

  const idempotencyKey = `card-agree:${tenantId}:${memberId}:${yearLabel}`;
  const { data: existingAgreement } = await db
    .from('membership_billing_agreements')
    .select('*')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();
  if (existingAgreement) {
    return { renewed: false, agreement: existingAgreement, detail: 'renewal agreement already exists' };
  }

  const stripeCtx = await d.getStripe(tenantId, previousAgreement.environment || 'live');
  if (!stripeCtx?.stripe) return { renewed: false, detail: 'Stripe membership credentials unavailable' };

  // Environment-matched account first; on a miss (e.g. mid-life test/live
  // mode flip or a stale recorded environment) retry the alternate account
  // before declaring the saved card unusable — a 'failed' renewal row is
  // terminal, so a wrong-account lookup must never masquerade as a dead card.
  let active = { stripe: stripeCtx.stripe, environment: stripeCtx.environment };
  let reusable = await findReusableCardPaymentMethod({ stripe: active.stripe, previousAgreement });
  if (!reusable && stripeCtx.alternate) {
    const altReusable = await findReusableCardPaymentMethod({ stripe: stripeCtx.alternate.stripe, previousAgreement });
    if (altReusable) {
      console.warn(`[Card Renewals] MODE MISMATCH: customer ${previousAgreement.stripe_customer_id} found in the ${stripeCtx.alternate.environment} account while agreement ${previousAgreement.id} recorded ${previousAgreement.environment || 'live'} (tenant ${tenantId})`);
      active = { stripe: stripeCtx.alternate.stripe, environment: stripeCtx.alternate.environment };
      reusable = altReusable;
    }
  }
  if (!reusable) {
    return { renewed: false, failed: true, detail: 'no reusable saved card payment method' };
  }
  const { stripe, environment } = active;

  // Off-session subscription FIRST, with a Stripe idempotency key so a cron
  // retry after a partial failure reuses the same subscription instead of
  // double-charging. error_if_incomplete makes an unusable card throw here,
  // before any local record exists.
  let subscription;
  try {
    subscription = await stripe.subscriptions.create(
      buildRenewalSubscriptionParams({
        customerId: reusable.customerId,
        paymentMethodId: reusable.paymentMethodId,
        offer,
        tenantId,
        memberId,
        yearLabel,
        previousAgreementId: previousAgreement.id,
        now: d.now(),
      }),
      { idempotencyKey: `card-renew-sub:${tenantId}:${memberId}:${yearLabel}` },
    );
  } catch (err) {
    console.error(`[Card Renewals] off-session subscription failed for member ${memberId}:`, err.message);
    return { renewed: false, failed: true, detail: `card charge setup failed: ${err.message}` };
  }

  // Fresh immutable snapshot at CURRENT tier terms — never copied from the
  // previous agreement.
  const snapshot = buildCardAgreementSnapshot({ offer, simResult });

  const { data: agreement, error: agreeErr } = await db
    .from('membership_billing_agreements')
    .insert({
      tenant_id: tenantId,
      member_id: memberId,
      agreement_type: 'member',
      provider: 'stripe',
      status: STATUS.FIRST_PAYMENT_PENDING,
      idempotency_key: idempotencyKey,
      stripe_customer_id: reusable.customerId,
      stripe_subscription_id: subscription.id,
      // Record the environment of the account that actually holds the new
      // subscription (may differ from the previous agreement after a flip).
      environment: environment || previousAgreement.environment || 'live',
      metadata: { card: { ...snapshot, renewal_of_agreement_id: previousAgreement.id, renewal_mode: 'auto' } },
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
    throw new Error(`insert card renewal agreement failed: ${agreeErr.message}`);
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
    billing_period: 'monthly_card',
    vat_rate_percent: simResult.vatRatePercent || null,
    vat_amount: simResult.vatAmount || 0,
    total_with_vat: snapshot.plan_total,
    payment_method: 'card_monthly',
    status: 'pending_payment_setup',
    payment_status: 'unpaid',
    billing_agreement_id: agreement.id,
    notes: `Automatic card renewal: ${offer.instalmentCount} x ${offer.currency} ${offer.monthlyAmount}`,
  });
  if (histErr && histErr.code !== '23505') {
    console.error('[Card Renewals] history insert failed:', histErr.message);
  }

  // Local plan row so the #3620 webhook pipeline matches the subscription's
  // invoices. ensureCardPlanForCheckout only reads subscription/customer off
  // the "session", so a synthetic one keeps the single insert path.
  await d.ensurePlan({
    agreement,
    session: { subscription: subscription.id, customer: reusable.customerId },
    db,
  });

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
  });

  return { renewed: true, agreement, detail: `renewed into ${yearLabel}` };
}

/**
 * Cron entry point: process monthly-card renewals for one tenant's member
 * agreements. Mirrors processTenantDdRenewals; counters go under
 * cardRenewalsProcessed / cardRenewalNotices / cardRenewed.
 */
export async function processTenantCardRenewals(tenantId, results, deps = {}) {
  const d = defaultDeps(deps);
  const db = d.db;
  const today = d.now();
  results.details = results.details || [];

  const { data: agreements, error } = await db
    .from('membership_billing_agreements')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('agreement_type', 'member')
    .not('member_id', 'is', null)
    .eq('metadata->card->>kind', CARD_PLAN_KIND);
  if (error) {
    results.details.push({ tenantId, step: 'card-renewals', status: 'error', reason: error.message });
    return;
  }
  if (!agreements?.length) return;

  // Only consider the latest agreement per member (earlier years superseded).
  const latestByMember = new Map();
  for (const a of agreements) {
    const prev = latestByMember.get(a.member_id);
    if (!prev || new Date(a.created_at) > new Date(prev.created_at)) latestByMember.set(a.member_id, a);
  }

  // Paused members are excluded from renewal processing (parity with DD).
  const pausedMemberIds = await getPausedMemberIdSet(tenantId, db);

  for (const agreement of latestByMember.values()) {
    try {
      if (pausedMemberIds.has(agreement.member_id)) {
        results.details.push({ tenantId, agreementId: agreement.id, step: 'card-renewals', status: 'skipped', reason: 'Membership paused' });
        continue;
      }
      const snapshot = agreement.metadata?.card;
      const window = computeRenewalWindow(snapshot);
      if (!window || today < window.noticeDate) continue;

      const { data: plans } = await db
        .from('membership_payment_plans')
        .select('id, status')
        .eq('billing_agreement_id', agreement.id)
        .order('created_at', { ascending: false })
        .limit(1);
      const planStatus = plans?.[0]?.status || null;

      const renewalYear = deriveNextYearLabel(snapshot.membership_year) || `after ${snapshot.membership_year}`;

      const { data: renewalRow } = await db
        .from('membership_dd_renewals')
        .select('*')
        .eq('previous_agreement_id', agreement.id)
        .eq('renewal_year', renewalYear)
        .maybeSingle();

      // Renewal year already recorded via a different payment method?
      const { data: nextYearRows } = await db
        .from('member_membership_history')
        .select('id, payment_method, billing_agreement_id')
        .eq('tenant_id', tenantId)
        .eq('member_id', agreement.member_id)
        .eq('membership_year', renewalYear)
        .limit(1);
      const nextRecord = nextYearRows?.[0] || null;
      const hasNextYearRecord = !!nextRecord && nextRecord.payment_method !== 'card_monthly';

      // Live tier terms decide the renewal mode (shared dd_auto_renew knob).
      const simResult = await d.simulate(tenantId, agreement.member_id, { source: 'card-renewal', mode: 'automatic' });
      const offer = simResult?.success ? resolveCardMonthlyOffer(simResult) : null;

      const decision = decideRenewalAction({
        snapshot,
        planStatus,
        autoRenew: resolveCardAutoRenew(simResult, snapshot),
        renewalRow,
        hasNextYearRecord,
        today,
        expectedKind: CARD_PLAN_KIND,
      });

      if (decision.action === 'send_notice') {
        if (!offer) {
          results.details.push({ tenantId, agreementId: agreement.id, step: 'card-renewal-notice', status: 'skipped', reason: 'monthly card not offered for renewal year' });
          continue;
        }
        const eventKey = decision.mode === 'auto' ? 'renewal_notice' : 'renewal_confirmation_required';
        await d.sendEmail(eventKey, agreement, {
          db,
          ...(d.send ? { send: d.send } : {}),
          extraContext: {
            renewalYear,
            newMonthlyAmount: Number(offer.monthlyAmount).toFixed(2),
            newInstalmentCount: offer.instalmentCount,
            newPlanTotal: Number(offer.planTotal).toFixed(2),
            newCurrency: offer.currency,
          },
        });
        await upsertRenewalRow(db, {
          tenant_id: tenantId,
          member_id: agreement.member_id,
          previous_agreement_id: agreement.id,
          renewal_year: renewalYear,
          mode: decision.mode,
          status: 'notice_sent',
          notice_sent_at: new Date().toISOString(),
        });
        results.cardRenewalNotices = (results.cardRenewalNotices || 0) + 1;
        results.details.push({ tenantId, agreementId: agreement.id, step: 'card-renewal-notice', status: 'sent', mode: decision.mode, renewalYear });
      } else if (decision.action === 'renew_auto') {
        const outcome = await executeCardAutoRenewal({
          tenantId,
          memberId: agreement.member_id,
          previousAgreement: agreement,
          renewalRow,
          deps,
        });
        if (outcome.renewed) {
          results.cardRenewed = (results.cardRenewed || 0) + 1;
        } else if (outcome.failed) {
          // Hard failure (unusable card): record it on the renewal row so it
          // surfaces on the admin renewals ledger, and tell the member.
          await upsertRenewalRow(db, {
            tenant_id: tenantId,
            member_id: agreement.member_id,
            previous_agreement_id: agreement.id,
            renewal_year: renewalYear,
            mode: renewalRow?.mode || 'auto',
            status: 'failed',
            notice_sent_at: renewalRow?.notice_sent_at || null,
            failure_reason: outcome.detail,
          });
          await d.sendEmail('renewal_card_failed', agreement, {
            db,
            ...(d.send ? { send: d.send } : {}),
            extraContext: { renewalYear, failureReason: 'your saved card could not be charged' },
          });
        }
        results.details.push({ tenantId, agreementId: agreement.id, step: 'card-auto-renewal', status: outcome.renewed ? 'renewed' : (outcome.failed ? 'failed' : 'skipped'), reason: outcome.detail });
      }
      results.cardRenewalsProcessed = (results.cardRenewalsProcessed || 0) + 1;
    } catch (err) {
      console.error(`[Card Renewals] tenant ${tenantId} agreement ${agreement.id} failed:`, err.message);
      results.details.push({ tenantId, agreementId: agreement.id, step: 'card-renewals', status: 'error', reason: err.message });
    }
  }
}
