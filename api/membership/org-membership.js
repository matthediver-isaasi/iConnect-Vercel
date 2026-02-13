import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { evaluateDiscountsForOrg, applyDiscountsToAnnualCost } from '../_lib/discountHelper.js';
import { getConfigForOrganisation } from '../_lib/membershipConfigResolver.js';

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

function calculateFreePeriodDiscount(annualCost, config) {
  if (!config.free_period_amount || !config.free_period_unit) return 0;

  const amount = config.free_period_amount;
  const unit = config.free_period_unit;

  let freeMonths = 0;
  if (unit === 'months') freeMonths = amount;
  else if (unit === 'weeks') freeMonths = amount / 4.33;
  else if (unit === 'days') freeMonths = amount / 30.44;

  return parseFloat((annualCost * freeMonths / 12).toFixed(2));
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
  let annualCost = annualCostRaw;
  let freeDiscount = 0;
  let adjustedAnnual = annualCost;
  let customDiscountTotal = 0;
  let customDiscountDetails = [];

  if (annualCost !== null) {
    const discountResult = await evaluateDiscountsForOrg(config.id, tenantId, organizationId);
    if (discountResult.discountDetails.length > 0) {
      const applied = applyDiscountsToAnnualCost(annualCost, discountResult.discountDetails);
      customDiscountTotal = applied.totalDiscount;
      customDiscountDetails = applied.appliedDiscounts;
      annualCost = applied.discountedCost;
    }

    freeDiscount = calculateFreePeriodDiscount(annualCost, config);
    adjustedAnnual = annualCost - freeDiscount;
  }

  const { data: historyRecords } = await supabase
    .from('organisation_membership_history')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('organization_id', organizationId)
    .order('membership_year', { ascending: false });

  const goLiveFieldId = await getGoLiveFieldId(tenantId);
  const goLiveDate = goLiveFieldId ? await getOrgGoLiveDate(organizationId, goLiveFieldId) : null;
  const yearNumber = determineMembershipYearNumber(goLiveDate, currentYear, config);

  const hasCurrentYearRecord = (historyRecords || []).some(h => h.membership_year === currentYear.label);

  const isNewOrg = (yearNumber === 1 || !goLiveDate) && !hasCurrentYearRecord;

  let nextYearPreview = null;
  let currentYearCost = null;

  if (annualCost !== null) {
    const freeDiscountForYear = calculateFreePeriodDiscount(annualCost, config);
    const costAfterFree = annualCost - freeDiscountForYear;

    let prorataCost = null;
    let remainingDays = null;
    let totalDays = null;

    if (config.prorata_enabled && isNewOrg) {
      const joinDate = goLiveDate ? new Date(goLiveDate) : new Date();
      const proRataResult = calculateProRata(costAfterFree, config, joinDate);
      prorataCost = proRataResult.proratedCost;
      remainingDays = proRataResult.remainingDays;
      totalDays = proRataResult.totalDays;
    }

    currentYearCost = {
      membershipYear: currentYear.label,
      tierLabel: matchedBand?.label || null,
      fieldValue,
      annualCost: annualCost,
      annualCostBeforeDiscounts: annualCostRaw,
      customDiscountTotal,
      customDiscountDetails,
      freeDiscount: isNewOrg ? freeDiscountForYear : 0,
      freePeriodAmount: config.free_period_amount,
      freePeriodUnit: config.free_period_unit,
      costAfterFreeDiscount: isNewOrg ? costAfterFree : annualCost,
      proRataEnabled: !!config.prorata_enabled && isNewOrg,
      prorataCost,
      remainingDays,
      totalDays,
      finalCost: prorataCost !== null ? prorataCost : (isNewOrg ? costAfterFree : annualCost),
      goLiveDate,
      currency: config.currency || 'GBP',
      billingPeriod: config.billing_period || 'annual',
    };

    const nextYearFull = annualCost;
    let nextYearRolloverDiscount = 0;

    if (config.rollover_enabled && config.free_period_amount && config.prorata_enabled) {
      const freePeriodMonths = getFreeMonths(config);
      const currentYearObj = calculateMembershipYear(config);
      const totalMonthsInYear = 12;
      const remainingMonths = Math.ceil(
        (currentYearObj.end - new Date()) / (1000 * 60 * 60 * 24 * 30.44)
      );
      const usedFreeMonths = Math.min(freePeriodMonths, Math.max(0, remainingMonths));
      const unusedFreeMonths = Math.max(0, freePeriodMonths - usedFreeMonths);

      if (unusedFreeMonths > 0) {
        nextYearRolloverDiscount = parseFloat((annualCost * unusedFreeMonths / totalMonthsInYear).toFixed(2));
      }
    }

    const nextYearFinal = nextYearFull - nextYearRolloverDiscount;

    nextYearPreview = {
      membershipYear: nextYear.label,
      tierLabel: matchedBand?.label || null,
      fieldValue,
      annualCost: nextYearFull,
      annualCostBeforeDiscounts: annualCostRaw,
      customDiscountTotal,
      customDiscountDetails,
      rolloverDiscount: nextYearRolloverDiscount,
      finalCost: parseFloat(nextYearFinal.toFixed(2)),
      currency: config.currency || 'GBP',
      billingPeriod: config.billing_period || 'annual',
    };
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
      if (yearData.rolloverDiscount !== undefined) yearData.rolloverDiscount = 0;
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
          if (yearData.rolloverDiscount !== undefined) yearData.rolloverDiscount = 0;
          yearData.finalCost = overrideCost;
        }
      }
    }
  }

  const currentYearOverride = overrides.find(o => o.membership_year === currentYear.label) || null;
  const nextYearOverride = overrides.find(o => o.membership_year === nextYear.label)
    || overrides.find(o => !o.membership_year) || null;

  await applyOverrideToYear(currentYearCost, currentYearOverride);
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
      annualCost,
      annualCostBeforeDiscounts: annualCostRaw,
      customDiscountTotal,
      customDiscountDetails,
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

  const bands = await getBandsForConfig(config.id, tenantId);
  const fieldValue = await getOrgFieldValue(organizationId, tenantId, config);
  const matchedBand = matchBand(fieldValue, bands);

  if (!matchedBand) {
    return res.status(400).json({ error: 'Organisation does not match any tier band' });
  }

  let annualCost = parseFloat(matchedBand.annual_cost);
  let customDiscountTotal = 0;
  let customDiscountDetails = [];

  const discountResult = await evaluateDiscountsForOrg(config.id, tenantId, organizationId);
  if (discountResult.discountDetails.length > 0) {
    const applied = applyDiscountsToAnnualCost(annualCost, discountResult.discountDetails);
    customDiscountTotal = applied.totalDiscount;
    customDiscountDetails = applied.appliedDiscounts;
    annualCost = applied.discountedCost;
  }

  const freeDiscount = calculateFreePeriodDiscount(annualCost, config);
  const adjustedAnnual = annualCost - freeDiscount;

  let prorataCost = null;
  if (config.prorata_enabled) {
    const prorata = calculateProRata(adjustedAnnual, config);
    prorataCost = prorata.proratedCost;
  }

  let rolloverDiscount = 0;
  if (config.rollover_enabled && config.free_period_amount) {
    const prevYearHistory = await supabase
      .from('organisation_membership_history')
      .select('rollover_discount')
      .eq('tenant_id', tenantId)
      .eq('organization_id', organizationId)
      .order('membership_year', { ascending: false })
      .limit(1)
      .maybeSingle();
  }

  const finalCost = prorataCost !== null ? prorataCost : adjustedAnnual;

  const { data: existing } = await supabase
    .from('organisation_membership_history')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('organization_id', organizationId)
    .eq('membership_year', membershipYear)
    .maybeSingle();

  if (existing) {
    return res.status(400).json({ error: `A membership record for ${membershipYear} already exists` });
  }

  const { data: record, error } = await supabase
    .from('organisation_membership_history')
    .insert({
      tenant_id: tenantId,
      organization_id: organizationId,
      membership_year: membershipYear,
      config_id: config.id,
      band_id: matchedBand.id,
      tier_label: matchedBand.label,
      field_value: fieldValue,
      annual_cost: annualCost,
      prorata_cost: prorataCost,
      free_period_discount: freeDiscount,
      rollover_discount: rolloverDiscount,
      custom_discount_total: customDiscountTotal,
      custom_discount_details: customDiscountDetails.length > 0 ? customDiscountDetails : null,
      final_cost: finalCost,
      currency: config.currency || 'GBP',
      billing_period: config.billing_period || 'annual',
      status: 'active',
      notes: notes || null,
    })
    .select()
    .single();

  if (error) {
    console.error('[Org Membership] Error creating history record:', error);
    return res.status(500).json({ error: 'Failed to create membership record' });
  }

  return res.json(record);
}
