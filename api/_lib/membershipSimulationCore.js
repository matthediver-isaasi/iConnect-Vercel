import { createDiscountHelper } from './discountHelperCore.js';
import { createVatOverrideHelper } from './vatOverrideHelperCore.js';
import { createMembershipConfigResolver } from './membershipConfigResolverCore.js';
import { resolveInvoiceAddress } from './invoiceAddressResolver.js';
import { matchBand } from './tierBandMatcher.js';
import { calculateMembershipYearWindow, calculateNextMembershipYearWindow, rollingMembershipWindow } from './membershipYear.js';

// A saved usage amount is not evidence of the rate/entitlement that produced it.
// In particular, never substitute the renewal schedule for the joining schedule.
export function calculateOriginalIncentiveRollover({ history = null, originalConfig, goLiveDate, annualCost, projectedAnnualCost, projectedDiscount, projectedDays }) {
  const review = (message) => {
    const error = new Error(`New-member incentive requires review: ${message}`);
    error.code = 'new_member_incentive_review_required';
    throw error;
  };
  const money = value => Math.round((value + Number.EPSILON) * 100) / 100;
  const validNumber = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0;
  const snapshotConfig = history?.commitment_snapshot?.config;
  const original = snapshotConfig || originalConfig;
  if (!original) review('the original joining configuration is unavailable.');
  if (typeof original.rollover_enabled !== 'boolean') review('the original rollover policy is missing.');
  if (!snapshotConfig) {
    const evidenceDate = new Date(history?.created_at || goLiveDate).getTime();
    const created = new Date(original.created_at).getTime();
    const updated = new Date(original.updated_at).getTime();
    if (!original.created_at || !original.updated_at || !(history?.created_at || goLiveDate)
        || ![evidenceDate, created, updated].every(Number.isFinite) || created > evidenceDate || updated > evidenceDate
        || (history && (!history.config_id || history.config_id !== original.id))) {
      review('no snapshot or demonstrably unchanged, history-linked joining configuration is available.');
    }
  }
  const result = {
    source: snapshotConfig ? 'commitment_snapshot' : history ? 'unchanged_history_config' : 'unchanged_joining_config',
    originalConfigId: original.id || history?.config_id || null,
    year1HistoryId: history?.id || null,
    unit: original.free_period_unit || null,
    originalEntitlement: 0, usedInYear1: 0, remainingEntitlement: 0,
    appliedDiscount: 0, appliedDays: 0,
    eligible: false,
  };
  if (!original.rollover_enabled || !original.free_period_amount || !original.free_period_unit) return result;
  if (!validNumber(original.free_period_amount)) review('the original incentive amount is invalid.');
  const originalAnnual = history?.annual_cost ?? history?.commitment_snapshot?.amounts?.annual_cost ?? projectedAnnualCost;
  const usedDiscount = history ? history.free_period_discount : projectedDiscount;
  if (!validNumber(originalAnnual) || !validNumber(usedDiscount)) review('original net annual price and Year 1 incentive usage must both be recorded.');
  if (history?.override_type === 'price') return result;
  if (history?.override_applied && !history.override_type) review('the original override type is missing.');
  if (history?.override_type === 'structure' && !snapshotConfig) review('the original structure override requires a saved configuration snapshot.');
  if (original.free_period_unit === 'percent') {
    result.originalEntitlement = money(Number(originalAnnual) * Number(original.free_period_amount) / 100);
    result.usedInYear1 = Number(usedDiscount);
    result.remainingEntitlement = money(Math.max(0, result.originalEntitlement - result.usedInYear1));
    result.appliedDiscount = money(Math.min(result.remainingEntitlement, Math.max(0, annualCost)));
  } else {
    const amount = Number(original.free_period_amount);
    const totalDays = original.free_period_unit === 'days' ? Math.round(amount)
      : original.free_period_unit === 'weeks' ? Math.round(amount / 4.33 * 30.44)
      : original.free_period_unit === 'months' ? Math.round(amount * 30.44) : null;
    const usedDays = history ? history.free_period_days_applied : projectedDays;
    if (totalDays === null || !validNumber(usedDays)) review('original free-day entitlement and Year 1 day usage must both be recorded.');
    const join = new Date(`${String(goLiveDate).slice(0, 10)}T00:00:00.000Z`);
    if (!Number.isFinite(join.getTime())) review('the original joining date is unavailable.');
    const firstWindow = calculateMembershipYearWindow(original, join);
    const totalYearDays = Math.round((firstWindow.end - firstWindow.start) / 86400000) + 1;
    const originalDaily = Number((Number(originalAnnual) / totalYearDays).toFixed(4));
    result.originalEntitlement = totalDays;
    result.usedInYear1 = Number(usedDays);
    result.remainingEntitlement = Math.max(0, totalDays - Number(usedDays));
    result.appliedDays = result.remainingEntitlement;
    result.appliedDiscount = money(Math.min(Math.max(0, annualCost), originalDaily * result.remainingEntitlement));
  }
  result.eligible = result.remainingEntitlement > 0;
  return result;
}

export function createMembershipSimulator(supabase, clock = () => new Date()) {
const { evaluateDiscountsForOrg, applyDiscountsToAnnualCost } = createDiscountHelper(supabase);
const { evaluateVatOverrideForOrg, evaluateVatOverrideForMember } = createVatOverrideHelper(supabase);
const { getConfigForOrganisation, getConfigForMember, getAllActiveConfigs, getConfigByIdDirect, resolveBasisFieldLabel, resolveRollingSuccessorConfig } = createMembershipConfigResolver(supabase);
return { resolveRollingSimulationContext, simulateMembershipForOrg, simulateMembershipForMember };

async function resolveRollingSimulationContext(client, {
  tenantId, memberId, organizationId, config, options = {}, now = clock(),
}) {
  const { data: rows, error } = await client.from(memberId ? 'member_membership_history' : 'organisation_membership_history')
    .select('*').eq('tenant_id', tenantId).eq(memberId ? 'member_id' : 'organization_id', memberId || organizationId);
  if (error) throw new Error(`Could not load purchased membership terms: ${error.message}`);
  const histories = (rows || []).filter(row => !['cancelled', 'void', 'expired_checkout'].includes(row.status));
  const rollingRows = histories.filter(row => String(row.term_key || '').startsWith('rolling:'));
  if (config?.start_mode !== 'immediate'
      && options.previousTerm?.commitment_snapshot?.start_mode === 'fixed_date') return null;
  if (config?.start_mode !== 'immediate' && !rollingRows.length && !options.previousTerm) return null;
  if (histories.some(row => !row.term_key) && !rollingRows.length && !options.previousTerm) {
    throw new Error('Legacy rolling membership requires review: no trusted commencement date and pricing commitment are available.');
  }
  const today = new Date(now).toISOString().slice(0, 10);
  const sorted = rollingRows.sort((a, b) => b.term_start_date.localeCompare(a.term_start_date));
  const current = sorted.find(row => row.term_start_date <= today) || sorted.at(-1);
  const requested = options.source !== 'cron' && options.targetYear && sorted.find(row => row.term_key === options.targetYear);
  const requestedNext = options.targetYear && options.targetYear !== current?.term_key;
  const renewalSource = ['simulate', 'cron', 'renewal', 'manual'].includes(options.source);
  const currentSettled = current && (current.payment_status === 'paid' || current.paid_at
    || Number(current.total_with_vat ?? current.final_cost) === 0 || current.billing_agreement_id);
  const needsNext = !!currentSettled && !requested && (requestedNext || renewalSource
    || today >= current.membership_renewal_date);
  const previousTerm = options.previousTerm
    ? (sorted.find(row => row.term_key === options.previousTerm.term_key) || options.previousTerm)
    : (needsNext ? current : null);
  if (!previousTerm && (requested || current)) return { existing: requested || current };
  if (previousTerm) {
    if (!options.previousTerm && (previousTerm.billing_agreement_id
      || previousTerm.commitment_snapshot?.payment_frequency === 'monthly')) {
      throw new Error('This rolling membership is managed by a recurring payment plan; use its renewal confirmation process.');
    }
    if (!previousTerm.membership_renewal_date || !previousTerm.commitment_snapshot) {
      throw new Error('Rolling membership requires review: saved renewal boundary or pricing snapshot is missing.');
    }
    const existing = sorted.find(row => row.term_start_date === previousTerm.membership_renewal_date);
    if (existing) return { existing, previousTerm };
    config = await resolveRollingSuccessorConfig(client, { tenantId, previousTerm });
    // Provider renewals pass their own explicitly resolved ID; never accept an
    // unrelated or no-longer-eligible structure in a renewal request.
    if (options.configId && options.configId !== config.id) {
      throw new Error('Selected membership structure is not the eligible structure at the saved renewal boundary.');
    }
  }
  if (!config) throw new Error('No eligible membership structure exists for this rolling membership.');
  return {
    config, previousTerm,
    window: rollingMembershipWindow(config, options.termStartDate || options.asOfDate || now, previousTerm),
  };
}

function purchasedRollingSimulation(row, entity, steps, invoicingSettings) {
  if (!row.commitment_snapshot?.config || !row.membership_renewal_date || !row.term_start_date || !row.term_end_date) {
    throw new Error('Rolling membership requires review: the saved commitment is incomplete.');
  }
  const config = row.commitment_snapshot.config;
  return {
    success: true, ...entity, config, steps, invoicingSettings,
    existingRecord: row, previousTerm: null, commitment: row,
    membershipYear: { label: row.term_key, start: new Date(`${row.term_start_date}T00:00:00.000Z`), end: new Date(`${row.term_end_date}T00:00:00.000Z`), ...row },
    tierLabel: row.tier_label, fieldValue: row.field_value,
    matchedBand: row.band_id ? { id: row.band_id } : null,
    annualCost: Number(row.annual_cost), annualCostBeforeDiscounts: Number(row.annual_cost),
    finalCost: Number(row.final_cost), totalWithVat: Number(row.total_with_vat ?? row.final_cost),
    vatAmount: Number(row.vat_amount || 0), vatRatePercent: row.vat_rate_percent,
    currency: row.currency, billingPeriod: row.commitment_snapshot.billing_period,
    yearNumber: row.year_number, customDiscountTotal: Number(row.custom_discount_total || 0),
    customDiscountDetails: row.custom_discount_details || [], prorataCost: row.prorata_cost,
    freeDiscount: Number(row.free_period_discount || 0), rolloverDiscount: Number(row.rollover_discount || 0),
    invoicePreview: null, nominalCode: config.nominal_code || null,
  };
}

async function simulateMembershipForOrg(tenantId, organizationId, options = {}) {
  const {
    source = 'workflow',
    mode = 'automatic',
    workflowName = null,
    verbose = false,
    targetYear = null,
    fieldOverrides = {},
    configId: explicitConfigId = null,
    asOfDate = null,
  } = options;

  const steps = [];
  const log = (step, detail, status = 'ok') => {
    steps.push({ step, detail, status, timestamp: clock().toISOString() });
  };

  log('Start', source === 'workflow'
    ? `Dry run simulation for organisation via workflow "${workflowName || 'Unknown'}"`
    : `Simulating "${mode}" renewal for organisation ${organizationId}`);

  const { data: org } = await supabase
    .from('organization')
    .select('id, name, tenant_id, invoicing_address, invoicing_email')
    .eq('id', organizationId)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (!org) {
    log('Lookup Organisation', 'Organisation not found', 'error');
    return { success: false, steps, error: 'Organisation not found or does not belong to this tenant' };
  }
  log('Lookup Organisation', `Found: ${org.name}`);

  const { data: allInvoicingSettings } = await supabase
    .from('organisation_membership_invoicing')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('organization_id', organizationId);

  let invoicingSettings = null;
  if (allInvoicingSettings && allInvoicingSettings.length > 0) {
    invoicingSettings = allInvoicingSettings.find(s => s.membership_year === (targetYear || null));
    if (!invoicingSettings) {
      invoicingSettings = allInvoicingSettings.find(s => !s.membership_year);
    }
  }

  const currentMode = invoicingSettings?.invoicing_mode || 'manual';
  log('Check Invoicing Settings', `Saved mode: "${currentMode}"${invoicingSettings?.invoice_date ? `, scheduled date: ${invoicingSettings.invoice_date}` : ''}${invoicingSettings?.membership_year ? ` (for ${invoicingSettings.membership_year})` : ''}`);

  let config = explicitConfigId
    ? await getConfigByIdDirect(tenantId, explicitConfigId)
    : await getConfigForOrganisation(tenantId, organizationId, fieldOverrides, asOfDate);
  let rollingContext;
  try {
    rollingContext = await resolveRollingSimulationContext(supabase, { tenantId, organizationId, config, options });
  } catch (error) {
    return { success: false, steps, code: 'rolling_membership_review_required', error: error.message };
  }
  if (rollingContext?.existing) return purchasedRollingSimulation(rollingContext.existing, { org }, steps, invoicingSettings);
  if (rollingContext) config = rollingContext.config;
  if (!config) {
    const allActive = await getAllActiveConfigs(tenantId, asOfDate);
    const scopedCount = allActive.filter(c => c.structure_field_id && c.structure_match_value).length;
    if (scopedCount > 0) {
      log('Fetch Tier Config', `No matching tier configuration found. There are ${allActive.length} active config(s), ${scopedCount} scoped — but none match this organisation's field values.`, 'error');
    } else {
      log('Fetch Tier Config', 'No active tier configuration found for this tenant', 'error');
    }
    return { success: false, steps, error: 'No active membership tier configuration found' };
  }

  // Re-resolve the config as of the *target* membership year's start date.
  // The first resolution above uses today's date (or any caller-supplied asOfDate),
  // which selects the config valid right now — wrong when simulating a future year
  // that may be governed by a different, future-scheduled config. We bootstrap the
  // target year window from the just-resolved config (only to derive the date), then
  // re-resolve as of that date so future-scheduled configs are honoured.
  let configResolutionDate = asOfDate || null;
  if (!explicitConfigId && !rollingContext) {
    const referenceDate = asOfDate ? new Date(`${asOfDate}T00:00:00.000Z`) : clock();
    const bootstrapCurrentYear = calculateMembershipYearWindow(config, referenceDate);
    const bootstrapNextYear = calculateNextMembershipYearWindow(config, referenceDate);
    let targetWindow;
    if (targetYear) {
      targetWindow = targetYear === bootstrapCurrentYear.label ? bootstrapCurrentYear : bootstrapNextYear;
    } else {
      targetWindow = source === 'simulate' ? bootstrapNextYear : bootstrapCurrentYear;
    }
    if (targetWindow.label === bootstrapNextYear.label) {
      const targetStartDate = targetWindow.start.toISOString().split('T')[0];
      configResolutionDate = targetStartDate;
      const reResolved = await getConfigForOrganisation(tenantId, organizationId, fieldOverrides, targetStartDate);
      if (reResolved) config = reResolved;
    }
  }

  const resolvedAsOf = configResolutionDate || clock().toISOString().split('T')[0];
  log('Fetch Tier Config', `Active config: "${config.name || 'Default'}", currency: ${config.currency || 'GBP'}, start: month ${config.membership_start_month || 1} day ${config.membership_start_day || 1}, incentive: ${config.free_period_amount ? `${config.free_period_amount} ${config.free_period_unit}` : 'none'}, rollover: ${config.rollover_enabled ? 'yes' : 'no'} (resolved as of ${resolvedAsOf})`);

  if (explicitConfigId) {
    log('Config Resolution', `Using explicitly selected config ID: ${explicitConfigId} (name: "${config.name || 'Default'}")`);
  } else if (config.structure_field_id && config.structure_match_value) {
    let structureFieldLabel = config.structure_field_id;
    try {
      const { data: fieldDef } = await supabase
        .from('preference_field')
        .select('label, name')
        .eq('id', config.structure_field_id)
        .maybeSingle();
      if (fieldDef) structureFieldLabel = fieldDef.label || fieldDef.name || config.structure_field_id;
    } catch {}

    const hasOverride = config.structure_field_id in fieldOverrides;
    let orgFieldValueRaw = hasOverride ? fieldOverrides[config.structure_field_id] : null;
    if (!hasOverride) {
      try {
        const { data: pv } = await supabase
          .from('organization_preference_value')
          .select('value')
          .eq('organization_id', organizationId)
          .eq('field_id', config.structure_field_id)
          .maybeSingle();
        orgFieldValueRaw = pv?.value || null;
      } catch {}
    }

    log('Config Resolution', `Scoped config matched — field "${structureFieldLabel}" = "${config.structure_match_value}" (organisation value: "${orgFieldValueRaw || 'N/A'}"${hasOverride ? ' [from form override]' : ''})`);
  } else {
    log('Config Resolution', 'Using default (unscoped) tier configuration — no structure scope defined');
  }

  const currentYear = calculateMembershipYearWindow(config, asOfDate ? new Date(`${asOfDate}T00:00:00.000Z`) : clock());
  const nextYear = calculateNextMembershipYearWindow(config, asOfDate ? new Date(`${asOfDate}T00:00:00.000Z`) : clock());
  log('Calculate Membership Year', `Current year: ${currentYear.label}, Next year: ${nextYear.label}`);

  let membershipYear;
  if (rollingContext) {
    membershipYear = rollingContext.window;
  } else if (targetYear) {
    membershipYear = targetYear === currentYear.label ? currentYear : nextYear;
  } else {
    membershipYear = source === 'simulate' ? nextYear : currentYear;
  }

  const goLiveFieldId = await getGoLiveFieldId(tenantId);
  const goLiveDate = goLiveFieldId ? await getOrgGoLiveDate(organizationId, goLiveFieldId) : null;
  const assumedGoLiveDate = goLiveDate || clock().toISOString().split('T')[0];
  const yearNumber = rollingContext ? (rollingContext.previousTerm ? (Number(rollingContext.previousTerm.year_number) || 1) + 1 : 1) : determineMembershipYearNumber(assumedGoLiveDate, membershipYear, config);
  const currentYearNumber = determineMembershipYearNumber(assumedGoLiveDate, currentYear, config);

  if (goLiveDate) {
    let yearDesc;
    if (yearNumber === 1) yearDesc = 'First year - pro-rata and free period discounts apply';
    else if (yearNumber === 2) yearDesc = 'Second year - free period spillover may apply';
    else yearDesc = `Year ${yearNumber} - established member, full annual fee`;
    log('Go-Live Date', `${goLiveDate} → membership year ${yearNumber}. ${yearDesc}`);
  } else {
    let yearDesc;
    if (yearNumber === 1) yearDesc = 'First year - pro-rata and free period discounts apply';
    else if (yearNumber === 2) yearDesc = 'Second year - free period spillover may apply';
    else yearDesc = `Year ${yearNumber} - established member, full annual fee`;
    log('Go-Live Date', `Not set - assuming today (${assumedGoLiveDate}) as go-live date → membership year ${yearNumber}. ${yearDesc}`, goLiveFieldId ? 'warning' : 'info');
  }

  const { data: existingRecord } = await supabase
    .from('organisation_membership_history')
    .select('id, membership_year, final_cost, xero_invoice_id, accounting_invoice_id')
    .eq('tenant_id', tenantId)
    .eq('organization_id', organizationId)
    .eq('membership_year', membershipYear.label)
    .maybeSingle();

  if (existingRecord) {
    log('Check Existing Record', `A membership record for ${membershipYear.label} already exists (final cost: ${existingRecord.final_cost}). Renewal would be blocked.`, 'warning');
  } else {
    log('Check Existing Record', `No existing record for ${membershipYear.label} - creation would proceed`);
  }

  const isFlat = config.pricing_model === 'flat';
  let annualCostRaw;
  let annualCost;
  let tierLabel;
  let matchedBand = null;
  let customDiscountTotal = 0;
  let customDiscountDetails = [];
  let usedConfigId = config.id;
  let usedBandId = null;
  let overrideApplied = false;
  // Pricing structures can be overridden without changing the schedule used
  // for the membership window. Keep the effective incentive policy separately.
  let incentiveConfig = config;

  let fieldValue = null;

  if (isFlat) {
    if (rollingContext && (config.flat_cost == null || !Number.isFinite(Number(config.flat_cost)) || Number(config.flat_cost) < 0)) {
      throw new Error('The rolling membership structure has no valid agreed price; review its pricing before renewal.');
    }
    annualCostRaw = parseFloat(config.flat_cost) || 0;
    annualCost = annualCostRaw;
    tierLabel = 'Flat Rate';
    log('Pricing Model', `Flat rate pricing: ${annualCostRaw}`);
  } else {
    const bands = await getBandsForConfig(config.id, tenantId);
    log('Fetch Tier Bands', `Found ${bands.length} band(s)`);

    fieldValue = await getOrgFieldValue(organizationId, tenantId, config, fieldOverrides);
    const fieldLabel = await resolveBasisFieldLabel(config, tenantId);
    log('Get Organisation Field Value', `${fieldLabel}: ${fieldValue !== null ? fieldValue : 'N/A'}`);

    matchedBand = matchBand(fieldValue, bands);
    if (!matchedBand) {
      log('Match Tier Band', `No band matches the current field value (${fieldValue})`, 'error');
      return { success: false, steps, error: `Organisation does not match any tier band (field value: ${fieldValue})` };
    }
    log('Match Tier Band', `Matched: "${matchedBand.label}" (range: ${matchedBand.min_value}-${matchedBand.max_value || '∞'}, annual cost: ${matchedBand.annual_cost})`);

    annualCostRaw = parseFloat(matchedBand.annual_cost);
    annualCost = annualCostRaw;
    tierLabel = matchedBand.label;
    usedBandId = matchedBand.id;
  }

  const discountResult = await evaluateDiscountsForOrg(config.id, tenantId, organizationId, fieldOverrides);
  if (discountResult.discountDetails.length > 0) {
    const applied = applyDiscountsToAnnualCost(annualCost, discountResult.discountDetails);
    customDiscountTotal = applied.totalDiscount;
    customDiscountDetails = applied.appliedDiscounts;
    annualCost = applied.discountedCost;
    const discountSummary = customDiscountDetails.map(d =>
      `${d.label || d.field_label}: ${d.discount_type === 'percentage' ? d.discount_value + '%' : d.applied_amount.toFixed(2)} (${d.applied_amount.toFixed(2)})`
    ).join(', ');
    log('Custom Discounts', `${customDiscountDetails.length} discount(s) applied, total: ${customDiscountTotal.toFixed(2)}. Details: ${discountSummary}`);
  } else {
    log('Custom Discounts', 'No matching discount rules for this organisation');
  }

  let override = null;
  try {
    const yearLabel = membershipYear?.label || null;
    let overrideQuery = supabase
      .from('organisation_membership_override')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('organization_id', organizationId);
    if (yearLabel) {
      overrideQuery = overrideQuery.or(`membership_year.eq.${yearLabel},membership_year.is.null`);
    }
    const { data: overrideRows } = await overrideQuery;
    if (overrideRows && overrideRows.length > 0) {
      override = overrideRows.find(o => o.membership_year === yearLabel) || overrideRows.find(o => !o.membership_year) || overrideRows[0];
    }
  } catch {}

  if (override) {
    overrideApplied = true;
    if (override.override_type === 'price' && override.manual_price !== null) {
      annualCost = parseFloat(override.manual_price);
      customDiscountTotal = 0;
      customDiscountDetails = [];
      log('Apply Override', `Price override: ${annualCost.toFixed(2)} (note: ${override.note || 'none'})`);
    } else if (override.override_type === 'discount' && override.discount_type && override.discount_value !== null) {
      const grossCost = annualCost + customDiscountTotal;
      const val = parseFloat(override.discount_value);
      let overrideDiscountAmt = 0;
      if (override.discount_type === 'percentage') {
        overrideDiscountAmt = parseFloat((grossCost * val / 100).toFixed(2));
      } else {
        overrideDiscountAmt = Math.min(val, grossCost);
      }
      annualCost = Math.max(0, grossCost - overrideDiscountAmt);
      customDiscountTotal = overrideDiscountAmt;
      customDiscountDetails = [{
        label: 'Manual Discount Override',
        discount_type: override.discount_type,
        discount_value: val,
        applied_amount: overrideDiscountAmt,
      }];
      log('Apply Override', `Discount override: ${override.discount_type === 'percentage' ? val + '%' : val.toFixed(2)} off, discount amount: ${overrideDiscountAmt.toFixed(2)}, net cost: ${annualCost.toFixed(2)} (note: ${override.note || 'none'})`);
    } else if (override.override_type === 'structure' && override.config_id) {
      if (rollingContext && override.config_id !== config.id) throw new Error('A rolling structure override must be resolved as an eligible structure before a new commitment is quoted.');
      const overrideConfig = await getConfigById(override.config_id, tenantId);
      if (overrideConfig) {
        const overrideBands = await getBandsForConfig(overrideConfig.id, tenantId);
        const overrideBand = override.band_id
          ? overrideBands.find(b => b.id === override.band_id)
          : matchBand(fieldValue, overrideBands);

        if (overrideBand) {
          incentiveConfig = overrideConfig;
          annualCostRaw = parseFloat(overrideBand.annual_cost);
          annualCost = annualCostRaw;
          tierLabel = overrideBand.label;
          matchedBand = overrideBand;
          usedConfigId = overrideConfig.id;
          usedBandId = overrideBand.id;

          const overrideDiscountResult = await evaluateDiscountsForOrg(overrideConfig.id, tenantId, organizationId, fieldOverrides);
          if (overrideDiscountResult.discountDetails.length > 0) {
            const overrideApplied2 = applyDiscountsToAnnualCost(annualCost, overrideDiscountResult.discountDetails);
            customDiscountTotal = overrideApplied2.totalDiscount;
            customDiscountDetails = overrideApplied2.appliedDiscounts;
            annualCost = overrideApplied2.discountedCost;
          } else {
            customDiscountTotal = 0;
            customDiscountDetails = [];
          }
          log('Apply Override', `Structure override: config "${overrideConfig.name || overrideConfig.id}", band "${overrideBand.label}", cost: ${annualCost.toFixed(2)} (note: ${override.note || 'none'})`);
        } else {
          log('Apply Override', 'Structure override set but no matching band found', 'warning');
          overrideApplied = false;
        }
      }
    }
  } else {
    log('Check Override', 'No override configured for this organisation');
  }

  const isPriceOverride = override?.override_type === 'price';

  const { data: historyRecords, error: historyError } = await supabase
    .from('organisation_membership_history')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('organization_id', organizationId);
  if (historyError) return { success: false, steps, code: 'new_member_incentive_review_required', error: `Could not load original incentive usage: ${historyError.message}` };

  const hasCurrentYearRecord = (historyRecords || []).some(h => h.membership_year === currentYear.label);
  const isNewOrg = rollingContext ? !rollingContext.previousTerm : (currentYearNumber === 1 || !goLiveDate) && !hasCurrentYearRecord;
  const effectiveJoinDate = rollingContext ? new Date(membershipYear.start) : goLiveDate ? new Date(goLiveDate) : clock();

  const yearStartMidnight = new Date(membershipYear.start);
  yearStartMidnight.setHours(0, 0, 0, 0);
  const yearEndMidnight = new Date(membershipYear.end);
  yearEndMidnight.setHours(0, 0, 0, 0);
  const totalDaysInYear = Math.floor(((rollingContext ? membershipYear.end : yearEndMidnight) - (rollingContext ? membershipYear.start : yearStartMidnight)) / (1000 * 60 * 60 * 24)) + 1;
  let dailyCost = null;
  let prorataDays = null;
  let prorataCost = null;
  let freePeriodDaysApplied = 0;
  let freeDiscount = 0;
  let billableDays = null;
  let finalCost = annualCost;
  let proRataEnabled = false;
  let incentiveRollover = null;

  if (isPriceOverride) {
    finalCost = annualCost;
    log('Price Override', `Final cost set to manual price: ${finalCost.toFixed(2)}, all calculation lines suppressed`);
  } else if (yearNumber === 1) {
    const config = incentiveConfig;
    dailyCost = parseFloat((annualCost / totalDaysInYear).toFixed(4));
    const isPercentIncentive = config.free_period_unit === 'percent';

    if (config.prorata_enabled && isNewOrg && !rollingContext) {
      proRataEnabled = true;
      const joinMidnight = new Date(effectiveJoinDate);
      joinMidnight.setHours(0, 0, 0, 0);
      prorataDays = Math.max(0, Math.floor((yearEndMidnight - joinMidnight) / (1000 * 60 * 60 * 24)) + 1);
      prorataCost = parseFloat((dailyCost * prorataDays).toFixed(2));
      log('Pro-Rata', `${prorataDays} days × ${dailyCost.toFixed(4)} = ${prorataCost.toFixed(2)}`);

      if (config.free_period_amount && config.free_period_unit) {
        if (isPercentIncentive) {
          const fullDiscountAmount = parseFloat((annualCost * config.free_period_amount / 100).toFixed(2));
          const proportionUsed = prorataDays / totalDaysInYear;
          freeDiscount = parseFloat((fullDiscountAmount * proportionUsed).toFixed(2));
          freeDiscount = Math.min(freeDiscount, prorataCost);
          log('Percentage Discount', `${config.free_period_amount}% of ${annualCost.toFixed(2)} = ${fullDiscountAmount.toFixed(2)} full year discount, pro-rated: ${(proportionUsed * 100).toFixed(1)}% (${prorataDays}/${totalDaysInYear} days) = ${freeDiscount.toFixed(2)} applied in year 1`);
        } else {
          const freePeriodMonths = getFreeMonths(config);
          const freePeriodTotalDays = Math.round(freePeriodMonths * 30.44);
          const freePeriodEnd = new Date(joinMidnight);
          freePeriodEnd.setDate(freePeriodEnd.getDate() + freePeriodTotalDays - 1);
          const lastFreeDay = freePeriodEnd < yearEndMidnight ? freePeriodEnd : yearEndMidnight;
          freePeriodDaysApplied = Math.max(0, Math.floor((lastFreeDay - joinMidnight) / (1000 * 60 * 60 * 24)) + 1);
          freePeriodDaysApplied = Math.min(freePeriodDaysApplied, prorataDays);
          freeDiscount = parseFloat((dailyCost * freePeriodDaysApplied).toFixed(2));
          log('Free Period', `${freePeriodDaysApplied} days × ${dailyCost.toFixed(4)} = ${freeDiscount.toFixed(2)}`);
        }
      }

      if (isPercentIncentive) {
        finalCost = parseFloat(Math.max(0, prorataCost - freeDiscount).toFixed(2));
        log('Final Cost', `Pro-rata ${prorataCost.toFixed(2)} - discount ${freeDiscount.toFixed(2)} = ${finalCost.toFixed(2)}`);
      } else {
        billableDays = prorataDays - freePeriodDaysApplied;
        finalCost = parseFloat((dailyCost * billableDays).toFixed(2));
        log('Final Cost', `${billableDays} billable days × ${dailyCost.toFixed(4)} = ${finalCost.toFixed(2)}`);
      }
    } else if (isNewOrg && config.free_period_amount && config.free_period_unit) {
      dailyCost = parseFloat((annualCost / totalDaysInYear).toFixed(4));
      if (isPercentIncentive) {
        freeDiscount = parseFloat((annualCost * config.free_period_amount / 100).toFixed(2));
        finalCost = parseFloat(Math.max(0, annualCost - freeDiscount).toFixed(2));
        log('Percentage Discount (no pro-rata)', `${config.free_period_amount}% of ${annualCost.toFixed(2)} = ${freeDiscount.toFixed(2)}, final: ${finalCost.toFixed(2)}`);
      } else {
        const freePeriodMonths = getFreeMonths(config);
        const freePeriodTotalDays = Math.round(freePeriodMonths * 30.44);
        freePeriodDaysApplied = Math.min(freePeriodTotalDays, totalDaysInYear);
        freeDiscount = parseFloat((dailyCost * freePeriodDaysApplied).toFixed(2));
        finalCost = parseFloat((annualCost - freeDiscount).toFixed(2));
        log('Free Period (no pro-rata)', `${freePeriodDaysApplied} days × ${dailyCost.toFixed(4)} = ${freeDiscount.toFixed(2)}, final: ${finalCost.toFixed(2)}`);
      }
    } else {
      log('Year 1', `No pro-rata or free period applicable. Final cost: ${finalCost.toFixed(2)}`);
    }
  } else if (yearNumber === 2) {
    dailyCost = parseFloat((annualCost / totalDaysInYear).toFixed(4));
    try {
      const activeHistory = (historyRecords || []).filter(row => !['cancelled', 'void', 'expired_checkout'].includes(row.status));
      const firstYears = activeHistory.filter(row => Number(row.year_number) === 1);
      if (firstYears.length > 1) throw new Error('Multiple Year 1 records prevent identifying original incentive usage.');
      const firstYear = firstYears[0] || null;
      if (!firstYear && activeHistory.some(row => row.membership_year !== membershipYear.label)) {
        throw new Error('Historical records do not identify original Year 1 incentive usage.');
      }
      const originalConfig = firstYear?.commitment_snapshot?.config || (firstYear?.config_id
        ? await getConfigById(firstYear.config_id, tenantId)
        : await getConfigForOrganisation(tenantId, organizationId, {}, goLiveDate));
      if (originalConfig && (firstYear?.currency || originalConfig.currency || 'GBP') !== (config.currency || 'GBP')) {
        throw new Error('Original incentive and renewal currencies differ; conversion requires review.');
      }
      let projection = null;
      if (!firstYear) {
        // Check provenance before quoting: a historical date alone does not make a
        // mutable schedule (or today's organisation fields/bands) historical evidence.
        if (!originalConfig || originalConfig.pricing_model !== 'flat') {
          throw new Error('Unrecorded Year 1 banded pricing requires original pricing evidence.');
        }
        calculateOriginalIncentiveRollover({ originalConfig, goLiveDate, annualCost,
          projectedAnnualCost: originalConfig.flat_cost, projectedDiscount: 0, projectedDays: 0 });
        const { data: originalRules, error: rulesError } = await supabase.from('membership_tier_discount')
          .select('*').eq('tenant_id', tenantId).eq('config_id', originalConfig.id);
        if (rulesError || originalRules?.length || overrideApplied) {
          throw new Error('Unrecorded Year 1 discounts or overrides require original pricing evidence.');
        }
        projection = await simulateMembershipForOrg(tenantId, organizationId, {
          source: 'workflow', configId: originalConfig.id, asOfDate: goLiveDate,
        });
        if (!projection.success || projection.yearNumber !== 1 || projection.overrideApplied) {
          throw new Error('Original Year 1 incentive could not be reconstructed safely.');
        }
      }
      incentiveRollover = calculateOriginalIncentiveRollover({
        history: firstYear, originalConfig, goLiveDate, annualCost,
        projectedAnnualCost: projection?.annualCost, projectedDiscount: projection?.freeDiscount,
        projectedDays: projection?.freePeriodDaysApplied,
      });
      freeDiscount = incentiveRollover.appliedDiscount;
      freePeriodDaysApplied = incentiveRollover.appliedDays;
      finalCost = parseFloat(Math.max(0, annualCost - freeDiscount).toFixed(2));
      log('Original Incentive Rollover', `${incentiveRollover.source}: entitlement ${incentiveRollover.originalEntitlement}, used ${incentiveRollover.usedInYear1}, remaining ${incentiveRollover.remainingEntitlement}; discount ${freeDiscount.toFixed(2)}`);
    } catch (error) {
      log('Original Incentive Rollover', error.message, 'error');
      return { success: false, steps, code: 'new_member_incentive_review_required', error: error.message };
    }
  } else {
    log('Discounts', `Year ${yearNumber} - no pro-rata, free period, or rollover discounts apply`);
  }

  const computedFinalCost = parseFloat(Math.max(0, finalCost).toFixed(2));
  const currency = config.currency || 'GBP';

  log('Calculate Final Cost', `Annual: ${annualCost.toFixed(2)}${customDiscountTotal > 0 ? ` (after custom discounts: ${customDiscountTotal.toFixed(2)})` : ''}, Free discount: ${freeDiscount.toFixed(2)}${prorataCost !== null ? `, Pro-rata: ${prorataCost.toFixed(2)}` : ''}, Final: ${computedFinalCost.toFixed(2)} ${currency}`);

  const { data: membershipLedgerSetting } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('setting_key', 'membership_nominal_ledger')
    .eq('tenant_id', tenantId)
    .maybeSingle();

  let xeroAccountCode = membershipLedgerSetting?.setting_value;
  if (!xeroAccountCode) {
    const { data: accountCodeSetting } = await supabase
      .from('system_settings')
      .select('setting_value')
      .eq('setting_key', 'xero_sales_account_code')
      .eq('tenant_id', tenantId)
      .maybeSingle();
    xeroAccountCode = accountCodeSetting?.setting_value || '200';
  }

  const { data: invoiceStatusSetting } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('setting_key', 'xero_invoice_status')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  const xeroInvoiceStatus = invoiceStatusSetting?.setting_value || 'DRAFT';

  let taxType = null;
  let taxLabel = null;
  let vatOverrideApplied = false;
  let vatOverrideDetail = null;

  const vatOverride = await evaluateVatOverrideForOrg(config.id, tenantId, organizationId, fieldOverrides);
  if (vatOverride && vatOverride.taxType) {
    taxType = vatOverride.taxType;
    taxLabel = vatOverride.taxLabel;
    vatOverrideApplied = true;
    vatOverrideDetail = vatOverride;
    log('VAT Override', `Overriding band VAT with "${vatOverride.taxLabel}" (${vatOverride.taxType}) based on ${vatOverride.fieldLabel} = "${vatOverride.matchValue}"${vatOverride.ruleLabel ? ` [${vatOverride.ruleLabel}]` : ''}`);
  } else {
    const bandVatRate = matchedBand?.vat_rate || null;
    if (bandVatRate) {
      try {
        const parsed = JSON.parse(bandVatRate);
        taxType = parsed.taxType || null;
        taxLabel = parsed.name || null;
      } catch {
        taxType = bandVatRate;
        taxLabel = bandVatRate;
      }
    } else if (isFlat && config.flat_vat_rate) {
      try {
        const parsed = JSON.parse(config.flat_vat_rate);
        taxType = parsed.taxType || null;
        taxLabel = parsed.name || null;
      } catch {
        taxType = config.flat_vat_rate;
        taxLabel = config.flat_vat_rate;
      }
      log('Flat Rate VAT', `Using flat rate VAT: "${taxLabel}" (${taxType})`);
    }
  }

  let vatRatePercent = null;
  if (taxType) {
    try {
      const vatRatesKey = `xero_vat_rates_${tenantId}`;
      const { data: vatRatesSetting } = await supabase
        .from('system_settings')
        .select('setting_value')
        .eq('setting_key', vatRatesKey)
        .maybeSingle();

      if (vatRatesSetting?.setting_value) {
        const cachedData = JSON.parse(vatRatesSetting.setting_value);
        const matchedRate = (cachedData.rates || []).find(r => r.taxType === taxType);
        if (matchedRate && matchedRate.effectiveRate != null) {
          vatRatePercent = parseFloat(matchedRate.effectiveRate);
        }
      }
    } catch (vatLookupErr) {
      log('VAT Rate Lookup', `Could not look up numeric VAT rate for taxType "${taxType}": ${vatLookupErr.message}`, 'warning');
    }

    if (vatRatePercent == null && taxLabel) {
      const percentMatch = taxLabel.match(/(\d+(?:\.\d+)?)\s*%/);
      if (percentMatch) {
        vatRatePercent = parseFloat(percentMatch[1]);
      }
    }
  }

  const vatAmount = vatRatePercent ? parseFloat((computedFinalCost * vatRatePercent / 100).toFixed(2)) : 0;
  const totalWithVat = parseFloat((computedFinalCost + vatAmount).toFixed(2));

  log('Xero Settings', `Account code: ${xeroAccountCode}, Invoice status: ${xeroInvoiceStatus}, VAT: ${taxLabel ? `${taxLabel} (${taxType})` : 'Not set (no VAT applied)'}${vatRatePercent ? `, Rate: ${vatRatePercent}%, VAT Amount: ${vatAmount.toFixed(2)}, Total incl VAT: ${totalWithVat.toFixed(2)}` : ''}`);

  const scheduleStartDate = formatDate(membershipYear.start) + ' at 00:00';
  const scheduledInvoiceDate = invoicingSettings?.invoice_date ? formatDate(new Date(invoicingSettings.invoice_date)) + ' at 00:00' : null;
  const nowFormatted = formatDate(clock(), true);

  const effectiveMode = mode || currentMode || 'manual';

  if (effectiveMode === 'automatic') {
    log('Mode: Automatic', `Both renewal and invoicing happen together on the membership schedule start date`);
    log(`Step 1 - Renew (${scheduleStartDate})`, `Create membership history record for ${membershipYear.label} with final cost ${computedFinalCost.toFixed(2)} ${currency}`);
    log(`Step 2 - Invoice (${scheduleStartDate})`, `Generate and send invoice for ${computedFinalCost.toFixed(2)} ${currency} via Xero`);
    log(`Step 3 - Note (${scheduleStartDate})`, `Add organisation note documenting the automatic renewal`);
  } else if (effectiveMode === 'scheduled') {
    log('Mode: Scheduled', `Renewal happens at schedule start, invoicing on a separate scheduled date`);
    log(`Step 1 - Renew (${scheduleStartDate})`, `Create membership history record for ${membershipYear.label} with final cost ${computedFinalCost.toFixed(2)} ${currency}`);
    if (scheduledInvoiceDate) {
      log(`Step 2 - Invoice (${scheduledInvoiceDate})`, `Generate and send invoice for ${computedFinalCost.toFixed(2)} ${currency} via Xero on ${scheduledInvoiceDate}`);
    } else {
      log('Step 2 - Invoice (date not set)', `No invoice date has been saved. Scheduled mode requires a date.`, 'warning');
    }
    log(`Step 3 - Note (${scheduleStartDate})`, `Add organisation note documenting the renewal and scheduled invoice date`);
  } else if (effectiveMode === 'manual') {
    log('Mode: Manual', `Admin triggers renewal manually via the "Renew & Invoice Now" button`);
    log(`Step 1 - Renew (${nowFormatted} - when clicked)`, `Create membership history record for ${membershipYear.label} with final cost ${computedFinalCost.toFixed(2)} ${currency}`);
    log(`Step 2 - Invoice (${nowFormatted} - when clicked)`, `Generate and send invoice for ${computedFinalCost.toFixed(2)} ${currency} via Xero immediately`);
    log(`Step 3 - Note (${nowFormatted} - when clicked)`, `Add organisation note documenting the manual renewal`);
  }

  const customDesc = config.invoice_description
    ? config.invoice_description.replace(/\{year\}/gi, membershipYear.label)
    : `Membership subscription for ${membershipYear.label}`;
  const invoiceDescription = `${customDesc}.\nTier: ${tierLabel || 'Standard'}\nFee: ${currency} ${computedFinalCost.toFixed(2)}`;
  const invoiceReference = `Membership ${membershipYear.label}`;
  const invoiceDueDate = new Date(clock().getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const lineItem = {
    description: invoiceDescription,
    quantity: 1,
    unitAmount: computedFinalCost.toFixed(2),
    accountCode: xeroAccountCode,
  };
  if (taxType) {
    lineItem.taxType = taxType;
    lineItem.taxLabel = taxLabel;
  }

  const resolvedAddress = await resolveInvoiceAddress(supabase, config, organizationId, 'organization');
  const invoicePreview = {
    contact: org.name,
    reference: invoiceReference,
    status: xeroInvoiceStatus,
    dueDate: invoiceDueDate,
    invoicingAddress: resolvedAddress,
    lineItems: [lineItem],
  };

  if (!existingRecord) {
    log('Would Create History', `Membership history record for ${membershipYear.label}: tier "${tierLabel}", final cost ${computedFinalCost.toFixed(2)} ${currency}${overrideApplied ? ' (with override)' : ''}`);
    log('Would Create Note', `Organisation note documenting the ${effectiveMode} renewal with invoice details`);
    log('Invoice Preview - Contact', `${org.name}`);
    log('Invoice Preview - Address', resolvedAddress ? `${resolvedAddress}` : 'Not set (no address will be sent to Xero)');
    log('Invoice Preview - Reference', invoiceReference);
    log('Invoice Preview - Status', xeroInvoiceStatus);
    log('Invoice Preview - Due Date', `${invoiceDueDate} (30 days from invoice creation date)`);
    log('Invoice Preview - Line Description', invoiceDescription.replace(/\n/g, ' | '));
    log('Invoice Preview - Quantity', '1');
    log('Invoice Preview - Unit Amount', `${currency} ${computedFinalCost.toFixed(2)}`);
    log('Invoice Preview - Account Code', xeroAccountCode);
    log('Invoice Preview - VAT / Tax Type', taxLabel ? `${taxLabel} (${taxType})` : 'Not set (no VAT will be applied)');
  } else {
    log('Would Be Blocked', `A record for ${membershipYear.label} already exists (final cost: ${existingRecord.final_cost}). Real renewal would be rejected.`, 'warning');
  }

  log('Dry Run Complete', 'No records were created or modified', 'info');

  const rolloverDiscount = (yearNumber === 2 && !isPriceOverride) ? freeDiscount : 0;
  const year1FreeDiscount = (yearNumber === 1 && !isPriceOverride) ? freeDiscount : 0;

  return {
    success: true,
    org,
    config,
    incentiveConfig,
    matchedBand,
    tierLabel,
    fieldValue,
    annualCost,
    annualCostBeforeDiscounts: annualCostRaw,
    finalCost: computedFinalCost,
    currency,
    membershipYear,
    previousTerm: rollingContext?.previousTerm || null,
    yearNumber,
    dailyCost: isPriceOverride ? null : dailyCost,
    totalDaysInYear,
    proRataEnabled: proRataEnabled,
    prorataDays: proRataEnabled ? prorataDays : null,
    prorataCost: proRataEnabled ? prorataCost : null,
    freeDiscount: isPriceOverride ? 0 : year1FreeDiscount,
    rolloverDiscount,
    incentiveRollover,
    freePeriodDaysApplied: isPriceOverride ? 0 : freePeriodDaysApplied,
    freePeriodAmount: incentiveConfig.free_period_amount,
    freePeriodUnit: incentiveConfig.free_period_unit,
    billableDays: proRataEnabled ? billableDays : null,
    customDiscountTotal,
    customDiscountDetails,
    overrideApplied,
    overrideType: override?.override_type || null,
    overrideDiscountType: override?.discount_type || null,
    overrideDiscountValue: override?.discount_value || null,
    existingRecord,
    invoicePreview: !existingRecord ? invoicePreview : null,
    invoicingSettings,
    xeroAccountCode,
    xeroInvoiceStatus,
    billingPeriod: config.billing_period || 'annual',
    goLiveDate,
    isNewOrg,
    nominalCode: String(matchedBand?.nominal_code || (isFlat ? config.nominal_code : '') || '').trim() || null,
    vatRatePercent,
    vatAmount,
    totalWithVat,
    taxType,
    taxLabel,
    vatOverrideApplied,
    vatOverrideDetail,
    steps,
  };
}

function formatDate(date, includeTime = false) {
  if (!date || !(date instanceof Date) || isNaN(date.getTime())) return 'Unknown';
  const datePart = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  if (!includeTime) return datePart;
  const timePart = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${datePart} at ${timePart}`;
}

async function getConfigById(configId, tenantId) {
  const { data } = await supabase
    .from('membership_tier_config')
    .select('*')
    .eq('id', configId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  return data;
}

async function getBandsForConfig(configId, tenantId) {
  const { data } = await supabase
    .from('membership_tier_band')
    .select('*')
    .eq('config_id', configId)
    .eq('tenant_id', tenantId)
    .order('display_order', { ascending: true, nullsFirst: false })
    .order('min_value', { ascending: true, nullsFirst: false });
  return data || [];
}


function calculateMembershipYear(config) {
  return calculateMembershipYearWindow(config);
}

function calculateNextMembershipYear(config) {
  return calculateNextMembershipYearWindow(config);
}

function calculateFreePeriodDiscount(annualCost, config) {
  if (!config.free_period_amount || !config.free_period_unit) return 0;
  const amount = config.free_period_amount;
  const unit = config.free_period_unit;
  if (unit === 'percent') {
    return parseFloat((annualCost * amount / 100).toFixed(2));
  }
  let freeMonths = 0;
  if (unit === 'months') freeMonths = amount;
  else if (unit === 'weeks') freeMonths = amount / 4.33;
  else if (unit === 'days') freeMonths = amount / 30.44;
  return parseFloat((annualCost * freeMonths / 12).toFixed(2));
}

function calculateRolloverDiscount(annualCost, config, goLiveDate) {
  if (!config.rollover_enabled || !config.free_period_amount || !goLiveDate) return 0;

  const goLive = new Date(goLiveDate);
  if (isNaN(goLive.getTime())) return 0;

  const startMonth = config.membership_start_month || 1;
  const startDay = config.membership_start_day || 1;

  const glYear = goLive.getFullYear();
  const glYearStart = new Date(glYear, startMonth - 1, startDay);
  const firstYearStart = goLive >= glYearStart ? glYearStart : new Date(glYear - 1, startMonth - 1, startDay);
  const firstYearEnd = new Date(firstYearStart.getFullYear() + 1, startMonth - 1, startDay);

  const totalDaysInFirstYear = Math.ceil((firstYearEnd - firstYearStart) / (1000 * 60 * 60 * 24));
  const remainingDaysInFirstYear = Math.max(0, Math.ceil((firstYearEnd - goLive) / (1000 * 60 * 60 * 24)));

  if (config.free_period_unit === 'percent') {
    const fullDiscountAmount = parseFloat((annualCost * config.free_period_amount / 100).toFixed(2));
    const y1Proportion = Math.min(1, remainingDaysInFirstYear / totalDaysInFirstYear);
    const y1DiscountApplied = parseFloat((fullDiscountAmount * y1Proportion).toFixed(2));
    const spillover = parseFloat(Math.max(0, fullDiscountAmount - y1DiscountApplied).toFixed(2));
    return Math.min(spillover, annualCost);
  }

  const remainingMonths = (remainingDaysInFirstYear / totalDaysInFirstYear) * 12;
  const freeMonths = getFreeMonths(config);
  const unusedFreeMonths = Math.max(0, freeMonths - remainingMonths);

  if (unusedFreeMonths <= 0) return 0;
  return parseFloat((annualCost * unusedFreeMonths / 12).toFixed(2));
}

function getFreeMonths(config) {
  if (!config.free_period_amount || !config.free_period_unit) return 0;
  const amount = config.free_period_amount;
  const unit = config.free_period_unit;
  if (unit === 'months') return amount;
  if (unit === 'weeks') return amount / 4.33;
  if (unit === 'days') return amount / 30.44;
  return 0;
}

function determineMembershipYearNumber(goLiveDate, targetYear, config) {
  if (!goLiveDate) return 99;

  const goLive = new Date(goLiveDate);
  if (isNaN(goLive.getTime())) return 99;

  if (config?.start_mode === 'immediate') {
    const targetStart = new Date(targetYear.start);
    targetStart.setHours(0, 0, 0, 0);
    const glMid = new Date(goLive);
    glMid.setHours(0, 0, 0, 0);
    if (targetStart <= glMid) return 1;
    let elapsed = targetStart.getFullYear() - glMid.getFullYear();
    const anniv = new Date(glMid.getFullYear() + elapsed, glMid.getMonth(), glMid.getDate());
    if (targetStart < anniv) elapsed -= 1;
    return Math.max(1, elapsed + 1);
  }

  const startMonth = config.membership_start_month || 1;
  const startDay = config.membership_start_day || 1;

  const glYear = goLive.getFullYear();
  const glYearStart = new Date(glYear, startMonth - 1, startDay);
  const firstYearStart = goLive >= glYearStart ? glYearStart : new Date(glYear - 1, startMonth - 1, startDay);

  const targetStart = new Date(targetYear.start);
  targetStart.setHours(0, 0, 0, 0);

  let yearNumber = 1;
  let currentStart = new Date(firstYearStart);
  while (currentStart < targetStart) {
    currentStart = new Date(currentStart.getFullYear() + 1, startMonth - 1, startDay);
    yearNumber++;
    if (yearNumber > 100) break;
  }

  return yearNumber;
}

async function getGoLiveFieldId(tenantId) {
  try {
    const { data } = await supabase
      .from('preference_field')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('entity_scope', 'organization')
      .eq('is_active', true)
      .eq('name', 'go_live')
      .maybeSingle();
    return data?.id || null;
  } catch {
    return null;
  }
}

async function getOrgGoLiveDate(orgId, goLiveFieldId) {
  if (!goLiveFieldId) return null;
  try {
    const { data } = await supabase
      .from('organization_preference_value')
      .select('value')
      .eq('organization_id', orgId)
      .eq('field_id', goLiveFieldId)
      .maybeSingle();
    if (!data?.value) return null;
    const dateStr = String(data.value).trim();
    if (!dateStr || dateStr === 'null') return null;
    return dateStr.split('T')[0];
  } catch {
    return null;
  }
}

async function getOrgFieldValue(orgId, tenantId, config, fieldOverrides = {}) {
  if (!config) return null;

  if (config.field_source === 'core' && config.field_name === 'member_count') {
    const coreKey = `core:${config.field_name}`;
    if (coreKey in fieldOverrides) {
      const num = parseFloat(fieldOverrides[coreKey]);
      return isNaN(num) ? null : num;
    }
    const { data: members } = await supabase
      .from('member')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('organization_id', orgId);
    return members?.length || 0;
  }

  if (config.field_id) {
    if (config.field_id in fieldOverrides) {
      const v = fieldOverrides[config.field_id];
      return v == null || v === '' ? null : v;
    }
    const { data: pv } = await supabase
      .from('organization_preference_value')
      .select('value')
      .eq('organization_id', orgId)
      .eq('field_id', config.field_id)
      .maybeSingle();

    if (pv?.value != null && pv.value !== '') {
      return pv.value;
    }
  }

  return null;
}

async function getMemberGoLiveDate(memberId, tenantId) {
  try {
    const { data: field } = await supabase
      .from('preference_field')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('entity_scope', 'member')
      .eq('is_active', true)
      .eq('name', 'go_live')
      .maybeSingle();
    if (!field?.id) return null;

    const { data: pv } = await supabase
      .from('member_preference_value')
      .select('value')
      .eq('member_id', memberId)
      .eq('field_id', field.id)
      .maybeSingle();
    if (!pv?.value) return null;
    const dateStr = String(pv.value).trim();
    if (!dateStr || dateStr === 'null') return null;
    return dateStr.split('T')[0];
  } catch {
    return null;
  }
}

async function getMemberFieldValue(memberId, tenantId, config, fieldOverrides = {}) {
  if (!config) return null;

  if (config.field_source === 'core' && config.field_name) {
    const coreKey = `core:${config.field_name}`;
    if (coreKey in fieldOverrides) {
      const num = parseFloat(fieldOverrides[coreKey]);
      return isNaN(num) ? null : num;
    }
    const coreFieldName = config.field_name;
    const { data: member } = await supabase
      .from('member')
      .select(coreFieldName)
      .eq('id', memberId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (member && member[coreFieldName] !== undefined && member[coreFieldName] !== null) {
      const num = parseFloat(member[coreFieldName]);
      return isNaN(num) ? null : num;
    }
    return null;
  }

  if (config.field_id) {
    if (config.field_id in fieldOverrides) {
      const v = fieldOverrides[config.field_id];
      return v == null || v === '' ? null : v;
    }
    const { data: pv } = await supabase
      .from('member_preference_value')
      .select('value')
      .eq('member_id', memberId)
      .eq('field_id', config.field_id)
      .maybeSingle();
    if (pv?.value != null && pv.value !== '') {
      return pv.value;
    }
  }

  return null;
}

async function simulateMembershipForMember(tenantId, memberId, options = {}) {
  const {
    source = 'workflow',
    mode = 'automatic',
    workflowName = null,
    verbose = false,
    targetYear = null,
    fieldOverrides = {},
    configId: explicitConfigId = null,
    asOfDate = null,
  } = options;

  const steps = [];
  const log = (step, detail, status = 'ok') => {
    steps.push({ step, detail, status, timestamp: clock().toISOString() });
  };

  log('Start', source === 'workflow'
    ? `Dry run simulation for member via workflow "${workflowName || 'Unknown'}"`
    : `Simulating "${mode}" renewal for member ${memberId}`);

  const { data: member } = await supabase
    .from('member')
    .select('id, first_name, last_name, email, tenant_id, organization_id, created_on')
    .eq('id', memberId)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (!member) {
    log('Lookup Member', 'Member not found', 'error');
    return { success: false, steps, error: 'Member not found or does not belong to this tenant' };
  }
  const memberName = `${member.first_name || ''} ${member.last_name || ''}`.trim() || member.email;
  log('Lookup Member', `Found: ${memberName} (${member.email || 'no email'})`);

  const { data: allInvoicingSettings } = await supabase
    .from('member_membership_invoicing')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('member_id', memberId);

  let invoicingSettings = null;
  if (allInvoicingSettings && allInvoicingSettings.length > 0) {
    invoicingSettings = allInvoicingSettings.find(s => s.membership_year === (targetYear || null));
    if (!invoicingSettings) {
      invoicingSettings = allInvoicingSettings.find(s => !s.membership_year);
    }
  }

  const currentMode = invoicingSettings?.invoicing_mode || 'manual';
  log('Check Invoicing Settings', `Saved mode: "${currentMode}"${invoicingSettings?.invoice_date ? `, scheduled date: ${invoicingSettings.invoice_date}` : ''}${invoicingSettings?.membership_year ? ` (for ${invoicingSettings.membership_year})` : ''}`);

  let config = explicitConfigId
    ? await getConfigByIdDirect(tenantId, explicitConfigId)
    : await getConfigForMember(tenantId, memberId, fieldOverrides, asOfDate);
  let rollingContext;
  try {
    rollingContext = await resolveRollingSimulationContext(supabase, { tenantId, memberId, config, options });
  } catch (error) {
    return { success: false, steps, code: 'rolling_membership_review_required', error: error.message };
  }
  if (rollingContext?.existing) return purchasedRollingSimulation(rollingContext.existing, { member }, steps, invoicingSettings);
  if (rollingContext) config = rollingContext.config;
  if (!config) {
    const allActive = await getAllActiveConfigs(tenantId, asOfDate);
    const memberConfigs = allActive.filter(c => c.structure_scope_type === 'member');
    if (memberConfigs.length > 0) {
      log('Fetch Tier Config', `No matching member tier configuration found. There are ${memberConfigs.length} member-scoped config(s), but none match this member's field values.`, 'error');
    } else {
      log('Fetch Tier Config', 'No active member-scoped tier configuration found for this tenant', 'error');
    }
    return { success: false, steps, error: 'No active member-scoped tier configuration found' };
  }

  // Re-resolve the config as of the *target* membership year's start date (see the
  // organisation simulation above for the full rationale): bootstrap the target year
  // window from the just-resolved config to derive its start date, then re-resolve as
  // of that date so future-scheduled configs governing the next year are honoured.
  let configResolutionDate = asOfDate || null;
  if (!explicitConfigId && !rollingContext) {
    const bootstrapCurrentYear = calculateMembershipYear(config);
    const bootstrapNextYear = calculateNextMembershipYear(config);
    let targetWindow;
    if (targetYear) {
      targetWindow = targetYear === bootstrapCurrentYear.label ? bootstrapCurrentYear : bootstrapNextYear;
    } else {
      targetWindow = source === 'simulate' ? bootstrapNextYear : bootstrapCurrentYear;
    }
    if (targetWindow.label === bootstrapNextYear.label) {
      const targetStartDate = targetWindow.start.toISOString().split('T')[0];
      configResolutionDate = targetStartDate;
      const reResolved = await getConfigForMember(tenantId, memberId, fieldOverrides, targetStartDate);
      if (reResolved) config = reResolved;
    }
  }

  const resolvedAsOf = configResolutionDate || clock().toISOString().split('T')[0];
  log('Fetch Tier Config', `Active config: "${config.name || 'Default'}", pricing: ${config.pricing_model || 'banded'}, currency: ${config.currency || 'GBP'}, start: month ${config.membership_start_month || 1} day ${config.membership_start_day || 1}, incentive: ${config.free_period_amount ? `${config.free_period_amount} ${config.free_period_unit}` : 'none'}, rollover: ${config.rollover_enabled ? 'yes' : 'no'} (resolved as of ${resolvedAsOf})`);

  if (explicitConfigId) {
    log('Config Resolution', `Using explicitly selected config ID: ${explicitConfigId} (name: "${config.name || 'Default'}")`);
  } else if (config.structure_field_id && config.structure_match_value) {
    let structureFieldLabel = config.structure_field_id;
    try {
      if (config.structure_field_id.startsWith('core:')) {
        structureFieldLabel = config.structure_field_id.replace('core:', '');
      } else {
        const { data: fieldDef } = await supabase
          .from('preference_field')
          .select('label, name')
          .eq('id', config.structure_field_id)
          .maybeSingle();
        if (fieldDef) structureFieldLabel = fieldDef.label || fieldDef.name || config.structure_field_id;
      }
    } catch {}
    const hasOverride = config.structure_field_id in fieldOverrides;
    log('Config Resolution', `Scoped config matched — field "${structureFieldLabel}" = "${config.structure_match_value}"${hasOverride ? ' [from form override]' : ''}`);
  } else {
    log('Config Resolution', 'Using default (unscoped) member tier configuration — no structure scope defined');
  }

  const currentYearObj = calculateMembershipYearWindow(config, asOfDate ? new Date(`${asOfDate}T00:00:00.000Z`) : clock());
  const nextYearObj = calculateNextMembershipYearWindow(config, asOfDate ? new Date(`${asOfDate}T00:00:00.000Z`) : clock());
  log('Calculate Membership Year', `Current year: ${currentYearObj.label}, Next year: ${nextYearObj.label}`);

  let membershipYear;
  if (rollingContext) {
    membershipYear = rollingContext.window;
  } else if (targetYear) {
    membershipYear = targetYear === currentYearObj.label ? currentYearObj : nextYearObj;
  } else {
    membershipYear = source === 'simulate' ? nextYearObj : currentYearObj;
  }

  const goLiveDate = await getMemberGoLiveDate(memberId, tenantId);
  const createdDate = member.created_on ? String(member.created_on).split('T')[0] : null;
  const assumedGoLiveDate = goLiveDate || createdDate || clock().toISOString().split('T')[0];
  const yearNumber = rollingContext ? (rollingContext.previousTerm ? (Number(rollingContext.previousTerm.year_number) || 1) + 1 : 1) : determineMembershipYearNumber(assumedGoLiveDate, membershipYear, config);
  const currentYearNumber = determineMembershipYearNumber(assumedGoLiveDate, currentYearObj, config);

  if (goLiveDate) {
    let yearDesc;
    if (yearNumber === 1) yearDesc = 'First year - pro-rata and free period discounts apply';
    else if (yearNumber === 2) yearDesc = 'Second year - free period spillover may apply';
    else yearDesc = `Year ${yearNumber} - established member, full annual fee`;
    log('Go-Live Date', `${goLiveDate} → membership year ${yearNumber}. ${yearDesc}`);
  } else {
    log('Go-Live Date', `Not set - using ${createdDate ? `member created date (${createdDate})` : `today (${assumedGoLiveDate})`} → membership year ${yearNumber}`, 'info');
  }

  const { data: existingRecord } = await supabase
    .from('member_membership_history')
    .select('id, membership_year, final_cost, xero_invoice_id')
    .eq('tenant_id', tenantId)
    .eq('member_id', memberId)
    .eq('membership_year', membershipYear.label)
    .maybeSingle();

  if (existingRecord) {
    log('Check Existing Record', `A membership record for ${membershipYear.label} already exists (final cost: ${existingRecord.final_cost}). Renewal would be blocked.`, 'warning');
  } else {
    log('Check Existing Record', `No existing record for ${membershipYear.label} - creation would proceed`);
  }

  const isFlat = config.pricing_model === 'flat';
  let annualCostRaw;
  let annualCost;
  let tierLabel;
  let matchedBand = null;
  let usedConfigId = config.id;
  let usedBandId = null;
  let fieldValue = null;

  if (isFlat) {
    if (rollingContext && (config.flat_cost == null || !Number.isFinite(Number(config.flat_cost)) || Number(config.flat_cost) < 0)) {
      throw new Error('The rolling membership structure has no valid agreed price; review its pricing before renewal.');
    }
    annualCostRaw = parseFloat(config.flat_cost) || 0;
    annualCost = annualCostRaw;
    tierLabel = 'Flat Rate';
    log('Pricing Model', `Flat rate pricing: ${annualCostRaw}`);
  } else {
    const bands = await getBandsForConfig(config.id, tenantId);
    log('Fetch Tier Bands', `Found ${bands.length} band(s)`);

    fieldValue = await getMemberFieldValue(memberId, tenantId, config, fieldOverrides);
    const fieldLabel = await resolveBasisFieldLabel(config, tenantId);
    log('Get Member Field Value', `${fieldLabel}: ${fieldValue !== null ? fieldValue : 'N/A'}`);

    matchedBand = matchBand(fieldValue, bands);
    if (!matchedBand) {
      log('Match Tier Band', `No band matches the current field value (${fieldValue})`, 'error');
      return { success: false, steps, error: `Member does not match any tier band (field value: ${fieldValue})` };
    }
    log('Match Tier Band', `Matched: "${matchedBand.label}" (range: ${matchedBand.min_value}-${matchedBand.max_value || '∞'}, annual cost: ${matchedBand.annual_cost})`);

    annualCostRaw = parseFloat(matchedBand.annual_cost);
    annualCost = annualCostRaw;
    tierLabel = matchedBand.label;
    usedBandId = matchedBand.id;
  }

  let overrideApplied = false;
  let override = null;
  let overrideConfigName = null;
  let customDiscountTotal = 0;
  let customDiscountDetails = [];
  try {
    const yearLabel = membershipYear?.label || null;
    let overrideQuery = supabase
      .from('member_membership_override')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('member_id', memberId);
    if (yearLabel) {
      overrideQuery = overrideQuery.or(`membership_year.eq.${yearLabel},membership_year.is.null`);
    }
    const { data: overrideRows } = await overrideQuery;
    if (overrideRows && overrideRows.length > 0) {
      override = overrideRows.find(o => o.membership_year === yearLabel) || overrideRows.find(o => !o.membership_year) || overrideRows[0];
    }
  } catch {}

  if (override) {
    overrideApplied = true;
    if (override.override_type === 'price' && override.manual_price !== null) {
      annualCost = parseFloat(override.manual_price);
      customDiscountTotal = 0;
      customDiscountDetails = [];
      log('Apply Override', `Price override: ${annualCost.toFixed(2)} (note: ${override.note || 'none'})`);
    } else if (override.override_type === 'discount' && override.discount_type && override.discount_value !== null) {
      const grossCost = annualCost;
      const val = parseFloat(override.discount_value);
      let overrideDiscountAmt = 0;
      if (override.discount_type === 'percentage') {
        overrideDiscountAmt = parseFloat((grossCost * val / 100).toFixed(2));
      } else {
        overrideDiscountAmt = Math.min(val, grossCost);
      }
      annualCost = Math.max(0, grossCost - overrideDiscountAmt);
      customDiscountTotal = overrideDiscountAmt;
      customDiscountDetails = [{
        label: 'Manual Discount Override',
        discount_type: override.discount_type,
        discount_value: val,
        applied_amount: overrideDiscountAmt,
      }];
      log('Apply Override', `Discount override: ${override.discount_type === 'percentage' ? val + '%' : val.toFixed(2)} off, discount amount: ${overrideDiscountAmt.toFixed(2)}, net cost: ${annualCost.toFixed(2)} (note: ${override.note || 'none'})`);
    } else if (override.override_type === 'structure' && override.config_id) {
      if (rollingContext && override.config_id !== config.id) throw new Error('A rolling structure override must be resolved as an eligible structure before a new commitment is quoted.');
      const overrideConfig = await getConfigById(override.config_id, tenantId);
      if (overrideConfig) {
        const overrideBands = await getBandsForConfig(overrideConfig.id, tenantId);
        const overrideBand = override.band_id
          ? overrideBands.find(b => b.id === override.band_id)
          : matchBand(fieldValue, overrideBands);

        if (overrideBand) {
          annualCostRaw = parseFloat(overrideBand.annual_cost);
          annualCost = annualCostRaw;
          tierLabel = overrideBand.label;
          matchedBand = overrideBand;
          usedConfigId = overrideConfig.id;
          usedBandId = overrideBand.id;
          overrideConfigName = overrideConfig.name || null;
          customDiscountTotal = 0;
          customDiscountDetails = [];
          log('Apply Override', `Structure override: config "${overrideConfig.name || overrideConfig.id}", band "${overrideBand.label}", cost: ${annualCost.toFixed(2)} (note: ${override.note || 'none'})`);
        } else {
          log('Apply Override', 'Structure override set but no matching band found', 'warning');
          overrideApplied = false;
        }
      }
    }
  } else {
    log('Check Override', 'No override configured for this member');
  }

  const isPriceOverride = override?.override_type === 'price';

  const { data: historyRecords } = await supabase
    .from('member_membership_history')
    .select('id, membership_year')
    .eq('tenant_id', tenantId)
    .eq('member_id', memberId);

  const hasCurrentYearRecord = (historyRecords || []).some(h => h.membership_year === currentYearObj.label);
  const isNewMember = rollingContext ? !rollingContext.previousTerm : (currentYearNumber === 1 || !goLiveDate) && !hasCurrentYearRecord;
  const effectiveJoinDate = rollingContext ? new Date(membershipYear.start) : goLiveDate ? new Date(goLiveDate) : (createdDate ? new Date(createdDate) : clock());

  const yearStartMidnight = new Date(membershipYear.start);
  yearStartMidnight.setHours(0, 0, 0, 0);
  const yearEndMidnight = new Date(membershipYear.end);
  yearEndMidnight.setHours(0, 0, 0, 0);
  const totalDaysInYear = Math.floor(((rollingContext ? membershipYear.end : yearEndMidnight) - (rollingContext ? membershipYear.start : yearStartMidnight)) / (1000 * 60 * 60 * 24)) + 1;
  let dailyCost = null;
  let prorataDays = null;
  let prorataCost = null;
  let freePeriodDaysApplied = 0;
  let freeDiscount = 0;
  let billableDays = null;
  let finalCost = annualCost;
  let proRataEnabled = false;

  if (isPriceOverride) {
    finalCost = annualCost;
    log('Price Override', `Final cost set to manual price: ${finalCost.toFixed(2)}, all calculation lines suppressed`);
  } else if (yearNumber === 1) {
    dailyCost = parseFloat((annualCost / totalDaysInYear).toFixed(4));
    const isPercentIncentive = config.free_period_unit === 'percent';

    if (config.prorata_enabled && isNewMember && !rollingContext) {
      proRataEnabled = true;
      const joinMidnight = new Date(effectiveJoinDate);
      joinMidnight.setHours(0, 0, 0, 0);
      prorataDays = Math.max(0, Math.floor((yearEndMidnight - joinMidnight) / (1000 * 60 * 60 * 24)) + 1);
      prorataCost = parseFloat((dailyCost * prorataDays).toFixed(2));
      log('Pro-Rata', `${prorataDays} days × ${dailyCost.toFixed(4)} = ${prorataCost.toFixed(2)}`);

      if (config.free_period_amount && config.free_period_unit) {
        if (isPercentIncentive) {
          const fullDiscountAmount = parseFloat((annualCost * config.free_period_amount / 100).toFixed(2));
          const proportionUsed = prorataDays / totalDaysInYear;
          freeDiscount = parseFloat((fullDiscountAmount * proportionUsed).toFixed(2));
          freeDiscount = Math.min(freeDiscount, prorataCost);
          log('Percentage Discount', `${config.free_period_amount}% of ${annualCost.toFixed(2)} = ${fullDiscountAmount.toFixed(2)} full year discount, pro-rated: ${(proportionUsed * 100).toFixed(1)}% = ${freeDiscount.toFixed(2)} applied in year 1`);
        } else {
          const freePeriodMonths = getFreeMonths(config);
          const freePeriodTotalDays = Math.round(freePeriodMonths * 30.44);
          const freePeriodEnd = new Date(joinMidnight);
          freePeriodEnd.setDate(freePeriodEnd.getDate() + freePeriodTotalDays - 1);
          const lastFreeDay = freePeriodEnd < yearEndMidnight ? freePeriodEnd : yearEndMidnight;
          freePeriodDaysApplied = Math.max(0, Math.floor((lastFreeDay - joinMidnight) / (1000 * 60 * 60 * 24)) + 1);
          freePeriodDaysApplied = Math.min(freePeriodDaysApplied, prorataDays);
          freeDiscount = parseFloat((dailyCost * freePeriodDaysApplied).toFixed(2));
          log('Free Period', `${freePeriodDaysApplied} days × ${dailyCost.toFixed(4)} = ${freeDiscount.toFixed(2)}`);
        }
      }

      if (isPercentIncentive) {
        finalCost = parseFloat(Math.max(0, prorataCost - freeDiscount).toFixed(2));
        log('Final Cost', `Pro-rata ${prorataCost.toFixed(2)} - discount ${freeDiscount.toFixed(2)} = ${finalCost.toFixed(2)}`);
      } else {
        billableDays = prorataDays - freePeriodDaysApplied;
        finalCost = parseFloat((dailyCost * billableDays).toFixed(2));
        log('Final Cost', `${billableDays} billable days × ${dailyCost.toFixed(4)} = ${finalCost.toFixed(2)}`);
      }
    } else if (isNewMember && config.free_period_amount && config.free_period_unit) {
      dailyCost = parseFloat((annualCost / totalDaysInYear).toFixed(4));
      if (isPercentIncentive) {
        freeDiscount = parseFloat((annualCost * config.free_period_amount / 100).toFixed(2));
        finalCost = parseFloat(Math.max(0, annualCost - freeDiscount).toFixed(2));
        log('Percentage Discount (no pro-rata)', `${config.free_period_amount}% of ${annualCost.toFixed(2)} = ${freeDiscount.toFixed(2)}, final: ${finalCost.toFixed(2)}`);
      } else {
        const freePeriodMonths = getFreeMonths(config);
        const freePeriodTotalDays = Math.round(freePeriodMonths * 30.44);
        freePeriodDaysApplied = Math.min(freePeriodTotalDays, totalDaysInYear);
        freeDiscount = parseFloat((dailyCost * freePeriodDaysApplied).toFixed(2));
        finalCost = parseFloat((annualCost - freeDiscount).toFixed(2));
        log('Free Period (no pro-rata)', `${freePeriodDaysApplied} days × ${dailyCost.toFixed(4)} = ${freeDiscount.toFixed(2)}, final: ${finalCost.toFixed(2)}`);
      }
    } else {
      log('Year 1', `No pro-rata or free period applicable. Final cost: ${finalCost.toFixed(2)}`);
    }
  } else if (yearNumber === 2) {
    dailyCost = parseFloat((annualCost / totalDaysInYear).toFixed(4));
    const isPercentIncentive = config.free_period_unit === 'percent';

    if (isNewMember && config.free_period_amount && config.free_period_unit && config.rollover_enabled) {
      if (isPercentIncentive) {
        const fullDiscountAmount = parseFloat((annualCost * config.free_period_amount / 100).toFixed(2));
        const joinMidnight = new Date(effectiveJoinDate);
        joinMidnight.setHours(0, 0, 0, 0);
        let firstYearStart;
        let firstYearEnd;
        if (config.start_mode === 'immediate') {
          firstYearStart = new Date(joinMidnight);
          firstYearEnd = new Date(joinMidnight);
          firstYearEnd.setFullYear(firstYearEnd.getFullYear() + 1);
        } else {
          const startMonth = config.membership_start_month || 1;
          const startDay = config.membership_start_day || 1;
          const joinDateYear = joinMidnight.getFullYear();
          const y1Start = new Date(joinDateYear, startMonth - 1, startDay);
          firstYearStart = joinMidnight >= y1Start ? y1Start : new Date(joinDateYear - 1, startMonth - 1, startDay);
          firstYearEnd = new Date(firstYearStart.getFullYear() + 1, startMonth - 1, startDay);
        }
        const firstYearTotalDays = Math.ceil((firstYearEnd - firstYearStart) / (1000 * 60 * 60 * 24));
        const remainingDaysInFirstYear = Math.max(0, Math.ceil((firstYearEnd - joinMidnight) / (1000 * 60 * 60 * 24)));

        let y1ProportionUsed = 1;
        if (config.prorata_enabled) {
          y1ProportionUsed = Math.min(1, remainingDaysInFirstYear / firstYearTotalDays);
        }

        const y1DiscountApplied = parseFloat((fullDiscountAmount * y1ProportionUsed).toFixed(2));
        const spilloverDiscount = parseFloat(Math.max(0, fullDiscountAmount - y1DiscountApplied).toFixed(2));
        freeDiscount = Math.min(spilloverDiscount, annualCost);
        finalCost = parseFloat(Math.max(0, annualCost - freeDiscount).toFixed(2));

        if (freeDiscount > 0) {
          log('Percentage Discount Rollover', `Full discount: ${fullDiscountAmount.toFixed(2)} (${config.free_period_amount}%), applied in Y1: ${y1DiscountApplied.toFixed(2)}, rollover to Y2: ${freeDiscount.toFixed(2)}`);
        } else {
          log('Percentage Discount Rollover', `No rollover - full ${config.free_period_amount}% discount was used in year 1`);
        }
      } else {
        const freePeriodMonths = getFreeMonths(config);
        const freePeriodTotalDays = Math.round(freePeriodMonths * 30.44);
        const curYear = calculateMembershipYear(config);
        const curYearStartMidnight = new Date(curYear.start);
        curYearStartMidnight.setHours(0, 0, 0, 0);
        const curYearEndMidnight = new Date(curYear.end);
        curYearEndMidnight.setHours(0, 0, 0, 0);
        const curYearTotalDays = Math.floor((curYearEndMidnight - curYearStartMidnight) / (1000 * 60 * 60 * 24)) + 1;

        let freeDaysInCurrentYear = 0;
        if (config.prorata_enabled) {
          const joinMidnight = new Date(effectiveJoinDate);
          joinMidnight.setHours(0, 0, 0, 0);
          const currentProrataDays = Math.max(0, Math.floor((curYearEndMidnight - joinMidnight) / (1000 * 60 * 60 * 24)) + 1);
          const freePeriodEnd = new Date(joinMidnight);
          freePeriodEnd.setDate(freePeriodEnd.getDate() + freePeriodTotalDays - 1);
          const lastFreeDay = freePeriodEnd < curYearEndMidnight ? freePeriodEnd : curYearEndMidnight;
          freeDaysInCurrentYear = Math.max(0, Math.floor((lastFreeDay - joinMidnight) / (1000 * 60 * 60 * 24)) + 1);
          freeDaysInCurrentYear = Math.min(freeDaysInCurrentYear, currentProrataDays);
        } else {
          freeDaysInCurrentYear = Math.min(freePeriodTotalDays, curYearTotalDays);
        }

        const spilloverDays = Math.max(0, freePeriodTotalDays - freeDaysInCurrentYear);
        freePeriodDaysApplied = Math.min(spilloverDays, totalDaysInYear);
        freeDiscount = parseFloat((dailyCost * freePeriodDaysApplied).toFixed(2));
        finalCost = parseFloat(Math.max(0, annualCost - freeDiscount).toFixed(2));

        if (freePeriodDaysApplied > 0) {
          log('Free Period Spillover', `${freePeriodDaysApplied} days × ${dailyCost.toFixed(4)} = ${freeDiscount.toFixed(2)} (spillover from year 1)`);
        } else {
          log('Free Period Spillover', 'No spillover - free period was fully used in year 1');
        }
      }
    } else if (isNewMember && config.free_period_amount && config.free_period_unit && !config.rollover_enabled) {
      log('Year 2 Rollover Skipped', `Free period rollover is disabled for this schedule. Full annual cost applies: ${finalCost.toFixed(2)}`);
    } else {
      log('Year 2', `Full annual cost applies. Final cost: ${finalCost.toFixed(2)}`);
    }
  } else {
    log('Discounts', `Year ${yearNumber} - no pro-rata, free period, or rollover discounts apply`);
  }

  const computedFinalCost = parseFloat(Math.max(0, finalCost).toFixed(2));
  const currency = config.currency || 'GBP';

  log('Calculate Final Cost', `Annual: ${annualCost.toFixed(2)}, Free discount: ${freeDiscount.toFixed(2)}${prorataCost !== null ? `, Pro-rata: ${prorataCost.toFixed(2)}` : ''}, Final: ${computedFinalCost.toFixed(2)} ${currency}`);

  const { data: membershipLedgerSetting } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('setting_key', 'membership_nominal_ledger')
    .eq('tenant_id', tenantId)
    .maybeSingle();

  let xeroAccountCode = membershipLedgerSetting?.setting_value;
  if (!xeroAccountCode) {
    const { data: accountCodeSetting } = await supabase
      .from('system_settings')
      .select('setting_value')
      .eq('setting_key', 'xero_sales_account_code')
      .eq('tenant_id', tenantId)
      .maybeSingle();
    xeroAccountCode = accountCodeSetting?.setting_value || '200';
  }

  const { data: invoiceStatusSetting } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('setting_key', 'xero_invoice_status')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  const xeroInvoiceStatus = invoiceStatusSetting?.setting_value || 'DRAFT';

  let taxType = null;
  let taxLabel = null;
  let vatOverrideApplied = false;
  let vatOverrideDetail = null;

  const vatOverride = await evaluateVatOverrideForMember(config.id, tenantId, memberId, fieldOverrides);
  if (vatOverride && vatOverride.taxType) {
    taxType = vatOverride.taxType;
    taxLabel = vatOverride.taxLabel;
    vatOverrideApplied = true;
    vatOverrideDetail = vatOverride;
    log('VAT Override', `Overriding VAT with "${vatOverride.taxLabel}" (${vatOverride.taxType}) based on ${vatOverride.fieldLabel} = "${vatOverride.matchValue}"${vatOverride.ruleLabel ? ` [${vatOverride.ruleLabel}]` : ''}`);
  } else {
    const bandVatRate = matchedBand?.vat_rate || null;
    if (bandVatRate) {
      try {
        const parsed = JSON.parse(bandVatRate);
        taxType = parsed.taxType || null;
        taxLabel = parsed.name || null;
      } catch {
        taxType = bandVatRate;
        taxLabel = bandVatRate;
      }
    } else if (isFlat && config.flat_vat_rate) {
      try {
        const parsed = JSON.parse(config.flat_vat_rate);
        taxType = parsed.taxType || null;
        taxLabel = parsed.name || null;
      } catch {
        taxType = config.flat_vat_rate;
        taxLabel = config.flat_vat_rate;
      }
      log('Flat Rate VAT', `Using flat rate VAT: "${taxLabel}" (${taxType})`);
    }
  }

  let vatRatePercent = null;
  if (taxType) {
    try {
      const vatRatesKey = `xero_vat_rates_${tenantId}`;
      const { data: vatRatesSetting } = await supabase
        .from('system_settings')
        .select('setting_value')
        .eq('setting_key', vatRatesKey)
        .maybeSingle();

      if (vatRatesSetting?.setting_value) {
        const cachedData = JSON.parse(vatRatesSetting.setting_value);
        const matchedRate = (cachedData.rates || []).find(r => r.taxType === taxType);
        if (matchedRate && matchedRate.effectiveRate != null) {
          vatRatePercent = parseFloat(matchedRate.effectiveRate);
        }
      }
    } catch (vatLookupErr) {
      log('VAT Rate Lookup', `Could not look up numeric VAT rate: ${vatLookupErr.message}`, 'warning');
    }

    if (vatRatePercent == null && taxLabel) {
      const percentMatch = taxLabel.match(/(\d+(?:\.\d+)?)\s*%/);
      if (percentMatch) {
        vatRatePercent = parseFloat(percentMatch[1]);
      }
    }
  }

  const vatAmount = vatRatePercent ? parseFloat((computedFinalCost * vatRatePercent / 100).toFixed(2)) : 0;
  const totalWithVat = parseFloat((computedFinalCost + vatAmount).toFixed(2));

  log('Xero Settings', `Account code: ${xeroAccountCode}, Invoice status: ${xeroInvoiceStatus}, VAT: ${taxLabel ? `${taxLabel} (${taxType})` : 'Not set (no VAT applied)'}${vatRatePercent ? `, Rate: ${vatRatePercent}%, VAT Amount: ${vatAmount.toFixed(2)}, Total incl VAT: ${totalWithVat.toFixed(2)}` : ''}`);

  const scheduleStartDate = formatDate(membershipYear.start) + ' at 00:00';
  const scheduledInvoiceDate = invoicingSettings?.invoice_date ? formatDate(new Date(invoicingSettings.invoice_date)) + ' at 00:00' : null;
  const nowFormatted = formatDate(clock(), true);
  const effectiveMode = mode || currentMode || 'manual';

  if (effectiveMode === 'automatic') {
    log('Mode: Automatic', 'Both renewal and invoicing happen together on the membership schedule start date');
    log(`Step 1 - Renew (${scheduleStartDate})`, `Create membership history record for ${membershipYear.label} with final cost ${computedFinalCost.toFixed(2)} ${currency}`);
    log(`Step 2 - Invoice (${scheduleStartDate})`, `Generate and send invoice for ${computedFinalCost.toFixed(2)} ${currency} via Xero`);
  } else if (effectiveMode === 'scheduled') {
    log('Mode: Scheduled', 'Renewal happens at schedule start, invoicing on a separate scheduled date');
    log(`Step 1 - Renew (${scheduleStartDate})`, `Create membership history record for ${membershipYear.label} with final cost ${computedFinalCost.toFixed(2)} ${currency}`);
    if (scheduledInvoiceDate) {
      log(`Step 2 - Invoice (${scheduledInvoiceDate})`, `Generate and send invoice on ${scheduledInvoiceDate}`);
    } else {
      log('Step 2 - Invoice (date not set)', 'No invoice date has been saved. Scheduled mode requires a date.', 'warning');
    }
  } else if (effectiveMode === 'manual') {
    log('Mode: Manual', 'Admin triggers renewal manually');
    log(`Step 1 - Renew (${nowFormatted} - when clicked)`, `Create membership history record for ${membershipYear.label} with final cost ${computedFinalCost.toFixed(2)} ${currency}`);
    log(`Step 2 - Invoice (${nowFormatted} - when clicked)`, `Generate and send invoice for ${computedFinalCost.toFixed(2)} ${currency} via Xero immediately`);
  }

  const customDesc = config.invoice_description
    ? config.invoice_description.replace(/\{year\}/gi, membershipYear.label)
    : `Membership subscription for ${membershipYear.label}`;
  const invoiceDescription = `${customDesc}.\nTier: ${tierLabel || 'Standard'}\nFee: ${currency} ${computedFinalCost.toFixed(2)}`;
  const invoiceReference = `Membership ${membershipYear.label}`;
  const invoiceDueDate = new Date(clock().getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const lineItem = {
    description: invoiceDescription,
    quantity: 1,
    unitAmount: computedFinalCost.toFixed(2),
    accountCode: xeroAccountCode,
  };
  if (taxType) {
    lineItem.taxType = taxType;
    lineItem.taxLabel = taxLabel;
  }

  const invoicePreview = {
    contact: memberName,
    reference: invoiceReference,
    status: xeroInvoiceStatus,
    dueDate: invoiceDueDate,
    lineItems: [lineItem],
  };

  if (!existingRecord) {
    log('Would Create History', `Membership history record for ${membershipYear.label}: tier "${tierLabel}", final cost ${computedFinalCost.toFixed(2)} ${currency}`);
    log('Invoice Preview - Contact', memberName);
    log('Invoice Preview - Reference', invoiceReference);
    log('Invoice Preview - Status', xeroInvoiceStatus);
    log('Invoice Preview - Due Date', `${invoiceDueDate} (30 days from invoice creation date)`);
    log('Invoice Preview - Line Description', invoiceDescription.replace(/\n/g, ' | '));
    log('Invoice Preview - Unit Amount', `${currency} ${computedFinalCost.toFixed(2)}`);
    log('Invoice Preview - Account Code', xeroAccountCode);
    log('Invoice Preview - VAT / Tax Type', taxLabel ? `${taxLabel} (${taxType})` : 'Not set (no VAT applied)');
  } else {
    log('Would Be Blocked', `A record for ${membershipYear.label} already exists (final cost: ${existingRecord.final_cost}). Real renewal would be rejected.`, 'warning');
  }

  log('Dry Run Complete', 'No records were created or modified', 'info');

  const rolloverDiscount = yearNumber === 2 ? freeDiscount : 0;
  const year1FreeDiscount = yearNumber === 1 ? freeDiscount : 0;

  return {
    success: true,
    member: { id: member.id, name: memberName, email: member.email },
    config,
    previousTerm: rollingContext?.previousTerm || null,
    matchedBand,
    tierLabel,
    fieldValue,
    annualCost,
    annualCostBeforeDiscounts: annualCostRaw,
    finalCost: computedFinalCost,
    currency,
    membershipYear,
    yearNumber,
    dailyCost,
    totalDaysInYear,
    proRataEnabled,
    prorataDays: proRataEnabled ? prorataDays : null,
    prorataCost: proRataEnabled ? prorataCost : null,
    freeDiscount: year1FreeDiscount,
    rolloverDiscount,
    freePeriodDaysApplied,
    freePeriodAmount: config.free_period_amount,
    freePeriodUnit: config.free_period_unit,
    billableDays: proRataEnabled ? billableDays : null,
    customDiscountTotal,
    customDiscountDetails,
    overrideApplied,
    overrideType: override?.override_type || null,
    overrideNote: override?.note || null,
    overrideDiscountType: override?.discount_type || null,
    overrideDiscountValue: override?.discount_value != null ? parseFloat(override.discount_value) : null,
    overrideConfigId: override?.config_id || null,
    overrideConfigName,
    existingRecord,
    invoicePreview: !existingRecord ? invoicePreview : null,
    invoicingSettings,
    xeroAccountCode,
    xeroInvoiceStatus,
    billingPeriod: config.billing_period || 'annual',
    goLiveDate,
    isNewMember,
    nominalCode: String(matchedBand?.nominal_code || (isFlat ? config.nominal_code : '') || '').trim() || null,
    vatRatePercent,
    vatAmount,
    totalWithVat,
    taxType,
    taxLabel,
    vatOverrideApplied,
    vatOverrideDetail,
    steps,
  };
}
}
