import {
  isRepeatableRowField,
  normalizeRepeatableRowField,
  repeatableRowChildren,
  repeatableRowFieldConfigUpdate,
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
import { computeHiddenFieldIds } from './formFieldVisibility.js';

function submittedValue(submissionData, field) {
  if (Object.prototype.hasOwnProperty.call(submissionData, field.id)) return submissionData[field.id];
  if (field.name && Object.prototype.hasOwnProperty.call(submissionData, field.name)) return submissionData[field.name];
  return undefined;
}

function isRelationshipSelectionField(field) {
  return field?.type === 'organisation_dropdown'
    || field?.type === 'organisation_group_dropdown'
    || field?.type === 'relationship_dropdown';
}

function validateAllHiddenRelationshipRows(value, hiddenChildIds, maxRows) {
  const errors = [];
  const rows = Array.isArray(value) ? value : [];
  if (value !== undefined && value !== null && !Array.isArray(value)) {
    errors.push({
      code: 'invalid_rows',
      message: 'Repeatable row answer must be an array',
    });
  }
  if (rows.length > maxRows) {
    errors.push({
      code: 'max_rows',
      message: `No more than ${maxRows} row(s) are allowed`,
    });
  }
  const rowIds = new Set();
  rows.forEach((row, rowIndex) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      errors.push({
        code: 'invalid_row',
        row: rowIndex,
        message: `Row ${rowIndex + 1} is invalid`,
      });
      return;
    }
    for (const key of Object.keys(row)) {
      if (key !== '_row_id' && key !== FORM_NOT_LISTED_TEXT_KEY
          && !hiddenChildIds.has(key)) {
        errors.push({
          code: 'unknown_child',
          row: rowIndex,
          child_id: key,
          message: `Row ${rowIndex + 1} contains an unsupported field`,
        });
      }
    }
    if (row._row_id !== undefined) {
      if (typeof row._row_id !== 'string' || !row._row_id.trim()
          || row._row_id.length > 200 || rowIds.has(row._row_id)) {
        errors.push({
          code: 'invalid_row_id',
          row: rowIndex,
          message: `Row ${rowIndex + 1} has an invalid row ID`,
        });
      } else {
        rowIds.add(row._row_id);
      }
    }
  });
  return {
    valid: errors.length === 0,
    errors,
    rows,
    config: {
      children: [],
      min_rows: 0,
      first_row_required: false,
    },
  };
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
    || computeHiddenFieldIds(form, submissionData, visibilityOptions);
  const repeatableFields = fields.filter(field => (
    isRepeatableRowField(field) && !authoritativeHiddenFieldIds.has(field.id)
  ));
  if (repeatableFields.length === 0) return;
  const service = relationshipService || createFormRelationshipService({ db, tenantId });
  const cache = new Map();

  for (const field of repeatableFields) {
    const value = submittedValue(submissionData, field);
    const hiddenChildIds = new Set(repeatableRowChildren(field)
      .filter(child => authoritativeHiddenFieldIds.has(child?.id)
        && isRelationshipSelectionField(child))
      .map(child => child.id));
    const validationField = hiddenChildIds.size > 0
      ? {
        ...field,
        ...repeatableRowFieldConfigUpdate(field, {
          children: repeatableRowChildren(field)
            .filter(child => !hiddenChildIds.has(child?.id)),
        }),
      }
      : field;
    // Text metadata is validated by the relationship service with its child
    // field definitions. Hidden relationship selections are removed only from
    // this validation copy; the submitted payload remains unchanged.
    const structuralValue = Array.isArray(value)
      ? value.map(row => (
        row && typeof row === 'object' && !Array.isArray(row)
          ? Object.fromEntries(Object.entries(row)
            .filter(([key]) => key !== FORM_NOT_LISTED_TEXT_KEY
              && !hiddenChildIds.has(key)))
          : row
      ))
      : value;
    const validation = repeatableRowChildren(validationField).length === 0
      ? validateAllHiddenRelationshipRows(
        value,
        hiddenChildIds,
        normalizeRepeatableRowField(field).max_rows,
      )
      : validateRepeatableRows(validationField, structuralValue, {
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
        hiddenFieldIds: authoritativeHiddenFieldIds,
        visibilityOptions,
      });
    }
  }
}