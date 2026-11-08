import { buildMemberDateTerm } from '../../shared/memberDateMembershipTerm.js';
import { parseFlatMembershipCost } from '../../shared/membershipFlatCost.js';

export function assertMemberDateSchedule(config) {
  if ((config.term_end_mode || 'standard') !== 'member_date_field') return;
  const cost = parseFlatMembershipCost(config.flat_cost);
  if (config.structure_scope_type !== 'member' || config.pricing_model !== 'flat'
      || !cost.valid || cost.value !== 0
      || config.dd_enabled || config.card_monthly_enabled || config.prorata_enabled
      || config.free_period_amount || config.rollover_enabled) {
    throw new Error('A member-date term requires an individual, flat, no-charge schedule without instalments, proration or free-period discounts.');
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(config.term_end_field_id || '')) {
    throw new Error('Select the member date field that determines the end of the membership.');
  }
}

export async function resolveMemberDateTerm(db, { tenantId, memberId, config, startDate, fieldOverrides = {} }) {
  assertMemberDateSchedule(config);
  const { data: field, error: fieldError } = await db.from('preference_field').select('*')
    .eq('tenant_id', tenantId).eq('id', config.term_end_field_id).maybeSingle();
  if (fieldError) throw new Error('The membership end-date field could not be verified.');
  let value;
  if (Object.prototype.hasOwnProperty.call(fieldOverrides, config.term_end_field_id)) {
    value = fieldOverrides[config.term_end_field_id];
  } else {
    const result = await db.from('member_preference_value').select('value')
      .eq('member_id', memberId).eq('field_id', config.term_end_field_id).maybeSingle();
    if (result.error) throw new Error('The membership end date could not be loaded.');
    value = result.data?.value;
  }
  try {
    return buildMemberDateTerm({ tenantId, memberId, field, value, startDate,
      graceDays: config.renewal_grace_days ?? 0 });
  } catch (error) {
    throw new Error(`${field?.label || 'Membership end date'}: ${error.message}`);
  }
}
