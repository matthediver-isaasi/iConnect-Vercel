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
  return firstMatchingOpenFormTransition(form, answers)?.action || null;
}

export function firstMatchingOpenFormTransition(form, answers) {
  for (const rule of form?.visibility_rules || []) {
    if (!evaluateOpenFormRule(form, answers, rule)) continue;
    const action = (rule.actions || []).find(candidate =>
      (candidate?.action_type || candidate?.rule_type || candidate?.action) === 'open_form'
      && candidate.id
      && candidate.destination_form_id
    );
    if (action) return { action, rule };
  }
  return null;
}

function ruleConditions(rule) {
  if (Array.isArray(rule?.conditions) && rule.conditions.length > 0) {
    return rule.conditions.filter(condition => condition?.field_id);
  }
  if (rule?.trigger_field_id) {
    return [{
      field_id: rule.trigger_field_id,
      operator: rule.operator,
      value: rule.value,
    }];
  }
  return [];
}

function answerValuesEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length
      && left.every((value, index) => answerValuesEqual(value, right[index]));
  }
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
      && leftKeys.every(key =>
        Object.prototype.hasOwnProperty.call(right, key)
        && answerValuesEqual(left[key], right[key])
      );
  }
  return false;
}

export function openFormTriggerFieldIds(
  form,
  answers,
  rule,
  previousAnswers = {},
  preferredFieldId = null,
) {
  const conditions = ruleConditions(rule);
  const uniqueFieldIds = [...new Set(conditions.map(condition => String(condition.field_id)))];
  const candidateFieldIds = (rule?.logic || 'and') === 'or'
    ? [...new Set(
      conditions
        .filter(condition => evaluateOne(form, answers, condition))
        .map(condition => String(condition.field_id)),
    )]
    : uniqueFieldIds;
  const changed = candidateFieldIds.filter(fieldId =>
    !answerValuesEqual(previousAnswers?.[fieldId], answers?.[fieldId])
  );
  const preferred = preferredFieldId == null ? null : String(preferredFieldId);
  const candidates = [
    ...(preferred && candidateFieldIds.includes(preferred) ? [preferred] : []),
    ...changed.filter(fieldId => fieldId !== preferred),
    ...candidateFieldIds.filter(fieldId => fieldId !== preferred && !changed.includes(fieldId)),
  ];

  for (const fieldId of candidates) {
    const withoutCandidate = { ...(answers || {}), [fieldId]: undefined };
    if (!evaluateOpenFormRule(form, withoutCandidate, rule)) return [fieldId];
  }

  const cleared = { ...(answers || {}) };
  const requiredFieldIds = [];
  for (const fieldId of candidates) {
    cleared[fieldId] = undefined;
    requiredFieldIds.push(fieldId);
    if (!evaluateOpenFormRule(form, cleared, rule)) return requiredFieldIds;
  }

  // Operators such as "is empty" remain matched when their answer is cleared.
  // The existing suspended-action lifecycle handles those rules until the
  // respondent changes the answer to a non-matching value.
  return [];
}