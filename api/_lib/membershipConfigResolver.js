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

export async function getConfigForOrganisation(tenantId, organisationId) {
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

  const { data: prefValues } = await supabase
    .from('organization_preference_value')
    .select('field_id, value')
    .eq('organization_id', organisationId)
    .in('field_id', fieldIds);

  const orgFieldMap = {};
  (prefValues || []).forEach(pv => {
    orgFieldMap[pv.field_id] = (pv.value || '').toString().toLowerCase().trim();
  });

  for (const cfg of scoped) {
    const orgVal = orgFieldMap[cfg.structure_field_id] || '';
    const matchVal = (cfg.structure_match_value || '').toString().toLowerCase().trim();
    if (orgVal && matchVal && orgVal === matchVal) {
      return cfg;
    }
  }

  return unscoped[0] || null;
}

export async function getConfigForMember(tenantId, memberId) {
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

  if (coreFieldIds.length > 0) {
    const selectCols = ['id', ...coreFieldIds].join(', ');
    const { data: member } = await supabase
      .from('member')
      .select(selectCols)
      .eq('id', memberId)
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (member) {
      for (const col of coreFieldIds) {
        memberFieldMap[`core:${col}`] = (member[col] || '').toString().toLowerCase().trim();
      }
    }
  }

  if (customFieldIds.length > 0) {
    const { data: prefValues } = await supabase
      .from('member_preference_value')
      .select('field_id, value')
      .eq('member_id', memberId)
      .in('field_id', customFieldIds);

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
