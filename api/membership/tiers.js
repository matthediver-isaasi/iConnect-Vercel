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
  const { action } = req.query;

  if (action === 'fields') {
    return getAvailableFields(req, res, tenantId);
  }

  if (action === 'preview') {
    return getPreview(req, res, tenantId);
  }

  const { data: config, error: configError } = await supabase
    .from('membership_tier_config')
    .select('*')
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (configError) {
    console.error('[Membership Tiers] Error fetching config:', configError);
    return res.status(500).json({ error: 'Failed to fetch configuration' });
  }

  let bands = [];
  if (config) {
    const { data: bandsData, error: bandsError } = await supabase
      .from('membership_tier_band')
      .select('*')
      .eq('config_id', config.id)
      .eq('tenant_id', tenantId)
      .order('min_value', { ascending: true });

    if (bandsError) {
      console.error('[Membership Tiers] Error fetching bands:', bandsError);
      return res.status(500).json({ error: 'Failed to fetch tier bands' });
    }
    bands = bandsData || [];
  }

  return res.json({
    config: config || null,
    bands
  });
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

async function getPreview(req, res, tenantId) {
  const { data: config, error: configError } = await supabase
    .from('membership_tier_config')
    .select('*')
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (configError || !config) {
    return res.json({ organizations: [], unmapped: [] });
  }

  const { data: bands, error: bandsError } = await supabase
    .from('membership_tier_band')
    .select('*')
    .eq('config_id', config.id)
    .eq('tenant_id', tenantId)
    .order('min_value', { ascending: true });

  if (bandsError) {
    return res.status(500).json({ error: 'Failed to fetch bands' });
  }

  const { data: orgs, error: orgError } = await supabase
    .from('organization')
    .select('id, name, status')
    .eq('tenant_id', tenantId)
    .order('name', { ascending: true });

  if (orgError) {
    return res.status(500).json({ error: 'Failed to fetch organizations' });
  }

  let orgValues = {};

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

  const results = (orgs || []).map(org => {
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

async function handlePost(req, res, tenantId) {
  let { config, bands } = req.body;

  if (!config) {
    return res.status(400).json({ error: 'Configuration is required' });
  }

  if (bands && Array.isArray(bands) && bands.length > 0) {
    const sortedBands = [...bands].sort((a, b) => (parseFloat(a.min_value) || 0) - (parseFloat(b.min_value) || 0));
    for (let i = 0; i < sortedBands.length; i++) {
      const band = sortedBands[i];
      const min = parseFloat(band.min_value);
      const max = band.max_value !== null && band.max_value !== undefined && band.max_value !== '' ? parseFloat(band.max_value) : null;

      if (isNaN(min)) {
        return res.status(400).json({ error: `Tier "${band.label || i + 1}" has an invalid minimum value` });
      }
      if (max !== null && isNaN(max)) {
        return res.status(400).json({ error: `Tier "${band.label || i + 1}" has an invalid maximum value` });
      }
      if (max !== null && max < min) {
        return res.status(400).json({ error: `Tier "${band.label || i + 1}" has max value less than min value` });
      }

      if (i > 0) {
        const prevBand = sortedBands[i - 1];
        const prevMax = prevBand.max_value !== null && prevBand.max_value !== undefined && prevBand.max_value !== ''
          ? parseFloat(prevBand.max_value) : null;
        if (prevMax === null) {
          return res.status(400).json({
            error: `Tier "${prevBand.label || i}" has no maximum value (open-ended), so no further tiers can follow it. Set a max value or remove subsequent tiers.`
          });
        }
        if (min <= prevMax) {
          return res.status(400).json({
            error: `Tier "${band.label || i + 1}" overlaps with the previous tier. Min value (${min}) should be greater than previous max (${prevMax}).`
          });
        }
      }
    }
    bands = sortedBands;
  }

  const { data: existing } = await supabase
    .from('membership_tier_config')
    .select('id')
    .eq('tenant_id', tenantId)
    .maybeSingle();

  let savedConfig;

  if (existing) {
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
        updated_at: new Date().toISOString()
      })
      .eq('id', existing.id)
      .eq('tenant_id', tenantId)
      .select()
      .single();

    if (error) {
      console.error('[Membership Tiers] Error updating config:', error);
      return res.status(500).json({ error: 'Failed to update configuration' });
    }
    savedConfig = data;
  } else {
    const { data, error } = await supabase
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
      })
      .select()
      .single();

    if (error) {
      console.error('[Membership Tiers] Error creating config:', error);
      return res.status(500).json({ error: 'Failed to create configuration' });
    }
    savedConfig = data;
  }

  if (bands && Array.isArray(bands)) {
    const { error: deleteError } = await supabase
      .from('membership_tier_band')
      .delete()
      .eq('config_id', savedConfig.id)
      .eq('tenant_id', tenantId);

    if (deleteError) {
      console.error('[Membership Tiers] Error clearing bands:', deleteError);
    }

    if (bands.length > 0) {
      const bandsToInsert = bands.map((band, index) => ({
        config_id: savedConfig.id,
        tenant_id: tenantId,
        label: band.label || `Tier ${index + 1}`,
        min_value: band.min_value ?? 0,
        max_value: band.max_value ?? null,
        annual_cost: band.annual_cost ?? 0,
        display_order: index,
      }));

      const { error: insertError } = await supabase
        .from('membership_tier_band')
        .insert(bandsToInsert);

      if (insertError) {
        console.error('[Membership Tiers] Error inserting bands:', insertError);
        return res.status(500).json({ error: 'Failed to save tier bands' });
      }
    }
  }

  const { data: savedBands } = await supabase
    .from('membership_tier_band')
    .select('*')
    .eq('config_id', savedConfig.id)
    .order('min_value', { ascending: true });

  return res.json({
    config: savedConfig,
    bands: savedBands || []
  });
}

async function handlePut(req, res, tenantId) {
  return handlePost(req, res, tenantId);
}

async function handleDelete(req, res, tenantId) {
  const { bandId } = req.query;

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

  const { data: config } = await supabase
    .from('membership_tier_config')
    .select('id')
    .eq('tenant_id', tenantId)
    .maybeSingle();

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
