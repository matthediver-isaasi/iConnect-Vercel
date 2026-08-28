import {
  FORM_NOT_LISTED_LABELS_KEY,
  FORM_NOT_LISTED_TEXT_KEY,
  containsFormNotListedValue,
  setFormNotListedText,
} from '../../shared/formNotListedChoice.js';

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

  await relationshipService.validateSubmission({
    form,
    submissionData: normalizeSubmissionFieldIds(form, updatedSubmissionData),
    allowMissingNotListedText: ({ field, containerField }) => (
      (containerField?.id || field?.id) !== fieldId
    ),
  });
  if (hasDueDiligenceRecord) {
    await relationshipService.validateSubmission({
      form,
      submissionData: normalizeSubmissionFieldIds(form, updatedOriginalValues),
      allowMissingNotListedText: ({ field, containerField }) => (
        (containerField?.id || field?.id) !== fieldId
      ),
    });
  }

  return { updatedSubmissionData, updatedOriginalValues };
}