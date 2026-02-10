import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

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
      return handlePut(req, res, tenantId, tenantContext);
    } else if (req.method === 'POST') {
      return handleManualRenewal(req, res, tenantId, tenantContext);
    } else {
      return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('[Org Membership Invoicing] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function handleGet(req, res, tenantId) {
  const { organizationId } = req.query;

  if (!organizationId) {
    return res.status(400).json({ error: 'organizationId is required' });
  }

  try {
    const { data, error } = await supabase
      .from('organisation_membership_invoicing')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) {
      if (error.code === '42P01') {
        return res.json({ invoicing_mode: 'manual', invoice_date: null });
      }
      console.error('[Invoicing] Error fetching settings:', error);
      return res.status(500).json({ error: 'Failed to fetch invoicing settings' });
    }

    return res.json(data || { invoicing_mode: 'manual', invoice_date: null });
  } catch (err) {
    return res.json({ invoicing_mode: 'manual', invoice_date: null });
  }
}

async function handlePut(req, res, tenantId, tenantContext) {
  const { organizationId, invoicingMode, invoiceDate } = req.body;

  if (!organizationId) {
    return res.status(400).json({ error: 'organizationId is required' });
  }

  if (!invoicingMode || !['automatic', 'scheduled', 'manual'].includes(invoicingMode)) {
    return res.status(400).json({ error: 'invoicingMode must be "automatic", "scheduled", or "manual"' });
  }

  if (invoicingMode === 'scheduled' && !invoiceDate) {
    return res.status(400).json({ error: 'invoice_date is required when invoicing mode is "scheduled"' });
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

  const { data: existing } = await supabase
    .from('organisation_membership_invoicing')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('organization_id', organizationId)
    .maybeSingle();

  const invoicingData = {
    tenant_id: tenantId,
    organization_id: organizationId,
    invoicing_mode: invoicingMode,
    invoice_date: invoicingMode === 'scheduled' ? invoiceDate : null,
    updated_at: new Date().toISOString(),
  };

  let result;
  if (existing) {
    const { data, error } = await supabase
      .from('organisation_membership_invoicing')
      .update(invoicingData)
      .eq('id', existing.id)
      .select()
      .single();

    if (error) {
      console.error('[Invoicing] Error updating settings:', error);
      return res.status(500).json({ error: 'Failed to update invoicing settings' });
    }
    result = data;
  } else {
    const { data, error } = await supabase
      .from('organisation_membership_invoicing')
      .insert(invoicingData)
      .select()
      .single();

    if (error) {
      console.error('[Invoicing] Error creating settings:', error);
      return res.status(500).json({ error: 'Failed to create invoicing settings' });
    }
    result = data;
  }

  return res.json(result);
}

async function getCurrentConfig(tenantId) {
  const { data, error } = await supabase
    .from('membership_tier_config')
    .select('*')
    .eq('tenant_id', tenantId)
    .is('effective_to', null)
    .order('effective_from', { ascending: false, nullsFirst: true })
    .limit(1)
    .maybeSingle();

  if (error) return null;
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

async function handleManualRenewal(req, res, tenantId, tenantContext) {
  const { organizationId } = req.body;

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

  const config = await getCurrentConfig(tenantId);
  if (!config) {
    return res.status(400).json({ error: 'No active tier configuration found' });
  }

  const nextYear = calculateNextMembershipYear(config);
  const bands = await getBandsForConfig(config.id, tenantId);
  const fieldValue = await getOrgFieldValue(organizationId, tenantId, config);

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

  let matchedBand = matchBand(fieldValue, bands);
  let annualCost = matchedBand ? parseFloat(matchedBand.annual_cost) : null;
  let tierLabel = matchedBand?.label || null;
  let finalCost = annualCost;
  let freeDiscount = 0;
  let rolloverDiscount = 0;
  let usedConfigId = config.id;
  let usedBandId = matchedBand?.id || null;

  if (annualCost !== null) {
    freeDiscount = calculateFreePeriodDiscount(annualCost, config);
    finalCost = annualCost - freeDiscount;
  }

  if (override) {
    if (override.override_type === 'price' && override.manual_price !== null) {
      annualCost = parseFloat(override.manual_price);
      finalCost = annualCost;
      freeDiscount = 0;
      rolloverDiscount = 0;
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
        }
      }
    }
  }

  if (annualCost === null) {
    return res.status(400).json({ error: 'Organisation does not match any tier band' });
  }

  const { data: existing } = await supabase
    .from('organisation_membership_history')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('organization_id', organizationId)
    .eq('membership_year', nextYear.label)
    .maybeSingle();

  if (existing) {
    return res.status(400).json({ error: `A membership record for ${nextYear.label} already exists` });
  }

  const { data: record, error: insertError } = await supabase
    .from('organisation_membership_history')
    .insert({
      tenant_id: tenantId,
      organization_id: organizationId,
      membership_year: nextYear.label,
      config_id: usedConfigId,
      band_id: usedBandId,
      tier_label: tierLabel,
      field_value: fieldValue,
      annual_cost: annualCost,
      prorata_cost: null,
      free_period_discount: freeDiscount,
      rollover_discount: rolloverDiscount,
      final_cost: finalCost,
      currency: config.currency || 'GBP',
      billing_period: config.billing_period || 'annual',
      status: 'active',
      notes: 'Manual renewal via invoicing action',
    })
    .select()
    .single();

  if (insertError) {
    console.error('[Invoicing] Error creating history record:', insertError);
    return res.status(500).json({ error: 'Failed to create membership record' });
  }

  try {
    const noteCreatorId = tenantContext.memberId || tenantContext.tenantUserId || null;
    await supabase
      .from('organization_note')
      .insert({
        organization_id: organizationId,
        member_id: noteCreatorId,
        content: `[Membership Renewal - Manual] Membership renewed for ${nextYear.label}. Fee: ${config.currency || 'GBP'} ${finalCost.toFixed(2)}. Invoice generated.`,
        attachments: []
      });
  } catch (noteErr) {
    console.error('[Invoicing] Failed to create note (non-fatal):', noteErr);
  }

  return res.json({
    success: true,
    record,
    message: `Membership renewed for ${nextYear.label}. Fee: ${finalCost.toFixed(2)}.`
  });
}

async function getConfigById(configId, tenantId) {
  const { data, error } = await supabase
    .from('membership_tier_config')
    .select('*')
    .eq('id', configId)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (error) return null;
  return data;
}
