import { supabase } from './database.js';
import { evaluateDiscountsForOrg, applyDiscountsToAnnualCost } from './discountHelper.js';
import { evaluateVatOverrideForOrg } from './vatOverrideHelper.js';
import { getConfigForOrganisation, getConfigForMember, getAllActiveConfigs, getConfigByIdDirect } from './membershipConfigResolver.js';
import { resolveInvoiceAddress } from './invoiceAddressResolver.js';

export async function simulateMembershipForOrg(tenantId, organizationId, options = {}) {
  const {
    source = 'workflow',
    mode = 'automatic',
    workflowName = null,
    verbose = false,
    targetYear = null,
    fieldOverrides = {},
    configId: explicitConfigId = null,
  } = options;

  const steps = [];
  const log = (step, detail, status = 'ok') => {
    steps.push({ step, detail, status, timestamp: new Date().toISOString() });
  };

  log('Start', source === 'workflow'
    ? `Dry run simulation for organisation via workflow "${workflowName || 'Unknown'}"`
    : `Simulating "${mode}" renewal for organisation ${organizationId}`);

  const { data: org } = await supabase
    .from('organization')
    .select('id, name, tenant_id, invoicing_address')
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

  const config = explicitConfigId
    ? await getConfigByIdDirect(tenantId, explicitConfigId)
    : await getConfigForOrganisation(tenantId, organizationId, fieldOverrides);
  if (!config) {
    const allActive = await getAllActiveConfigs(tenantId);
    const scopedCount = allActive.filter(c => c.structure_field_id && c.structure_match_value).length;
    if (scopedCount > 0) {
      log('Fetch Tier Config', `No matching tier configuration found. There are ${allActive.length} active config(s), ${scopedCount} scoped — but none match this organisation's field values.`, 'error');
    } else {
      log('Fetch Tier Config', 'No active tier configuration found for this tenant', 'error');
    }
    return { success: false, steps, error: 'No active membership tier configuration found' };
  }
  log('Fetch Tier Config', `Active config: "${config.name || 'Default'}", currency: ${config.currency || 'GBP'}, start: month ${config.membership_start_month || 1} day ${config.membership_start_day || 1}, incentive: ${config.free_period_amount ? `${config.free_period_amount} ${config.free_period_unit}` : 'none'}, rollover: ${config.rollover_enabled ? 'yes' : 'no'}`);

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

  const currentYear = calculateMembershipYear(config);
  const nextYear = calculateNextMembershipYear(config);
  log('Calculate Membership Year', `Current year: ${currentYear.label}, Next year: ${nextYear.label}`);

  let membershipYear;
  if (targetYear) {
    membershipYear = targetYear === currentYear.label ? currentYear : nextYear;
  } else {
    membershipYear = source === 'simulate' ? nextYear : currentYear;
  }

  const goLiveFieldId = await getGoLiveFieldId(tenantId);
  const goLiveDate = goLiveFieldId ? await getOrgGoLiveDate(organizationId, goLiveFieldId) : null;
  const assumedGoLiveDate = goLiveDate || new Date().toISOString().split('T')[0];
  const yearNumber = determineMembershipYearNumber(assumedGoLiveDate, membershipYear, config);
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
    .select('id, membership_year, final_cost, xero_invoice_id')
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

  let fieldValue = null;

  if (isFlat) {
    annualCostRaw = parseFloat(config.flat_cost) || 0;
    annualCost = annualCostRaw;
    tierLabel = 'Flat Rate';
    log('Pricing Model', `Flat rate pricing: ${annualCostRaw}`);
  } else {
    const bands = await getBandsForConfig(config.id, tenantId);
    log('Fetch Tier Bands', `Found ${bands.length} band(s)`);

    fieldValue = await getOrgFieldValue(organizationId, tenantId, config, fieldOverrides);
    const fieldLabel = config.field_source === 'core' && config.field_name === 'member_count'
      ? 'Member Count' : (config.field_name || 'Value');
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

  const { data: historyRecords } = await supabase
    .from('organisation_membership_history')
    .select('id, membership_year')
    .eq('tenant_id', tenantId)
    .eq('organization_id', organizationId);

  const hasCurrentYearRecord = (historyRecords || []).some(h => h.membership_year === currentYear.label);
  const isNewOrg = (currentYearNumber === 1 || !goLiveDate) && !hasCurrentYearRecord;
  const effectiveJoinDate = goLiveDate ? new Date(goLiveDate) : new Date();

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

  if (isPriceOverride) {
    finalCost = annualCost;
    log('Price Override', `Final cost set to manual price: ${finalCost.toFixed(2)}, all calculation lines suppressed`);
  } else if (yearNumber === 1) {
    dailyCost = parseFloat((annualCost / totalDaysInYear).toFixed(4));
    const isPercentIncentive = config.free_period_unit === 'percent';

    if (config.prorata_enabled && isNewOrg) {
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
    const isPercentIncentive = config.free_period_unit === 'percent';

    if (isNewOrg && config.free_period_amount && config.free_period_unit) {
      if (isPercentIncentive) {
        const fullDiscountAmount = parseFloat((annualCost * config.free_period_amount / 100).toFixed(2));

        const startMonth = config.membership_start_month || 1;
        const startDay = config.membership_start_day || 1;
        const joinMidnight = new Date(effectiveJoinDate);
        joinMidnight.setHours(0, 0, 0, 0);
        const joinYear = joinMidnight.getFullYear();
        const y1Start = new Date(joinYear, startMonth - 1, startDay);
        const firstYearStart = joinMidnight >= y1Start ? y1Start : new Date(joinYear - 1, startMonth - 1, startDay);
        const firstYearEnd = new Date(firstYearStart.getFullYear() + 1, startMonth - 1, startDay);
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
          log('Percentage Discount Rollover', `Full discount: ${fullDiscountAmount.toFixed(2)} (${config.free_period_amount}%), applied in Y1: ${y1DiscountApplied.toFixed(2)} (${remainingDaysInFirstYear}/${firstYearTotalDays} days), rollover to Y2: ${freeDiscount.toFixed(2)}`);
        } else {
          log('Percentage Discount Rollover', `No rollover - full ${config.free_period_amount}% discount was used in year 1`);
        }
      } else {
        const freePeriodMonths = getFreeMonths(config);
        const freePeriodTotalDays = Math.round(freePeriodMonths * 30.44);
        const currentYear = calculateMembershipYear(config);
        const currentYearStartMidnight = new Date(currentYear.start);
        currentYearStartMidnight.setHours(0, 0, 0, 0);
        const currentYearEndMidnight = new Date(currentYear.end);
        currentYearEndMidnight.setHours(0, 0, 0, 0);
        const currentYearTotalDays = Math.floor((currentYearEndMidnight - currentYearStartMidnight) / (1000 * 60 * 60 * 24)) + 1;

        let freeDaysInCurrentYear = 0;
        if (config.prorata_enabled) {
          const joinMidnight = new Date(effectiveJoinDate);
          joinMidnight.setHours(0, 0, 0, 0);
          const currentProrataDays = Math.max(0, Math.floor((currentYearEndMidnight - joinMidnight) / (1000 * 60 * 60 * 24)) + 1);
          const freePeriodEnd = new Date(joinMidnight);
          freePeriodEnd.setDate(freePeriodEnd.getDate() + freePeriodTotalDays - 1);
          const lastFreeDay = freePeriodEnd < currentYearEndMidnight ? freePeriodEnd : currentYearEndMidnight;
          freeDaysInCurrentYear = Math.max(0, Math.floor((lastFreeDay - joinMidnight) / (1000 * 60 * 60 * 24)) + 1);
          freeDaysInCurrentYear = Math.min(freeDaysInCurrentYear, currentProrataDays);
        } else {
          freeDaysInCurrentYear = Math.min(freePeriodTotalDays, currentYearTotalDays);
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
    } else {
      log('Year 2', `Full annual cost applies. Final cost: ${finalCost.toFixed(2)}`);
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
  const nowFormatted = formatDate(new Date(), true);

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
  const invoiceDueDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

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
    matchedBand,
    tierLabel,
    fieldValue,
    annualCost,
    annualCostBeforeDiscounts: annualCostRaw,
    finalCost: computedFinalCost,
    currency,
    membershipYear,
    yearNumber,
    dailyCost: isPriceOverride ? null : dailyCost,
    totalDaysInYear,
    proRataEnabled: proRataEnabled,
    prorataDays: proRataEnabled ? prorataDays : null,
    prorataCost: proRataEnabled ? prorataCost : null,
    freeDiscount: isPriceOverride ? 0 : year1FreeDiscount,
    rolloverDiscount,
    freePeriodDaysApplied: isPriceOverride ? 0 : freePeriodDaysApplied,
    freePeriodAmount: config.free_period_amount,
    freePeriodUnit: config.free_period_unit,
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
    .order('min_value', { ascending: true });
  return data || [];
}

function matchBand(fieldValue, bands) {
  if (fieldValue === null || fieldValue === undefined || !bands?.length) return null;
  for (const band of bands) {
    const min = parseFloat(band.min_value);
    const max = band.max_value !== null ? parseFloat(band.max_value) : Infinity;
    if (fieldValue >= min && fieldValue <= max) return band;
  }
  return null;
}

function calculateMembershipYear(config) {
  const startMonth = config.membership_start_month || 1;
  const startDay = config.membership_start_day || 1;
  const now = new Date();
  const currentYear = now.getFullYear();
  const yearStart = new Date(currentYear, startMonth - 1, startDay);

  if (now < yearStart) {
    return {
      label: `${currentYear - 1}/${currentYear}`,
      start: new Date(currentYear - 1, startMonth - 1, startDay),
      end: new Date(currentYear, startMonth - 1, startDay - 1),
    };
  }
  return {
    label: `${currentYear}/${currentYear + 1}`,
    start: yearStart,
    end: new Date(currentYear + 1, startMonth - 1, startDay - 1),
  };
}

function calculateNextMembershipYear(config) {
  const current = calculateMembershipYear(config);
  const nextStart = new Date(current.end);
  nextStart.setDate(nextStart.getDate() + 1);
  const startMonth = config.membership_start_month || 1;
  const nextYear = nextStart.getFullYear();
  return {
    label: `${nextYear}/${nextYear + 1}`,
    start: nextStart,
    end: new Date(nextYear + 1, startMonth - 1, (config.membership_start_day || 1) - 1),
  };
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
      const num = parseFloat(fieldOverrides[config.field_id]);
      return isNaN(num) ? null : num;
    }
    const { data: pv } = await supabase
      .from('organization_preference_value')
      .select('value')
      .eq('organization_id', orgId)
      .eq('field_id', config.field_id)
      .maybeSingle();

    if (pv?.value) {
      const num = parseFloat(pv.value);
      return isNaN(num) ? null : num;
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
      const num = parseFloat(fieldOverrides[config.field_id]);
      return isNaN(num) ? null : num;
    }
    const { data: pv } = await supabase
      .from('member_preference_value')
      .select('value')
      .eq('member_id', memberId)
      .eq('field_id', config.field_id)
      .maybeSingle();
    if (pv?.value) {
      const num = parseFloat(pv.value);
      return isNaN(num) ? null : num;
    }
  }

  return null;
}

export async function simulateMembershipForMember(tenantId, memberId, options = {}) {
  const {
    source = 'workflow',
    mode = 'automatic',
    workflowName = null,
    verbose = false,
    targetYear = null,
    fieldOverrides = {},
    configId: explicitConfigId = null,
  } = options;

  const steps = [];
  const log = (step, detail, status = 'ok') => {
    steps.push({ step, detail, status, timestamp: new Date().toISOString() });
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

  const config = explicitConfigId
    ? await getConfigByIdDirect(tenantId, explicitConfigId)
    : await getConfigForMember(tenantId, memberId, fieldOverrides);
  if (!config) {
    const allActive = await getAllActiveConfigs(tenantId);
    const memberConfigs = allActive.filter(c => c.structure_scope_type === 'member');
    if (memberConfigs.length > 0) {
      log('Fetch Tier Config', `No matching member tier configuration found. There are ${memberConfigs.length} member-scoped config(s), but none match this member's field values.`, 'error');
    } else {
      log('Fetch Tier Config', 'No active member-scoped tier configuration found for this tenant', 'error');
    }
    return { success: false, steps, error: 'No active member-scoped tier configuration found' };
  }
  log('Fetch Tier Config', `Active config: "${config.name || 'Default'}", pricing: ${config.pricing_model || 'banded'}, currency: ${config.currency || 'GBP'}, start: month ${config.membership_start_month || 1} day ${config.membership_start_day || 1}, incentive: ${config.free_period_amount ? `${config.free_period_amount} ${config.free_period_unit}` : 'none'}, rollover: ${config.rollover_enabled ? 'yes' : 'no'}`);

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

  const currentYearObj = calculateMembershipYear(config);
  const nextYearObj = calculateNextMembershipYear(config);
  log('Calculate Membership Year', `Current year: ${currentYearObj.label}, Next year: ${nextYearObj.label}`);

  let membershipYear;
  if (targetYear) {
    membershipYear = targetYear === currentYearObj.label ? currentYearObj : nextYearObj;
  } else {
    membershipYear = source === 'simulate' ? nextYearObj : currentYearObj;
  }

  const goLiveDate = await getMemberGoLiveDate(memberId, tenantId);
  const createdDate = member.created_on ? String(member.created_on).split('T')[0] : null;
  const assumedGoLiveDate = goLiveDate || createdDate || new Date().toISOString().split('T')[0];
  const yearNumber = determineMembershipYearNumber(assumedGoLiveDate, membershipYear, config);
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
    annualCostRaw = parseFloat(config.flat_cost) || 0;
    annualCost = annualCostRaw;
    tierLabel = 'Flat Rate';
    log('Pricing Model', `Flat rate pricing: ${annualCostRaw}`);
  } else {
    const bands = await getBandsForConfig(config.id, tenantId);
    log('Fetch Tier Bands', `Found ${bands.length} band(s)`);

    fieldValue = await getMemberFieldValue(memberId, tenantId, config, fieldOverrides);
    const fieldLabel = config.field_name || 'Value';
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
  const isNewMember = (currentYearNumber === 1 || !goLiveDate) && !hasCurrentYearRecord;
  const effectiveJoinDate = goLiveDate ? new Date(goLiveDate) : (createdDate ? new Date(createdDate) : new Date());

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

  if (isPriceOverride) {
    finalCost = annualCost;
    log('Price Override', `Final cost set to manual price: ${finalCost.toFixed(2)}, all calculation lines suppressed`);
  } else if (yearNumber === 1) {
    dailyCost = parseFloat((annualCost / totalDaysInYear).toFixed(4));
    const isPercentIncentive = config.free_period_unit === 'percent';

    if (config.prorata_enabled && isNewMember) {
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

    if (isNewMember && config.free_period_amount && config.free_period_unit) {
      if (isPercentIncentive) {
        const fullDiscountAmount = parseFloat((annualCost * config.free_period_amount / 100).toFixed(2));
        const startMonth = config.membership_start_month || 1;
        const startDay = config.membership_start_day || 1;
        const joinMidnight = new Date(effectiveJoinDate);
        joinMidnight.setHours(0, 0, 0, 0);
        const joinDateYear = joinMidnight.getFullYear();
        const y1Start = new Date(joinDateYear, startMonth - 1, startDay);
        const firstYearStart = joinMidnight >= y1Start ? y1Start : new Date(joinDateYear - 1, startMonth - 1, startDay);
        const firstYearEnd = new Date(firstYearStart.getFullYear() + 1, startMonth - 1, startDay);
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
  const nowFormatted = formatDate(new Date(), true);
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
  const invoiceDueDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

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
    vatRatePercent,
    vatAmount,
    totalWithVat,
    taxType,
    taxLabel,
    steps,
  };
}
