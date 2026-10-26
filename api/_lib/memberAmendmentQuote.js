import { recoverRollingCommitment } from './rollingMembershipCommitment.js';
import { assessMemberAmendmentOperationalScope } from './membershipAmendmentReadOverlay.js';
import { amendmentTermDays, prorateAmendmentMoney } from './memberAmendmentCalculation.js';

export const AMENDMENT_CAPABILITIES = Object.freeze({
  preview: true, create: true, apply: true, invoice: true, refund: true, providerAmendment: false,
  retainedCredit: true, reconcile: true, notifications: true,
  collectionMode: 'xero_invoice_verified_payment',
  refundMode: 'xero_bank_reconciled_manual_refund_only',
  automatedCashRefund: false, repeatedAmendments: false,
});

export class AmendmentError extends Error {
  constructor(message, status = 422, code = 'amendment_blocked') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function amendmentDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
      || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))
      || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new AmendmentError('A valid effectiveDate (YYYY-MM-DD) is required', 400, 'invalid_date');
  }
  return value;
}

function cents(value, label) {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))
      || Number(value) < 0 || Math.abs(Number(value) * 100 - Math.round(Number(value) * 100)) > 0.00001
      || !Number.isSafeInteger(Math.round(Number(value) * 100))) {
    throw new AmendmentError(`An exact nonnegative ${label} amount is required`);
  }
  return Math.round(Number(value) * 100);
}

export function currentAmendmentBlockers(current, today) {
  if (!current) return ['No single current dated personal membership purchase was found; legacy/organisation-derived memberships need review.'];
  const blockers = [];
  if (!current.commitment_snapshot || recoverRollingCommitment({ history: current }).status !== 'already_recorded') {
    blockers.push('A complete, consistent original purchase commitment snapshot is required; current overrides are not purchase evidence.');
  }
  const snapshot = current.commitment_snapshot;
  if (snapshot?.config?.id !== current.config_id || snapshot?.config?.tenant_id !== current.tenant_id
      || snapshot?.config?.structure_scope_type !== 'member') {
    blockers.push('Original structure snapshot ownership and personal scope must be explicit.');
  }
  if (current.status !== 'active' || current.payment_status !== 'paid') blockers.push('The original purchase must be active and fully paid.');
  if (snapshot?.payment_frequency !== 'upfront' || snapshot?.payment_method !== current.payment_method || current.billing_agreement_id
      || ['direct_debit', 'gocardless', 'card_monthly', 'monthly_direct_debit', 'monthly_card'].includes(current.payment_method)) {
    blockers.push('Monthly/provider-linked commitments require a provider amendment flow, which is not implemented.');
  }
  if (snapshot?.billing_period !== 'annual' || current.term_duration_months !== 12) {
    blockers.push('Only original annual, twelve-month commitments are supported in this first slice.');
  }
  if (!/^[A-Z]{3}$/.test(current.currency || '')
      || !Intl.supportedValuesOf('currency').includes(current.currency)
      || new Intl.NumberFormat('en', { style: 'currency', currency: current.currency }).resolvedOptions().maximumFractionDigits !== 2) {
    blockers.push('Only recognized currencies with two decimal minor units are supported.');
  }
  if (!(current.term_start_date <= today && today < current.membership_renewal_date)) blockers.push('The purchase is not in its current term.');
  if (['free_period_discount', 'rollover_discount', 'custom_discount_total'].some((key) => Number(current[key] || 0) !== 0)
      || snapshot?.config?.free_period_amount || snapshot?.config?.rollover_enabled
      || Number(current.final_cost) !== Number(current.annual_cost)
      || (current.prorata_cost != null && Number(current.prorata_cost) !== Number(current.annual_cost))
      || (Array.isArray(current.custom_discount_details) && current.custom_discount_details.length)) {
    blockers.push('Discounted/free-period purchase pricing requires explicit discount carry-forward policy, not implemented in this slice.');
  }
  return blockers;
}

/** Exact minor-unit arithmetic; actual UTC days, inclusive effective date/exclusive renewal date. */
export function buildMemberAmendmentQuote({
  current, config, band = null, discounts = [], vatOverrides = [], vatSetting = null,
  effectiveDate, today, quotedAt,
}) {
  amendmentDate(effectiveDate);
  const blockers = currentAmendmentBlockers(current, today);
  if (blockers.length) throw new AmendmentError(blockers.join(' '));
  const operational = assessMemberAmendmentOperationalScope({ current, config });
  if (!operational.supported) throw new AmendmentError(operational.blockers.join(' '), 422, 'operational_scope_unsupported');
  if (effectiveDate !== today) throw new AmendmentError('Only today is supported; backdated and scheduled changes require a separate policy.');
  if (!config || config.tenant_id !== current.tenant_id || config.structure_scope_type !== 'member'
      || config.is_active !== true || config.billing_period !== 'annual'
      || !['immediate', 'fixed_date'].includes(config.start_mode)
      || !config.effective_from || config.effective_from > effectiveDate
      || (config.effective_to && config.effective_to < effectiveDate)) {
    throw new AmendmentError('Target must be an active, effective annual personal structure.');
  }
  if (config.currency !== current.currency) throw new AmendmentError('Currency changes are not supported.');
  if (config.free_period_amount || config.rollover_enabled || discounts.length || vatOverrides.length) {
    throw new AmendmentError('Target discount, free-period, rollover or conditional VAT rules require a richer quote policy; this structure is not eligible.');
  }
  const flat = config.pricing_model === 'flat';
  if (!flat && config.pricing_model !== 'tiered') throw new AmendmentError('Unsupported target pricing model.');
  if ((flat && band) || (!flat && (!band || band.config_id !== config.id || band.tenant_id !== current.tenant_id))) {
    throw new AmendmentError('Select exactly one target band belonging to this structure (or no band for a flat structure).');
  }
  if (current.config_id === config.id && (current.band_id || null) === (band?.id || null)) {
    throw new AmendmentError('Select a different structure or band.');
  }
  const targetNet = cents(flat ? config.flat_cost : band.annual_cost, 'target annual net');
  const tax = flat ? config.flat_vat_rate : band.vat_rate;
  let targetVatRate = 0;
  let taxAuthority = 'explicit_no_tax_config';
  if (tax) {
    let parsed;
    try { parsed = typeof tax === 'string' ? JSON.parse(tax) : tax; } catch { parsed = { taxType: tax }; }
    const taxType = parsed?.taxType;
    let cached;
    try { cached = JSON.parse(vatSetting?.setting_value || '{}'); } catch { /* blocked below */ }
    const rates = cached?.rates?.filter((rate) => rate.taxType === taxType) || [];
    if (!taxType || rates.length !== 1 || rates[0].effectiveRate == null
        || !Number.isFinite(Number(rates[0].effectiveRate))
        || Number(rates[0].effectiveRate) < 0 || Number(rates[0].effectiveRate) > 100) {
      throw new AmendmentError('Target VAT cannot be resolved from a unique saved tax-rate setting; no live provider lookup or label inference is performed.');
    }
    targetVatRate = Number(rates[0].effectiveRate);
    taxAuthority = 'saved_tenant_tax_rate_cache';
  }
  const originalNet = cents(current.final_cost, 'original full-term net');
  const originalVat = cents(current.vat_amount, 'original full-term VAT');
  const originalGross = cents(current.total_with_vat, 'original full-term gross');
  if (originalNet + originalVat !== originalGross) throw new AmendmentError('Original net and VAT do not equal the original gross.');
  const targetVat = Math.round(targetNet * targetVatRate / 100);
  if (!Number.isSafeInteger(targetVat) || !Number.isSafeInteger(targetNet + targetVat)) throw new AmendmentError('Target price exceeds safe minor-unit bounds.');
  const {totalDays,remainingDays}=amendmentTermDays(current.term_start_date,current.membership_renewal_date,effectiveDate);
  const prorate = (net, vat) => prorateAmendmentMoney({netMinor:net,vatMinor:vat},remainingDays,totalDays);
  const originalRemaining = prorate(originalNet, originalVat);
  const targetRemaining = prorate(targetNet, targetVat);
  const delta = Object.fromEntries(Object.keys(originalRemaining).map((key) => [key, targetRemaining[key] - originalRemaining[key]]));
  const financialChange = delta.netMinor !== 0 || delta.vatMinor !== 0;
  const status = financialChange ? 'pending_settlement' : 'pending_application';
  const applicationBlockers = financialChange
    ? ['Requires source-linked Xero invoice/payment evidence and an explicit settlement choice. Proposal creation alone does not collect, refund or change membership.']
    : ['Requires an explicit zero-difference settlement and application decision; proposal creation alone does not change membership.'];
  return {
    version: 1, quotedAt, effectiveDate, currency: current.currency, minorUnit: 2,
    sourceRecordId: current.id,
    sourceAuthority: 'original_purchase_commitment_snapshot',
    targetAuthority: 'current_explicit_structure_and_band_configuration',
    term: {
      startDate: current.term_start_date, endDate: current.term_end_date,
      renewalDate: current.membership_renewal_date, anchorDate: current.term_anchor_date,
      durationMonths: current.term_duration_months, termKey: current.term_key,
    },
    proration: { method: 'actual_utc_days_remaining_over_original_term', totalDays, remainingDays, rounding: 'nearest_minor_unit_per_net_and_vat_component' },
    originalFullTerm: { netMinor: originalNet, vatMinor: originalVat, grossMinor: originalGross },
    targetFullTerm: { netMinor: targetNet, vatMinor: targetVat, grossMinor: targetNet + targetVat, vatRatePercent: targetVatRate, taxAuthority },
    originalRemaining, targetRemaining, delta,
    financialDirection: !financialChange ? 'none' : delta.grossMinor > 0 ? 'charge' : delta.grossMinor < 0 ? 'credit' : 'tax_adjustment',
    status, entitlementApplied: false, settlementStatus: 'not_started', blockers: applicationBlockers,
    sourceSnapshot: current, targetSnapshot: { config, band, discounts, vatOverrides, vatSetting },
  };
}
