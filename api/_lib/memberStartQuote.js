import { createHash } from 'node:crypto';
import { buildRollingCommitment } from './rollingMembershipCommitment.js';
import { amendmentDate, AmendmentError } from './memberAmendmentQuote.js';
import { START_PAYMENT_MODES, startPaymentMethod, startMonthlyOffer, startMonthlyCommitment } from './memberStartPayment.js';

export const START_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const START_CAPABILITIES = { paymentModes: START_PAYMENT_MODES, paymentLink: true, recurring: true };
export function startError(message, status = 422, code = 'start_not_supported') {
  return new AmendmentError(message, status, code);
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
export const startFingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function normalizeStart(input, create = false) {
  if (!START_UUID.test(input?.memberId || '') || !START_UUID.test(input?.configId || '')
      || (input.bandId != null && !START_UUID.test(input.bandId))) throw startError('Valid memberId, configId and optional bandId are required.', 400, 'invalid_request');
  amendmentDate(input.startDate);
  if (!START_PAYMENT_MODES.includes(input.paymentMode)) throw startError('Select a supported membership payment mode.', 400, 'unsupported_payment_mode');
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.trim().length > 2000) throw startError('A reason between 1 and 2000 characters is required.', 400, 'invalid_reason');
  if (create && (!/^[a-f0-9]{64}$/.test(input.expectedQuote || '')
      || !/^[A-Za-z0-9_.:-]{8,128}$/.test(input.idempotencyKey || ''))) throw startError('A preview expectedQuote and stable idempotencyKey are required.', 400, 'invalid_confirmation');
  return { memberId: input.memberId.toLowerCase(), configId: input.configId.toLowerCase(),
    bandId: input.bandId?.toLowerCase() || null, startDate: input.startDate, reason: input.reason.trim(), paymentMode: input.paymentMode };
}
function money(value) {
  if (value == null || value === '' || !Number.isFinite(Number(value)) || Number(value) < 0
      || !Number.isSafeInteger(Math.round(Number(value) * 100))
      || Math.abs(Number(value) * 100 - Math.round(Number(value) * 100)) > 0.00001) throw startError('An exact non-negative configured price is required.');
  return Math.round(Number(value) * 100);
}
const day = text => Date.parse(`${text}T00:00:00Z`);
const date = ms => new Date(ms).toISOString().slice(0, 10);

/** A deliberately bounded purchase quote, never an inference from custom class/expiry.
 * Complex incentives/overrides are rejected rather than approximated or silently lost.
 */
export function buildStartQuote({ request, config, band, discounts = [], vatOverrides = [], overrides = [], vatSetting, today }) {
  const { startDate, paymentMode } = request;
  if (paymentMode === 'member_choice') throw startError('Member choice requires complete per-method quotes from the Start preview service.');
  if (startDate < today) throw startError('Backdating is not supported. Choose today or a future start date.');
  if (!config || config.id !== request.configId || config.structure_scope_type !== 'member' || config.is_active !== true
      || config.billing_period !== 'annual' || !['immediate', 'fixed_date'].includes(config.start_mode)
      || !config.effective_from || config.effective_from > startDate || (config.effective_to && config.effective_to < startDate)) {
    throw startError('Select an active annual personal structure effective on the chosen start date.');
  }
  if (config.free_period_amount || config.rollover_enabled || discounts.length || vatOverrides.length || overrides.length) {
    throw startError('This structure/member has incentives, rollover, discount, VAT override or pricing override rules. Use the existing reviewed membership payment flow; admin Start does not approximate these rules.');
  }
  const flat = config.pricing_model === 'flat';
  if (!flat && config.pricing_model !== 'tiered') throw startError('Unsupported pricing model.');
  if ((flat && request.bandId) || (!flat && (!band || band.id !== request.bandId || band.config_id !== config.id || band.tenant_id !== config.tenant_id))) {
    throw startError('Select one band belonging to this structure, or no band for flat pricing.');
  }
  const currency = config.currency;
  if (!/^[A-Z]{3}$/.test(currency || '') || !Intl.supportedValuesOf('currency').includes(currency)
      || new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits !== 2) throw startError('A supported two-decimal currency is required.');
  const annualMinor = money(flat ? config.flat_cost : band.annual_cost);
  if (paymentMode === 'stripe_upfront' && !config.online_card_payment) throw startError('Upfront card payment is not enabled on this structure.');
  let paymentOffer;
  try { paymentOffer = startMonthlyOffer(config, band, paymentMode); } catch (error) { throw startError(error.message); }
  const tax = flat ? config.flat_vat_rate : band.vat_rate;
  let taxType = null;
  let vatRatePercent = 0;
  if (tax) {
    let parsed;
    try { parsed = typeof tax === 'string' ? JSON.parse(tax) : tax; } catch { parsed = { taxType: tax }; }
    taxType = parsed?.taxType;
    let cache;
    try { cache = JSON.parse(vatSetting?.setting_value || '{}'); } catch { /* fail closed below */ }
    const rates = cache?.rates?.filter(rate => rate.taxType === taxType) || [];
    if (!taxType || rates.length !== 1 || rates[0].effectiveRate == null
        || !Number.isFinite(Number(rates[0].effectiveRate)) || Number(rates[0].effectiveRate) < 0 || Number(rates[0].effectiveRate) > 100) throw startError('VAT requires a unique authoritative saved tenant tax rate.');
    vatRatePercent = Number(rates[0].effectiveRate);
  }
  let termEnd, membershipYear, windowStart, windowEnd;
  if (config.start_mode === 'fixed_date') {
    const month = Number(config.membership_start_month || 1), d = Number(config.membership_start_day || 1);
    let year = Number(startDate.slice(0, 4));
    const anchor = y => `${y}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    amendmentDate(anchor(year));
    if (startDate < anchor(year)) year--;
    windowStart = anchor(year);
    amendmentDate(windowStart);
    amendmentDate(anchor(year + 1));
    windowEnd = date(day(anchor(year + 1)) - 86400000);
    termEnd = windowEnd;
    membershipYear = `${year}/${year + 1}`;
  }
  let finalMinor = annualMinor;
  let prorataDays = null;
  if (config.start_mode === 'fixed_date' && config.prorata_enabled) {
    prorataDays = (day(windowEnd) - day(startDate)) / 86400000 + 1;
    const totalDays = (day(windowEnd) - day(windowStart)) / 86400000 + 1;
    // Match the existing member simulation's four-decimal daily rate.
    const daily = Number((annualMinor / 100 / totalDays).toFixed(4));
    finalMinor = Math.round(Number((daily * prorataDays).toFixed(2)) * 100);
  }
  const initialQuotedAmounts = { finalCost: finalMinor / 100, vatAmount: Math.round(finalMinor * vatRatePercent / 100) / 100,
    totalWithVat: (finalMinor + Math.round(finalMinor * vatRatePercent / 100)) / 100 };
  const dynamic = paymentMode === 'direct_debit' && paymentOffer?.collectionPolicy?.pricing_policy === 'dynamic';
  const validationPlanMinor = paymentOffer ? dynamic ? paymentOffer.monthlyAmountMinor * paymentOffer.instalmentCount : Math.round(paymentOffer.planTotal * 100) : null;
  if (paymentOffer) finalMinor = Math.round(validationPlanMinor / (1 + vatRatePercent / 100));
  const vatMinor = paymentOffer ? validationPlanMinor - finalMinor : Math.round(finalMinor * vatRatePercent / 100);
  const totalMinor = finalMinor + vatMinor;
  if (!Number.isSafeInteger(totalMinor)) throw startError('Quoted total exceeds supported monetary bounds.');
  if ((paymentMode === 'free') !== (totalMinor === 0)) throw startError(totalMinor === 0 ? 'Nothing is due: choose free payment mode.' : 'Payment is due: choose invoice payment mode.');
  const amounts = { annual_cost: annualMinor / 100, final_cost: finalMinor / 100, vat_amount: vatMinor / 100, total_with_vat: totalMinor / 100, currency };
  const tierLabel = flat ? 'Flat Rate' : band.label;
  const pricingSnapshot = { band: band || null, tier_label: tierLabel, vat_rate_percent: vatRatePercent, taxType };
  const commitment = paymentOffer
    ? startMonthlyCommitment({ config, quote: { termStart: startDate, termEnd }, amounts: { ...amounts, monthly_amount: paymentOffer.monthlyAmount, instalment_count: paymentOffer.instalmentCount }, pricingSnapshot, mode: paymentMode })
    : config.start_mode === 'immediate'
    ? buildRollingCommitment({ config, startDate, paymentMethod: startPaymentMethod(paymentMode) || 'free', paymentFrequency: 'upfront', amounts, pricingSnapshot })
    : { term_start_date: startDate, term_end_date: termEnd, commitment_snapshot: { version: 1, start_mode: 'fixed_date', config_id: config.id,
      config, billing_period: 'annual', payment_method: startPaymentMethod(paymentMode), payment_frequency: 'upfront', amounts, pricing: pricingSnapshot } };
  if (paymentMode === 'direct_debit') commitment.commitment_snapshot.collection_policy = paymentOffer.collectionPolicy;
  if (dynamic) {
    // The initial quote remains immutable evidence, not a promise of a fixed
    // term total. Existing dynamic per-instalment pricing owns later amounts.
    for (const key of ['final_cost', 'vat_amount', 'total_with_vat']) {
      amounts[key] = null;
      commitment.commitment_snapshot.amounts[key] = null;
    }
  }
  return { version: 2, paymentOffer, initialQuotedAmounts, configId: config.id, bandId: band?.id || null, paymentMode, termStart: startDate,
    termEnd: commitment.term_end_date, membershipYear: membershipYear || commitment.term_key,
    annualCost: amounts.annual_cost, finalCost: amounts.final_cost, vatAmount: amounts.vat_amount,
    totalWithVat: amounts.total_with_vat, currency, tierLabel, vatRatePercent, taxType, prorataDays,
    commitment, targetSnapshot: { config, band: band || null, discounts, vatOverrides, overrides, vatSetting: vatSetting || null } };
}
