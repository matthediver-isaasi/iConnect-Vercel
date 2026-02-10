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

    const currency = config.currency || 'GBP';
    const scheduleStartDate = formatDate(nextYear.start) + ' at 00:00';
    const scheduledInvoiceDate = invoicingSettings?.invoice_date ? formatDate(new Date(invoicingSettings.invoice_date)) + ' at 00:00' : null;
    const nowFormatted = formatDate(new Date(), true);

    const { data: accountCodeSetting } = await supabase
      .from('system_settings')
      .select('setting_value')
      .eq('setting_key', 'xero_sales_account_code')
      .eq('tenant_id', tenantId)
      .maybeSingle();
    const xeroAccountCode = accountCodeSetting?.setting_value || '200';

    const { data: invoiceStatusSetting } = await supabase
      .from('system_settings')
      .select('setting_value')
      .eq('setting_key', 'xero_invoice_status')
      .eq('tenant_id', tenantId)
      .maybeSingle();
    const xeroInvoiceStatus = invoiceStatusSetting?.setting_value || 'DRAFT';

    const { data: vatRateSetting } = await supabase
      .from('system_settings')
      .select('setting_value')
      .eq('setting_key', 'xero_membership_vat_rate')
      .eq('tenant_id', tenantId)
      .maybeSingle();
    let taxType = null;
    let taxLabel = null;
    if (vatRateSetting?.setting_value) {
      try {
        const parsed = JSON.parse(vatRateSetting.setting_value);
        taxType = parsed.taxType || null;
        taxLabel = parsed.name || null;
      } catch {
        taxType = vatRateSetting.setting_value;
        taxLabel = vatRateSetting.setting_value;
      }
    }

    log('Xero Settings', `Account code: ${xeroAccountCode}, Invoice status: ${xeroInvoiceStatus}, VAT: ${taxLabel ? `${taxLabel} (${taxType})` : 'Not set (no VAT applied)'}`);

    if (mode === 'automatic') {
      log('Mode: Automatic', `Both renewal and invoicing happen together on the membership schedule start date`);
      log(`Step 1 - Renew (${scheduleStartDate})`, `Create membership history record for ${nextYear.label} with final cost ${finalCost.toFixed(2)} ${currency}`);
      log(`Step 2 - Invoice (${scheduleStartDate})`, `Generate and send invoice for ${finalCost.toFixed(2)} ${currency} via Xero`);
      log(`Step 3 - Note (${scheduleStartDate})`, `Add organisation note documenting the automatic renewal`);
    } else if (mode === 'scheduled') {
      log('Mode: Scheduled', `Renewal happens at schedule start, invoicing on a separate scheduled date`);
      log(`Step 1 - Renew (${scheduleStartDate})`, `Create membership history record for ${nextYear.label} with final cost ${finalCost.toFixed(2)} ${currency}`);
      if (scheduledInvoiceDate) {
        log(`Step 2 - Invoice (${scheduledInvoiceDate})`, `Generate and send invoice for ${finalCost.toFixed(2)} ${currency} via Xero on ${scheduledInvoiceDate}`);
      } else {
        log('Step 2 - Invoice (date not set)', `No invoice date has been saved. Scheduled mode requires a date.`, 'warning');
      }
      log(`Step 3 - Note (${scheduleStartDate})`, `Add organisation note documenting the renewal and scheduled invoice date`);
    } else if (mode === 'manual') {
      log('Mode: Manual', `Admin triggers renewal manually via the "Renew & Invoice Now" button`);
      log(`Step 1 - Renew (${nowFormatted} - when clicked)`, `Create membership history record for ${nextYear.label} with final cost ${finalCost.toFixed(2)} ${currency}`);
      log(`Step 2 - Invoice (${nowFormatted} - when clicked)`, `Generate and send invoice for ${finalCost.toFixed(2)} ${currency} via Xero immediately`);
      log(`Step 3 - Note (${nowFormatted} - when clicked)`, `Add organisation note documenting the manual renewal`);
    }

    log('Dry Run Summary', 'This is a dry run - no records were created or modified', 'info');

    const invoiceDescription = `Membership subscription for ${nextYear.label}.\nTier: ${tierLabel || 'Standard'}\nFee: ${currency} ${finalCost.toFixed(2)}`;
    const invoiceReference = `Membership ${nextYear.label}`;
    const invoiceDueDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const lineItem = {
      description: invoiceDescription,
      quantity: 1,
      unitAmount: finalCost.toFixed(2),
      accountCode: xeroAccountCode,
    };
    if (taxType) {
      lineItem.taxType = taxType;
      lineItem.taxLabel = taxLabel;
    }

    const invoicePreview = {
      contact: org.name,
      reference: invoiceReference,
      status: xeroInvoiceStatus,
      dueDate: invoiceDueDate,
      lineItems: [lineItem]
    };

    if (!existingRecord) {
      log('Would Create History', `Membership history record for ${nextYear.label}: tier "${tierLabel}", final cost ${finalCost.toFixed(2)} ${currency}${overrideApplied ? ' (with override)' : ''}`);
      log('Would Create Note', `Organisation note documenting the ${mode} renewal with invoice details`);
      log('Invoice Preview - Contact', `${org.name}`);
      log('Invoice Preview - Reference', invoiceReference);
      log('Invoice Preview - Status', xeroInvoiceStatus);
      log('Invoice Preview - Due Date', `${invoiceDueDate} (30 days from invoice creation date)`);
      log('Invoice Preview - Line Description', invoiceDescription.replace(/\n/g, ' | '));
      log('Invoice Preview - Quantity', '1');
      log('Invoice Preview - Unit Amount', `${currency} ${finalCost.toFixed(2)}`);
      log('Invoice Preview - Account Code', xeroAccountCode);
      log('Invoice Preview - VAT / Tax Type', taxLabel ? `${taxLabel} (${taxType})` : 'Not set (no VAT will be applied)');
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
      invoicePreview: !existingRecord ? invoicePreview : null,
      steps,
    });
  } catch (error) {
    console.error('[Simulate Renewal] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

function formatDate(date, includeTime = false) {
  if (!date || !(date instanceof Date) || isNaN(date.getTime())) return 'Unknown';
  const datePart = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  if (!includeTime) return datePart;
  const timePart = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${datePart} at ${timePart}`;
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
