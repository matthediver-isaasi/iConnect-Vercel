import { buildRollingCommitment } from './rollingMembershipCommitment.js';
import { membershipIncentiveSnapshot } from './membershipIncentiveSnapshot.js';
import { computeAddonTotals } from './membershipAddons.js';

/** Freeze server-derived simulation, including addon prices, before charging. */
export function snapshotFormMembershipPayment(simulation, addonLines = [], paymentMethod = 'stripe') {
  const simResult = structuredClone(simulation);
  if (!simResult.commitment_snapshot) Object.assign(simResult, membershipIncentiveSnapshot(simResult));
  if (simResult.config?.start_mode === 'immediate' && !simResult.commitment) {
    const start = new Date(simResult.membershipYear?.start).toISOString().slice(0, 10);
    if ((simResult.config.effective_from && simResult.config.effective_from > start)
        || (simResult.config.effective_to && simResult.config.effective_to < start)) {
      throw new Error('Selected membership structure is not effective on the agreed commencement date');
    }
  }
  const addons = computeAddonTotals(addonLines);
  const commitment = simResult.commitment || buildRollingCommitment({
    config: simResult.config,
    startDate: simResult.membershipYear?.start,
    previousTerm: simResult.previousTerm,
    paymentMethod,
    paymentFrequency: 'upfront',
    amounts: {
      annual_cost: simResult.annualCost,
      final_cost: Math.round((Number(simResult.finalCost) + addons.subtotal) * 100) / 100,
      vat_amount: Math.round((Number(simResult.vatAmount ?? 0) + addons.vat) * 100) / 100,
      total_with_vat: Math.round((Number(simResult.totalWithVat ?? simResult.finalCost) + addons.total) * 100) / 100,
      currency: simResult.currency || 'GBP',
    },
    pricingSnapshot: { matchedBand: simResult.matchedBand, customDiscountDetails: simResult.customDiscountDetails, addonLines },
  });
  if (commitment.term_key) {
    simResult.commitment = commitment;
    simResult.membershipYear.label = commitment.term_key;
  }
  return { version: 1, simResult, addonLines: structuredClone(addonLines) };
}

export async function saveFormMembershipPaymentQuote(db, { tenantId, memberId, organizationId, snapshot }) {
  const { data, error } = await db.rpc('reserve_form_membership_payment_quote', {
    p_tenant_id: tenantId, p_member_id: memberId, p_organization_id: organizationId || null, p_quote: snapshot,
  });
  if (error || !data?.id) throw new Error(`Could not save membership payment terms: ${error?.message || 'missing quote id'}`);
  return data;
}

export async function bindFormMembershipPaymentQuote(db, quote, pi) {
  const { data, error } = await db.rpc('bind_form_membership_payment_quote', {
    p_quote_id: quote.id, p_tenant_id: quote.tenant_id, p_payment_intent_id: pi.id,
  });
  if (error || data !== true) throw new Error(`Could not bind saved membership terms to payment: ${error?.message || 'binding failed'}`);
}

export async function createReservedFormMembershipIntent(db, stripe, reservation, now = new Date()) {
  if (reservation.stripe_payment_intent_id) {
    return stripe.paymentIntents.retrieve(reservation.stripe_payment_intent_id);
  }
  // Stripe may evict idempotency keys after 24h. An unresolved old reservation
  // is review-only: never create a second intent after that protection expires.
  if (new Date(now) - new Date(reservation.created_at) > 23 * 60 * 60 * 1000) {
    throw new Error('This membership payment reservation requires review before retrying');
  }
  const params = reservation.quote.paymentIntentParams;
  if (!params) throw new Error('Reserved membership quote has no authoritative payment parameters');
  const pi = await stripe.paymentIntents.create({
    ...params, metadata: { ...params.metadata, membership_quote_id: reservation.id },
  }, { idempotencyKey: `membership-quote:${reservation.id}` });
  await bindFormMembershipPaymentQuote(db, reservation, pi);
  return pi;
}

export async function loadFormMembershipPaymentQuote(db, pi) {
  const id = pi.metadata?.membership_quote_id;
  if (!id && (pi.metadata?.membership_quote_version
      || String(pi.metadata?.membership_year || '').startsWith('rolling:'))) {
    throw new Error('Payment has no authoritative saved membership quote; administrator review required');
  }
  if (!id) return null; // Legacy PI: caller must use its explicit legacy policy.
  const { data, error } = await db.from('membership_payment_quote').select('*')
    .eq('id', id).eq('tenant_id', pi.metadata.tenant_id)
    .eq('member_id', pi.metadata.member_id).maybeSingle();
  if (error || !data) throw new Error(`Saved membership payment terms unavailable: ${error?.message || 'quote not found'}`);
  if ((data.organization_id || null) !== (pi.metadata.organization_id || null)
      || data.quote?.simResult?.membershipYear?.label !== pi.metadata.membership_year) {
    throw new Error('Saved membership payment terms do not match the payment identity');
  }
  if (data.stripe_payment_intent_id && data.stripe_payment_intent_id !== pi.id) {
    throw new Error('Saved membership quote belongs to another PaymentIntent');
  }
  // Provider confirmation may beat the response-side bind after PI creation.
  // The signed PI's opaque quote metadata safely repairs that crash window.
  if (!data.stripe_payment_intent_id && pi.id) await bindFormMembershipPaymentQuote(db, data, pi);
  return { ...data.quote, quoteId: data.id, memberId: data.member_id, organizationId: data.organization_id || null };
}

/** Reconciliation must reconstruct the same breakdown, not infer net from gross. */
export function historyFromFormPaymentSnapshot(snapshot) {
  const sim = snapshot.simResult;
  const addons = computeAddonTotals(snapshot.addonLines || []);
  return {
    ...(sim.commitment_snapshot ? { commitment_snapshot: structuredClone(sim.commitment_snapshot) } : membershipIncentiveSnapshot(sim)),
    ...(snapshot.quoteId ? { membership_payment_quote_id: snapshot.quoteId } : {}),
    ...(!sim.commitment && sim.paymentSchedule ? sim.paymentSchedule : {}),
    ...(sim.commitment || {}),
    membership_year: sim.membershipYear?.label,
    config_id: sim.config?.id || null,
    band_id: sim.matchedBand?.id || null,
    tier_label: sim.tierLabel,
    field_value: sim.fieldValue,
    annual_cost: sim.annualCost,
    prorata_cost: sim.prorataCost,
    free_period_discount: sim.freeDiscount || 0,
    rollover_discount: sim.rolloverDiscount || 0,
    override_applied: sim.overrideApplied || false,
    override_type: sim.overrideType || null,
    custom_discount_total: sim.customDiscountTotal || 0,
    custom_discount_details: sim.customDiscountDetails?.length ? sim.customDiscountDetails : null,
    final_cost: Math.round((Number(sim.finalCost) + addons.subtotal) * 100) / 100,
    vat_amount: Math.round((Number(sim.vatAmount || 0) + addons.vat) * 100) / 100,
    total_with_vat: Math.round((Number(sim.totalWithVat ?? sim.finalCost) + addons.total) * 100) / 100,
    vat_rate_percent: sim.vatRatePercent || null,
    currency: sim.currency || 'GBP',
    billing_period: sim.billingPeriod || 'annual',
    year_number: sim.yearNumber || null,
    prorata_days: sim.prorataDays || null,
    free_period_days_applied: sim.freePeriodDaysApplied || 0,
  };
}

export function formPaymentActivationFields(commitment, now = new Date()) {
  const scheduled = commitment?.term_start_date > new Date(now).toISOString().slice(0, 10);
  return {
    status: scheduled ? 'scheduled' : 'active',
    ...(scheduled ? { scheduled_activation_date: commitment.term_start_date } : {}),
  };
}