import { supabase } from '../_lib/database.js';
import { createXeroMembershipInvoice } from '../_lib/xero.js';
import { evaluateDiscountsForOrg, applyDiscountsToAnnualCost } from '../_lib/discountHelper.js';
import { getConfigForOrganisation } from '../_lib/membershipConfigResolver.js';

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    console.log('[cron/process-membership-renewals] Unauthorized request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  const startTime = Date.now();
  const results = { processed: 0, skipped: 0, errors: 0, details: [] };

  try {
    const { data: configs, error: configError } = await supabase
      .from('membership_tier_config')
      .select('*')
      .is('effective_to', null);

    if (configError) {
      console.error('[cron/process-membership-renewals] Error fetching configs:', configError);
      return res.status(500).json({ error: 'Failed to fetch tier configs' });
    }

    const tenantIds = [];

    if (!configs || configs.length === 0) {
      console.log('[cron/process-membership-renewals] No active tier configs found');
    } else {
      tenantIds.push(...new Set(configs.map(c => c.tenant_id)));

      for (const tenantId of tenantIds) {
        try {
          await processTenantRenewals(tenantId, results);
        } catch (tenantErr) {
          console.error(`[cron/process-membership-renewals] Error processing tenant ${tenantId}:`, tenantErr);
          results.errors++;
          results.details.push({ tenantId, error: tenantErr.message });
        }
      }
    }

    const duration = Date.now() - startTime;

    for (const tenantId of tenantIds) {
      try {
        const tenantDetails = results.details.filter(d => d.tenantId === tenantId);
        const tenantProcessed = tenantDetails.filter(d => d.status === 'processed').length;
        const tenantSkipped = tenantDetails.filter(d => d.status === 'skipped').length;
        const tenantErrors = tenantDetails.filter(d => d.status === 'error').length;

        await supabase.from('scheduled_task_log').insert({
          tenant_id: tenantId,
          task_name: 'membership_renewals',
          task_display_name: 'Membership Renewals',
          status: tenantErrors > 0 ? 'partial' : 'success',
          details: JSON.stringify({
            processed: tenantProcessed,
            skipped: tenantSkipped,
            errors: tenantErrors,
            duration_ms: duration,
            details: tenantDetails,
          }),
          executed_at: new Date().toISOString(),
        });
      } catch (logErr) {
        console.error(`[cron/process-membership-renewals] Failed to log for tenant ${tenantId}:`, logErr);
      }
    }

    if (tenantIds.length === 0) {
      try {
        await supabase.from('scheduled_task_log').insert({
          tenant_id: null,
          task_name: 'membership_renewals',
          task_display_name: 'Membership Renewals',
          status: 'success',
          details: JSON.stringify({ message: 'No active tier configs found', duration_ms: duration }),
          executed_at: new Date().toISOString(),
        });
      } catch (logErr) {
        console.error('[cron/process-membership-renewals] Failed to log:', logErr);
      }
    }

    console.log(`[cron/process-membership-renewals] Completed in ${duration}ms. Processed: ${results.processed}, Skipped: ${results.skipped}, Errors: ${results.errors}`);

    return res.json({
      success: true,
      duration_ms: duration,
      results,
    });

  } catch (error) {
    console.error('[cron/process-membership-renewals] Fatal error:', error);

    try {
      await supabase.from('scheduled_task_log').insert({
        tenant_id: null,
        task_name: 'membership_renewals',
        task_display_name: 'Membership Renewals',
        status: 'error',
        details: JSON.stringify({ error: error.message }),
        executed_at: new Date().toISOString(),
      });
    } catch (logErr) {
      console.error('[cron/process-membership-renewals] Failed to log error:', logErr);
    }

    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function processTenantRenewals(tenantId, results) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const { data: invoicingRows, error: invError } = await supabase
    .from('organisation_membership_invoicing')
    .select('*')
    .eq('tenant_id', tenantId)
    .in('invoicing_mode', ['automatic', 'scheduled']);

  if (invError) {
    if (invError.code === '42P01') return;
    throw invError;
  }

  if (!invoicingRows || invoicingRows.length === 0) return;

  const goLiveFieldId = await getGoLiveFieldId(tenantId);
  const configBandsCache = {};

  for (const invoicingSetting of invoicingRows) {
    const orgId = invoicingSetting.organization_id;
    const mode = invoicingSetting.invoicing_mode;

    try {
      const config = await getConfigForOrganisation(tenantId, orgId);
      if (!config) {
        results.skipped++;
        results.details.push({ tenantId, orgId, mode, status: 'skipped', reason: 'No matching tier config for this organisation' });
        continue;
      }

      if (!configBandsCache[config.id]) {
        configBandsCache[config.id] = await getBandsForConfig(config.id, tenantId);
      }
      const bands = configBandsCache[config.id];

      const nextYear = calculateNextMembershipYear(config);
      const yearStart = new Date(nextYear.start);
      yearStart.setHours(0, 0, 0, 0);
      const renewalDue = today >= yearStart;

      const { data: existing } = await supabase
        .from('organisation_membership_history')
        .select('id, xero_invoice_id')
        .eq('tenant_id', tenantId)
        .eq('organization_id', orgId)
        .eq('membership_year', nextYear.label)
        .maybeSingle();

      if (mode === 'automatic') {
        if (!renewalDue) {
          results.skipped++;
          continue;
        }
        if (existing) {
          results.skipped++;
          results.details.push({ tenantId, orgId, mode, status: 'skipped', reason: `Record for ${nextYear.label} already exists` });
          continue;
        }
        await processOrgRenewal(tenantId, orgId, config, bands, nextYear, mode, true, goLiveFieldId, results);
      } else if (mode === 'scheduled') {
        if (!renewalDue && !existing) {
          results.skipped++;
          continue;
        }

        if (!existing && renewalDue) {
          const invoiceDue = isInvoiceDateReached(invoicingSetting, today);
          await processOrgRenewal(tenantId, orgId, config, bands, nextYear, mode, invoiceDue, goLiveFieldId, results);
        } else if (existing && !existing.xero_invoice_id) {
          const invoiceDue = isInvoiceDateReached(invoicingSetting, today);
          if (invoiceDue) {
            await invoiceExistingRecord(tenantId, orgId, existing.id, config, bands, nextYear, results);
          } else {
            results.skipped++;
          }
        } else {
          results.skipped++;
          results.details.push({ tenantId, orgId, mode, status: 'skipped', reason: `Record for ${nextYear.label} already exists with invoice` });
        }
      }
    } catch (orgErr) {
      console.error(`[cron/process-membership-renewals] Error processing org ${orgId}:`, orgErr);
      results.errors++;
      results.details.push({ tenantId, orgId, mode, status: 'error', reason: orgErr.message });
    }
  }
}

function isInvoiceDateReached(invoicingSetting, today) {
  if (!invoicingSetting.invoice_date) return false;
  const scheduledDate = new Date(invoicingSetting.invoice_date);
  scheduledDate.setHours(0, 0, 0, 0);
  return today >= scheduledDate;
}

async function invoiceExistingRecord(tenantId, orgId, recordId, config, bands, nextYear, results) {
  const { data: org } = await supabase
    .from('organization')
    .select('id, name, tenant_id')
    .eq('id', orgId)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (!org) return;

  const { data: record } = await supabase
    .from('organisation_membership_history')
    .select('*')
    .eq('id', recordId)
    .single();

  if (!record) return;

  let bandVatRate = null;
  if (record.band_id) {
    const band = bands.find(b => b.id === record.band_id);
    bandVatRate = band?.vat_rate || null;
  }

  let xeroInvoice = null;
  try {
    xeroInvoice = await createXeroMembershipInvoice({
      appTenantId: tenantId,
      organizationName: org.name,
      membershipYear: record.membership_year,
      tierLabel: record.tier_label,
      finalCost: parseFloat(record.final_cost),
      currency: record.currency || 'GBP',
      reference: `Membership ${record.membership_year}`,
      vatRate: bandVatRate,
    });

    if (xeroInvoice) {
      await supabase
        .from('organisation_membership_history')
        .update({
          xero_invoice_id: xeroInvoice.invoice_id,
          xero_invoice_number: xeroInvoice.invoice_number,
        })
        .eq('id', recordId);
    }
  } catch (xeroErr) {
    console.error(`[cron/process-membership-renewals] Scheduled Xero invoice failed for org ${orgId} (non-fatal):`, xeroErr.message);
  }

  try {
    const invoiceNote = xeroInvoice
      ? ` Xero invoice ${xeroInvoice.invoice_number} created.`
      : ' Xero invoice could not be created - check Xero connection.';
    await supabase
      .from('organization_note')
      .insert({
        organization_id: orgId,
        member_id: null,
        content: `[Membership Invoice - Scheduled] Invoice generated for ${record.membership_year}. Fee: ${record.currency || 'GBP'} ${parseFloat(record.final_cost).toFixed(2)}.${invoiceNote}`,
        attachments: [],
      });
  } catch (noteErr) {
    console.error(`[cron/process-membership-renewals] Failed to create invoice note for org ${orgId} (non-fatal):`, noteErr);
  }

  results.processed++;
  results.details.push({
    tenantId,
    orgId,
    orgName: org.name,
    mode: 'scheduled',
    action: 'invoiced',
    status: 'processed',
    membershipYear: record.membership_year,
    finalCost: parseFloat(record.final_cost),
    xeroInvoice: xeroInvoice?.invoice_number || null,
  });

  console.log(`[cron/process-membership-renewals] Scheduled invoice: ${org.name} for ${record.membership_year}, cost: ${parseFloat(record.final_cost).toFixed(2)}, invoice: ${xeroInvoice?.invoice_number || 'none'}`);
}

async function processOrgRenewal(tenantId, orgId, config, bands, nextYear, mode, createInvoice, goLiveFieldId, results) {
  const { data: org } = await supabase
    .from('organization')
    .select('id, name, tenant_id')
    .eq('id', orgId)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (!org) {
    results.skipped++;
    results.details.push({
      tenantId,
      orgId,
      mode,
      status: 'skipped',
      reason: 'Organisation not found',
    });
    return;
  }

  const goLiveDate = goLiveFieldId ? await getOrgGoLiveDate(orgId, goLiveFieldId) : null;
  const membershipYearNumber = determineMembershipYearNumber(goLiveDate, nextYear, config);

  const fieldValue = await getOrgFieldValue(orgId, tenantId, config);
  let matchedBand = matchBand(fieldValue, bands);
  let annualCost = matchedBand ? parseFloat(matchedBand.annual_cost) : null;
  let tierLabel = matchedBand?.label || null;
  let bandVatRate = matchedBand?.vat_rate || null;
  let finalCost = annualCost;
  let freeDiscount = 0;
  let rolloverDiscount = 0;
  let customDiscountTotal = 0;
  let customDiscountDetails = [];
  let usedConfigId = config.id;
  let usedBandId = matchedBand?.id || null;

  if (annualCost !== null) {
    const discountResult = await evaluateDiscountsForOrg(config.id, tenantId, orgId);
    if (discountResult.discountDetails.length > 0) {
      const applied = applyDiscountsToAnnualCost(annualCost, discountResult.discountDetails);
      customDiscountTotal = applied.totalDiscount;
      customDiscountDetails = applied.appliedDiscounts;
      annualCost = applied.discountedCost;
      finalCost = annualCost;
    }

    if (membershipYearNumber === 1) {
      freeDiscount = calculateFreePeriodDiscount(annualCost, config);
      finalCost = annualCost - freeDiscount;
    } else if (membershipYearNumber === 2 && config.rollover_enabled) {
      rolloverDiscount = calculateRolloverDiscount(annualCost, config, goLiveDate);
      finalCost = annualCost - rolloverDiscount;
    }
  }

  let override = null;
  try {
    const yearLabel = nextYear?.label || null;
    let overrideQuery = supabase
      .from('organisation_membership_override')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('organization_id', orgId);
    if (yearLabel) {
      overrideQuery = overrideQuery.or(`membership_year.eq.${yearLabel},membership_year.is.null`);
    }
    const { data: overrideRows } = await overrideQuery;
    if (overrideRows && overrideRows.length > 0) {
      override = overrideRows.find(o => o.membership_year === yearLabel) || overrideRows.find(o => !o.membership_year) || overrideRows[0];
    }
  } catch (err) {}

  if (override) {
    if (override.override_type === 'price' && override.manual_price !== null) {
      annualCost = parseFloat(override.manual_price);
      finalCost = annualCost;
      freeDiscount = 0;
      rolloverDiscount = 0;
      customDiscountTotal = 0;
      customDiscountDetails = [];
    } else if (override.override_type === 'structure' && override.config_id) {
      const overrideConfig = await getConfigById(override.config_id, tenantId);
      if (overrideConfig) {
        const overrideBands = await getBandsForConfig(overrideConfig.id, tenantId);
        const overrideBand = override.band_id
          ? overrideBands.find(b => b.id === override.band_id)
          : matchBand(fieldValue, overrideBands);

        if (overrideBand) {
          annualCost = parseFloat(overrideBand.annual_cost);
          tierLabel = overrideBand.label;
          bandVatRate = overrideBand.vat_rate || null;
          freeDiscount = 0;
          rolloverDiscount = 0;
          usedConfigId = overrideConfig.id;
          usedBandId = overrideBand.id;

          const overrideDiscountResult = await evaluateDiscountsForOrg(overrideConfig.id, tenantId, orgId);
          if (overrideDiscountResult.discountDetails.length > 0) {
            const overrideApplied = applyDiscountsToAnnualCost(annualCost, overrideDiscountResult.discountDetails);
            customDiscountTotal = overrideApplied.totalDiscount;
            customDiscountDetails = overrideApplied.appliedDiscounts;
            annualCost = overrideApplied.discountedCost;
          } else {
            customDiscountTotal = 0;
            customDiscountDetails = [];
          }
          finalCost = annualCost;
        }
      }
    }
  }

  if (annualCost === null) {
    results.skipped++;
    results.details.push({
      tenantId,
      orgId,
      orgName: org.name,
      mode,
      status: 'skipped',
      reason: 'No matching tier band',
    });
    return;
  }

  const { data: record, error: insertError } = await supabase
    .from('organisation_membership_history')
    .insert({
      tenant_id: tenantId,
      organization_id: orgId,
      membership_year: nextYear.label,
      config_id: usedConfigId,
      band_id: usedBandId,
      tier_label: tierLabel,
      field_value: fieldValue,
      annual_cost: annualCost,
      prorata_cost: null,
      free_period_discount: freeDiscount,
      rollover_discount: rolloverDiscount,
      custom_discount_total: customDiscountTotal,
      custom_discount_details: customDiscountDetails.length > 0 ? customDiscountDetails : null,
      final_cost: finalCost,
      currency: config.currency || 'GBP',
      billing_period: config.billing_period || 'annual',
      status: 'active',
      notes: `${mode === 'automatic' ? 'Automatic' : 'Scheduled'} renewal via cron job (year ${membershipYearNumber}${goLiveDate ? ', go-live: ' + goLiveDate : ''})`,
    })
    .select()
    .single();

  if (insertError) {
    throw new Error(`Failed to create history record: ${insertError.message}`);
  }

  let xeroInvoice = null;
  if (createInvoice) {
    try {
      xeroInvoice = await createXeroMembershipInvoice({
        appTenantId: tenantId,
        organizationName: org.name,
        membershipYear: nextYear.label,
        tierLabel,
        finalCost,
        currency: config.currency || 'GBP',
        reference: `Membership ${nextYear.label}`,
        vatRate: bandVatRate,
      });

      if (xeroInvoice) {
        const { error: linkError } = await supabase
          .from('organisation_membership_history')
          .update({
            xero_invoice_id: xeroInvoice.invoice_id,
            xero_invoice_number: xeroInvoice.invoice_number,
          })
          .eq('id', record.id);

        if (linkError) {
          console.error(`[cron/process-membership-renewals] Failed to link Xero invoice for org ${orgId}:`, linkError.message);
        }
      }
    } catch (xeroErr) {
      console.error(`[cron/process-membership-renewals] Xero invoice failed for org ${orgId} (non-fatal):`, xeroErr.message);
    }
  }

  try {
    const modeLabel = mode === 'automatic' ? 'Automatic' : 'Scheduled';
    let noteContent = `[Membership Renewal - ${modeLabel}] Membership renewed for ${nextYear.label}. Fee: ${config.currency || 'GBP'} ${finalCost.toFixed(2)}.`;
    if (createInvoice) {
      noteContent += xeroInvoice
        ? ` Xero invoice ${xeroInvoice.invoice_number} created.`
        : ' Xero invoice could not be created - check Xero connection.';
    } else {
      noteContent += ' Invoice will be generated on the scheduled date.';
    }
    await supabase
      .from('organization_note')
      .insert({
        organization_id: orgId,
        member_id: null,
        content: noteContent,
        attachments: [],
      });
  } catch (noteErr) {
    console.error(`[cron/process-membership-renewals] Failed to create note for org ${orgId} (non-fatal):`, noteErr);
  }

  results.processed++;
  results.details.push({
    tenantId,
    orgId,
    orgName: org.name,
    mode,
    action: createInvoice ? 'renewed_and_invoiced' : 'renewed',
    status: 'processed',
    membershipYear: nextYear.label,
    membershipYearNumber,
    goLiveDate: goLiveDate || null,
    finalCost,
    freeDiscount,
    rolloverDiscount,
    xeroInvoice: xeroInvoice?.invoice_number || null,
  });

  console.log(`[cron/process-membership-renewals] Renewed: ${org.name} for ${nextYear.label} (year ${membershipYearNumber}), cost: ${finalCost.toFixed(2)}, free: ${freeDiscount.toFixed(2)}, rollover: ${rolloverDiscount.toFixed(2)}, invoice: ${createInvoice ? (xeroInvoice?.invoice_number || 'failed') : 'deferred'}`);
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
  let freeMonths = 0;
  if (unit === 'months') freeMonths = amount;
  else if (unit === 'weeks') freeMonths = amount / 4.33;
  else if (unit === 'days') freeMonths = amount / 30.44;
  return parseFloat((annualCost * freeMonths / 12).toFixed(2));
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

async function getBandsForConfig(configId, tenantId) {
  const { data } = await supabase
    .from('membership_tier_band')
    .select('*')
    .eq('config_id', configId)
    .eq('tenant_id', tenantId)
    .order('min_value', { ascending: true });
  return data || [];
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

function getMembershipYearStartForDate(date, config) {
  const startMonth = config.membership_start_month || 1;
  const startDay = config.membership_start_day || 1;
  const year = date.getFullYear();
  const yearStart = new Date(year, startMonth - 1, startDay);
  if (date >= yearStart) {
    return yearStart;
  }
  return new Date(year - 1, startMonth - 1, startDay);
}

function getNextMembershipYearStart(yearStart, config) {
  const startMonth = config.membership_start_month || 1;
  const startDay = config.membership_start_day || 1;
  return new Date(yearStart.getFullYear() + 1, startMonth - 1, startDay);
}

function determineMembershipYearNumber(goLiveDate, targetYear, config) {
  if (!goLiveDate) return 99;

  const goLive = new Date(goLiveDate);
  if (isNaN(goLive.getTime())) return 99;

  const firstYearStart = getMembershipYearStartForDate(goLive, config);
  const targetStart = new Date(targetYear.start);
  targetStart.setHours(0, 0, 0, 0);

  let yearNumber = 1;
  let currentStart = new Date(firstYearStart);
  while (currentStart < targetStart) {
    currentStart = getNextMembershipYearStart(currentStart, config);
    yearNumber++;
    if (yearNumber > 100) break;
  }

  return yearNumber;
}

function calculateRolloverDiscount(annualCost, config, goLiveDate) {
  if (!config.rollover_enabled || !config.free_period_amount || !goLiveDate) return 0;

  const goLive = new Date(goLiveDate);
  if (isNaN(goLive.getTime())) return 0;

  const firstYearStart = getMembershipYearStartForDate(goLive, config);
  const firstYearEnd = getNextMembershipYearStart(firstYearStart, config);

  const totalDaysInFirstYear = Math.ceil((firstYearEnd - firstYearStart) / (1000 * 60 * 60 * 24));
  const remainingDaysInFirstYear = Math.max(0, Math.ceil((firstYearEnd - goLive) / (1000 * 60 * 60 * 24)));
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

async function getOrgFieldValue(orgId, tenantId, config) {
  if (!config) return null;

  if (config.field_source === 'core' && config.field_name === 'member_count') {
    const { data: members } = await supabase
      .from('member')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('organization_id', orgId);
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
