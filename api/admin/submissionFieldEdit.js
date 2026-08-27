export function effectiveSubmissionFieldEdit(submissionData, fieldId, value) {
  const savedValues = submissionData
    && typeof submissionData === 'object'
    && !Array.isArray(submissionData)
    ? submissionData
    : {};
  const updatedSubmissionData = {
    ...savedValues,
    [fieldId]: value,
  };
  return updatedSubmissionData;
}

export function normalizeSubmissionFieldIds(form, submissionData) {
  const values = submissionData
    && typeof submissionData === 'object'
    && !Array.isArray(submissionData)
    ? submissionData
    : {};
  const normalized = {};

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
}) {
  const updatedSubmissionData = effectiveSubmissionFieldEdit(
    submissionData,
    fieldId,
    value,
  );
  const updatedOriginalValues = hasDueDiligenceRecord
    ? effectiveSubmissionFieldEdit(originalFormValues, fieldId, value)
    : null;

  await relationshipService.validateSubmission({
    form,
    submissionData: normalizeSubmissionFieldIds(form, updatedSubmissionData),
  });
  if (hasDueDiligenceRecord) {
    await relationshipService.validateSubmission({
      form,
      submissionData: normalizeSubmissionFieldIds(form, updatedOriginalValues),
    });
  }

  return { updatedSubmissionData, updatedOriginalValues };
}