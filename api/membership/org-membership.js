import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { getConfigForOrganisation, resolveBasisFieldLabel } from '../_lib/membershipConfigResolver.js';
import { simulateMembershipForOrg } from '../_lib/membershipSimulation.js';
import { matchBand } from '../_lib/tierBandMatcher.js';
import { calculateMembershipYearWindow, calculateNextMembershipYearWindow } from '../_lib/membershipYear.js';
import { computeAddonTotals, loadAddonLines } from '../_lib/membershipAddons.js';
import {
  fireNewZeroDueMembershipPaidWorkflow,
  isZeroDueMembership,
  zeroDuePaymentFields,
} from '../_lib/zeroDueMembership.js';

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  try {
    const tenantContext = await getTenantContext(req);
    if (!tenantContext?.tenantId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { tenantId } = tenantContext;

    if (req.method === 'GET') {
      return handleGet(req, res, tenantId);
    } else if (req.method === 'PUT') {
      return handlePut(req, res, tenantId);
    } else if (req.method === 'POST') {
      return handlePost(req, res, tenantId);
    } else {
      return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('[Org Membership] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function getConfigById(configId, tenantId) {
  const { data, error } = await supabase
    .from('membership_tier_config')
    .select('*')
    .eq('id', configId)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (error) {
    console.error('[Org Membership] Error fetching config by id:', error);
    return null;
  }
  return data;
}

async function getBandsForConfig(configId, tenantId) {
  const { data, error } = await supabase
    .from('membership_tier_band')
    .select('*')
    .eq('config_id', configId)
    .eq('tenant_id', tenantId)
    .order('display_order', { ascending: true, nullsFirst: false })
    .order('min_value', { ascending: true, nullsFirst: false });

  if (error) return [];
  return data || [];
}


function calculateMembershipYear(config) {
  return calculateMembershipYearWindow(config);
}

function calculateNextMembershipYear(config) {
  return calculateNextMembershipYearWindow(config);
}

function calculateProRata(annualCost, config, joinDate) {
  if (!config.prorata_enabled) {
    return { proratedCost: annualCost, remainingDays: null, totalDays: null };
  }

  const year = calculateMembershipYear(config);
  const totalDays = Math.ceil((year.end - year.start) / (1000 * 60 * 60 * 24)) + 1;
  const from = joinDate ? new Date(joinDate) : new Date();
  const remainingDays = Math.max(0, Math.ceil((year.end - from) / (1000 * 60 * 60 * 24)) + 1);
  const proratedCost = parseFloat((annualCost * remainingDays / totalDays).toFixed(2));

  return { proratedCost, remainingDays, totalDays };
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

async function getOrgFieldValue(orgId, tenantId, config) {
  if (!config) return null;

  if (config.field_source === 'core' && config.field_name === 'member_count') {
    const { data: members, error } = await supabase
      .from('member')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('organization_id', orgId);

    if (error) return null;
    return members?.length || 0;
  }

  if (config.field_id) {
    const { data: pv } = await supabase
      .from('organization_preference_value')
      .select('value, organization:organization!inner(tenant_id)')
      .eq('organization_id', orgId)
      .eq('field_id', config.field_id)
      .eq('organization.tenant_id', tenantId)
      .maybeSingle();

    if (pv?.value != null && pv.value !== '') {
      return pv.value;
    }
  }

  return null;
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

function mapSimResultToYearData(sim, startDate) {
  const effectiveFreeDiscount = sim.yearNumber === 2 ? sim.rolloverDiscount : sim.freeDiscount;
  return {
    membershipYear: sim.membershipYear?.label || null,
    yearNumber: sim.yearNumber,
    startDate,
    tierLabel: sim.tierLabel || null,
    fieldValue: sim.fieldValue,
    annualCost: sim.annualCost,
    annualCostBeforeDiscounts: sim.annualCostBeforeDiscounts,
    customDiscountTotal: sim.customDiscountTotal || 0,
    customDiscountDetails: sim.customDiscountDetails || [],
    dailyCost: sim.dailyCost,
    totalDaysInYear: sim.totalDaysInYear,
    proRataEnabled: sim.proRataEnabled,
    prorataDays: sim.prorataDays,
    prorataCost: sim.prorataCost,
    freeDiscount: effectiveFreeDiscount,
    freePeriodDaysApplied: sim.freePeriodDaysApplied || 0,
    freePeriodAmount: sim.freePeriodAmount,
    freePeriodUnit: sim.freePeriodUnit,
    billableDays: sim.billableDays,
    finalCost: sim.finalCost,
    vatRatePercent: sim.vatRatePercent || null,
    vatAmount: sim.vatAmount || 0,
    totalWithVat: sim.totalWithVat || sim.finalCost,
    taxType: sim.taxType || null,
    taxLabel: sim.taxLabel || null,
    goLiveDate: sim.goLiveDate,
    isNewOrg: sim.isNewOrg,
    currency: sim.currency || 'GBP',
    billingPeriod: sim.billingPeriod || 'annual',
    resolvedConfigName: sim.config?.name || null,
  };
}

// Recompute VAT and total-with-VAT from the (already correct) final cost so the
// card is never internally inconsistent after an override mutates finalCost.
// Uses the same rounding as the renewal simulation (membershipSimulation.js).
function recomputeVatForYear(yearData) {
  if (!yearData || yearData.finalCost == null) return;
  const rate = yearData.vatRatePercent;
  if (rate && rate > 0) {
    yearData.vatAmount = parseFloat((yearData.finalCost * rate / 100).toFixed(2));
    yearData.totalWithVat = parseFloat((yearData.finalCost + yearData.vatAmount).toFixed(2));
  } else {
    yearData.vatAmount = 0;
    yearData.totalWithVat = yearData.finalCost;
  }
}

async function handleGet(req, res, tenantId) {
  const { organizationId, action } = req.query;

  if (!organizationId) {
    return res.status(400).json({ error: 'organizationId is required' });
  }

  const { data: org } = await supabase
    .from('organization')
    .select('id, name, tenant_id')
    .eq('id', organizationId)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (!org) {
    return res.status(404).json({ error: 'Organisation not found' });
  }

  const config = await getConfigForOrganisation(tenantId, organizationId);

  if (action === 'history') {
    return getHistory(req, res, tenantId, organizationId);
  }

  if (!config) {
    return res.json({
      organization: org,
      config: null,
      currentTier: null,
      fieldValue: null,
      fieldLabel: null,
      currentYear: null,
      nextYearPreview: null,
      history: []
    });
  }

  const bands = await getBandsForConfig(config.id, tenantId);
  const fieldValue = await getOrgFieldValue(organizationId, tenantId, config);
  const matchedBand = matchBand(fieldValue, bands);

  const currentYear = calculateMembershipYear(config);
  const nextYear = calculateNextMembershipYear(config);

  let annualCostRaw = null;
  if (config.pricing_model === 'flat' && config.flat_cost != null) {
    annualCostRaw = parseFloat(config.flat_cost);
  } else if (matchedBand) {
    annualCostRaw = parseFloat(matchedBand.annual_cost);
  }

  const { data: historyRecords } = await supabase
    .from('organisation_membership_history')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('organization_id', organizationId)
    .order('membership_year', { ascending: false });

  const goLiveFieldId = await getGoLiveFieldId(tenantId);
  const goLiveDate = goLiveFieldId ? await getOrgGoLiveDate(organizationId, goLiveFieldId) : null;
  const yearNumber = goLiveDate ? determineMembershipYearNumber(goLiveDate, currentYear, config) : 1;

  const currentYearRecord = (historyRecords || []).find(h => h.membership_year === currentYear.label);
  const hasCurrentYearRecord = !!currentYearRecord;

  const isNewOrg = (yearNumber === 1 || !goLiveDate) && !hasCurrentYearRecord;

  const currentYearStartDate = goLiveDate
    ? currentYear.start.toISOString().split('T')[0]
    : new Date().toISOString().split('T')[0];
  const nextYearStartDate = nextYear.start.toISOString().split('T')[0];

  let nextYearPreview = null;
  let currentYearCost = null;

  if (annualCostRaw !== null) {
    const yearStartMidnight = new Date(currentYear.start);
    yearStartMidnight.setHours(0, 0, 0, 0);
    const yearEndMidnight = new Date(currentYear.end);
    yearEndMidnight.setHours(0, 0, 0, 0);
    const totalDaysInYear = Math.floor((yearEndMidnight - yearStartMidnight) / (1000 * 60 * 60 * 24)) + 1;

    if (currentYearRecord) {
      const recAnnual = parseFloat(currentYearRecord.annual_cost);
      const recCustomTotal = parseFloat(currentYearRecord.custom_discount_total || 0);
      const recProrata = currentYearRecord.prorata_cost != null ? parseFloat(currentYearRecord.prorata_cost) : null;
      const recFreeDiscount = parseFloat(currentYearRecord.free_period_discount || 0);
      const recRollover = parseFloat(currentYearRecord.rollover_discount || 0);
      const recFinal = parseFloat(currentYearRecord.final_cost);
      const hasProRata = recProrata !== null;

      let recProrataDays = currentYearRecord.prorata_days || null;
      let recFreePeriodDaysApplied = currentYearRecord.free_period_days_applied || 0;
      let recBillableDays = null;

      if (recProrataDays == null && hasProRata && goLiveDate && config.prorata_enabled) {
        const joinMidnight = new Date(goLiveDate);
        joinMidnight.setHours(0, 0, 0, 0);
        recProrataDays = Math.max(0, Math.floor((yearEndMidnight - joinMidnight) / (1000 * 60 * 60 * 24)) + 1);
      }
      if (recFreePeriodDaysApplied === 0 && recFreeDiscount > 0 && goLiveDate && config.free_period_amount && config.free_period_unit) {
        const joinMidnight = new Date(goLiveDate);
        joinMidnight.setHours(0, 0, 0, 0);
        const freePeriodMonths = getFreeMonths(config);
        const freePeriodTotalDays = Math.round(freePeriodMonths * 30.44);
        const freePeriodEnd = new Date(joinMidnight);
        freePeriodEnd.setDate(freePeriodEnd.getDate() + freePeriodTotalDays - 1);
        const lastFreeDay = freePeriodEnd < yearEndMidnight ? freePeriodEnd : yearEndMidnight;
        recFreePeriodDaysApplied = Math.max(0, Math.floor((lastFreeDay - joinMidnight) / (1000 * 60 * 60 * 24)) + 1);
        if (recProrataDays !== null) {
          recFreePeriodDaysApplied = Math.min(recFreePeriodDaysApplied, recProrataDays);
        }
      }
      if (hasProRata && recProrataDays !== null) {
        recBillableDays = Math.max(0, recProrataDays - recFreePeriodDaysApplied);
      }

      const recDailyCost = recAnnual > 0 ? parseFloat((recAnnual / totalDaysInYear).toFixed(4)) : 0;

      currentYearCost = {
        membershipYear: currentYear.label,
        startDate: currentYearStartDate,
        tierLabel: currentYearRecord.tier_label || null,
        fieldValue: currentYearRecord.field_value != null ? parseFloat(currentYearRecord.field_value) : fieldValue,
        annualCost: recAnnual,
        annualCostBeforeDiscounts: recCustomTotal > 0 ? parseFloat((recAnnual + recCustomTotal).toFixed(2)) : recAnnual,
        customDiscountTotal: recCustomTotal,
        customDiscountDetails: currentYearRecord.custom_discount_details || [],
        proRataEnabled: hasProRata,
        prorataCost: recProrata,
        freeDiscount: recFreeDiscount,
        rolloverDiscount: recRollover,
        finalCost: recFinal,
        goLiveDate,
        isNewOrg: false,
        currency: currentYearRecord.currency || config.currency || 'GBP',
        billingPeriod: currentYearRecord.billing_period || config.billing_period || 'annual',
        yearNumber: currentYearRecord.year_number || yearNumber,
        dailyCost: recDailyCost,
        totalDaysInYear,
        prorataDays: hasProRata ? recProrataDays : null,
        freePeriodDaysApplied: recFreePeriodDaysApplied,
        freePeriodAmount: config.free_period_amount,
        freePeriodUnit: config.free_period_unit,
        billableDays: hasProRata ? recBillableDays : null,
        vatRatePercent: currentYearRecord.vat_rate_percent != null ? parseFloat(currentYearRecord.vat_rate_percent) : null,
        vatAmount: currentYearRecord.vat_amount != null ? parseFloat(currentYearRecord.vat_amount) : 0,
        totalWithVat: currentYearRecord.total_with_vat != null ? parseFloat(currentYearRecord.total_with_vat) : recFinal,
        taxType: null,
        taxLabel: null,
        overrideApplied: currentYearRecord.override_applied || false,
        overrideType: currentYearRecord.override_type || null,
        recordedFromHistory: true,
      };
    } else {
      try {
        const simResult = await simulateMembershipForOrg(tenantId, organizationId, {
          source: 'tab',
          targetYear: currentYear.label,
        });
        if (simResult.success) {
          currentYearCost = mapSimResultToYearData(simResult, currentYearStartDate);
        } else {
          console.warn('[Org Membership] Current year simulation failed:', simResult.error);
        }
      } catch (simErr) {
        console.warn('[Org Membership] Current year simulation error:', simErr.message);
      }
    }

    const nextSimResult = await simulateMembershipForOrg(tenantId, organizationId, {
      source: 'tab',
      targetYear: nextYear.label,
      asOfDate: nextYearStartDate,
    });
    if (nextSimResult.success) {
      nextYearPreview = mapSimResultToYearData(nextSimResult, nextYearStartDate);
    } else {
      console.warn('[Org Membership] Next year simulation failed:', nextSimResult.error);
    }
  }

  const fieldLabel = await resolveBasisFieldLabel(config, tenantId);

  let overrides = [];
  try {
    const { data: overrideData } = await supabase
      .from('organisation_membership_override')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('organization_id', organizationId);
    overrides = overrideData || [];
  } catch (err) {
    // Table may not exist yet
  }

  // The financial figures on `yearData` already reflect the override:
  //  - nextYearPreview and the (un-recorded) current year come from
  //    simulateMembershipForOrg, which has already applied the override
  //    (including the year-2 no-rollover rule and the VAT/total).
  //  - the recorded current year reads the saved history values, which were
  //    written with the override applied.
  // Re-deriving cost here would apply the override a SECOND time (e.g. re-adding
  // the percent/free-period incentive on top of the already-simulated final
  // cost, and leaving VAT/total based on the pre-rollover figure). So this only
  // attaches display metadata; VAT/total are recomputed from finalCost via
  // recomputeVatForYear so the card is always internally consistent.
  async function applyOverrideToYear(yearData, override) {
    if (!override || !yearData) return;
    if (override.override_type === 'price' && override.manual_price !== null) {
      yearData.overrideType = 'price';
      yearData.overridePrice = parseFloat(override.manual_price);
      yearData.overrideNote = override.note;
      if (yearData.originalAnnualCost === undefined) {
        yearData.originalAnnualCost = yearData.annualCostBeforeDiscounts ?? yearData.annualCost;
      }
      if (yearData.originalFinalCost === undefined) {
        yearData.originalFinalCost = yearData.finalCost;
      }
    } else if (override.override_type === 'discount') {
      yearData.overrideType = 'discount';
      yearData.overrideNote = override.note;
      yearData.overrideDiscountType = override.discount_type;
      yearData.overrideDiscountValue = override.discount_value != null ? parseFloat(override.discount_value) : null;
      yearData.originalAnnualCost = yearData.annualCostBeforeDiscounts ?? yearData.annualCost;
      yearData.originalFinalCost = yearData.finalCost;
    } else if (override.override_type === 'structure' && override.config_id) {
      const overrideConfig = await getConfigById(override.config_id, tenantId);
      if (overrideConfig) {
        yearData.overrideType = 'structure';
        yearData.overrideConfigId = overrideConfig.id;
        yearData.overrideConfigName = overrideConfig.name;
        yearData.overrideNote = override.note;
        if (yearData.originalAnnualCost === undefined) {
          yearData.originalAnnualCost = yearData.annualCostBeforeDiscounts ?? yearData.annualCost;
        }
        if (yearData.originalFinalCost === undefined) {
          yearData.originalFinalCost = yearData.finalCost;
        }
      }
    } else {
      return;
    }
    recomputeVatForYear(yearData);
  }

  const currentYearOverride = overrides.find(o => o.membership_year === currentYear.label) || null;
  const nextYearOverride = overrides.find(o => o.membership_year === nextYear.label)
    || overrides.find(o => !o.membership_year) || null;

  await applyOverrideToYear(currentYearCost, currentYearOverride);

  if (currentYearOverride?.override_type === 'price' && nextYearPreview) {
    nextYearPreview.freeDiscount = 0;
    nextYearPreview.freePeriodDaysApplied = 0;
    nextYearPreview.freePeriodAmount = null;
    nextYearPreview.freePeriodUnit = null;
    const nextFull = nextYearPreview.annualCost;
    nextYearPreview.finalCost = parseFloat(Math.max(0, nextFull).toFixed(2));
    recomputeVatForYear(nextYearPreview);
  }

  await applyOverrideToYear(nextYearPreview, nextYearOverride);

  return res.json({
    organization: org,
    config: {
      id: config.id,
      name: config.name,
      currency: config.currency,
      billing_period: config.billing_period,
      field_source: config.field_source,
      field_id: config.field_id,
      field_name: config.field_name,
      effective_from: config.effective_from,
      prorata_enabled: config.prorata_enabled,
      free_period_amount: config.free_period_amount,
      free_period_unit: config.free_period_unit,
      rollover_enabled: config.rollover_enabled,
      membership_start_month: config.membership_start_month,
      membership_start_day: config.membership_start_day,
      pricing_model: config.pricing_model || 'tiered',
      flat_cost: config.flat_cost != null ? parseFloat(config.flat_cost) : null,
      flat_vat_rate: config.flat_vat_rate || null,
    },
    currentTier: matchedBand ? {
      bandId: matchedBand.id,
      label: matchedBand.label,
      minValue: parseFloat(matchedBand.min_value),
      maxValue: matchedBand.max_value !== null ? parseFloat(matchedBand.max_value) : null,
      annualCost: currentYearCost?.annualCost ?? annualCostRaw,
      annualCostBeforeDiscounts: currentYearCost?.annualCostBeforeDiscounts ?? annualCostRaw,
      customDiscountTotal: currentYearCost?.customDiscountTotal ?? 0,
      customDiscountDetails: currentYearCost?.customDiscountDetails ?? [],
    } : null,
    fieldValue,
    fieldLabel,
    currentYear: {
      label: currentYear.label,
      start: currentYear.start.toISOString().split('T')[0],
      end: currentYear.end.toISOString().split('T')[0],
    },
    nextYearPreview,
    currentYearCost,
    isNewOrg,
    goLiveDate,
    overrides,
    currentYearOverride,
    nextYearOverride,
    history: historyRecords || [],
    bands: bands.map(b => ({
      id: b.id,
      label: b.label,
      minValue: parseFloat(b.min_value),
      maxValue: b.max_value !== null ? parseFloat(b.max_value) : null,
      annualCost: parseFloat(b.annual_cost),
    })),
  });
}

async function getHistory(req, res, tenantId, organizationId) {
  const { data, error } = await supabase
    .from('organisation_membership_history')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('organization_id', organizationId)
    .order('membership_year', { ascending: false });

  if (error) {
    return res.status(500).json({ error: 'Failed to fetch history' });
  }

  return res.json(data || []);
}

async function handlePut(req, res, tenantId) {
  const { organizationId, fieldValue } = req.body;

  if (!organizationId) {
    return res.status(400).json({ error: 'organizationId is required' });
  }

  const { data: org } = await supabase
    .from('organization')
    .select('id, tenant_id')
    .eq('id', organizationId)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (!org) {
    return res.status(404).json({ error: 'Organisation not found' });
  }

  const config = await getConfigForOrganisation(tenantId, organizationId);
  if (!config) {
    return res.status(400).json({ error: 'No active tier configuration found' });
  }

  if (config.field_source === 'core' && config.field_name === 'member_count') {
    return res.status(400).json({
      error: 'Member count is automatically calculated and cannot be manually updated here. Add or remove members to change this value.'
    });
  }

  if (!config.field_id) {
    return res.status(400).json({ error: 'No field configured for tier calculation' });
  }

  const { data, error } = await supabase
    .from('organization_preference_value')
    .upsert(
      {
        organization_id: organizationId,
        field_id: config.field_id,
        value: fieldValue !== undefined && fieldValue !== null ? String(fieldValue) : '',
        updated_at: new Date().toISOString()
      },
      {
        onConflict: 'organization_id,field_id',
        ignoreDuplicates: false
      }
    )
    .select()
    .single();

  if (error) {
    console.error('[Org Membership] Error updating field value:', error);
    return res.status(500).json({ error: 'Failed to update field value' });
  }

  return res.json({ success: true, value: data.value });
}

async function handlePost(req, res, tenantId) {
  const { organizationId, membershipYear, notes } = req.body;

  if (!organizationId || !membershipYear) {
    return res.status(400).json({ error: 'organizationId and membershipYear are required' });
  }

  const simResult = await simulateMembershipForOrg(tenantId, organizationId, {
    source: 'record_fee',
    mode: 'manual',
    targetYear: membershipYear,
  });

  if (!simResult.success) {
    return res.status(400).json({ error: simResult.error || 'Simulation failed' });
  }

  // Stored, approved add-ons are part of the membership amount due. Keep the
  // history totals aligned with the renewal cron, which also persists the
  // add-on-inclusive figures so a later invoice can split the lines correctly.
  const addonLines = await loadAddonLines(tenantId, organizationId, simResult.membershipYear.label);
  const addonTotals = computeAddonTotals(addonLines);
  const zeroDue = isZeroDueMembership(simResult, addonTotals);

  if (simResult.existingRecord) {
    const { data: existingRecord, error: existingError } = await supabase
      .from('organisation_membership_history')
      .select('id, payment_status, paid_at, final_cost, total_with_vat')
      .eq('tenant_id', tenantId)
      .eq('organization_id', organizationId)
      .eq('membership_year', simResult.membershipYear.label)
      .maybeSingle();

    if (existingError || !existingRecord) {
      console.error('[Org Membership] Error reloading existing history record:', existingError);
      return res.status(500).json({ error: 'Failed to confirm existing membership record' });
    }

    // A previous request may have committed the paid zero-due row but failed
    // while delivering its workflow. Re-fire with the row's original paid_at;
    // fireWorkflowForPaidRow uses a stable delivery key, making this safe to
    // retry without duplicating downstream work.
    if (
      existingRecord.payment_status === 'paid'
      && isZeroDueMembership({
        finalCost: existingRecord.final_cost,
        totalWithVat: existingRecord.total_with_vat,
      })
    ) {
      try {
        await fireNewZeroDueMembershipPaidWorkflow({
          table: 'organisation_membership_history',
          row: existingRecord,
          paidAt: existingRecord.paid_at,
          baseUrl: req.headers.host
            ? `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`
            : '',
          source: 'record_fee_org_membership_zero_due',
        });
      } catch (workflowErr) {
        console.error('[Org Membership] Retried zero-due paid workflow failed:', workflowErr.message);
        return res.status(500).json({
          error: 'Membership is already activated, but its paid workflow could not be completed. Retry this request.',
          retryable: true,
        });
      }

      return res.json({
        success: true,
        zeroDue: true,
        already_processed: true,
        record: existingRecord,
        message: 'Membership was already activated with no payment required',
      });
    }

    return res.status(400).json({ error: `A membership record for ${simResult.membershipYear.label} already exists` });
  }

  const vatRate = simResult.matchedBand?.vat_rate !== null && simResult.matchedBand?.vat_rate !== undefined
    ? parseFloat(simResult.matchedBand.vat_rate)
    : null;

  const paidAt = zeroDue ? new Date().toISOString() : null;
  const insertData = {
    tenant_id: tenantId,
    organization_id: organizationId,
    membership_year: simResult.membershipYear.label,
    config_id: simResult.config.id,
    band_id: simResult.matchedBand?.id || null,
    tier_label: simResult.tierLabel,
    field_value: simResult.fieldValue,
    annual_cost: simResult.annualCost,
    prorata_cost: simResult.prorataCost,
    free_period_discount: simResult.freeDiscount || 0,
    rollover_discount: simResult.rolloverDiscount || 0,
    custom_discount_total: simResult.customDiscountTotal || 0,
    custom_discount_details: simResult.customDiscountDetails?.length > 0 ? simResult.customDiscountDetails : null,
    final_cost: Math.round(((Number(simResult.finalCost) || 0) + addonTotals.subtotal) * 100) / 100,
    currency: simResult.currency,
    billing_period: simResult.billingPeriod || 'annual',
    vat_rate_percent: simResult.vatRatePercent || null,
    vat_amount: Math.round(((Number(simResult.vatAmount) || 0) + addonTotals.vat) * 100) / 100,
    total_with_vat: Math.round(((Number(simResult.totalWithVat ?? simResult.finalCost) || 0) + addonTotals.total) * 100) / 100,
    year_number: simResult.yearNumber || null,
    prorata_days: simResult.prorataDays || null,
    free_period_days_applied: simResult.freePeriodDaysApplied || 0,
    override_applied: simResult.overrideApplied || false,
    override_type: simResult.overrideType || null,
    status: 'active',
    notes: notes || null,
    ...(zeroDue ? zeroDuePaymentFields(paidAt) : {}),
  };

  if (vatRate !== null) {
    insertData.vat_rate = vatRate;
  }

  const { data: record, error } = await supabase
    .from('organisation_membership_history')
    .insert(insertData)
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      const { data: existingRecord, error: existingError } = await supabase
        .from('organisation_membership_history')
        .select('id, payment_status, paid_at, final_cost, total_with_vat')
        .eq('tenant_id', tenantId)
        .eq('organization_id', organizationId)
        .eq('membership_year', simResult.membershipYear.label)
        .maybeSingle();
      if (
        !existingError
        && existingRecord?.payment_status === 'paid'
        && isZeroDueMembership({
          finalCost: existingRecord.final_cost,
          totalWithVat: existingRecord.total_with_vat,
        })
      ) {
        try {
          await fireNewZeroDueMembershipPaidWorkflow({
            table: 'organisation_membership_history',
            row: existingRecord,
            paidAt: existingRecord.paid_at,
            baseUrl: req.headers.host
              ? `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`
              : '',
            source: 'record_fee_org_membership_zero_due',
          });
          return res.json({
            success: true,
            zeroDue: true,
            already_processed: true,
            record: existingRecord,
            message: 'Membership was already activated with no payment required',
          });
        } catch (workflowErr) {
          console.error('[Org Membership] Retried zero-due paid workflow failed:', workflowErr.message);
          return res.status(500).json({
            error: 'Membership is already activated, but its paid workflow could not be completed. Retry this request.',
            retryable: true,
          });
        }
      }
      return res.status(400).json({ error: `A membership record for ${simResult.membershipYear.label} already exists (duplicate prevented)` });
    }
    console.error('[Org Membership] Error creating history record:', error);
    return res.status(500).json({ error: 'Failed to create membership record' });
  }

  if (zeroDue) {
    try {
      await fireNewZeroDueMembershipPaidWorkflow({
        table: 'organisation_membership_history',
        row: record,
        paidAt,
        baseUrl: req.headers.host
          ? `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`
          : '',
        source: 'record_fee_org_membership_zero_due',
      });
    } catch (workflowErr) {
      // The durable paid row is intentionally retained. A retry reaches the
      // existing-record branch above and safely attempts this workflow again.
      console.error('[Org Membership] Zero-due paid workflow failed:', workflowErr.message);
      return res.status(500).json({
        error: 'Membership was activated, but its paid workflow could not be completed. Retry this request.',
        retryable: true,
        record,
      });
    }
  }

  return res.json(record);
}
