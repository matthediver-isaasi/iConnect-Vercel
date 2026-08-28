import {
  isRepeatableRowField,
  validateRepeatableRows,
} from '../../shared/formRepeatableRows.js';
import {
  FORM_NOT_LISTED_TEXT_KEY,
  hasEnabledFormNotListedChoice,
  isFormNotListedValue,
} from '../../shared/formNotListedChoice.js';
import {
  createFormRelationshipService,
  FormRelationshipError,
} from './formRelationshipOptions.js';

function submittedValue(submissionData, field) {
  if (Object.prototype.hasOwnProperty.call(submissionData, field.id)) return submissionData[field.id];
  if (field.name && Object.prototype.hasOwnProperty.call(submissionData, field.name)) return submissionData[field.name];
  return undefined;
}

/**
 * Validates repeatable answers exclusively against persisted field definitions.
 * Dynamic child validation is delegated to the same tenant-scoped organisation
 * and relationship service used by ordinary form fields. A shared cache avoids
 * repeating lookups when rows contain the same parent/selection.
 */
export async function validateRepeatableRowSubmission({
  db,
  tenantId,
  form,
  submissionData = {},
  relationshipService,
}) {
  if (!submissionData || typeof submissionData !== 'object' || Array.isArray(submissionData)) {
    throw new FormRelationshipError(400, 'Invalid submission data');
  }
  const fields = Array.isArray(form?.fields) ? form.fields : [];
  const repeatableFields = fields.filter(isRepeatableRowField);
  if (repeatableFields.length === 0) return;
  const service = relationshipService || createFormRelationshipService({ db, tenantId });
  const cache = new Map();

  for (const field of repeatableFields) {
    const value = submittedValue(submissionData, field);
    // Text metadata is validated by the relationship service with its child
    // field definitions; omit only that reserved key from row shape validation.
    const structuralValue = Array.isArray(value)
      ? value.map(row => (
        row && typeof row === 'object' && !Array.isArray(row)
          ? Object.fromEntries(Object.entries(row)
            .filter(([key]) => key !== FORM_NOT_LISTED_TEXT_KEY))
          : row
      ))
      : value;
    const validation = validateRepeatableRows(field, structuralValue, {
      rootFields: fields,
      isAllowedSpecialSelection: ({ child, value: selected }) => (
        isFormNotListedValue(selected) && hasEnabledFormNotListedChoice(child)
      ),
    });
    if (!validation.valid) {
      const error = new FormRelationshipError(400, validation.errors[0]?.message || 'Invalid repeatable row answer');
      error.code = validation.errors[0]?.code || 'INVALID_REPEATABLE_ROW';
      error.details = validation.errors;
      throw error;
    }
    const virtualForm = { ...form, fields: validation.config.children };
    for (let index = 0; index < validation.rows.length; index += 1) {
      const row = value[index];
      // Empty optional rows are intentionally ignored by both client and server.
      const hasValue = validation.config.children.some((child) => {
        const selected = row?.[child.id];
        return selected !== undefined && selected !== null
          && selected !== '' && (!Array.isArray(selected) || selected.length > 0);
      });
      if (!hasValue && index >= validation.config.min_rows
          && !(index === 0 && validation.config.first_row_required)) continue;
      await service.validateSubmission({
        form: virtualForm,
        submissionData: row,
        cache,
        // Root values remain separate from a row answer. Services which
        // understand scoped parents can resolve them without making root
        // values appear to be submitted child fields.
        rootForm: form,
        rootFields: fields,
        rootSubmissionData: submissionData,
        containerField: field,
        containerFieldId: field.id,
      });
    }
  }
}