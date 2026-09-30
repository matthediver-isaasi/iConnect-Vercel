import { evaluateSubmitControlRule } from './formSubmitControl.js';
import { FormRelationshipError } from './formRelationshipOptions.js';
import { isFormNotListedValue } from '../../shared/formNotListedChoice.js';
import { isRelationshipMultiSelect } from '../../shared/formRelationshipSelection.js';

function validationError(message) {
  const error = new FormRelationshipError(400, message);
  error.code = 'DISPLAY_NAME_COPY_INVALID';
  return error;
}

function displayNameCopyConfiguration(action, fields) {
  if (action?.set_value_source !== 'field') return null;
  if (action?.copy_mode != null && !['stored_value', 'display_name'].includes(action.copy_mode)) {
    return { invalid: true };
  }
  if (action?.copy_mode !== 'display_name') return null;
  const source = fields.find(field => String(field?.id) === String(action.set_value_field_id));
  const target = fields.find(field => String(field?.id) === String(action.target_field_id));
  if (!source || !target
    || source.repeatable_container_field_id
    || source.option_source !== undefined
    || !['organisation_dropdown', 'organisation_group_dropdown', 'relationship_dropdown'].includes(source.type)
    || isRelationshipMultiSelect(source)
    || !['text', 'textarea'].includes(target.type)) {
    return { invalid: true };
  }
  return { source, target };
}

/**
 * Re-derives every active display-name copy from persisted, respondent-scoped
 * picker options. This belongs in the shared server layer because plain and
 * payment submissions both create a form_submission before downstream writes.
 */
export async function validateConditionalDisplayNameCopies({
  db, tenantId, form, submissionData, visibilityOptions = {}, relationshipService,
}) {
  const fields = form?.fields || [];
  for (const rule of form?.visibility_rules || []) {
    if (!evaluateSubmitControlRule(rule, submissionData, visibilityOptions)) continue;
    const actions = Array.isArray(rule.actions)
      ? rule.actions
      : ((rule?.rule_type === 'set_value' || rule?.action === 'set_value') ? [rule] : []);
    for (const action of actions) {
      const config = displayNameCopyConfiguration(action, fields);
      if (!config) continue;
      if (config.invalid) throw validationError('Invalid display-name copy configuration');
      const selected = submissionData?.[config.source.id];
      let expected = '';
      if (isFormNotListedValue(selected) || Array.isArray(selected)) {
        throw validationError('Display-name source is unavailable');
      }
      if (selected != null && selected !== '') {
        if (typeof selected !== 'string' && typeof selected !== 'number') {
          throw validationError('Invalid display-name copy selection');
        }
        if (config.source.type === 'relationship_dropdown') {
          const parentId = submissionData?.[config.source.parent_field_id];
          if (!parentId) throw validationError('Display-name source is unavailable');
          // relationshipOptions deliberately has bounded public pagination.
          // Walk its ordinary pages rather than adding an unrestricted "all"
          // transport flag, so a valid option after page one can be verified
          // without broadening the public endpoint's data exposure.
          const pageSize = 25;
          let page = 1;
          let total = null;
          do {
            const options = await relationshipService.relationshipOptions({
              form,
              fieldId: config.source.id,
              parentRecordId: parentId,
              query: { page, pageSize },
            });
            const match = (options.data || []).find(option => String(option.id) === String(selected));
            if (match) {
              expected = match.label || '';
              break;
            }
            total = Number.isFinite(options.total) ? options.total : 0;
            page += 1;
          } while ((page - 1) * pageSize < total);
        } else {
          const table = config.source.type === 'organisation_dropdown' ? 'organization' : 'organization_group';
          const { data, error } = await db.from(table).select('name').eq('tenant_id', tenantId)
            .eq('id', selected).maybeSingle();
          if (error) throw error;
          expected = data?.name || '';
        }
        if (!expected) throw validationError('Display-name source is unavailable');
      }
      if (submissionData?.[config.target.id] !== expected) {
        throw validationError('Display-name copy is unresolved or stale');
      }
    }
  }
}