import { resolveDdOffer } from './ddOfferCore.js';
import { buildRollingCommitment } from './rollingMembershipCommitment.js';
import { isDeepStrictEqual } from 'node:util';

export const START_PAYMENT_MODES = ['stripe_upfront', 'stripe_monthly', 'direct_debit', 'invoice', 'free'];
export const startPaymentMethod = mode => ({ stripe_upfront: 'stripe', stripe_monthly: 'card_monthly', direct_debit: 'direct_debit', invoice: 'invoice', free: null })[mode];

export function startPaymentOptions(config, band, availability = {}) {
  const price = Number(config.pricing_model === 'flat' ? config.flat_cost : band?.annual_cost);
  const scopeReason = config.structure_scope_type !== 'member' || config.billing_period !== 'annual'
    || !['immediate', 'fixed_date'].includes(config.start_mode) || !['flat', 'tiered'].includes(config.pricing_model)
    ? 'Start requires an annual individual structure with rolling or fixed-date commencement.'
    : config.free_period_amount || config.rollover_enabled
      ? 'This structure has incentives or rollover requiring the existing reviewed membership pricing flow.' : null;
  let offer, ddReason = null;
  try { offer = resolveDdOffer({ success: true, config: { ...config, dd_enabled: true, dd_auto_renew: config.dd_auto_renew ?? false }, matchedBand: band, currency: config.currency }); }
  catch (error) { ddReason = error.message; }
  if (config.dd_enabled && config.dd_auto_renew == null && config.dd_policy_version == null) ddReason = 'Direct Debit collection policy requires administrator review.';
  let cardOffer, cardReason;
  try { cardOffer = startMonthlyOffer(config, band, 'stripe_monthly'); }
  catch (error) { cardReason = error.message; }
  const reasons = {
    stripe_upfront: !config.online_card_payment ? 'Upfront card payment is not enabled on this structure.' : !availability.stripe ? 'Stripe membership payments are not configured.' : null,
    stripe_monthly: !config.card_monthly_enabled ? 'Monthly card is not enabled on this structure.' : !cardOffer ? cardReason || 'A positive monthly amount is required for the selected price band.' : !availability.stripe ? 'Stripe membership payments are not configured.' : null,
    direct_debit: !config.dd_enabled ? 'Direct Debit is not enabled on this structure.' : ddReason || (!offer ? 'A positive monthly amount is required for the selected price band.' : !availability.directDebit ? 'GoCardless is not configured.' : null),
    invoice: !availability.invoice ? 'The durable accounting queue and a connected accounting provider are required.' : null,
    free: price !== 0 ? 'Free is available only when nothing is due.' : null,
  };
  return START_PAYMENT_MODES.map(mode => {
    const reason = scopeReason || (['stripe_upfront', 'invoice'].includes(mode) && price === 0 ? 'Nothing is due: choose free.'
      : !availability.stripe && mode.startsWith('stripe_') && availability.stripeUnavailableReason ? availability.stripeUnavailableReason
        : !availability.directDebit && mode === 'direct_debit' && availability.directDebitUnavailableReason ? availability.directDebitUnavailableReason
          : reasons[mode]);
    return { mode, available: !reason, reason };
  });
}

export function startMonthlyOffer(config, band, mode) {
  if (!['stripe_monthly', 'direct_debit'].includes(mode)) return null;
  const offer = resolveDdOffer({ success: true, config: { ...config, dd_enabled: true, ...(mode === 'stripe_monthly' ? { dd_auto_renew: config.dd_auto_renew ?? false, dd_policy_version: 1, dd_collection_end_policy: config.dd_auto_renew === false ? 'stop' : 'continue', dd_pricing_policy: 'fixed' } : {}) }, matchedBand: band, currency: config.currency });
  if (!offer) throw new Error('A positive monthly amount is required for the selected structure/band.');
  if (mode === 'stripe_monthly' ? !config.card_monthly_enabled : !config.dd_enabled) throw new Error('The selected structure does not enable this monthly payment method.');
  if (mode === 'stripe_monthly') {
    offer.planTotal = Math.round(offer.monthlyAmountMinor * offer.instalmentCount) / 100;
    offer.autoRenew = config.dd_auto_renew !== false;
  }
  return offer;
}

export function startMonthlyCommitment({ config, quote, amounts, pricingSnapshot, mode }) {
  const commitment = buildRollingCommitment({
    config: { ...config, start_mode: 'immediate' }, startDate: quote.termStart,
    paymentMethod: startPaymentMethod(mode), paymentFrequency: 'monthly', amounts, pricingSnapshot,
  });
  if (config.start_mode === 'fixed_date') {
    commitment.term_end_date = quote.termEnd;
    commitment.membership_renewal_date = new Date(Date.parse(`${quote.termEnd}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    commitment.term_key = `fixed:${quote.termStart}`;
  }
  Object.assign(commitment.commitment_snapshot, { start_mode: config.start_mode, config, member_start_version: 1 });
  return commitment;
}

/** Dedicated versioned authority, including fixed-date upfront purchases.
 * Never fall back to live matching when a Start envelope is present but invalid. */
export function simulationFromMemberStart(token) {
  const saved = token?.cost_breakdown?.memberStart;
  if (!saved) return null;
  const q = saved.quote;
  const config = q?.targetSnapshot?.config;
  const band = q?.targetSnapshot?.band;
  const dynamic = q?.paymentMode === 'direct_debit' && q?.paymentOffer?.collectionPolicy?.pricing_policy === 'dynamic';
  const fail = () => { throw Object.assign(new Error('The saved membership Start purchase is incomplete or inconsistent; administrator review is required.'),
    { status: 409, code: 'member_start_snapshot_invalid' }); };
  if (saved.version !== 1 || !saved.requestId || saved.tenantId !== token.tenant_id || saved.memberId !== token.member_id
      || token.organization_id || saved.recordId !== token.history_record_id
      || !q || q.version !== 2 || !config || config.id !== q.configId || config.tenant_id !== token.tenant_id
      || (q.bandId || null) !== (band?.id || null) || (band && (band.config_id !== config.id || band.tenant_id !== token.tenant_id))
      || !START_PAYMENT_MODES.includes(q.paymentMode) || q.membershipYear !== token.membership_year
      || !/^\d{4}-\d{2}-\d{2}$/.test(q.termStart || '') || !/^\d{4}-\d{2}-\d{2}$/.test(q.termEnd || '')
      || !Number.isFinite(Date.parse(q.termStart)) || !Number.isFinite(Date.parse(q.termEnd)) || q.termStart > q.termEnd
      || (token.final_cost == null ? q.finalCost !== null : Number(token.final_cost) !== q.finalCost) || token.currency !== q.currency
      || !Number.isFinite(q.annualCost) || q.annualCost < 0
      || (dynamic ? ![q.finalCost, q.vatAmount, q.totalWithVat, q.paymentOffer.planTotal].every(n => n === null)
        || q.commitment?.commitment_snapshot?.collection_policy?.pricing_policy !== 'dynamic'
        : ![q.finalCost, q.vatAmount, q.totalWithVat].every(n => Number.isFinite(n) && n >= 0)
          || Math.round((q.finalCost + q.vatAmount) * 100) !== Math.round(q.totalWithVat * 100))) fail();
  if (q.commitment?.term_key && (q.commitment.term_start_date !== q.termStart || q.commitment.term_end_date !== q.termEnd
      || q.commitment.commitment_snapshot?.config_id !== q.configId
      || q.commitment.commitment_snapshot?.payment_method !== startPaymentMethod(q.paymentMode)
      || q.commitment.commitment_snapshot?.amounts?.total_with_vat !== q.totalWithVat)) fail();
  if (new Date(`${q.termStart}T00:00:00Z`).toISOString().slice(0, 10) !== q.termStart
      || new Date(`${q.termEnd}T00:00:00Z`).toISOString().slice(0, 10) !== q.termEnd) fail();
  if (['stripe_monthly', 'direct_debit'].includes(q.paymentMode)) {
    const offer = q.paymentOffer;
    const snapshot = q.commitment?.commitment_snapshot;
    if (!q.commitment?.term_key || !offer || !Number.isFinite(offer.monthlyAmount) || offer.monthlyAmount <= 0
        || offer.monthlyAmountMinor !== Math.round(offer.monthlyAmount * 100)
        || !Number.isInteger(offer.instalmentCount) || offer.instalmentCount < 1 || offer.instalmentCount > 12
        || !['mandate', 'first_payment', 'manual'].includes(offer.activationRule)
        || offer.currency !== q.currency || !isDeepStrictEqual(snapshot?.config, config)
        || snapshot?.amounts?.annual_cost !== q.annualCost || snapshot?.amounts?.final_cost !== q.finalCost
        || snapshot?.amounts?.vat_amount !== q.vatAmount || snapshot?.amounts?.currency !== q.currency
        || snapshot?.amounts?.monthly_amount !== offer.monthlyAmount || snapshot?.amounts?.instalment_count !== offer.instalmentCount
        || (q.paymentMode === 'direct_debit' && !isDeepStrictEqual(snapshot?.collection_policy, offer.collectionPolicy))) fail();
  } else if (config.start_mode === 'immediate' && !q.commitment?.term_key) fail();
  return startQuoteSimulation(q, { requestId: saved.requestId, recordId: saved.recordId, paymentMode: q.paymentMode, termStart: q.termStart, termEnd: q.termEnd });
}

export function startQuoteSimulation(q, memberStart = { paymentMode: q.paymentMode }) {
  const config = q.targetSnapshot.config;
  const band = q.targetSnapshot.band;
  return {
    success: true, config, matchedBand: band || null, tierLabel: q.tierLabel, currency: q.currency,
    annualCost: q.annualCost, finalCost: q.finalCost, vatAmount: q.vatAmount, totalWithVat: q.totalWithVat,
    vatRatePercent: q.vatRatePercent, billingPeriod: config.billing_period,
    membershipYear: { label: q.membershipYear, start: new Date(`${q.termStart}T00:00:00Z`), end: new Date(`${q.termEnd}T00:00:00Z`) },
    commitment: q.commitment?.term_key ? q.commitment : null,
    existingRecord: memberStart.recordId ? { id: memberStart.recordId } : null,
    memberStart,
    paymentSchedule: { term_start_date: q.termStart, term_end_date: q.termEnd },
  };
}

export function assertMemberStartAction(token, action) {
  const sim = simulationFromMemberStart(token);
  if (!sim) return;
  const allowed = { stripe_upfront: ['create_payment', 'confirm_payment'], stripe_monthly: ['start_monthly_card'], direct_debit: ['start_direct_debit'] };
  if (!allowed[sim.memberStart.paymentMode]?.includes(action)) {
    const error = new Error('This membership purchase must use its saved payment method. Contact your administrator to review a different method.');
    error.status = 409;
    error.code = 'member_start_payment_mode_locked';
    throw error;
  }
}

export function assertMemberStartHistory(token, row) {
  const sim = simulationFromMemberStart(token);
  if (!sim) return null;
  const q = token.cost_breakdown.memberStart.quote;
  const sameAmount = (value, expected) => expected === null ? value === null : value != null && Number(value) === expected;
  if (!row || row.id !== sim.memberStart.recordId || row.tenant_id !== token.tenant_id || row.member_id !== token.member_id
      || row.organization_id || row.config_id !== q.configId || (row.band_id || null) !== q.bandId
      || row.term_start_date !== q.termStart || row.term_end_date !== q.termEnd
      || row.membership_year !== q.membershipYear || row.currency !== q.currency
      || row.payment_method !== startPaymentMethod(q.paymentMode)
      || !sameAmount(row.annual_cost, q.annualCost) || !sameAmount(row.final_cost, q.finalCost)
      || !sameAmount(row.vat_amount, q.vatAmount) || !sameAmount(row.total_with_vat, q.totalWithVat)) {
    throw new Error('The saved membership Start history does not match its immutable purchase; administrator review is required.');
  }
  return sim;
}
