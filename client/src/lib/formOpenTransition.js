import { evaluateScoreCondition } from './surveyConditions.js';
import { evaluateLmicCondition } from '../../../api/_lib/formLmicConditions.js';
import { evaluateFormLogicCondition } from './formLogicConditions.js';
import { COUNTRIES } from '../../../shared/countries.js';
import { FORM_NO_RELATIONSHIP_VALUE } from '../../../shared/formNoRelationshipChoice.js';

function evaluateOne(form, answers, condition) {
  if (!condition?.field_id) return false;
  let triggerValue = answers?.[condition.field_id];
  const relationshipEmpty = triggerValue === FORM_NO_RELATIONSHIP_VALUE;
  const lmic = evaluateLmicCondition(triggerValue, condition.operator, form?.lmic_country_codes);
  if (lmic !== undefined) return lmic;
  if (typeof triggerValue === 'string' && /^[A-Z]{2}$/.test(triggerValue)) {
    triggerValue = COUNTRIES.find(country => country.code === triggerValue)?.name || triggerValue;
  }
  const score = evaluateScoreCondition(triggerValue, condition.operator, condition.value);
  if (score !== undefined) return score;
  return evaluateFormLogicCondition(triggerValue, condition.operator, condition.value, {
    relationshipEmpty,
  });
}

export function evaluateOpenFormRule(form, answers, rule) {
  if (Array.isArray(rule?.conditions) && rule.conditions.length > 0) {
    const results = rule.conditions.map(condition => evaluateOne(form, answers, condition));
    return (rule.logic || 'and') === 'or'
      ? results.some(Boolean)
      : results.every(Boolean);
  }
  if (rule?.trigger_field_id) {
    return evaluateOne(form, answers, {
      field_id: rule.trigger_field_id,
      operator: rule.operator,
      value: rule.value,
    });
  }
  return false;
}

export function firstMatchingOpenFormAction(form, answers) {
  for (const rule of form?.visibility_rules || []) {
    if (!evaluateOpenFormRule(form, answers, rule)) continue;
    const action = (rule.actions || []).find(candidate =>
      (candidate?.action_type || candidate?.rule_type || candidate?.action) === 'open_form'
      && candidate.id
      && candidate.destination_form_id
    );
    if (action) return action;
  }
  return null;
}