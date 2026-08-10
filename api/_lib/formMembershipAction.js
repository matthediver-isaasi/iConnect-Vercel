/**
 * Conditional-logic "membership structure" action (Task #3489).
 *
 * A form's visibility_rules may contain (at most one per rule) an action:
 *   { id, action_type: 'membership_structure', config_id: '<uuid>',
 *     field_mappings?: { <prefFieldId | 'core:<name>'>: '<formFieldId>' } }
 *
 * Semantics:
 *  - Rules are evaluated in stored order against the current answers using
 *    the SAME condition evaluator as submit-control rules.
 *  - The FIRST matched rule carrying a membership action wins (deterministic
 *    precedence); later matches are ignored.
 *  - `field_mappings` maps membership calculation inputs (preference field
 *    ids, or 'core:<name>' pseudo-fields such as 'core:member_count') to
 *    form field ids, so the fee can be derived from the applicant's answers
 *    before any member/organisation record exists.
 *
 * React-free and shared by the public form client and the server payment
 * endpoints so the two can never drift.
 */

import { evaluateSubmitControlRule } from './formSubmitControl.js';

export function isMembershipStructureAction(action) {
  return !!action
    && action.action_type === 'membership_structure'
    && typeof action.config_id === 'string'
    && action.config_id.trim() !== '';
}

/**
 * Resolve the membership action for the current answers.
 * Returns { configId, fieldMappings, ruleId, actionId } for the first
 * matched rule carrying a valid membership action, or null.
 */
export function resolveMembershipAction(visibilityRules, formValues, options = {}) {
  const rules = Array.isArray(visibilityRules) ? visibilityRules : [];
  for (const rule of rules) {
    if (!rule) continue;
    const actions = Array.isArray(rule.actions) ? rule.actions.filter(isMembershipStructureAction) : [];
    if (actions.length === 0) continue;
    if (!rule.trigger_field_id && !(Array.isArray(rule.conditions) && rule.conditions.length > 0)) continue;
    if (!evaluateSubmitControlRule(rule, formValues, options)) continue;
    const action = actions[0];
    return {
      configId: action.config_id.trim(),
      fieldMappings: (action.field_mappings && typeof action.field_mappings === 'object')
        ? action.field_mappings : {},
      ruleId: rule.id ?? null,
      actionId: action.id ?? null,
    };
  }
  return null;
}

/**
 * Build simulation fieldOverrides from an action's field_mappings and the
 * submitted answers. Keys are preference field ids or 'core:<name>' keys —
 * exactly the override keys the membership simulation understands. Empty /
 * missing answers are skipped (so the simulation falls back to stored
 * values, if any exist).
 */
export function buildMembershipFieldOverrides(fieldMappings, formValues) {
  const overrides = {};
  const mappings = (fieldMappings && typeof fieldMappings === 'object') ? fieldMappings : {};
  const values = formValues || {};
  for (const [targetKey, formFieldId] of Object.entries(mappings)) {
    if (!targetKey || !formFieldId) continue;
    const v = values[formFieldId];
    if (v === undefined || v === null || v === '') continue;
    overrides[targetKey] = v;
  }
  return overrides;
}
