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
  if (!action || action.action_type !== 'membership_structure') return false;
  // Auto-resolve mode (Task #3659): no pinned structure — the concrete
  // config is resolved from the mapped answer at quote/charge time.
  if (action.resolve_mode === 'auto') return true;
  return typeof action.config_id === 'string' && action.config_id.trim() !== '';
}

/**
 * Resolve the membership action for the current answers.
 * Returns { configId, autoResolve, fieldMappings, ruleId, actionId } for
 * the first matched rule carrying a valid membership action, or null.
 * In auto-resolve mode configId is null and autoResolve is true.
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
    const autoResolve = action.resolve_mode === 'auto';
    return {
      configId: autoResolve ? null : action.config_id.trim(),
      autoResolve,
      fieldMappings: (action.field_mappings && typeof action.field_mappings === 'object')
        ? action.field_mappings : {},
      ruleId: rule.id ?? null,
      actionId: action.id ?? null,
    };
  }
  return null;
}

/**
 * Auto-resolve the concrete membership structure from the mapped form
 * answers (Task #3659). Mirrors getConfigForMember's scoped match-value
 * semantics: among the supplied ACTIVE configs of the requested scope,
 * the first whose structure_match_value equals (case-insensitive, trimmed)
 * the override value for its structure_field_id wins; configs without a
 * structure field are an unscoped fallback. Pure — the caller supplies
 * today's-effective configs (getAllActiveConfigs) and the overrides built
 * from the form answers.
 *
 * Returns { config } or { error } (descriptive, never a £0 fallback).
 */
export function autoResolveMembershipConfig(activeConfigs, fieldOverrides = {}, { scope = 'member' } = {}) {
  const all = Array.isArray(activeConfigs) ? activeConfigs : [];
  const configs = all.filter(c => c && (c.structure_scope_type || 'organization') === scope);
  if (configs.length === 0) {
    return { error: 'No membership structures are currently in effect for this form. Ask the administrator to update the form.' };
  }
  const scoped = configs.filter(c => c.structure_field_id && c.structure_match_value);
  const unscoped = configs.filter(c => !c.structure_field_id);

  const norm = (v) => (v === undefined || v === null) ? '' : String(v).toLowerCase().trim();
  const overrides = (fieldOverrides && typeof fieldOverrides === 'object') ? fieldOverrides : {};

  for (const cfg of scoped) {
    const answer = norm(overrides[cfg.structure_field_id]);
    const matchVal = norm(cfg.structure_match_value);
    if (answer && matchVal && answer === matchVal) {
      return { config: cfg };
    }
  }
  if (unscoped.length > 0) return { config: unscoped[0] };

  if (scoped.length === 0) {
    return { error: 'No membership structures are currently in effect for this form. Ask the administrator to update the form.' };
  }
  // Descriptive no-match error: surface the applicant's mapped answer.
  let rawAnswer = null;
  for (const cfg of scoped) {
    const v = overrides[cfg.structure_field_id];
    if (v !== undefined && v !== null && String(v).trim() !== '') { rawAnswer = String(v).trim(); break; }
  }
  if (rawAnswer === null) {
    return { error: 'The membership structure could not be determined because the answer it depends on is missing.' };
  }
  return { error: `No membership structure matches '${rawAnswer}'` };
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
