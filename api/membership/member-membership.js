import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { getConfigForMember } from '../_lib/membershipConfigResolver.js';
import { simulateMembershipForMember } from '../_lib/membershipSimulation.js';

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
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('[Member Membership] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

function mapSimResultToYearData(sim, startDate) {
  const effectiveFreeDiscount = sim.yearNumber === 2 ? (sim.rolloverDiscount || 0) : (sim.freeDiscount || 0);
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
    isNewMember: sim.isNewMember,
    currency: sim.currency || 'GBP',
    billingPeriod: sim.billingPeriod || 'annual',
    overrideApplied: sim.overrideApplied || false,
    overrideType: sim.overrideType || null,
    overrideNote: sim.overrideNote || null,
    overrideDiscountType: sim.overrideDiscountType || null,
    overrideDiscountValue: sim.overrideDiscountValue,
    overrideConfigId: sim.overrideConfigId || null,
    overrideConfigName: sim.overrideConfigName || null,
    originalAnnualCost: sim.overrideApplied ? sim.annualCostBeforeDiscounts : undefined,
  };
}

async function handleGet(req, res, tenantId) {
  const { memberId } = req.query;

  if (!memberId) {
    return res.status(400).json({ error: 'memberId is required' });
  }

  const { data: member } = await supabase
    .from('member')
    .select('id, first_name, last_name, email, tenant_id, organization_id')
    .eq('id', memberId)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (!member) {
    return res.status(404).json({ error: 'Member not found' });
  }

  const config = await getConfigForMember(tenantId, memberId);

  if (!config) {
    return res.json({
      member: { id: member.id, name: `${member.first_name || ''} ${member.last_name || ''}`.trim() },
      config: null,
      currentYearCost: null,
      nextYearPreview: null,
      history: [],
    });
  }

  const startMonth = config.membership_start_month || 1;
  const startDay = config.membership_start_day || 1;
  const now = new Date();
  const currentCalYear = now.getFullYear();
  const yearStart = new Date(currentCalYear, startMonth - 1, startDay);

  let currentYear;
  if (now < yearStart) {
    currentYear = {
      label: `${currentCalYear - 1}/${currentCalYear}`,
      start: new Date(currentCalYear - 1, startMonth - 1, startDay),
      end: new Date(currentCalYear, startMonth - 1, startDay - 1),
    };
  } else {
    currentYear = {
      label: `${currentCalYear}/${currentCalYear + 1}`,
      start: yearStart,
      end: new Date(currentCalYear + 1, startMonth - 1, startDay - 1),
    };
  }

  const nextStart = new Date(currentYear.end);
  nextStart.setDate(nextStart.getDate() + 1);
  const nextCalYear = nextStart.getFullYear();
  const nextYear = {
    label: `${nextCalYear}/${nextCalYear + 1}`,
    start: nextStart,
    end: new Date(nextCalYear + 1, startMonth - 1, startDay - 1),
  };

  let history = [];
  try {
    const { data: historyRecords } = await supabase
      .from('member_membership_history')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('member_id', memberId)
      .order('membership_year', { ascending: false });
    history = historyRecords || [];
  } catch (err) {
    console.log('[Member Membership] History table may not exist yet:', err.message);
  }

  const currentYearStartDate = currentYear.start.toISOString().split('T')[0];
  const nextYearStartDate = nextYear.start.toISOString().split('T')[0];

  let currentYearCost = null;
  let nextYearPreview = null;

  const currentYearRecord = history.find(h => h.membership_year === currentYear.label);

  if (currentYearRecord) {
    const recAnnual = parseFloat(currentYearRecord.annual_cost);
    const recCustomTotal = parseFloat(currentYearRecord.custom_discount_total || 0);
    const recProrata = currentYearRecord.prorata_cost != null ? parseFloat(currentYearRecord.prorata_cost) : null;
    const recFreeDiscount = parseFloat(currentYearRecord.free_period_discount || 0);
    const recFinal = parseFloat(currentYearRecord.final_cost);
    const hasProRata = recProrata !== null;

    currentYearCost = {
      membershipYear: currentYear.label,
      startDate: currentYearStartDate,
      tierLabel: currentYearRecord.tier_label || null,
      fieldValue: currentYearRecord.field_value,
      annualCost: recAnnual,
      annualCostBeforeDiscounts: recCustomTotal > 0 ? parseFloat((recAnnual + recCustomTotal).toFixed(2)) : recAnnual,
      customDiscountTotal: recCustomTotal,
      customDiscountDetails: currentYearRecord.custom_discount_details || [],
      proRataEnabled: hasProRata,
      prorataCost: recProrata,
      freeDiscount: recFreeDiscount,
      finalCost: recFinal,
      currency: currentYearRecord.currency || config.currency || 'GBP',
      billingPeriod: currentYearRecord.billing_period || config.billing_period || 'annual',
      yearNumber: currentYearRecord.year_number || null,
      dailyCost: null,
      prorataDays: currentYearRecord.prorata_days || null,
      freePeriodDaysApplied: currentYearRecord.free_period_days_applied || 0,
      freePeriodAmount: config.free_period_amount,
      freePeriodUnit: config.free_period_unit,
      billableDays: null,
      vatRatePercent: currentYearRecord.vat_rate_percent != null ? parseFloat(currentYearRecord.vat_rate_percent) : null,
      vatAmount: currentYearRecord.vat_amount != null ? parseFloat(currentYearRecord.vat_amount) : 0,
      totalWithVat: currentYearRecord.total_with_vat != null ? parseFloat(currentYearRecord.total_with_vat) : recFinal,
      taxType: null,
      taxLabel: null,
      overrideApplied: currentYearRecord.override_applied || false,
      overrideType: currentYearRecord.override_type || null,
      isNewMember: false,
      recordedFromHistory: true,
    };
  } else {
    try {
      const simResult = await simulateMembershipForMember(tenantId, memberId, {
        source: 'tab',
        targetYear: currentYear.label,
      });
      if (simResult.success) {
        currentYearCost = mapSimResultToYearData(simResult, currentYearStartDate);
      }
    } catch (simErr) {
      console.warn('[Member Membership] Current year simulation failed:', simErr.message);
    }
  }

  try {
    const nextSimResult = await simulateMembershipForMember(tenantId, memberId, {
      source: 'tab',
      targetYear: nextYear.label,
    });
    if (nextSimResult.success) {
      nextYearPreview = mapSimResultToYearData(nextSimResult, nextYearStartDate);
    }
  } catch (simErr) {
    console.warn('[Member Membership] Next year simulation failed:', simErr.message);
  }

  return res.json({
    member: { id: member.id, name: `${member.first_name || ''} ${member.last_name || ''}`.trim() },
    config: {
      id: config.id,
      name: config.name,
      currency: config.currency || 'GBP',
      billing_period: config.billing_period || 'annual',
      effective_from: config.effective_from,
      membership_start_month: config.membership_start_month,
      membership_start_day: config.membership_start_day,
      online_card_payment: !!config.online_card_payment,
    },
    currentYearCost,
    nextYearPreview,
    history,
    currentYear: currentYear.label,
  });
}
