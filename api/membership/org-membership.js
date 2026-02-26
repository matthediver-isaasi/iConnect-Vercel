import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { getConfigForOrganisation } from '../_lib/membershipConfigResolver.js';
import { simulateMembershipForOrg } from '../_lib/membershipSimulation.js';

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
    .order('min_value', { ascending: true });

  if (error) return [];
  return data || [];
}

function matchBand(fieldValue, bands) {
  if (fieldValue === null || fieldValue === undefined || !bands?.length) return null;
  for (const band of bands) {
    const min = parseFloat(band.min_value);
    const max = band.max_value !== null ? parseFloat(band.max_value) : Infinity;
    if (fieldValue >= min && fieldValue <= max) {
      return band;
    }
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
  const startDay = config.membership_start_day || 1;
  const nextYear = nextStart.getFullYear();
  return {
    label: `${nextYear}/${nextYear + 1}`,
    start: nextStart,
    end: new Date(nextYear + 1, startMonth - 1, startDay - 1),
  };
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

    if (pv?.value) {
      const num = parseFloat(pv.value);
      return isNaN(num) ? null : num;
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
  };
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

  const annualCostRaw = matchedBand ? parseFloat(matchedBand.annual_cost) : null;

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
      const recProrata = currentYearRecord.prorata_cost != null ? parseFloat(currentYearRecord.prorata_cost) : null;
      const recFreeDiscount = parseFloat(currentYearRecord.free_period_discount || 0);
      const recRollover = parseFloat(currentYearRecord.rollover_discount || 0);
      const recCustomTotal = parseFloat(currentYearRecord.custom_discount_total || 0);
      const recFinal = parseFloat(currentYearRecord.final_cost);
      const recDailyCost = recAnnual > 0 ? parseFloat((recAnnual / totalDaysInYear).toFixed(4)) : 0;

      const hasProRata = recProrata !== null && recProrata !== recAnnual;
      let recProrataDays = null;
      let recFreePeriodDaysApplied = 0;
      let recBillableDays = null;

      if (hasProRata && goLiveDate && config.prorata_enabled) {
        const joinMidnight = new Date(goLiveDate);
        joinMidnight.setHours(0, 0, 0, 0);
        recProrataDays = Math.max(0, Math.floor((yearEndMidnight - joinMidnight) / (1000 * 60 * 60 * 24)) + 1);
      }
      if (recFreeDiscount > 0 && goLiveDate && config.free_period_amount && config.free_period_unit) {
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

      currentYearCost = {
        membershipYear: currentYear.label,
        yearNumber,
        startDate: currentYearStartDate,
        tierLabel: currentYearRecord.tier_label || matchedBand?.label || null,
        fieldValue: currentYearRecord.field_value != null ? parseFloat(currentYearRecord.field_value) : fieldValue,
        annualCost: recAnnual,
        annualCostBeforeDiscounts: recCustomTotal > 0 ? parseFloat((recAnnual + recCustomTotal).toFixed(2)) : recAnnual,
        customDiscountTotal: recCustomTotal,
        customDiscountDetails: currentYearRecord.custom_discount_details || [],
        dailyCost: recDailyCost,
        totalDaysInYear,
        proRataEnabled: hasProRata,
        prorataDays: hasProRata ? recProrataDays : null,
        prorataCost: hasProRata ? recProrata : null,
        freeDiscount: recFreeDiscount,
        freePeriodDaysApplied: recFreePeriodDaysApplied,
        freePeriodAmount: config.free_period_amount,
        freePeriodUnit: config.free_period_unit,
        billableDays: hasProRata ? recBillableDays : null,
        rolloverDiscount: recRollover,
        finalCost: recFinal,
        goLiveDate,
        isNewOrg,
        currency: currentYearRecord.currency || config.currency || 'GBP',
        billingPeriod: currentYearRecord.billing_period || config.billing_period || 'annual',
        recordedFromHistory: true,
      };
    } else {
      const simResult = await simulateMembershipForOrg(tenantId, organizationId, {
        source: 'tab',
        targetYear: currentYear.label,
      });
      if (simResult.success) {
        currentYearCost = mapSimResultToYearData(simResult, currentYearStartDate);
      } else {
        console.warn('[Org Membership] Current year simulation failed:', simResult.error);
      }
    }

    const nextSimResult = await simulateMembershipForOrg(tenantId, organizationId, {
      source: 'tab',
      targetYear: nextYear.label,
    });
    if (nextSimResult.success) {
      nextYearPreview = mapSimResultToYearData(nextSimResult, nextYearStartDate);
    } else {
      console.warn('[Org Membership] Next year simulation failed:', nextSimResult.error);
    }
  }

  const fieldLabel = config.field_source === 'core' && config.field_name === 'member_count'
    ? 'Member Count'
    : config.field_name || 'Value';

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

  async function applyOverrideToYear(yearData, override) {
    if (!override || !yearData) return;
    if (override.override_type === 'price' && override.manual_price !== null) {
      yearData.overrideType = 'price';
      yearData.overridePrice = parseFloat(override.manual_price);
      yearData.overrideNote = override.note;
      yearData.originalAnnualCost = yearData.annualCost;
      yearData.originalFinalCost = yearData.finalCost;
      yearData.finalCost = parseFloat(override.manual_price);
      yearData.annualCost = parseFloat(override.manual_price);
      yearData.annualCostBeforeDiscounts = parseFloat(override.manual_price);
      yearData.customDiscountTotal = 0;
      yearData.customDiscountDetails = [];
      yearData.dailyCost = null;
      yearData.proRataEnabled = false;
      yearData.prorataDays = null;
      yearData.prorataCost = null;
      yearData.freeDiscount = 0;
      yearData.freePeriodDaysApplied = 0;
      yearData.billableDays = null;
    } else if (override.override_type === 'discount') {
      const grossCost = yearData.annualCostBeforeDiscounts ?? yearData.annualCost;
      let discountAmount = 0;
      if (override.discount_type === 'percentage' && override.discount_value != null) {
        discountAmount = parseFloat((grossCost * parseFloat(override.discount_value) / 100).toFixed(2));
      } else if (override.discount_type === 'fixed' && override.discount_value != null) {
        discountAmount = parseFloat(parseFloat(override.discount_value).toFixed(2));
      }
      discountAmount = Math.min(discountAmount, grossCost);
      const netCost = parseFloat((grossCost - discountAmount).toFixed(2));
      yearData.overrideType = 'discount';
      yearData.overrideNote = override.note;
      yearData.overrideDiscountType = override.discount_type;
      yearData.overrideDiscountValue = parseFloat(override.discount_value);
      yearData.originalAnnualCost = yearData.annualCostBeforeDiscounts ?? yearData.annualCost;
      yearData.originalFinalCost = yearData.finalCost;
      yearData.originalCustomDiscountTotal = yearData.customDiscountTotal;
      yearData.customDiscountTotal = discountAmount;
      yearData.annualCost = netCost;
      const totalDays = yearData.totalDaysInYear || 365;
      yearData.dailyCost = parseFloat((netCost / totalDays).toFixed(4));
      const isPercentIncentive = yearData.freePeriodUnit === 'percent';
      if (yearData.proRataEnabled && yearData.prorataDays != null) {
        yearData.prorataCost = parseFloat((yearData.dailyCost * yearData.prorataDays).toFixed(2));
        if (isPercentIncentive && yearData.freePeriodAmount) {
          const fullDiscountAmount = parseFloat((netCost * yearData.freePeriodAmount / 100).toFixed(2));
          const proportionUsed = yearData.prorataDays / totalDays;
          yearData.freeDiscount = parseFloat((fullDiscountAmount * proportionUsed).toFixed(2));
          yearData.freeDiscount = Math.min(yearData.freeDiscount, yearData.prorataCost);
          yearData.finalCost = parseFloat(Math.max(0, yearData.prorataCost - yearData.freeDiscount).toFixed(2));
        } else if (yearData.freePeriodDaysApplied > 0) {
          yearData.freeDiscount = parseFloat((yearData.dailyCost * yearData.freePeriodDaysApplied).toFixed(2));
          yearData.billableDays = yearData.prorataDays - yearData.freePeriodDaysApplied;
          yearData.finalCost = parseFloat((yearData.dailyCost * yearData.billableDays).toFixed(2));
        } else {
          yearData.finalCost = yearData.prorataCost;
        }
      } else if (isPercentIncentive && yearData.freePeriodAmount) {
        yearData.freeDiscount = parseFloat((netCost * yearData.freePeriodAmount / 100).toFixed(2));
        yearData.finalCost = parseFloat(Math.max(0, netCost - yearData.freeDiscount).toFixed(2));
      } else if (yearData.freePeriodDaysApplied > 0) {
        yearData.freeDiscount = parseFloat((yearData.dailyCost * yearData.freePeriodDaysApplied).toFixed(2));
        yearData.finalCost = parseFloat((netCost - yearData.freeDiscount).toFixed(2));
      } else {
        yearData.finalCost = netCost;
      }
    } else if (override.override_type === 'structure' && override.config_id) {
      const overrideConfig = await getConfigById(override.config_id, tenantId);
      if (overrideConfig) {
        const overrideBands = await getBandsForConfig(overrideConfig.id, tenantId);
        const overrideBand = override.band_id
          ? overrideBands.find(b => b.id === override.band_id)
          : matchBand(fieldValue, overrideBands);

        if (overrideBand) {
          const overrideCost = parseFloat(overrideBand.annual_cost);
          yearData.overrideType = 'structure';
          yearData.overrideConfigId = overrideConfig.id;
          yearData.overrideConfigName = overrideConfig.name;
          yearData.overrideNote = override.note;
          yearData.originalAnnualCost = yearData.annualCost;
          yearData.originalFinalCost = yearData.finalCost;
          yearData.tierLabel = overrideBand.label;
          yearData.annualCost = overrideCost;
          yearData.finalCost = overrideCost;
        }
      }
    }
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

  if (simResult.existingRecord) {
    return res.status(400).json({ error: `A membership record for ${simResult.membershipYear.label} already exists` });
  }

  const vatRate = simResult.matchedBand?.vat_rate !== null && simResult.matchedBand?.vat_rate !== undefined
    ? parseFloat(simResult.matchedBand.vat_rate)
    : null;

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
    final_cost: simResult.finalCost,
    currency: simResult.currency,
    billing_period: simResult.billingPeriod || 'annual',
    status: 'active',
    notes: notes || null,
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
      return res.status(400).json({ error: `A membership record for ${simResult.membershipYear.label} already exists (duplicate prevented)` });
    }
    console.error('[Org Membership] Error creating history record:', error);
    return res.status(500).json({ error: 'Failed to create membership record' });
  }

  return res.json(record);
}
