import { supabase } from './database.js';

export async function evaluateVatOverrideForOrg(configId, tenantId, organizationId) {
  try {
    const { data: overrideRules, error: overrideError } = await supabase
      .from('membership_tier_vat_override')
      .select('*')
      .eq('config_id', configId)
      .eq('tenant_id', tenantId)
      .order('sort_order', { ascending: true });

    if (overrideError) {
      if (overrideError.code === '42P01') return null;
      console.error('[VatOverrideHelper] Error fetching VAT override rules:', overrideError);
      return null;
    }

    if (!overrideRules || overrideRules.length === 0) return null;

    const fieldIds = [...new Set(overrideRules.map(d => d.field_id).filter(Boolean))];
    if (fieldIds.length === 0) return null;

    const { data: orgValues, error: valuesError } = await supabase
      .from('organization_preference_value')
      .select('field_id, value')
      .eq('organization_id', organizationId)
      .in('field_id', fieldIds);

    if (valuesError) {
      console.error('[VatOverrideHelper] Error fetching org field values:', valuesError);
      return null;
    }

    const valueMap = {};
    (orgValues || []).forEach(v => {
      valueMap[v.field_id] = v.value;
    });

    for (const rule of overrideRules) {
      const orgFieldValue = valueMap[rule.field_id];
      if (orgFieldValue === undefined || orgFieldValue === null) continue;

      const normalizedOrgValue = String(orgFieldValue).trim().toLowerCase();
      const normalizedMatchValue = String(rule.match_value).trim().toLowerCase();

      if (normalizedOrgValue === normalizedMatchValue) {
        if (rule.vat_rate) {
          try {
            const parsed = JSON.parse(rule.vat_rate);
            return {
              taxType: parsed.taxType || null,
              taxLabel: parsed.name || null,
              ruleLabel: rule.label || null,
              fieldLabel: rule.field_label || null,
              matchValue: rule.match_value,
            };
          } catch {
            return {
              taxType: rule.vat_rate,
              taxLabel: rule.vat_rate,
              ruleLabel: rule.label || null,
              fieldLabel: rule.field_label || null,
              matchValue: rule.match_value,
            };
          }
        }
        return null;
      }
    }

    return null;
  } catch (err) {
    console.error('[VatOverrideHelper] Unexpected error:', err);
    return null;
  }
}
