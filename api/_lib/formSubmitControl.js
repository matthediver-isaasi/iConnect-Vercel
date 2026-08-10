/**
 * Conditional-logic "submit control" actions (Task #3474).
 *
 * A form's visibility_rules may contain actions of type `submit_control`:
 *   { id, action_type: 'submit_control', submit_state: 'disable'|'enable', message?: string }
 *
 * Semantics:
 *  - The submit button starts enabled.
 *  - If ANY rule whose conditions currently match carries a matched
 *    `disable` submit action, submit is disabled…
 *  - …unless ANY matched rule carries an `enable` submit action — enable
 *    overrides disable (mirrors how "show" re-reveals a hidden field).
 *  - The hint message shown near the button is the first matched disable
 *    action's message (in rule order).
 *
 * This module is React-free and shared verbatim by the public form client
 * (FormView) and the server-side submission processor so the two can never
 * drift. The condition evaluator mirrors FormView.evaluateSingleCondition
 * (boolean normalization on equality operators, array handling) — keep them
 * in sync if operators are ever added.
 */

const normalizeBooleanCompareValue = (v) => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const lower = v.trim().toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
  }
  return v;
};

// ── Survey score answers & numeric operators ──────────────────────────────
// Mirrors client/src/lib/surveyConditions.js (evaluateScoreCondition): score
// answers are objects ({score:n}/{na:true}) and surveys add numeric compare
// operators. Returns true/false when this path owns the comparison,
// otherwise undefined (fall through to the standard logic below).
const NUMERIC_OPERATORS = new Set([
  'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'between',
]);

const toScoreNumber = (triggerValue) => {
  let v = triggerValue;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if (v.na === true) return null;
    v = v.score;
  }
  if (v === undefined || v === null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const isScoreObject = (v) => v && typeof v === 'object' && !Array.isArray(v) && ('score' in v || 'na' in v);

const evaluateScoreCondition = (triggerValue, operator, value) => {
  const numeric = toScoreNumber(triggerValue);

  if (NUMERIC_OPERATORS.has(operator)) {
    if (numeric === null) return false;
    if (operator === 'between') {
      let lo; let hi;
      if (Array.isArray(value)) { [lo, hi] = value; }
      else if (typeof value === 'string') { [lo, hi] = value.split(/[,\u2013-]/).map((s) => s.trim()); }
      else if (value && typeof value === 'object') { lo = value.from; hi = value.to; }
      lo = Number(lo); hi = Number(hi);
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return false;
      return numeric >= Math.min(lo, hi) && numeric <= Math.max(lo, hi);
    }
    const compare = Number(value);
    if (!Number.isFinite(compare)) return false;
    switch (operator) {
      case 'greater_than': return numeric > compare;
      case 'greater_than_or_equal': return numeric >= compare;
      case 'less_than': return numeric < compare;
      case 'less_than_or_equal': return numeric <= compare;
      default: return false;
    }
  }

  if (isScoreObject(triggerValue)) {
    switch (operator) {
      case 'equals': {
        const compare = Number(value);
        return numeric !== null && Number.isFinite(compare) && numeric === compare;
      }
      case 'not_equals': {
        const compare = Number(value);
        return numeric === null || !Number.isFinite(compare) || numeric !== compare;
      }
      case 'not_empty': return true; // an object answer (score or N/A) is an answer
      case 'is_empty': return false;
      default: return undefined;
    }
  }

  return undefined;
};

export function evaluateSubmitControlCondition(triggerValue, operator, value) {
  const scoreResult = evaluateScoreCondition(triggerValue, operator, value);
  if (scoreResult !== undefined) return scoreResult;
  const isBooleanTrigger = typeof triggerValue === 'boolean';
  switch (operator) {
    case 'equals':
      if (isBooleanTrigger) return triggerValue === normalizeBooleanCompareValue(value);
      if (Array.isArray(triggerValue)) return triggerValue.includes(value);
      return triggerValue === value;
    case 'not_equals':
      if (isBooleanTrigger) return triggerValue !== normalizeBooleanCompareValue(value);
      if (Array.isArray(triggerValue)) return !triggerValue.includes(value);
      return triggerValue !== value;
    case 'contains':
      if (Array.isArray(triggerValue)) return triggerValue.includes(value);
      if (typeof triggerValue === 'string') return triggerValue.includes(value);
      return false;
    case 'not_empty':
      return triggerValue !== undefined && triggerValue !== null && triggerValue !== '' &&
        (!Array.isArray(triggerValue) || triggerValue.length > 0);
    case 'is_empty':
      return triggerValue === undefined || triggerValue === null || triggerValue === '' ||
        (Array.isArray(triggerValue) && triggerValue.length === 0);
    default:
      return false;
  }
}

// Rule-level condition evaluation with legacy single-trigger + AND/OR
// conditions array support (mirrors FormView.evaluateRuleConditions).
export function evaluateSubmitControlRule(rule, formValues) {
  if (!rule) return false;
  const values = formValues || {};
  if (rule.trigger_field_id && (!Array.isArray(rule.conditions) || rule.conditions.length === 0)) {
    return evaluateSubmitControlCondition(values[rule.trigger_field_id], rule.operator, rule.value);
  }
  if (Array.isArray(rule.conditions) && rule.conditions.length > 0) {
    const results = rule.conditions.map((c) => {
      if (!c || !c.field_id) return false;
      return evaluateSubmitControlCondition(values[c.field_id], c.operator, c.value);
    });
    return String(rule.logic || 'and').toLowerCase() === 'or'
      ? results.some((r) => r === true)
      : results.every((r) => r === true);
  }
  return false;
}

export function isSubmitControlAction(action) {
  return !!action && action.action_type === 'submit_control' &&
    (action.submit_state === 'disable' || action.submit_state === 'enable');
}

/**
 * Resolve the submit-control state for the current answers.
 * Returns { disabled: boolean, message: string|null }.
 * Forms with no submit_control actions always resolve to { disabled: false }.
 */
export function resolveSubmitControl(visibilityRules, formValues) {
  const rules = Array.isArray(visibilityRules) ? visibilityRules : [];
  let anyDisable = false;
  let anyEnable = false;
  let message = null;

  for (const rule of rules) {
    if (!rule) continue;
    const actions = Array.isArray(rule.actions) ? rule.actions.filter(isSubmitControlAction) : [];
    if (actions.length === 0) continue;
    if (!rule.trigger_field_id && !(Array.isArray(rule.conditions) && rule.conditions.length > 0)) continue;
    const met = evaluateSubmitControlRule(rule, formValues);
    if (!met) continue;
    for (const action of actions) {
      if (action.submit_state === 'disable') {
        anyDisable = true;
        if (message === null) {
          const msg = typeof action.message === 'string' ? action.message.trim() : '';
          if (msg) message = msg;
        }
      } else if (action.submit_state === 'enable') {
        anyEnable = true;
      }
    }
  }

  const disabled = anyDisable && !anyEnable;
  return { disabled, message: disabled ? message : null };
}
