import { supabase } from './database.js';

export async function evaluateDiscountsForOrg(configId, tenantId, organizationId) {
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

    const { data: orgValues, error: valuesError } = await supabase
      .from('organization_preference_value')
      .select('field_id, value')
      .eq('organization_id', organizationId)
      .in('field_id', fieldIds);

    if (valuesError) {
      console.error('[DiscountHelper] Error fetching org field values:', valuesError);
      return result;
    }

    const valueMap = {};
    (orgValues || []).forEach(v => {
      valueMap[v.field_id] = v.value;
    });

    for (const rule of discountRules) {
      const orgFieldValue = valueMap[rule.field_id];
      if (orgFieldValue === undefined || orgFieldValue === null) continue;

      const normalizedOrgValue = String(orgFieldValue).trim().toLowerCase();
      const normalizedMatchValue = String(rule.match_value).trim().toLowerCase();

      if (normalizedOrgValue === normalizedMatchValue) {
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
