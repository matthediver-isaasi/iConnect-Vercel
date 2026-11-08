import { parseFlatMembershipCost } from "../../../shared/membershipFlatCost.js";

export function termEndFieldsFromConfig(config) {
  return {
    term_end_mode: config?.term_end_mode || 'standard',
    term_end_field_id: config?.term_end_field_id || null,
  };
}

export function memberDateTermPolicyErrors(config) {
  if (config.term_end_mode !== 'member_date_field') return [];
  const errors = [];
  if (config.structure_scope_type !== 'member') errors.push('Member date terms are available only for member-scoped schedules.');
  const cost = parseFlatMembershipCost(config.flat_cost);
  if (config.pricing_model !== 'flat' || !cost.valid || cost.value !== 0) {
    errors.push('Choose flat pricing and explicitly enter a cost of 0. Existing prices are not changed automatically.');
  }
  if (config.dd_enabled) errors.push('Turn off Direct Debit for a member date term.');
  if (config.card_monthly_enabled) errors.push('Turn off monthly card payments for a member date term.');
  if (config.prorata_enabled) errors.push('Turn off pro-rata pricing for a member date term.');
  if (config.free_period_enabled || Number(config.free_period_amount) > 0) errors.push('Turn off the free period and remove its amount for a member date term.');
  if (config.rollover_enabled) errors.push('Turn off rollover for a member date term.');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(config.term_end_field_id || '')) {
    errors.push('Choose a member date custom field for the term end.');
  }
  return errors;
}
