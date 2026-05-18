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
    console.error('[Member Membership Override] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function handleGet(req, res, tenantId) {
  const { memberId, action } = req.query;

  if (!memberId) {
    return res.status(400).json({ error: 'memberId is required' });
  }

  if (action === 'configs') {
    const { data: configs, error } = await supabase
      .from('membership_tier_config')
      .select('id, name, effective_from, effective_to, currency, billing_period, field_source, field_name, structure_scope_type')
      .eq('tenant_id', tenantId)
      .order('effective_from', { ascending: false });

    if (error) {
      console.error('[Member Override] Error fetching configs:', error);
      return res.status(500).json({ error: 'Failed to fetch tier configs' });
    }

    const memberConfigs = (configs || []).filter(c => c.structure_scope_type === 'member');

    const configsWithBands = await Promise.all(memberConfigs.map(async (config) => {
      const { data: bands } = await supabase
        .from('membership_tier_band')
        .select('id, label, min_value, max_value, match_value, annual_cost')
        .eq('config_id', config.id)
        .eq('tenant_id', tenantId)
        .order('display_order', { ascending: true, nullsFirst: false })
        .order('min_value', { ascending: true, nullsFirst: false });

      return { ...config, bands: bands || [] };
    }));

    return res.json(configsWithBands);
  }

  const membershipYear = req.query.membershipYear;
  let override = null;

  if (membershipYear) {
    const { data: yearOverride, error: yearErr } = await supabase
      .from('member_membership_override')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('member_id', memberId)
      .eq('membership_year', membershipYear)
      .maybeSingle();

    if (yearErr && yearErr.code !== '42P01') {
      console.error('[Member Override] Error fetching override:', yearErr);
      return res.status(500).json({ error: 'Failed to fetch override' });
    }

    if (yearOverride) {
      override = yearOverride;
    } else {
      const { data: generalOverride } = await supabase
        .from('member_membership_override')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('member_id', memberId)
        .is('membership_year', null)
        .maybeSingle();
      override = generalOverride || null;
    }
  } else {
    const { data: allOverrides, error: allErr } = await supabase
      .from('member_membership_override')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('member_id', memberId);

    if (allErr && allErr.code !== '42P01') {
      console.error('[Member Override] Error fetching override:', allErr);
      return res.status(500).json({ error: 'Failed to fetch override' });
    }
    override = allOverrides?.[0] || null;
  }

  const error = null;

  if (error) {
    if (error.code === '42P01') {
      return res.json(null);
    }
    console.error('[Member Override] Error fetching override:', error);
    return res.status(500).json({ error: 'Failed to fetch override' });
  }

  return res.json(override);
}

async function handlePost(req, res, tenantId, tenantContext) {
  const {
    memberId,
    overrideType,
    configId,
    bandId,
    manualPrice,
    discountType,
    discountValue,
    note,
    membershipYear
  } = req.body;

  if (!memberId) {
    return res.status(400).json({ error: 'memberId is required' });
  }

  if (!overrideType || !['structure', 'price', 'discount'].includes(overrideType)) {
    return res.status(400).json({ error: 'overrideType must be "structure", "price", or "discount"' });
  }

  if (!note || !note.trim()) {
    return res.status(400).json({ error: 'A note explaining the override reason is required' });
  }

  const { data: member } = await supabase
    .from('member')
    .select('id, first_name, last_name, email, tenant_id')
    .eq('id', memberId)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (!member) {
    return res.status(404).json({ error: 'Member not found' });
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

  if (overrideType === 'discount') {
    if (!discountType || !['percentage', 'fixed'].includes(discountType)) {
      return res.status(400).json({ error: 'discountType must be "percentage" or "fixed"' });
    }
    if (discountValue === null || discountValue === undefined || isNaN(parseFloat(discountValue)) || parseFloat(discountValue) < 0) {
      return res.status(400).json({ error: 'A valid discount value is required' });
    }
    if (discountType === 'percentage' && parseFloat(discountValue) > 100) {
      return res.status(400).json({ error: 'Percentage discount cannot exceed 100%' });
    }
  }

  const overrideData = {
    tenant_id: tenantId,
    member_id: memberId,
    override_type: overrideType,
    config_id: overrideType === 'structure' ? configId : null,
    band_id: overrideType === 'structure' ? (bandId || null) : null,
    manual_price: overrideType === 'price' ? parseFloat(manualPrice) : null,
    discount_type: overrideType === 'discount' ? discountType : null,
    discount_value: overrideType === 'discount' ? parseFloat(discountValue) : null,
    membership_year: membershipYear || null,
    note: note.trim(),
    updated_at: new Date().toISOString(),
  };

  let existingQuery = supabase
    .from('member_membership_override')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('member_id', memberId);

  if (membershipYear) {
    existingQuery = existingQuery.eq('membership_year', membershipYear);
  } else {
    existingQuery = existingQuery.is('membership_year', null);
  }

  const { data: existing } = await existingQuery.maybeSingle();

  let result;
  if (existing) {
    const { data, error } = await supabase
      .from('member_membership_override')
      .update(overrideData)
      .eq('id', existing.id)
      .select()
      .single();

    if (error) {
      console.error('[Member Override] Error updating override:', error);
      return res.status(500).json({ error: 'Failed to update override' });
    }
    result = data;
  } else {
    const { data, error } = await supabase
      .from('member_membership_override')
      .insert(overrideData)
      .select()
      .single();

    if (error) {
      console.error('[Member Override] Error creating override:', error);
      return res.status(500).json({ error: 'Failed to create override' });
    }
    result = data;
  }

  const notePrefix = overrideType === 'structure'
    ? '[Membership Override - Structure]'
    : overrideType === 'price'
      ? '[Membership Override - Price]'
      : '[Membership Override - Discount]';

  const noteContent = `${notePrefix} ${note.trim()}`;

  try {
    const noteCreatorId = tenantContext.memberId || tenantContext.tenantUserId || null;
    await supabase
      .from('member_note')
      .insert({
        member_id: memberId,
        created_by_member_id: noteCreatorId,
        content: noteContent,
        attachments: []
      });
  } catch (noteErr) {
    console.error('[Member Override] Failed to create note (non-fatal):', noteErr);
  }

  return res.json(result);
}

async function handleDelete(req, res, tenantId, tenantContext) {
  const { memberId } = req.query;

  if (!memberId) {
    return res.status(400).json({ error: 'memberId is required' });
  }

  const { data: member } = await supabase
    .from('member')
    .select('id, tenant_id')
    .eq('id', memberId)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (!member) {
    return res.status(404).json({ error: 'Member not found' });
  }

  const membershipYear = req.query.membershipYear;
  let deleteQuery = supabase
    .from('member_membership_override')
    .delete()
    .eq('tenant_id', tenantId)
    .eq('member_id', memberId);

  if (membershipYear) {
    deleteQuery = deleteQuery.eq('membership_year', membershipYear);
  }

  const { error } = await deleteQuery;

  if (error) {
    console.error('[Member Override] Error deleting override:', error);
    return res.status(500).json({ error: 'Failed to remove override' });
  }

  try {
    const noteCreatorId = tenantContext.memberId || tenantContext.tenantUserId || null;
    await supabase
      .from('member_note')
      .insert({
        member_id: memberId,
        created_by_member_id: noteCreatorId,
        content: '[Membership Override - Removed] The membership renewal override has been removed. The next year preview will now use the standard active tier structure.',
        attachments: []
      });
  } catch (noteErr) {
    console.error('[Member Override] Failed to create removal note (non-fatal):', noteErr);
  }

  return res.json({ success: true });
}
