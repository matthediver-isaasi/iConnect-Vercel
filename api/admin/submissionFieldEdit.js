import {
  FORM_NOT_LISTED_LABELS_KEY,
  FORM_NOT_LISTED_TEXT_KEY,
  containsFormNotListedValue,
  setFormNotListedText,
} from '../../shared/formNotListedChoice.js';
import {
  computeAuthoritativeHiddenFieldIds,
  computeHiddenFieldIds,
} from '../_lib/formFieldVisibility.js';
import { validateFutureDateFields } from '../../shared/formFutureDates.js';

export function effectiveSubmissionFieldEdit(
  submissionData,
  fieldId,
  value,
  { hasNotListedText = false, notListedText } = {},
) {
  const savedValues = submissionData
    && typeof submissionData === 'object'
    && !Array.isArray(submissionData)
    ? submissionData
    : {};
  const updatedSubmissionData = {
    ...savedValues,
    [fieldId]: value,
  };
  return containsFormNotListedValue(value)
    ? (hasNotListedText
      ? setFormNotListedText(updatedSubmissionData, fieldId, notListedText)
      : updatedSubmissionData)
    : setFormNotListedText(updatedSubmissionData, fieldId, '');
}

export function normalizeSubmissionFieldIds(form, submissionData) {
  const values = submissionData
    && typeof submissionData === 'object'
    && !Array.isArray(submissionData)
    ? submissionData
    : {};
  const normalized = {};
  for (const reservedKey of [FORM_NOT_LISTED_LABELS_KEY, FORM_NOT_LISTED_TEXT_KEY]) {
    if (Object.prototype.hasOwnProperty.call(values, reservedKey)) {
      normalized[reservedKey] = values[reservedKey];
    }
  }

  for (const field of (Array.isArray(form?.fields) ? form.fields : [])) {
    if (!field?.id) continue;
    const hasIdValue = Object.prototype.hasOwnProperty.call(values, field.id)
      && values[field.id] !== undefined;
    normalized[field.id] = hasIdValue
      ? values[field.id]
      : (field.name ? values[field.name] : undefined);
  }

  return normalized;
}

export async function validateSubmissionFieldEditCandidates({
  relationshipService,
  form,
  submissionData,
  originalFormValues,
  hasDueDiligenceRecord,
  fieldId,
  value,
  hasNotListedText = false,
  notListedText,
  visibilityOptions = {},
  db = null,
  tenantId = null,
}) {
  const updatedSubmissionData = effectiveSubmissionFieldEdit(
    submissionData,
    fieldId,
    value,
    { hasNotListedText, notListedText },
  );
  const updatedOriginalValues = hasDueDiligenceRecord
    ? effectiveSubmissionFieldEdit(
      originalFormValues,
      fieldId,
      value,
      { hasNotListedText, notListedText },
    )
    : null;

  const resolveHiddenFieldIds = async candidate => (
    db && tenantId
      ? computeAuthoritativeHiddenFieldIds({
        db,
        tenantId,
        form,
        formValues: candidate,
        visibilityOptions,
      })
      : computeHiddenFieldIds(form, candidate, visibilityOptions)
  );
  const validateFutureDates = async (candidate, previous) => {
    const hiddenFieldIds = await resolveHiddenFieldIds(candidate);
    const errors = validateFutureDateFields(
      form?.fields || [],
      candidate,
      {
        hiddenFieldIds,
        previousValues: previous,
      },
    );
    if (!errors.length) return;
    const error = new Error(errors[0].message);
    error.status = 400;
    error.code = 'FUTURE_DATE_INVALID';
    error.details = errors;
    throw error;
  };
  await validateFutureDates(updatedSubmissionData, submissionData);
  if (hasDueDiligenceRecord) {
    await validateFutureDates(updatedOriginalValues, originalFormValues ?? submissionData);
  }

  const hiddenFieldIds = await resolveHiddenFieldIds(updatedSubmissionData);
  await relationshipService.validateSubmission({
    form,
    submissionData: normalizeSubmissionFieldIds(form, updatedSubmissionData),
    hiddenFieldIds,
    allowMissingNotListedText: ({ field, containerField }) => (
      (containerField?.id || field?.id) !== fieldId
    ),
  });
  if (hasDueDiligenceRecord) {
    await relationshipService.validateSubmission({
      form,
      submissionData: normalizeSubmissionFieldIds(form, updatedOriginalValues),
      hiddenFieldIds: await resolveHiddenFieldIds(updatedOriginalValues),
      allowMissingNotListedText: ({ field, containerField }) => (
        (containerField?.id || field?.id) !== fieldId
      ),
    });
  }

  return { updatedSubmissionData, updatedOriginalValues };
}