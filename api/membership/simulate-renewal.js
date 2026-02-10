import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const tenantContext = await getTenantContext(req);
    if (!tenantContext?.tenantId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { tenantId } = tenantContext;
    const { organizationId, mode } = req.body;

    if (!organizationId) {
      return res.status(400).json({ error: 'organizationId is required' });
    }

    if (!mode || !['automatic', 'scheduled', 'manual'].includes(mode)) {
      return res.status(400).json({ error: 'mode must be "automatic", "scheduled", or "manual"' });
    }

    const steps = [];
    const log = (step, detail, status = 'ok') => {
      steps.push({ step, detail, status, timestamp: new Date().toISOString() });
    };

    log('Start', `Simulating "${mode}" renewal for organisation ${organizationId}`);

    const { data: org } = await supabase
      .from('organization')
      .select('id, name, tenant_id')
      .eq('id', organizationId)
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (!org) {
      log('Lookup Organisation', 'Organisation not found', 'error');
      return res.json({ success: false, steps });
    }
    log('Lookup Organisation', `Found: ${org.name}`);

    const { data: invoicingSettings } = await supabase
      .from('organisation_membership_invoicing')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    const currentMode = invoicingSettings?.invoicing_mode || 'manual';
    log('Check Invoicing Settings', `Saved mode: "${currentMode}"${invoicingSettings?.invoice_date ? `, scheduled date: ${invoicingSettings.invoice_date}` : ''}`);

    const config = await getCurrentConfig(tenantId);
    if (!config) {
      log('Fetch Tier Config', 'No active tier configuration found', 'error');
      return res.json({ success: false, steps });
    }
    log('Fetch Tier Config', `Active config: "${config.name || 'Default'}", currency: ${config.currency || 'GBP'}, start: month ${config.membership_start_month || 1} day ${config.membership_start_day || 1}`);

    const currentYear = calculateMembershipYear(config);
    const nextYear = calculateNextMembershipYear(config);
    log('Calculate Membership Year', `Current year: ${currentYear.label}, Next year: ${nextYear.label}`);

    const { data: existingRecord } = await supabase
      .from('organisation_membership_history')
      .select('id, membership_year, final_cost')
      .eq('tenant_id', tenantId)
      .eq('organization_id', organizationId)
      .eq('membership_year', nextYear.label)
      .maybeSingle();

    if (existingRecord) {
      log('Check Existing Record', `A membership record for ${nextYear.label} already exists (final cost: ${existingRecord.final_cost}). Renewal would be blocked.`, 'warning');
    } else {
      log('Check Existing Record', `No existing record for ${nextYear.label} - renewal can proceed`);
    }

    const bands = await getBandsForConfig(config.id, tenantId);
    log('Fetch Tier Bands', `Found ${bands.length} band(s)`);

    const fieldValue = await getOrgFieldValue(organizationId, tenantId, config);
    const fieldLabel = config.field_source === 'core' && config.field_name === 'member_count'
      ? 'Member Count' : (config.field_name || 'Value');
    log('Get Organisation Field Value', `${fieldLabel}: ${fieldValue !== null ? fieldValue : 'N/A'}`);

    let matchedBand = matchBand(fieldValue, bands);
    if (!matchedBand) {
      log('Match Tier Band', 'No band matches the current field value', 'error');
      return res.json({ success: false, steps });
    }
    log('Match Tier Band', `Matched: "${matchedBand.label}" (range: ${matchedBand.min_value}-${matchedBand.max_value || '∞'}, annual cost: ${matchedBand.annual_cost})`);

    let annualCost = parseFloat(matchedBand.annual_cost);
    let tierLabel = matchedBand.label;
    let freeDiscount = calculateFreePeriodDiscount(annualCost, config);
    let rolloverDiscount = 0;
    let finalCost = annualCost - freeDiscount;
    let usedConfigId = config.id;
    let usedBandId = matchedBand.id;
    let overrideApplied = false;

    if (freeDiscount > 0) {
      log('Free Period Discount', `Discount: ${freeDiscount.toFixed(2)} (${config.free_period_amount} ${config.free_period_unit})`);
    }

    let override = null;
    try {
      const { data: overrideData } = await supabase
        .from('organisation_membership_override')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('organization_id', organizationId)
        .maybeSingle();
      override = overrideData;
    } catch (err) {}

    if (override) {
      overrideApplied = true;
      if (override.override_type === 'price' && override.manual_price !== null) {
        annualCost = parseFloat(override.manual_price);
        finalCost = annualCost;
        freeDiscount = 0;
        rolloverDiscount = 0;
        log('Apply Override', `Price override: ${annualCost.toFixed(2)} (note: ${override.note || 'none'})`);
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
            finalCost = annualCost;
            freeDiscount = 0;
            rolloverDiscount = 0;
            usedConfigId = overrideConfig.id;
            usedBandId = overrideBand.id;
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

    log('Calculate Final Cost', `Annual: ${annualCost.toFixed(2)}, Free discount: ${freeDiscount.toFixed(2)}, Rollover: ${rolloverDiscount.toFixed(2)}, Final: ${finalCost.toFixed(2)} ${config.currency || 'GBP'}`);

    if (mode === 'automatic') {
      log('Mode: Automatic', 'At the start of the membership schedule, the system would automatically:');
      log('Step 1 - Renew', `Create membership history record for ${nextYear.label} with final cost ${finalCost.toFixed(2)} ${config.currency || 'GBP'}`);
      log('Step 2 - Invoice', `Generate and send invoice for ${finalCost.toFixed(2)} ${config.currency || 'GBP'} via Xero`);
      log('Step 3 - Note', `Add organisation note documenting the renewal`);
    } else if (mode === 'scheduled') {
      const scheduledDate = invoicingSettings?.invoice_date || 'Not set';
      log('Mode: Scheduled', `Renewal and invoicing are split across two dates`);
      log('Step 1 - Renew (at schedule start)', `Create membership history record for ${nextYear.label} with final cost ${finalCost.toFixed(2)} ${config.currency || 'GBP'}`);
      log('Step 2 - Invoice (on ${scheduledDate})', `Generate and send invoice for ${finalCost.toFixed(2)} ${config.currency || 'GBP'} via Xero on ${scheduledDate}`);
      log('Step 3 - Note', `Add organisation note documenting the renewal and scheduled invoice date`);
      if (scheduledDate === 'Not set') {
        log('Warning', 'No invoice date has been saved for this organisation. Scheduled mode requires a date.', 'warning');
      }
    } else if (mode === 'manual') {
      log('Mode: Manual', 'Admin triggers renewal manually via the "Renew & Invoice Now" button');
      log('Step 1 - Renew', `Create membership history record for ${nextYear.label} with final cost ${finalCost.toFixed(2)} ${config.currency || 'GBP'}`);
      log('Step 2 - Invoice', `Generate and send invoice for ${finalCost.toFixed(2)} ${config.currency || 'GBP'} via Xero immediately`);
      log('Step 3 - Note', `Add organisation note documenting the manual renewal`);
    }

    log('Dry Run Summary', 'This is a dry run - no records were created or modified', 'info');

    if (!existingRecord) {
      log('Would Create History', `Membership history record for ${nextYear.label}: tier "${tierLabel}", final cost ${finalCost.toFixed(2)} ${config.currency || 'GBP'}${overrideApplied ? ' (with override)' : ''}`);
      log('Would Create Note', `Organisation note documenting the ${mode} renewal`);
      log('Would Generate Invoice', `Invoice for ${finalCost.toFixed(2)} ${config.currency || 'GBP'} via Xero${mode === 'scheduled' ? ` on scheduled date` : ''}`, 'info');
    } else {
      log('Would Be Blocked', `A record for ${nextYear.label} already exists (final cost: ${existingRecord.final_cost}). Real renewal would be rejected.`, 'warning');
    }

    log('Complete', `Simulation finished for "${mode}" mode`);

    return res.json({
      success: true,
      mode,
      organization: org.name,
      membershipYear: nextYear.label,
      tierLabel,
      finalCost,
      currency: config.currency || 'GBP',
      overrideApplied,
      steps,
    });
  } catch (error) {
    console.error('[Simulate Renewal] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function getCurrentConfig(tenantId) {
  const { data } = await supabase
    .from('membership_tier_config')
    .select('*')
    .eq('tenant_id', tenantId)
    .is('effective_to', null)
    .order('effective_from', { ascending: false, nullsFirst: true })
    .limit(1)
    .maybeSingle();
  return data;
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
  let freeMonths = 0;
  if (unit === 'months') freeMonths = amount;
  else if (unit === 'weeks') freeMonths = amount / 4.33;
  else if (unit === 'days') freeMonths = amount / 30.44;
  return parseFloat((annualCost * freeMonths / 12).toFixed(2));
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
