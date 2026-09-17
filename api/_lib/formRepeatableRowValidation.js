import {
  effectiveRepeatableRowAnswers,
  getRepeatableRowHiddenChildIds,
  isRepeatableRowField,
  repeatableRowChildren,
  repeatableRowFieldConfigUpdate,
  repeatableSelectionContainsExcludedValue,
  resolveRepeatableExcludedValues,
  validateRepeatableRowVisibilityConfiguration,
  validateRepeatableRows,
} from '../../shared/formRepeatableRows.js';
import {
  FORM_NOT_LISTED_LABELS_KEY,
  FORM_NOT_LISTED_TEXT_KEY,
  hasEnabledFormNotListedChoice,
  isFormNotListedValue,
} from '../../shared/formNotListedChoice.js';
import {
  createFormRelationshipService,
  FormRelationshipError,
} from './formRelationshipOptions.js';
import { computeAuthoritativeHiddenFieldIds } from './formFieldVisibility.js';

function submittedValue(submissionData, field) {
  if (Object.prototype.hasOwnProperty.call(submissionData, field.id)) return submissionData[field.id];
  if (field.name && Object.prototype.hasOwnProperty.call(submissionData, field.name)) return submissionData[field.name];
  return undefined;
}

function hasHiddenField(hiddenFieldIds, id) {
  return hiddenFieldIds?.has(id) || hiddenFieldIds?.has(String(id));
}

function structuralRows(rawRows) {
  if (!Array.isArray(rawRows)) return rawRows;
  // Not-listed metadata has a deliberately separate schema. Keep it available
  // to the relationship service, but do not let repeatable row key validation
  // mistake it for a forged child id.
  return rawRows.map((row) => (
    row && typeof row === 'object' && !Array.isArray(row)
      ? Object.fromEntries(Object.entries(row).filter(([key]) => (
        key !== FORM_NOT_LISTED_TEXT_KEY && key !== FORM_NOT_LISTED_LABELS_KEY
      )))
      : row
  ));
}

/**
 * Return the non-persisted answer view for consumers which must not act on a
 * repeatable cell that was hidden in its own row. Visibility is evaluated from
 * the original row before it is projected, so a source cell can safely drive a
 * rule even when the source itself is later omitted from a side-effect view.
 */
export function effectiveRepeatableRowSubmissionData(
  form,
  submissionData = {},
  { hiddenFieldIds = new Set() } = {},
) {
  if (!submissionData || typeof submissionData !== 'object' || Array.isArray(submissionData)) {
    return submissionData;
  }
  const result = { ...submissionData };
  for (const field of form?.fields || []) {
    if (!isRepeatableRowField(field)) continue;
    const key = Object.prototype.hasOwnProperty.call(submissionData, field.id)
      ? field.id
      : (field.name && Object.prototype.hasOwnProperty.call(submissionData, field.name)
        ? field.name : null);
    if (key == null) continue;
    result[key] = effectiveRepeatableRowAnswers(field, submissionData[key], {
      hiddenFieldIds,
      parentHidden: hasHiddenField(hiddenFieldIds, field.id),
    });
  }
  return result;
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
  visibilityOptions = {},
  hiddenFieldIds,
}) {
  if (!submissionData || typeof submissionData !== 'object' || Array.isArray(submissionData)) {
    throw new FormRelationshipError(400, 'Invalid submission data');
  }
  const fields = Array.isArray(form?.fields) ? form.fields : [];
  const authoritativeHiddenFieldIds = hiddenFieldIds
    || await computeAuthoritativeHiddenFieldIds({
      db,
      tenantId,
      form,
      formValues: submissionData,
      visibilityOptions,
    });
  // A malformed persisted row rule is never permission to omit validation.
  // Check it before parent visibility filtering, including a container which
  // happens to be hidden for this particular submission.
  for (const field of fields.filter(isRepeatableRowField)) {
    const errors = validateRepeatableRowVisibilityConfiguration(field);
    if (!errors.length) continue;
    const error = new FormRelationshipError(400, errors[0].message);
    error.code = errors[0].code;
    error.details = errors;
    throw error;
  }
  const repeatableFields = fields.filter(field => (
    isRepeatableRowField(field) && !hasHiddenField(authoritativeHiddenFieldIds, field.id)
  ));
  if (repeatableFields.length === 0) return;
  const service = relationshipService || createFormRelationshipService({ db, tenantId });
  const cache = new Map();

  for (const field of repeatableFields) {
    const value = submittedValue(submissionData, field);
    const noVisibleChildWithoutARow = repeatableRowChildren(field).every((child) => (
      getRepeatableRowHiddenChildIds(field, {}, {
        hiddenFieldIds: authoritativeHiddenFieldIds,
      }).has(String(child.id))
    ));
    // A visible container with no visible child cannot collect a minimum
    // answer. This retains the established hidden-child behavior while row
    // shape/max-row checks continue to run below.
    const validationField = noVisibleChildWithoutARow
      ? {
        ...field,
        ...repeatableRowFieldConfigUpdate(field, {
          min_rows: 0,
          minimum_rows: 0,
          first_row_required: false,
          initial_row_required: false,
        }),
      }
      : field;
    // validateRepeatableRows owns both the full persisted configuration and
    // the raw row shape. It evaluates row_visibility from each raw row while
    // still rejecting forged keys (including forged values for hidden cells).
    const validation = validateRepeatableRows(validationField, structuralRows(value), {
      rootFields: fields,
      hiddenFieldIds: authoritativeHiddenFieldIds,
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
    const effectiveRows = effectiveRepeatableRowAnswers(field, value, {
      hiddenFieldIds: authoritativeHiddenFieldIds,
    });
    for (let rowIndex = 0; rowIndex < validation.rows.length; rowIndex += 1) {
      const rawRow = value?.[rowIndex];
      const row = effectiveRows?.[rowIndex];
      const hiddenChildIds = getRepeatableRowHiddenChildIds(field, rawRow, {
        hiddenFieldIds: authoritativeHiddenFieldIds,
      });
      const visibleChildren = validation.config.children
        .filter(child => !hiddenChildIds.has(String(child.id)));
      for (const child of visibleChildren) {
        const excludedValues = resolveRepeatableExcludedValues(child, fields, submissionData, field);
        if (repeatableSelectionContainsExcludedValue(
          row?.[child.id],
          child,
          excludedValues,
        )) {
          const error = new FormRelationshipError(
            400,
            `${child.label || child.id} contains a value selected in an earlier field`,
          );
          error.code = 'excluded_repeatable_value';
          error.details = [{
            code: 'excluded_repeatable_value',
            row: rowIndex,
            child_id: child.id,
            message: error.message,
          }];
          throw error;
        }
      }
      if (visibleChildren.length === 0) continue;
      // Keep every persisted child definition and the raw row available to
      // this validator. Conditional options, relationship parents, and
      // Not-listed validation can depend on a source cell hidden in this
      // particular row. The row-local hidden set suppresses validations and
      // side effects for hidden targets without erasing their raw sources.
      const virtualForm = { ...form, fields: validation.config.children };
      // Empty optional rows are intentionally ignored by both client and server.
      const hasValue = visibleChildren.some((child) => {
        const selected = row?.[child.id];
        return selected !== undefined && selected !== null
          && selected !== '' && (!Array.isArray(selected) || selected.length > 0);
      });
      if (!hasValue && rowIndex >= validation.config.min_rows
          && !(rowIndex === 0 && validation.config.first_row_required)) continue;
      await service.validateSubmission({
        form: virtualForm,
        submissionData: rawRow,
        cache,
        // Root values remain separate from a row answer. Services which
        // understand scoped parents can resolve them without making root
        // values appear to be submitted child fields.
        rootForm: form,
        rootFields: fields,
        rootSubmissionData: submissionData,
        containerField: field,
        containerFieldId: field.id,
        hiddenFieldIds: hiddenChildIds,
        visibilityOptions,
      });
    }
  }
}