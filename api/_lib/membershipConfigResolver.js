import { supabase } from './database.js';

export async function getAllActiveConfigs(tenantId) {
  const { data, error } = await supabase
    .from('membership_tier_config')
    .select('*')
    .eq('tenant_id', tenantId)
    .is('effective_to', null)
    .order('effective_from', { ascending: false, nullsFirst: true });

  if (error) {
    console.error('[membershipConfigResolver] Error fetching active configs:', error);
    return [];
  }
  return data || [];
}

export async function getConfigForOrganisation(tenantId, organisationId, fieldOverrides = {}) {
  const allConfigs = await getAllActiveConfigs(tenantId);
  if (!allConfigs || allConfigs.length === 0) return null;

  const configs = allConfigs.filter(c => (c.structure_scope_type || 'organization') === 'organization');
  if (configs.length === 0) return null;

  const unscoped = configs.filter(c => !c.structure_field_id);
  const scoped = configs.filter(c => c.structure_field_id && c.structure_match_value);

  if (scoped.length === 0) {
    return unscoped[0] || null;
  }

  const fieldIds = [...new Set(scoped.map(c => c.structure_field_id))];

  const orgFieldMap = {};
  Object.entries(fieldOverrides).forEach(([k, v]) => {
    if (v !== undefined && v !== null) {
      orgFieldMap[k] = String(v).toLowerCase().trim();
    }
  });

  const dbFieldIds = fieldIds.filter(id => !(id in fieldOverrides));
  if (dbFieldIds.length > 0) {
    const { data: prefValues } = await supabase
      .from('organization_preference_value')
      .select('field_id, value')
      .eq('organization_id', organisationId)
      .in('field_id', dbFieldIds);

    (prefValues || []).forEach(pv => {
      orgFieldMap[pv.field_id] = (pv.value || '').toString().toLowerCase().trim();
    });
  }

  for (const cfg of scoped) {
    const orgVal = orgFieldMap[cfg.structure_field_id] || '';
    const matchVal = (cfg.structure_match_value || '').toString().toLowerCase().trim();
    if (orgVal && matchVal && orgVal === matchVal) {
      return cfg;
    }
  }

  return unscoped[0] || null;
}

export async function getConfigByIdDirect(tenantId, configId) {
  const { data } = await supabase
    .from('membership_tier_config')
    .select('*')
    .eq('id', configId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  return data;
}

export async function getConfigForMember(tenantId, memberId, fieldOverrides = {}) {
  const allConfigs = await getAllActiveConfigs(tenantId);
  if (!allConfigs || allConfigs.length === 0) return null;

  const configs = allConfigs.filter(c => c.structure_scope_type === 'member');
  if (configs.length === 0) return null;

  const unscoped = configs.filter(c => !c.structure_field_id);
  const scoped = configs.filter(c => c.structure_field_id && c.structure_match_value);

  if (scoped.length === 0) {
    return unscoped[0] || null;
  }

  const coreFieldIds = scoped
    .filter(c => c.structure_field_id.startsWith('core:'))
    .map(c => c.structure_field_id.replace('core:', ''));

  const customFieldIds = scoped
    .filter(c => !c.structure_field_id.startsWith('core:'))
    .map(c => c.structure_field_id);

  const memberFieldMap = {};
  Object.entries(fieldOverrides).forEach(([k, v]) => {
    if (v !== undefined && v !== null) {
      memberFieldMap[k] = String(v).toLowerCase().trim();
    }
  });

  const unresolvedCoreFields = coreFieldIds.filter(col => !(`core:${col}` in fieldOverrides));
  if (unresolvedCoreFields.length > 0) {
    const selectCols = ['id', ...unresolvedCoreFields].join(', ');
    const { data: member } = await supabase
      .from('member')
      .select(selectCols)
      .eq('id', memberId)
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (member) {
      for (const col of unresolvedCoreFields) {
        memberFieldMap[`core:${col}`] = (member[col] || '').toString().toLowerCase().trim();
      }
    }
  }

  const unresolvedCustomIds = customFieldIds.filter(id => !(id in fieldOverrides));
  if (unresolvedCustomIds.length > 0) {
    const { data: prefValues } = await supabase
      .from('member_preference_value')
      .select('field_id, value')
      .eq('member_id', memberId)
      .in('field_id', unresolvedCustomIds);

    (prefValues || []).forEach(pv => {
      memberFieldMap[pv.field_id] = (pv.value || '').toString().toLowerCase().trim();
    });
  }

  for (const cfg of scoped) {
    const memberVal = memberFieldMap[cfg.structure_field_id] || '';
    const matchVal = (cfg.structure_match_value || '').toString().toLowerCase().trim();
    if (memberVal && matchVal && memberVal === matchVal) {
      return cfg;
    }
  }

  return unscoped[0] || null;
}
