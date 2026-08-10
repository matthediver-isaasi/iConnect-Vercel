import { supabase } from './database.js';

// Scope-aware discount evaluation: member-scoped structures store their
// custom-field values in member_preference_value (keyed by member_id),
// organisation-scoped ones in organization_preference_value. Field values
// supplied via fieldOverrides (e.g. form answers for a detached quote)
// always win and skip the DB lookup entirely.
export async function evaluateDiscountsForEntity(configId, tenantId, entityId, fieldOverrides = {}, entityType = 'organization') {
  return evaluateDiscountsInternal(configId, tenantId, entityId, fieldOverrides, entityType);
}

export async function evaluateDiscountsForOrg(configId, tenantId, organizationId, fieldOverrides = {}) {
  return evaluateDiscountsInternal(configId, tenantId, organizationId, fieldOverrides, 'organization');
}

async function evaluateDiscountsInternal(configId, tenantId, entityId, fieldOverrides = {}, entityType = 'organization') {
  const result = {
    totalDiscount: 0,
    discountDetails: [],
  };

  try {
    const { data: discountRules, error: discountError } = await supabase
      .from('membership_tier_discount')
      .select('*')
      .eq('config_id', configId)
      .eq('tenant_id', tenantId)
      .order('sort_order', { ascending: true });

    if (discountError) {
      if (discountError.code === '42P01') return result;
      console.error('[DiscountHelper] Error fetching discount rules:', discountError);
      return result;
    }

    if (!discountRules || discountRules.length === 0) return result;

    const fieldIds = [...new Set(discountRules.map(d => d.field_id).filter(Boolean))];
    if (fieldIds.length === 0) return result;

    const valueMap = {};
    Object.entries(fieldOverrides).forEach(([k, v]) => {
      if (v !== undefined && v !== null && fieldIds.includes(k)) {
        valueMap[k] = v;
      }
    });

    const dbFieldIds = fieldIds.filter(id => !(id in valueMap));
    if (dbFieldIds.length > 0) {
      const isMemberScope = entityType === 'member';
      const { data: entityValues, error: valuesError } = await supabase
        .from(isMemberScope ? 'member_preference_value' : 'organization_preference_value')
        .select('field_id, value')
        .eq(isMemberScope ? 'member_id' : 'organization_id', entityId)
        .in('field_id', dbFieldIds);

      if (valuesError) {
        console.error('[DiscountHelper] Error fetching entity field values:', valuesError);
        return result;
      }

      (entityValues || []).forEach(v => {
        valueMap[v.field_id] = v.value;
      });
    }

    for (const rule of discountRules) {
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
        result.discountDetails.push({
          rule_id: rule.id,
          field_id: rule.field_id,
          field_label: rule.field_label || rule.field_id,
          match_value: rule.match_value,
          discount_type: rule.discount_type,
          discount_value: parseFloat(rule.discount_value) || 0,
          label: rule.label || null,
        });
      }
    }

    return result;
  } catch (err) {
    console.error('[DiscountHelper] Unexpected error:', err);
    return result;
  }
}

export function applyDiscountsToAnnualCost(annualCost, discountDetails) {
  if (!discountDetails || discountDetails.length === 0) {
    return { discountedCost: annualCost, totalDiscount: 0, appliedDiscounts: [] };
  }

  let totalPercentage = 0;
  let totalFixed = 0;
  const appliedDiscounts = [];

  for (const d of discountDetails) {
    if (d.discount_type === 'percentage') {
      const amount = (annualCost * (d.discount_value / 100));
      totalPercentage += amount;
      appliedDiscounts.push({
        ...d,
        applied_amount: Math.round(amount * 100) / 100,
      });
    } else if (d.discount_type === 'fixed') {
      totalFixed += d.discount_value;
      appliedDiscounts.push({
        ...d,
        applied_amount: d.discount_value,
      });
    }
  }

  const totalDiscount = Math.round((totalPercentage + totalFixed) * 100) / 100;
  const discountedCost = Math.max(0, Math.round((annualCost - totalDiscount) * 100) / 100);

  return { discountedCost, totalDiscount, appliedDiscounts };
}
