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
      return handlePost(req, res, tenantId, tenantContext);
    } else if (req.method === 'DELETE') {
      return handleDelete(req, res, tenantId, tenantContext);
    } else {
      return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('[Org Membership Override] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function handleGet(req, res, tenantId) {
  const { organizationId, action } = req.query;

  if (!organizationId) {
    return res.status(400).json({ error: 'organizationId is required' });
  }

  if (action === 'configs') {
    const { data: configs, error } = await supabase
      .from('membership_tier_config')
      .select('id, name, effective_from, effective_to, currency, billing_period, field_source, field_name')
      .eq('tenant_id', tenantId)
      .order('effective_from', { ascending: false });

    if (error) {
      console.error('[Override] Error fetching configs:', error);
      return res.status(500).json({ error: 'Failed to fetch tier configs' });
    }

    const configsWithBands = await Promise.all((configs || []).map(async (config) => {
      const { data: bands } = await supabase
        .from('membership_tier_band')
        .select('id, label, min_value, max_value, annual_cost')
        .eq('config_id', config.id)
        .eq('tenant_id', tenantId)
        .order('min_value', { ascending: true });

      return { ...config, bands: bands || [] };
    }));

    return res.json(configsWithBands);
  }

  const membershipYear = req.query.membershipYear;
  let overrideQuery = supabase
    .from('organisation_membership_override')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('organization_id', organizationId);
  
  if (membershipYear) {
    overrideQuery = overrideQuery.eq('membership_year', membershipYear);
  }

  const { data: override, error } = await overrideQuery.maybeSingle();

  if (error) {
    if (error.code === '42P01') {
      return res.json(null);
    }
    console.error('[Override] Error fetching override:', error);
    return res.status(500).json({ error: 'Failed to fetch override' });
  }

  return res.json(override);
}

async function handlePost(req, res, tenantId, tenantContext) {
  const {
    organizationId,
    overrideType,
    configId,
    bandId,
    manualPrice,
    note,
    membershipYear
  } = req.body;

  if (!organizationId) {
    return res.status(400).json({ error: 'organizationId is required' });
  }

  if (!overrideType || !['structure', 'price'].includes(overrideType)) {
    return res.status(400).json({ error: 'overrideType must be "structure" or "price"' });
  }

  if (!note || !note.trim()) {
    return res.status(400).json({ error: 'A note explaining the override reason is required' });
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

  if (overrideType === 'structure') {
    if (!configId) {
      return res.status(400).json({ error: 'configId is required for structure override' });
    }
    const { data: config } = await supabase
      .from('membership_tier_config')
      .select('id')
      .eq('id', configId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (!config) {
      return res.status(400).json({ error: 'Invalid tier config' });
    }
  }

  if (overrideType === 'price') {
    if (manualPrice === null || manualPrice === undefined || isNaN(parseFloat(manualPrice))) {
      return res.status(400).json({ error: 'A valid manual price is required for price override' });
    }
  }

  const overrideData = {
    tenant_id: tenantId,
    organization_id: organizationId,
    override_type: overrideType,
    config_id: overrideType === 'structure' ? configId : null,
    band_id: overrideType === 'structure' ? (bandId || null) : null,
    manual_price: overrideType === 'price' ? parseFloat(manualPrice) : null,
    membership_year: membershipYear || null,
    note: note.trim(),
    created_by: tenantContext.tenantUserId || tenantContext.memberId || null,
    updated_at: new Date().toISOString(),
  };

  let existingQuery = supabase
    .from('organisation_membership_override')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('organization_id', organizationId);
  
  if (membershipYear) {
    existingQuery = existingQuery.eq('membership_year', membershipYear);
  } else {
    existingQuery = existingQuery.is('membership_year', null);
  }
  
  const { data: existing } = await existingQuery.maybeSingle();

  let result;
  if (existing) {
    const { data, error } = await supabase
      .from('organisation_membership_override')
      .update(overrideData)
      .eq('id', existing.id)
      .select()
      .single();

    if (error) {
      console.error('[Override] Error updating override:', error);
      return res.status(500).json({ error: 'Failed to update override' });
    }
    result = data;
  } else {
    const { data, error } = await supabase
      .from('organisation_membership_override')
      .insert(overrideData)
      .select()
      .single();

    if (error) {
      console.error('[Override] Error creating override:', error);
      return res.status(500).json({ error: 'Failed to create override' });
    }
    result = data;
  }

  const notePrefix = overrideType === 'structure'
    ? '[Membership Override - Structure]'
    : '[Membership Override - Price]';

  const noteContent = `${notePrefix} ${note.trim()}`;

  try {
    const noteCreatorId = tenantContext.memberId || tenantContext.tenantUserId || null;
    await supabase
      .from('organization_note')
      .insert({
        organization_id: organizationId,
        member_id: noteCreatorId,
        content: noteContent,
        attachments: []
      });
  } catch (noteErr) {
    console.error('[Override] Failed to create note (non-fatal):', noteErr);
  }

  return res.json(result);
}

async function handleDelete(req, res, tenantId, tenantContext) {
  const { organizationId } = req.query;

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

  const membershipYear = req.query.membershipYear;
  let deleteQuery = supabase
    .from('organisation_membership_override')
    .delete()
    .eq('tenant_id', tenantId)
    .eq('organization_id', organizationId);
  
  if (membershipYear) {
    deleteQuery = deleteQuery.eq('membership_year', membershipYear);
  }

  const { error } = await deleteQuery;

  if (error) {
    console.error('[Override] Error deleting override:', error);
    return res.status(500).json({ error: 'Failed to remove override' });
  }

  try {
    const noteCreatorId = tenantContext.memberId || tenantContext.tenantUserId || null;
    await supabase
      .from('organization_note')
      .insert({
        organization_id: organizationId,
        member_id: noteCreatorId,
        content: '[Membership Override - Removed] The membership renewal override has been removed. The next year preview will now use the standard active tier structure.',
        attachments: []
      });
  } catch (noteErr) {
    console.error('[Override] Failed to create removal note (non-fatal):', noteErr);
  }

  return res.json({ success: true });
}
