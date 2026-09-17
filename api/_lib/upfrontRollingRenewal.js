import { buildRollingCommitment } from './rollingMembershipCommitment.js';

/** Called when an authorised upfront renewal is accepted, before invoicing. */
export function upfrontRollingCommitment(simResult, { paymentMethod = 'invoice', addonTotals = { subtotal: 0, vat: 0, total: 0 } } = {}) {
  if (simResult.config?.start_mode !== 'immediate') return {};
  const cents = value => Math.round(value * 100) / 100;
  return buildRollingCommitment({
    config: simResult.config,
    startDate: simResult.membershipYear.start,
    previousTerm: simResult.previousTerm,
    paymentMethod, paymentFrequency: 'upfront',
    amounts: {
      annual_cost: simResult.annualCost,
      final_cost: cents(simResult.finalCost + addonTotals.subtotal),
      vat_amount: cents((simResult.vatAmount || 0) + addonTotals.vat),
      total_with_vat: cents((simResult.totalWithVat ?? simResult.finalCost) + addonTotals.total),
      currency: simResult.currency,
    },
    pricingSnapshot: {
      band: simResult.matchedBand, tier_label: simResult.tierLabel,
      field_value: simResult.fieldValue, vat_rate_percent: simResult.vatRatePercent,
      customDiscountDetails: simResult.customDiscountDetails || [],
    },
  });
}