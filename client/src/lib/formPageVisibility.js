/**
 * Resolve the embedded form's field/page visibility projection.
 *
 * Page ids must be classified before field ids: visibility.field_states can
 * target either kind of object, and page targets hide all of their fields.
 * This deliberately only computes visibility. It never mutates answers, so a
 * later rule change can reveal a page with the respondent's previous values.
 */
export function resolveFormPageVisibility({
  fields = [],
  pages = [],
  visibilityRules = [],
  formValues = {},
  evaluateRuleConditions,
}) {
  const formFields = Array.isArray(fields) ? fields : [];
  const formPages = Array.isArray(pages) ? pages : [];
  const rules = Array.isArray(visibilityRules) ? visibilityRules : [];
  const pageIdSet = new Set(formPages.map(page => page?.id));
  const evaluate = typeof evaluateRuleConditions === 'function'
    ? evaluateRuleConditions
    : () => false;

  const hiddenFields = new Set(
    formFields
      .filter(field => field?.starts_hidden === true || field?.starts_hidden === 'true')
      .map(field => field.id),
  );
  const hiddenPages = new Set(
    formPages
      .filter(page => page?.starts_hidden === true || page?.starts_hidden === 'true')
      .map(page => page.id),
  );

  // Match FormView/api legacy initialization: show targets are treated as
  // fields only, and this fallback is used only when no field already has
  // starts_hidden. Page visibility is represented by field_states targets.
  if (hiddenFields.size === 0 && rules.length > 0) {
    for (const rule of rules) {
      if (rule?.actions && Array.isArray(rule.actions)) {
        for (const action of rule.actions) {
          if (action.action_type === 'visibility' && action.field_states) {
            for (const [targetId, state] of Object.entries(action.field_states)) {
              if (state?.visible === true && !pageIdSet.has(targetId)) {
                hiddenFields.add(targetId);
              }
            }
          } else if (action.action_type === 'show' && action.target_field_ids?.length) {
            action.target_field_ids.forEach(targetId => hiddenFields.add(targetId));
          }
        }
      } else if (rule?.action === 'show' && rule.target_field_ids?.length) {
        rule.target_field_ids.forEach(targetId => hiddenFields.add(targetId));
      }
    }
  }

  const fieldVisibility = {};
  const pageVisibility = {};
  for (const rule of rules) {
    if (!rule?.conditions?.length && !rule?.trigger_field_id) continue;
    const conditionMet = evaluate(rule, formValues);

    if (rule.actions && Array.isArray(rule.actions)) {
      for (const action of rule.actions) {
        if (action.action_type === 'visibility' && action.field_states) {
          for (const [targetId, state] of Object.entries(action.field_states)) {
            const visibility = pageIdSet.has(targetId) ? pageVisibility : fieldVisibility;
            if (!visibility[targetId]) {
              visibility[targetId] = { showRules: [], hideRules: [] };
            }
            if (state?.visible === true) {
              visibility[targetId].showRules.push(conditionMet);
            } else if (state?.visible === false) {
              visibility[targetId].hideRules.push(conditionMet);
            }
          }
        } else if (action.action_type === 'show' || action.action_type === 'hide') {
          for (const targetId of action.target_field_ids || []) {
            if (!fieldVisibility[targetId]) {
              fieldVisibility[targetId] = { showRules: [], hideRules: [] };
            }
            if (action.action_type === 'show') {
              fieldVisibility[targetId].showRules.push(conditionMet);
            } else {
              fieldVisibility[targetId].hideRules.push(conditionMet);
            }
          }
        }
      }
    } else if (rule.target_field_ids?.length) {
      for (const targetId of rule.target_field_ids) {
        if (!fieldVisibility[targetId]) {
          fieldVisibility[targetId] = { showRules: [], hideRules: [] };
        }
        if (rule.action === 'show') {
          fieldVisibility[targetId].showRules.push(conditionMet);
        } else if (rule.action === 'hide') {
          fieldVisibility[targetId].hideRules.push(conditionMet);
        }
      }
    }
  }

  // Shows reveal, then hides win if both conditions match.
  for (const [targetId, { showRules, hideRules }] of Object.entries(fieldVisibility)) {
    if (showRules.some(result => result === true)) hiddenFields.delete(targetId);
    if (hideRules.some(result => result === true)) hiddenFields.add(targetId);
  }
  for (const [pageId, { showRules, hideRules }] of Object.entries(pageVisibility)) {
    if (showRules.some(result => result === true)) hiddenPages.delete(pageId);
    if (hideRules.some(result => result === true)) hiddenPages.add(pageId);
  }

  for (const field of formFields) {
    if (field?.page_id && hiddenPages.has(field.page_id)) {
      hiddenFields.add(field.id);
    }
  }

  return { hiddenFieldIds: hiddenFields, hiddenPageIds: hiddenPages };
}
