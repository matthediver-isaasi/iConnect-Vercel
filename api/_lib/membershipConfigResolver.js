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
  const configs = await getAllActiveConfigs(tenantId);
  if (!configs || configs.length === 0) return null;

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

  return null;
}
