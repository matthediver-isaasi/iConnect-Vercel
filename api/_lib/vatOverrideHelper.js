import { supabase } from './database.js';

export async function evaluateVatOverrideForOrg(configId, tenantId, organizationId, fieldOverrides = {}) {
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

    const valueMap = {};
    fieldIds.forEach(id => {
      if (id in fieldOverrides && fieldOverrides[id] !== undefined && fieldOverrides[id] !== null) {
        valueMap[id] = fieldOverrides[id];
      }
    });

    const dbFieldIds = fieldIds.filter(id => !(id in valueMap));
    if (dbFieldIds.length > 0) {
      const { data: orgValues, error: valuesError } = await supabase
        .from('organization_preference_value')
        .select('field_id, value')
        .eq('organization_id', organizationId)
        .in('field_id', dbFieldIds);

      if (valuesError) {
        console.error('[VatOverrideHelper] Error fetching org field values:', valuesError);
        return null;
      }

      (orgValues || []).forEach(v => {
        valueMap[v.field_id] = v.value;
      });
    }

    for (const rule of overrideRules) {
      const orgFieldValue = valueMap[rule.field_id];
      if (orgFieldValue === undefined || orgFieldValue === null) continue;

      const normalizedOrgValue = String(orgFieldValue).trim().toLowerCase();

      let matchValues;
      try { matchValues = JSON.parse(rule.match_value); } catch { matchValues = null; }
      let isMatch = Array.isArray(matchValues)
        ? matchValues.some(v => String(v).trim().toLowerCase() === normalizedOrgValue)
        : normalizedOrgValue === String(rule.match_value).trim().toLowerCase();
      if (rule.match_condition === 'not_equals') isMatch = !isMatch;

      if (isMatch) {
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

export async function evaluateVatOverrideForMember(configId, tenantId, memberId, fieldOverrides = {}) {
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

    const valueMap = {};
    fieldIds.forEach(id => {
      if (id in fieldOverrides && fieldOverrides[id] !== undefined && fieldOverrides[id] !== null) {
        valueMap[id] = fieldOverrides[id];
      }
    });

    const dbFieldIds = fieldIds.filter(id => !(id in valueMap));
    if (dbFieldIds.length > 0) {
      const coreFieldIds = dbFieldIds.filter(id => id.startsWith('core:'));
      const customFieldIds = dbFieldIds.filter(id => !id.startsWith('core:'));

      if (coreFieldIds.length > 0) {
        try {
          const { data: member } = await supabase
            .from('member')
            .select('*')
            .eq('id', memberId)
            .maybeSingle();
          if (member) {
            coreFieldIds.forEach(id => {
              const fieldName = id.replace('core:', '');
              if (member[fieldName] !== undefined && member[fieldName] !== null) {
                valueMap[id] = member[fieldName];
              }
            });
          }
        } catch {}
      }

      if (customFieldIds.length > 0) {
        const { data: memberValues, error: valuesError } = await supabase
          .from('member_preference_value')
          .select('field_id, value')
          .eq('member_id', memberId)
          .in('field_id', customFieldIds);

        if (valuesError) {
          console.error('[VatOverrideHelper] Error fetching member field values:', valuesError);
          return null;
        }

        (memberValues || []).forEach(v => {
          valueMap[v.field_id] = v.value;
        });
      }
    }

    for (const rule of overrideRules) {
      const fieldValue = valueMap[rule.field_id];
      if (fieldValue === undefined || fieldValue === null) continue;

      const normalizedValue = String(fieldValue).trim().toLowerCase();

      let matchValues;
      try { matchValues = JSON.parse(rule.match_value); } catch { matchValues = null; }
      let isMatch = Array.isArray(matchValues)
        ? matchValues.some(v => String(v).trim().toLowerCase() === normalizedValue)
        : normalizedValue === String(rule.match_value).trim().toLowerCase();
      if (rule.match_condition === 'not_equals') isMatch = !isMatch;

      if (isMatch) {
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
    console.error('[VatOverrideHelper] Unexpected error (member):', err);
    return null;
  }
}
