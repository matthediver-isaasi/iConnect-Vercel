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
    } else if (req.method === 'POST') {
      return handlePost(req, res, tenantId);
    } else if (req.method === 'PUT') {
      return handlePut(req, res, tenantId);
    } else if (req.method === 'DELETE') {
      return handleDelete(req, res, tenantId);
    } else {
      return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('[Membership Tiers] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function handleGet(req, res, tenantId) {
  const { action, configId } = req.query;

  if (action === 'fields') {
    return getAvailableFields(req, res, tenantId);
  }

  if (action === 'discount_fields') {
    return getDiscountFields(req, res, tenantId);
  }

  if (action === 'structure_fields') {
    return getStructureFields(req, res, tenantId);
  }

  if (action === 'preview') {
    return getPreview(req, res, tenantId, configId);
  }

  if (action === 'history') {
    return getHistory(req, res, tenantId);
  }

  if (configId) {
    return getConfigById(req, res, tenantId, configId);
  }

  const { data: activeConfigs } = await supabase
    .from('membership_tier_config')
    .select('*')
    .eq('tenant_id', tenantId)
    .is('effective_to', null)
    .order('effective_from', { ascending: false, nullsFirst: true });

  const configs = activeConfigs || [];
  const firstConfig = configs[0] || null;

  let bands = [];
  let discounts = [];
  if (firstConfig) {
    bands = await getBandsForConfig(firstConfig.id, tenantId);
    discounts = await getDiscountsForConfig(firstConfig.id, tenantId);
  }

  const { data: allConfigs } = await supabase
    .from('membership_tier_config')
    .select('id, name, effective_from, effective_to, created_at, structure_field_id, structure_match_value')
    .eq('tenant_id', tenantId)
    .order('effective_from', { ascending: false, nullsFirst: true });

  return res.json({
    config: firstConfig,
    bands,
    discounts,
    activeConfigs: configs,
    history: allConfigs || []
  });
}

async function getCurrentConfig(tenantId) {
  const { data: current, error } = await supabase
    .from('membership_tier_config')
    .select('*')
    .eq('tenant_id', tenantId)
    .is('effective_to', null)
    .order('effective_from', { ascending: false, nullsFirst: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('[Membership Tiers] Error fetching current config:', error);
    return null;
  }
  return current;
}

async function getBandsForConfig(configId, tenantId) {
  const { data: bandsData, error } = await supabase
    .from('membership_tier_band')
    .select('*')
    .eq('config_id', configId)
    .eq('tenant_id', tenantId)
    .order('min_value', { ascending: true });

  if (error) {
    console.error('[Membership Tiers] Error fetching bands:', error);
    return [];
  }
  return bandsData || [];
}

async function getConfigById(req, res, tenantId, configId) {
  const { data: config, error: configError } = await supabase
    .from('membership_tier_config')
    .select('*')
    .eq('id', configId)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (configError || !config) {
    return res.status(404).json({ error: 'Configuration not found' });
  }

  const bands = await getBandsForConfig(config.id, tenantId);
  const discounts = await getDiscountsForConfig(config.id, tenantId);

  return res.json({
    config,
    bands,
    discounts,
    isHistorical: config.effective_to !== null
  });
}

async function getHistory(req, res, tenantId) {
  const { data: configs, error } = await supabase
    .from('membership_tier_config')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('effective_from', { ascending: false, nullsFirst: true });

  if (error) {
    console.error('[Membership Tiers] Error fetching history:', error);
    return res.status(500).json({ error: 'Failed to fetch history' });
  }

  const results = [];
  for (const config of (configs || [])) {
    const bands = await getBandsForConfig(config.id, tenantId);
    const discounts = await getDiscountsForConfig(config.id, tenantId);
    results.push({
      config,
      bands,
      discounts,
      isHistorical: config.effective_to !== null
    });
  }

  return res.json(results);
}

async function getAvailableFields(req, res, tenantId) {
  const { data: fields, error } = await supabase
    .from('preference_field')
    .select('id, name, label, field_type, entity_scope')
    .eq('tenant_id', tenantId)
    .eq('entity_scope', 'organization')
    .eq('is_active', true)
    .order('display_order', { ascending: true });

  if (error) {
    console.error('[Membership Tiers] Error fetching fields:', error);
    return res.status(500).json({ error: 'Failed to fetch fields' });
  }

  const numericalFields = (fields || []).filter(f =>
    ['number', 'integer', 'decimal', 'numeric', 'currency'].includes(f.field_type?.toLowerCase())
  );

  const coreNumericalFields = [
    { id: 'core:member_count', name: 'member_count', label: 'Member Count', field_type: 'number', entity_scope: 'organization', is_core: true }
  ];

  return res.json([...coreNumericalFields, ...numericalFields]);
}

async function getPreview(req, res, tenantId, configId) {
  let config;

  if (configId) {
    const { data, error } = await supabase
      .from('membership_tier_config')
      .select('*')
      .eq('id', configId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (error || !data) {
      return res.json({ organizations: [], unmapped: [] });
    }
    config = data;
  } else {
    config = await getCurrentConfig(tenantId);
    if (!config) {
      return res.json({ organizations: [], unmapped: [] });
    }
  }

  const bands = await getBandsForConfig(config.id, tenantId);

  const { data: allOrgs, error: orgError } = await supabase
    .from('organization')
    .select('id, name, status')
    .eq('tenant_id', tenantId)
    .order('name', { ascending: true });

  if (orgError) {
    return res.status(500).json({ error: 'Failed to fetch organizations' });
  }

  let orgs = allOrgs || [];

  if (config.structure_field_id && config.structure_match_value) {
    const allOrgIds = orgs.map(o => o.id);
    const { data: scopeValues } = await supabase
      .from('organization_preference_value')
      .select('organization_id, value')
      .eq('field_id', config.structure_field_id)
      .in('organization_id', allOrgIds.length > 0 ? allOrgIds : ['__none__']);

    const matchingOrgIds = new Set(
      (scopeValues || [])
        .filter(pv => pv.value === config.structure_match_value)
        .map(pv => pv.organization_id)
    );
    orgs = orgs.filter(o => matchingOrgIds.has(o.id));
  }

  const isFlat = config.pricing_model === 'flat';
  const flatCost = isFlat ? parseFloat(config.flat_cost) || 0 : null;

  let orgValues = {};

  if (!isFlat) {
    if (config.field_source === 'core' && config.field_name === 'member_count') {
      const { data: members } = await supabase
        .from('member')
        .select('organization_id')
        .eq('tenant_id', tenantId)
        .not('organization_id', 'is', null);

      const counts = {};
      (members || []).forEach(m => {
        counts[m.organization_id] = (counts[m.organization_id] || 0) + 1;
      });
      orgValues = counts;
    } else if (config.field_id) {
      const orgIds = (orgs || []).map(o => o.id);
      const { data: prefValues } = await supabase
        .from('organization_preference_value')
        .select('organization_id, value')
        .eq('field_id', config.field_id)
        .in('organization_id', orgIds.length > 0 ? orgIds : ['__none__']);

      (prefValues || []).forEach(pv => {
        const numVal = parseFloat(pv.value);
        if (!isNaN(numVal)) {
          orgValues[pv.organization_id] = numVal;
        }
      });
    }
  }

  const results = (orgs || []).map(org => {
    if (isFlat) {
      return {
        id: org.id,
        name: org.name,
        status: org.status,
        fieldValue: null,
        tierLabel: 'Flat Rate',
        annualCost: flatCost,
        bandId: 'flat'
      };
    }

    const fieldValue = orgValues[org.id] ?? null;
    let matchedBand = null;

    if (fieldValue !== null && bands?.length > 0) {
      for (const band of bands) {
        const min = parseFloat(band.min_value);
        const max = band.max_value !== null ? parseFloat(band.max_value) : Infinity;
        if (fieldValue >= min && fieldValue <= max) {
          matchedBand = band;
          break;
        }
      }
    }

    return {
      id: org.id,
      name: org.name,
      status: org.status,
      fieldValue,
      tierLabel: matchedBand?.label || null,
      annualCost: matchedBand ? parseFloat(matchedBand.annual_cost) : null,
      bandId: matchedBand?.id || null
    };
  });

  const mapped = results.filter(r => r.bandId);
  const unmapped = results.filter(r => !r.bandId);

  return res.json({
    config,
    bands: bands || [],
    organizations: mapped,
    unmapped,
    summary: {
      totalOrgs: results.length,
      mappedOrgs: mapped.length,
      unmappedOrgs: unmapped.length,
      totalAnnualRevenue: mapped.reduce((sum, r) => sum + (r.annualCost || 0), 0)
    }
  });
}

function validateBands(bands) {
  if (!bands || !Array.isArray(bands) || bands.length === 0) return null;

  const sortedBands = [...bands].sort((a, b) => (parseFloat(a.min_value) || 0) - (parseFloat(b.min_value) || 0));
  for (let i = 0; i < sortedBands.length; i++) {
    const band = sortedBands[i];
    const min = parseFloat(band.min_value);
    const max = band.max_value !== null && band.max_value !== undefined && band.max_value !== '' ? parseFloat(band.max_value) : null;

    if (isNaN(min)) {
      return { error: `Tier "${band.label || i + 1}" has an invalid minimum value` };
    }
    if (max !== null && isNaN(max)) {
      return { error: `Tier "${band.label || i + 1}" has an invalid maximum value` };
    }
    if (max !== null && max < min) {
      return { error: `Tier "${band.label || i + 1}" has max value less than min value` };
    }

    if (i > 0) {
      const prevBand = sortedBands[i - 1];
      const prevMax = prevBand.max_value !== null && prevBand.max_value !== undefined && prevBand.max_value !== ''
        ? parseFloat(prevBand.max_value) : null;
      if (prevMax === null) {
        return { error: `Tier "${prevBand.label || i}" has no maximum value (open-ended), so no further tiers can follow it. Set a max value or remove subsequent tiers.` };
      }
      if (min <= prevMax) {
        return { error: `Tier "${band.label || i + 1}" overlaps with the previous tier. Min value (${min}) should be greater than previous max (${prevMax}).` };
      }
    }
  }
  return { sortedBands };
}

async function handlePost(req, res, tenantId) {
  let { config, bands, discounts } = req.body;

  if (!config) {
    return res.status(400).json({ error: 'Configuration is required' });
  }

  if (!config.effective_from) {
    return res.status(400).json({ error: 'Effective from date is required' });
  }

  if (config.structure_field_id && !config.structure_match_value?.trim()) {
    return res.status(400).json({ error: 'Match value is required when a structure scope field is selected' });
  }

  const today = new Date().toISOString().split('T')[0];
  const configId_check = config.id || req.query.configId;
  if (!configId_check && config.effective_from > today) {
    return res.status(400).json({ error: 'Effective from date cannot be in the future. New tier structures take effect from today or a past date.' });
  }

  if (bands && Array.isArray(bands) && bands.length > 0) {
    const validation = validateBands(bands);
    if (validation?.error) {
      return res.status(400).json({ error: validation.error });
    }
    bands = validation.sortedBands;
  }

  const configId = config.id || req.query.configId;

  if (configId) {
    const { data: existingConfig } = await supabase
      .from('membership_tier_config')
      .select('*')
      .eq('id', configId)
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (!existingConfig) {
      return res.status(404).json({ error: 'Configuration not found' });
    }

    if (existingConfig.effective_to !== null) {
      return res.status(400).json({ error: 'Cannot modify a historical tier structure. Create a new one instead.' });
    }

    const { data, error } = await supabase
      .from('membership_tier_config')
      .update({
        name: config.name || 'Default',
        field_source: config.field_source || 'custom',
        field_id: config.field_id || null,
        field_name: config.field_name || null,
        currency: config.currency || 'GBP',
        billing_period: config.billing_period || 'annual',
        is_active: config.is_active !== false,
        effective_from: config.effective_from,
        membership_start_month: config.membership_start_month ?? 1,
        membership_start_day: config.membership_start_day ?? 1,
        prorata_enabled: config.prorata_enabled ?? false,
        free_period_amount: config.free_period_amount || null,
        free_period_unit: config.free_period_amount ? (config.free_period_unit || 'months') : null,
        rollover_enabled: config.free_period_amount ? (config.rollover_enabled ?? false) : false,
        structure_field_id: config.structure_field_id || null,
        structure_match_value: config.structure_match_value || null,
        pricing_model: config.pricing_model || 'tiered',
        flat_cost: config.pricing_model === 'flat' ? (parseFloat(config.flat_cost) || 0) : null,
        updated_at: new Date().toISOString()
      })
      .eq('id', configId)
      .eq('tenant_id', tenantId)
      .select()
      .single();

    if (error) {
      console.error('[Membership Tiers] Error updating config:', error);
      return res.status(500).json({ error: 'Failed to update configuration' });
    }

    if (bands && Array.isArray(bands)) {
      await saveBandsForConfig(data.id, tenantId, bands);
    }

    if (discounts && Array.isArray(discounts)) {
      await saveDiscountsForConfig(data.id, tenantId, discounts);
    }

    const savedBands = await getBandsForConfig(data.id, tenantId);
    const savedDiscounts = await getDiscountsForConfig(data.id, tenantId);
    return res.json({ config: data, bands: savedBands, discounts: savedDiscounts });
  }

  const structureFieldId = config.structure_field_id || null;
  const structureMatchValue = config.structure_match_value || null;

  let matchQuery = supabase
    .from('membership_tier_config')
    .select('*')
    .eq('tenant_id', tenantId)
    .is('effective_to', null);

  if (structureFieldId) {
    matchQuery = matchQuery.eq('structure_field_id', structureFieldId).eq('structure_match_value', structureMatchValue);
  } else {
    matchQuery = matchQuery.is('structure_field_id', null);
  }

  const { data: matchingConfigs } = await matchQuery.order('effective_from', { ascending: false, nullsFirst: true });
  const currentConfig = matchingConfigs?.[0] || null;

  if (currentConfig) {
    const newEffectiveFrom = new Date(config.effective_from);

    if (currentConfig.effective_from) {
      const currentFrom = new Date(currentConfig.effective_from);
      if (newEffectiveFrom <= currentFrom) {
        return res.status(400).json({
          error: `New tier structure must start after the current one (${currentConfig.effective_from}). Please choose a later date.`
        });
      }
    }

    const prevDay = new Date(newEffectiveFrom);
    prevDay.setDate(prevDay.getDate() - 1);
    const closingDate = prevDay.toISOString().split('T')[0];

    const { error: closeError } = await supabase
      .from('membership_tier_config')
      .update({
        effective_to: closingDate,
        updated_at: new Date().toISOString()
      })
      .eq('id', currentConfig.id)
      .eq('tenant_id', tenantId);

    if (closeError) {
      console.error('[Membership Tiers] Error closing previous config:', closeError);
      return res.status(500).json({ error: 'Failed to close previous tier structure' });
    }
  }

  const { data: newConfig, error: createError } = await supabase
    .from('membership_tier_config')
    .insert({
      tenant_id: tenantId,
      name: config.name || 'Default',
      field_source: config.field_source || 'custom',
      field_id: config.field_id || null,
      field_name: config.field_name || null,
      currency: config.currency || 'GBP',
      billing_period: config.billing_period || 'annual',
      is_active: config.is_active !== false,
      effective_from: config.effective_from,
      effective_to: null,
      membership_start_month: config.membership_start_month ?? 1,
      membership_start_day: config.membership_start_day ?? 1,
      prorata_enabled: config.prorata_enabled ?? false,
      free_period_amount: config.free_period_amount || null,
      free_period_unit: config.free_period_amount ? (config.free_period_unit || 'months') : null,
      rollover_enabled: config.free_period_amount ? (config.rollover_enabled ?? false) : false,
      structure_field_id: structureFieldId,
      structure_match_value: structureMatchValue,
      pricing_model: config.pricing_model || 'tiered',
      flat_cost: config.pricing_model === 'flat' ? (parseFloat(config.flat_cost) || 0) : null,
    })
    .select()
    .single();

  if (createError) {
    console.error('[Membership Tiers] Error creating config:', createError);
    if (currentConfig) {
      await supabase
        .from('membership_tier_config')
        .update({ effective_to: null, updated_at: new Date().toISOString() })
        .eq('id', currentConfig.id)
        .eq('tenant_id', tenantId);
    }
    return res.status(500).json({ error: 'Failed to create configuration' });
  }

  if (bands && Array.isArray(bands) && bands.length > 0) {
    await saveBandsForConfig(newConfig.id, tenantId, bands);
  }

  if (discounts && Array.isArray(discounts) && discounts.length > 0) {
    await saveDiscountsForConfig(newConfig.id, tenantId, discounts);
  }

  const savedBands = await getBandsForConfig(newConfig.id, tenantId);
  const savedDiscounts = await getDiscountsForConfig(newConfig.id, tenantId);

  const { data: allConfigs } = await supabase
    .from('membership_tier_config')
    .select('id, name, effective_from, effective_to, created_at')
    .eq('tenant_id', tenantId)
    .order('effective_from', { ascending: false, nullsFirst: true });

  return res.json({
    config: newConfig,
    bands: savedBands,
    discounts: savedDiscounts,
    history: allConfigs || []
  });
}

async function checkVatRateColumnExists() {
  const { data, error } = await supabase
    .from('membership_tier_band')
    .select('vat_rate')
    .limit(0);
  return !error;
}

async function saveBandsForConfig(configId, tenantId, bands) {
  if (bands.length === 0) {
    const { error: deleteError } = await supabase
      .from('membership_tier_band')
      .delete()
      .eq('config_id', configId)
      .eq('tenant_id', tenantId);
    if (deleteError) {
      console.error('[Membership Tiers] Error clearing bands:', deleteError);
    }
    return;
  }

  const hasVatColumn = await checkVatRateColumnExists();

  const bandsToInsert = bands.map((band, index) => {
    const row = {
      config_id: configId,
      tenant_id: tenantId,
      label: band.label || `Tier ${index + 1}`,
      min_value: band.min_value ?? 0,
      max_value: band.max_value ?? null,
      annual_cost: band.annual_cost ?? 0,
      display_order: index,
    };
    if (hasVatColumn) {
      row.vat_rate = band.vat_rate || null;
    }
    return row;
  });

  const { error: deleteError } = await supabase
    .from('membership_tier_band')
    .delete()
    .eq('config_id', configId)
    .eq('tenant_id', tenantId);

  if (deleteError) {
    console.error('[Membership Tiers] Error clearing bands:', deleteError);
  }

  const { error: insertError } = await supabase
    .from('membership_tier_band')
    .insert(bandsToInsert);

  if (insertError) {
    console.error('[Membership Tiers] Error inserting bands:', insertError);
  }
}

async function handlePut(req, res, tenantId) {
  return handlePost(req, res, tenantId);
}

async function handleDelete(req, res, tenantId) {
  const { bandId, configId } = req.query;

  if (bandId) {
    const { error } = await supabase
      .from('membership_tier_band')
      .delete()
      .eq('id', bandId)
      .eq('tenant_id', tenantId);

    if (error) {
      console.error('[Membership Tiers] Error deleting band:', error);
      return res.status(500).json({ error: 'Failed to delete band' });
    }
    return res.json({ success: true });
  }

  if (configId) {
    const { data: config } = await supabase
      .from('membership_tier_config')
      .select('id, effective_to')
      .eq('id', configId)
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (!config) {
      return res.status(404).json({ error: 'Configuration not found' });
    }

    await supabase
      .from('membership_tier_band')
      .delete()
      .eq('config_id', config.id)
      .eq('tenant_id', tenantId);

    await deleteDiscountsForConfig(config.id, tenantId);

    await supabase
      .from('membership_tier_config')
      .delete()
      .eq('id', config.id)
      .eq('tenant_id', tenantId);

    if (config.effective_to === null) {
      const { data: prevConfig } = await supabase
        .from('membership_tier_config')
        .select('id')
        .eq('tenant_id', tenantId)
        .not('id', 'eq', config.id)
        .order('effective_from', { ascending: false, nullsFirst: true })
        .limit(1)
        .maybeSingle();

      if (prevConfig) {
        await supabase
          .from('membership_tier_config')
          .update({ effective_to: null, updated_at: new Date().toISOString() })
          .eq('id', prevConfig.id)
          .eq('tenant_id', tenantId);
      }
    }

    return res.json({ success: true });
  }

  const config = await getCurrentConfig(tenantId);

  if (config) {
    await supabase
      .from('membership_tier_band')
      .delete()
      .eq('config_id', config.id);

    await supabase
      .from('membership_tier_config')
      .delete()
      .eq('id', config.id)
      .eq('tenant_id', tenantId);
  }

  return res.json({ success: true });
}

async function getDiscountsForConfig(configId, tenantId) {
  try {
    const { data, error } = await supabase
      .from('membership_tier_discount')
      .select('*')
      .eq('config_id', configId)
      .eq('tenant_id', tenantId)
      .order('sort_order', { ascending: true });

    if (error) {
      console.error('[Membership Tiers] Error fetching discounts:', error);
      return [];
    }
    return data || [];
  } catch {
    return [];
  }
}

async function saveDiscountsForConfig(configId, tenantId, discounts) {
  try {
    await deleteDiscountsForConfig(configId, tenantId);

    if (!discounts || discounts.length === 0) return;

    const rows = discounts.map((d, index) => ({
      config_id: configId,
      tenant_id: tenantId,
      field_id: d.field_id,
      field_label: d.field_label || null,
      match_value: d.match_value || '',
      discount_type: d.discount_type || 'percentage',
      discount_value: parseFloat(d.discount_value) || 0,
      label: d.label || null,
      sort_order: index,
    }));

    const { error } = await supabase
      .from('membership_tier_discount')
      .insert(rows);

    if (error) {
      console.error('[Membership Tiers] Error saving discounts:', error);
    }
  } catch (err) {
    console.error('[Membership Tiers] Error saving discounts:', err);
  }
}

async function deleteDiscountsForConfig(configId, tenantId) {
  try {
    await supabase
      .from('membership_tier_discount')
      .delete()
      .eq('config_id', configId)
      .eq('tenant_id', tenantId);
  } catch {}
}

async function getStructureFields(req, res, tenantId) {
  const { data: fields, error } = await supabase
    .from('preference_field')
    .select('id, name, label, field_type, entity_scope, options')
    .eq('tenant_id', tenantId)
    .eq('entity_scope', 'organization')
    .eq('is_active', true)
    .order('display_order', { ascending: true });

  if (error) {
    console.error('[Membership Tiers] Error fetching structure fields:', error);
    return res.status(500).json({ error: 'Failed to fetch fields' });
  }

  return res.json(fields || []);
}

async function getDiscountFields(req, res, tenantId) {
  const { data: fields, error } = await supabase
    .from('preference_field')
    .select('id, name, label, field_type, entity_scope, options')
    .eq('tenant_id', tenantId)
    .eq('entity_scope', 'organization')
    .eq('is_active', true)
    .order('display_order', { ascending: true });

  if (error) {
    console.error('[Membership Tiers] Error fetching discount fields:', error);
    return res.status(500).json({ error: 'Failed to fetch fields' });
  }

  return res.json(fields || []);
}
