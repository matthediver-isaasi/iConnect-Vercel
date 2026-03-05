import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const context = await getTenantContext(req);
  if (!context?.tenantId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const tenantId = context.tenantId;
  const { configId } = req.query;

  try {
    let config;
    if (configId) {
      const { data } = await supabase
        .from('membership_tier_config')
        .select('*')
        .eq('id', configId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      config = data;
    } else {
      const { data: configs } = await supabase
        .from('membership_tier_config')
        .select('*')
        .eq('tenant_id', tenantId)
        .is('effective_to', null)
        .order('effective_from', { ascending: false, nullsFirst: true })
        .limit(1);
      config = configs?.[0] || null;
    }

    if (!config) {
      return res.json({ requiredFields: [] });
    }

    const requiredFields = [];
    const fieldIdsToResolve = [];

    if (config.structure_field_id && !config.structure_field_id.startsWith('core:')) {
      fieldIdsToResolve.push(config.structure_field_id);
    }
    if (config.field_id) {
      fieldIdsToResolve.push(config.field_id);
    }

    const { data: discountRules } = await supabase
      .from('membership_tier_discount')
      .select('id, field_id, label, field_label')
      .eq('config_id', config.id)
      .eq('tenant_id', tenantId)
      .order('sort_order', { ascending: true });

    const discountFieldIds = (discountRules || []).map(d => d.field_id).filter(Boolean);
    fieldIdsToResolve.push(...discountFieldIds);

    let vatOverrideRules = [];
    try {
      const { data, error } = await supabase
        .from('membership_tier_vat_override')
        .select('id, field_id, label, field_label')
        .eq('config_id', config.id)
        .eq('tenant_id', tenantId)
        .order('sort_order', { ascending: true });
      if (!error) vatOverrideRules = data || [];
    } catch {}

    const vatFieldIds = vatOverrideRules.map(v => v.field_id).filter(Boolean);
    fieldIdsToResolve.push(...vatFieldIds);

    const uniqueFieldIds = [...new Set(fieldIdsToResolve.filter(Boolean))];
    let fieldLabelMap = {};
    if (uniqueFieldIds.length > 0) {
      const { data: fields } = await supabase
        .from('preference_field')
        .select('id, label, name, field_type')
        .in('id', uniqueFieldIds);
      (fields || []).forEach(f => {
        fieldLabelMap[f.id] = { label: f.label || f.name || f.id, field_type: f.field_type };
      });
    }

    if (config.structure_field_id) {
      const isCore = config.structure_field_id.startsWith('core:');
      requiredFields.push({
        field_id: config.structure_field_id,
        field_label: isCore
          ? config.structure_field_id.replace('core:', '')
          : (fieldLabelMap[config.structure_field_id]?.label || config.structure_field_id),
        field_source: isCore ? 'core' : 'custom',
        field_type: isCore ? 'text' : (fieldLabelMap[config.structure_field_id]?.field_type || 'text'),
        usage: 'structure',
        usage_detail: `Determines which membership schedule applies (must match "${config.structure_match_value}")`,
      });
    }

    if (config.pricing_model !== 'flat') {
      if (config.field_source === 'core' && config.field_name) {
        requiredFields.push({
          field_id: `core:${config.field_name}`,
          field_label: config.field_name === 'member_count' ? 'Member Count' : config.field_name,
          field_source: 'core',
          field_type: 'number',
          usage: 'band',
          usage_detail: 'Used to determine the pricing band',
        });
      } else if (config.field_id) {
        requiredFields.push({
          field_id: config.field_id,
          field_label: fieldLabelMap[config.field_id]?.label || config.field_id,
          field_source: 'custom',
          field_type: fieldLabelMap[config.field_id]?.field_type || 'number',
          usage: 'band',
          usage_detail: 'Used to determine the pricing band',
        });
      }
    }

    for (const rule of (discountRules || [])) {
      if (!rule.field_id) continue;
      requiredFields.push({
        field_id: rule.field_id,
        field_label: rule.field_label || fieldLabelMap[rule.field_id]?.label || rule.field_id,
        field_source: 'custom',
        field_type: fieldLabelMap[rule.field_id]?.field_type || 'text',
        usage: 'discount',
        usage_detail: `Used for discount rule: ${rule.label || 'Unnamed discount'}`,
      });
    }

    for (const rule of vatOverrideRules) {
      if (!rule.field_id) continue;
      requiredFields.push({
        field_id: rule.field_id,
        field_label: rule.field_label || fieldLabelMap[rule.field_id]?.label || rule.field_id,
        field_source: 'custom',
        field_type: fieldLabelMap[rule.field_id]?.field_type || 'text',
        usage: 'vat_override',
        usage_detail: `Used for VAT override rule: ${rule.label || 'Unnamed VAT rule'}`,
      });
    }

    const seen = new Set();
    const dedupedFields = requiredFields.filter(f => {
      const key = `${f.field_id}:${f.usage}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return res.json({
      configId: config.id,
      configName: config.name || 'Default',
      scopeType: config.structure_scope_type || 'organization',
      requiredFields: dedupedFields,
    });
  } catch (err) {
    console.error('[TierRequiredFields] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
