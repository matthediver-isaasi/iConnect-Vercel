/**
 * Detached membership quote for brand-new applicants (Task #3489).
 *
 * The full membership simulation (membershipSimulation.js) requires an
 * existing member/organisation row (go-live date, stored field values,
 * existing history records). A form's conditional "membership structure"
 * action must derive the charge amount BEFORE any entity exists, so this
 * module computes a quote purely from the selected tier config plus
 * field overrides built from the form answers, assuming a brand-new entity
 * joining today (goLive = today, year 1, no existing records, no per-entity
 * overrides).
 *
 * computeNewApplicantCost mirrors the simulation's year-1 "new entity" cost
 * math (pro-rata + free period / percentage incentive) — keep the two in
 * sync if that arithmetic ever changes.
 */

import { supabase } from './database.js';
import { getConfigByIdDirect } from './membershipConfigResolver.js';
import { matchBand } from './tierBandMatcher.js';
import { calculateMembershipYearWindow } from './membershipYear.js';
import { evaluateDiscountsForEntity, applyDiscountsToAnnualCost } from './discountHelper.js';
import { evaluateVatOverrideForOrg, evaluateVatOverrideForMember } from './vatOverrideHelper.js';
import { resolveCardMonthlyOffer } from './stripeMonthlyCard.js';

// Sentinel entity id used when calling helpers that expect an entity id but
// only need it for stored-value lookups (a nil uuid matches no rows, so all
// values come from the supplied fieldOverrides).
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

function getFreeMonths(config) {
  if (!config.free_period_amount || !config.free_period_unit) return 0;
  const amount = config.free_period_amount;
  const unit = config.free_period_unit;
  if (unit === 'months') return amount;
  if (unit === 'weeks') return amount / 4.33;
  if (unit === 'days') return amount / 30.44;
  return 0;
}

/**
 * Pure year-1 new-entity cost math (mirrors membershipSimulation.js's
 * yearNumber === 1 / isNewOrg branch). `joinDate` defaults to today.
 * Returns { finalCost, dailyCost, prorataDays, prorataCost, freeDiscount,
 *           freePeriodDaysApplied, billableDays, proRataEnabled,
 *           totalDaysInYear }.
 */
export function computeNewApplicantCost({ config, annualCost, membershipYear, joinDate = new Date() }) {
  const yearStartMidnight = new Date(membershipYear.start);
  yearStartMidnight.setHours(0, 0, 0, 0);
  const yearEndMidnight = new Date(membershipYear.end);
  yearEndMidnight.setHours(0, 0, 0, 0);
  const totalDaysInYear = Math.floor((yearEndMidnight - yearStartMidnight) / (1000 * 60 * 60 * 24)) + 1;

  let dailyCost = null;
  let prorataDays = null;
  let prorataCost = null;
  let freePeriodDaysApplied = 0;
  let freeDiscount = 0;
  let billableDays = null;
  let finalCost = annualCost;
  let proRataEnabled = false;

  dailyCost = parseFloat((annualCost / totalDaysInYear).toFixed(4));
  const isPercentIncentive = config.free_period_unit === 'percent';

  if (config.prorata_enabled) {
    proRataEnabled = true;
    const joinMidnight = new Date(joinDate);
    joinMidnight.setHours(0, 0, 0, 0);
    prorataDays = Math.max(0, Math.floor((yearEndMidnight - joinMidnight) / (1000 * 60 * 60 * 24)) + 1);
    prorataCost = parseFloat((dailyCost * prorataDays).toFixed(2));

    if (config.free_period_amount && config.free_period_unit) {
      if (isPercentIncentive) {
        const fullDiscountAmount = parseFloat((annualCost * config.free_period_amount / 100).toFixed(2));
        const proportionUsed = prorataDays / totalDaysInYear;
        freeDiscount = parseFloat((fullDiscountAmount * proportionUsed).toFixed(2));
        freeDiscount = Math.min(freeDiscount, prorataCost);
      } else {
        const freePeriodMonths = getFreeMonths(config);
        const freePeriodTotalDays = Math.round(freePeriodMonths * 30.44);
        const freePeriodEnd = new Date(joinMidnight);
        freePeriodEnd.setDate(freePeriodEnd.getDate() + freePeriodTotalDays - 1);
        const lastFreeDay = freePeriodEnd < yearEndMidnight ? freePeriodEnd : yearEndMidnight;
        freePeriodDaysApplied = Math.max(0, Math.floor((lastFreeDay - joinMidnight) / (1000 * 60 * 60 * 24)) + 1);
        freePeriodDaysApplied = Math.min(freePeriodDaysApplied, prorataDays);
        freeDiscount = parseFloat((dailyCost * freePeriodDaysApplied).toFixed(2));
      }
    }

    if (isPercentIncentive) {
      finalCost = parseFloat(Math.max(0, prorataCost - freeDiscount).toFixed(2));
    } else {
      billableDays = prorataDays - freePeriodDaysApplied;
      finalCost = parseFloat((dailyCost * billableDays).toFixed(2));
    }
  } else if (config.free_period_amount && config.free_period_unit) {
    if (isPercentIncentive) {
      freeDiscount = parseFloat((annualCost * config.free_period_amount / 100).toFixed(2));
      finalCost = parseFloat(Math.max(0, annualCost - freeDiscount).toFixed(2));
    } else {
      const freePeriodMonths = getFreeMonths(config);
      const freePeriodTotalDays = Math.round(freePeriodMonths * 30.44);
      freePeriodDaysApplied = Math.min(freePeriodTotalDays, totalDaysInYear);
      freeDiscount = parseFloat((dailyCost * freePeriodDaysApplied).toFixed(2));
      finalCost = parseFloat((annualCost - freeDiscount).toFixed(2));
    }
  }

  return {
    finalCost: parseFloat(Math.max(0, finalCost).toFixed(2)),
    dailyCost,
    prorataDays: proRataEnabled ? prorataDays : null,
    prorataCost: proRataEnabled ? prorataCost : null,
    freeDiscount,
    freePeriodDaysApplied,
    billableDays: proRataEnabled ? billableDays : null,
    proRataEnabled,
    totalDaysInYear,
  };
}

function getBasisValueFromOverrides(config, fieldOverrides) {
  if (config.field_source === 'core' && config.field_name) {
    const coreKey = `core:${config.field_name}`;
    if (coreKey in fieldOverrides) {
      const num = parseFloat(fieldOverrides[coreKey]);
      return isNaN(num) ? null : num;
    }
    return null;
  }
  if (config.field_id && config.field_id in fieldOverrides) {
    const v = fieldOverrides[config.field_id];
    return v == null || v === '' ? null : v;
  }
  return null;
}

async function lookupVatRatePercent(tenantId, taxType, taxLabel) {
  let vatRatePercent = null;
  if (!taxType) return null;
  try {
    const { data: vatRatesSetting } = await supabase
      .from('system_settings')
      .select('setting_value')
      .eq('setting_key', `xero_vat_rates_${tenantId}`)
      .maybeSingle();
    if (vatRatesSetting?.setting_value) {
      const cachedData = JSON.parse(vatRatesSetting.setting_value);
      const matchedRate = (cachedData.rates || []).find(r => r.taxType === taxType);
      if (matchedRate && matchedRate.effectiveRate != null) {
        vatRatePercent = parseFloat(matchedRate.effectiveRate);
      }
    }
  } catch { /* fall through to label parsing */ }
  if (vatRatePercent == null && taxLabel) {
    const percentMatch = taxLabel.match(/(\d+(?:\.\d+)?)\s*%/);
    if (percentMatch) vatRatePercent = parseFloat(percentMatch[1]);
  }
  return vatRatePercent;
}

function parseVatRateJson(raw) {
  if (!raw) return { taxType: null, taxLabel: null };
  try {
    const parsed = JSON.parse(raw);
    return { taxType: parsed.taxType || null, taxLabel: parsed.name || null };
  } catch {
    return { taxType: raw, taxLabel: raw };
  }
}

/**
 * Quote a membership fee for a brand-new applicant against an explicit tier
 * config, using ONLY the supplied fieldOverrides for basis/discount/VAT
 * field values. Never reads or writes member/organisation data.
 *
 * Returns { success: true, quote } or { success: false, error }.
 */
export async function quoteMembershipForNewApplicant({ tenantId, configId, fieldOverrides = {}, now = new Date() }) {
  const config = await getConfigByIdDirect(tenantId, configId);
  if (!config) {
    return { success: false, error: 'The selected membership structure was not found or is not active' };
  }
  const target = (config.structure_scope_type === 'member') ? 'member' : 'organization';
  const membershipYear = calculateMembershipYearWindow(config, now);

  const isFlat = config.pricing_model === 'flat';
  let annualCostRaw;
  let tierLabel;
  let matchedBand = null;
  let fieldValue = null;

  if (isFlat) {
    annualCostRaw = parseFloat(config.flat_cost) || 0;
    tierLabel = 'Flat Rate';
  } else {
    const { data: bands, error: bandsErr } = await supabase
      .from('membership_tier_band')
      .select('*')
      .eq('config_id', config.id)
      .eq('tenant_id', tenantId)
      .order('min_value', { ascending: true });
    if (bandsErr) {
      return { success: false, error: 'Could not load pricing bands for the selected membership structure' };
    }
    fieldValue = getBasisValueFromOverrides(config, fieldOverrides);
    if (fieldValue === null || fieldValue === undefined) {
      return { success: false, error: 'The membership fee could not be calculated because the pricing answer is missing' };
    }
    matchedBand = matchBand(fieldValue, bands || []);
    if (!matchedBand) {
      return { success: false, error: `The answers do not match any pricing band (value: ${fieldValue})` };
    }
    annualCostRaw = parseFloat(matchedBand.annual_cost);
    tierLabel = matchedBand.label;
  }

  // Custom discount rules — values come exclusively from fieldOverrides
  // (the nil-uuid entity matches no stored rows).
  let annualCost = annualCostRaw;
  let customDiscountTotal = 0;
  let customDiscountDetails = [];
  // Scope-aware: member-scoped structures evaluate discount rules against
  // member custom fields (values come from the mapped form answers via
  // fieldOverrides; the nil-UUID entity lookup stays fail-safe/empty).
  const discountResult = await evaluateDiscountsForEntity(config.id, tenantId, NIL_UUID, fieldOverrides, target);
  if (discountResult.discountDetails.length > 0) {
    const applied = applyDiscountsToAnnualCost(annualCost, discountResult.discountDetails);
    customDiscountTotal = applied.totalDiscount;
    customDiscountDetails = applied.appliedDiscounts;
    annualCost = applied.discountedCost;
  }

  const cost = computeNewApplicantCost({ config, annualCost, membershipYear, joinDate: now });

  // VAT: override rules first (from overrides only), then band/flat rates.
  let taxType = null;
  let taxLabel = null;
  const vatOverride = target === 'member'
    ? await evaluateVatOverrideForMember(config.id, tenantId, NIL_UUID, fieldOverrides)
    : await evaluateVatOverrideForOrg(config.id, tenantId, NIL_UUID, fieldOverrides);
  if (vatOverride && vatOverride.taxType) {
    taxType = vatOverride.taxType;
    taxLabel = vatOverride.taxLabel;
  } else if (matchedBand?.vat_rate) {
    ({ taxType, taxLabel } = parseVatRateJson(matchedBand.vat_rate));
  } else if (isFlat && config.flat_vat_rate) {
    ({ taxType, taxLabel } = parseVatRateJson(config.flat_vat_rate));
  }
  const vatRatePercent = await lookupVatRatePercent(tenantId, taxType, taxLabel);
  const vatAmount = vatRatePercent ? parseFloat((cost.finalCost * vatRatePercent / 100).toFixed(2)) : 0;
  const totalWithVat = parseFloat((cost.finalCost + vatAmount).toFixed(2));

  const quote = {
      target,
      config_id: config.id,
      config_name: config.name || null,
      band_id: matchedBand?.id || null,
      tier_label: tierLabel,
      field_value: fieldValue,
      annual_cost: annualCost,
      annual_cost_before_discounts: annualCostRaw,
      custom_discount_total: customDiscountTotal,
      custom_discount_details: customDiscountDetails.length > 0 ? customDiscountDetails : null,
      final_cost: cost.finalCost,
      currency: config.currency || 'GBP',
      membership_year: membershipYear.label,
      membership_year_start: membershipYear.start
        ? new Date(membershipYear.start).toISOString().slice(0, 10)
        : null,
      year_number: 1,
      prorata_cost: cost.prorataCost,
      prorata_days: cost.prorataDays,
      free_period_discount: cost.freeDiscount || 0,
      free_period_days_applied: cost.freePeriodDaysApplied || 0,
      billing_period: config.billing_period || 'annual',
      vat_rate_percent: vatRatePercent || null,
      vat_amount: vatAmount || 0,
      total_with_vat: totalWithVat,
      tax_type: taxType,
      tax_label: taxLabel,
      nominal_code: String(matchedBand?.nominal_code || (isFlat ? config.nominal_code : '') || '').trim() || null,
      invoice_description: config.invoice_description || null,
    };
  // The public form needs an offer derived from the same resolved config and
  // band as its annual quote. This is display data only; checkout repeats the
  // calculation and never accepts it from the browser.
  const monthlyCardOffer = target === 'member'
    ? resolveCardMonthlyOffer({
      success: true, config, matchedBand, currency: quote.currency,
      membershipYear: { label: membershipYear.label, start: membershipYear.start },
      tierLabel, annualCost, finalCost: quote.final_cost,
    })
    : null;
  if (monthlyCardOffer) quote.monthly_card_offer = monthlyCardOffer;
  return { success: true, quote };
}

/**
 * Adapt a full membershipSimulation.js result (used when an existing
 * organisation is already known at payment-create time) into the same quote
 * shape as quoteMembershipForNewApplicant.
 */
export function quoteFromSimulationResult(simResult, target) {
  const quote = {
    target,
    config_id: simResult.config?.id || null,
    config_name: simResult.config?.name || null,
    band_id: simResult.matchedBand?.id || null,
    tier_label: simResult.tierLabel,
    field_value: simResult.fieldValue,
    annual_cost: simResult.annualCost,
    annual_cost_before_discounts: simResult.annualCostBeforeDiscounts,
    custom_discount_total: simResult.customDiscountTotal || 0,
    custom_discount_details: simResult.customDiscountDetails?.length > 0 ? simResult.customDiscountDetails : null,
    final_cost: simResult.finalCost,
    currency: simResult.currency || 'GBP',
    membership_year: simResult.membershipYear?.label || null,
    membership_year_start: simResult.membershipYear?.start
      ? new Date(simResult.membershipYear.start).toISOString().slice(0, 10)
      : null,
    year_number: simResult.yearNumber || null,
    prorata_cost: simResult.prorataCost,
    prorata_days: simResult.prorataDays,
    free_period_discount: simResult.freeDiscount || 0,
    free_period_days_applied: simResult.freePeriodDaysApplied || 0,
    billing_period: simResult.billingPeriod || 'annual',
    vat_rate_percent: simResult.vatRatePercent || null,
    vat_amount: simResult.vatAmount || 0,
    total_with_vat: simResult.totalWithVat || simResult.finalCost,
    tax_type: simResult.taxType || null,
    tax_label: simResult.taxLabel || null,
    nominal_code: simResult.nominalCode || null,
    invoice_description: simResult.config?.invoice_description || null,
  };
  const monthlyCardOffer = target === 'member' ? resolveCardMonthlyOffer(simResult) : null;
  if (monthlyCardOffer) quote.monthly_card_offer = monthlyCardOffer;
  return quote;
}
