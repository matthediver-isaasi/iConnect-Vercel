const LIST_FIELD_TYPES = new Set(['list', 'picklist']);

export function isOrganisationListField(field) {
  return LIST_FIELD_TYPES.has(field?.field_type);
}

export function normalizeOrganisationCustomValue(field, value) {
  if (!isOrganisationListField(field)) {
    return value == null ? '' : value;
  }

  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = parsed ? [parsed] : [];
    }
  }

  if (parsed == null || parsed === '') return [];
  return (Array.isArray(parsed) ? parsed : [parsed])
    .map((item) => String(item))
    .filter(Boolean);
}

export function buildOrganisationCustomValueMap(fields, values) {
  const fieldsById = new Map((fields || []).map((field) => [field.id, field]));
  return Object.fromEntries((values || []).map((preferenceValue) => [
    preferenceValue.field_id,
    normalizeOrganisationCustomValue(fieldsById.get(preferenceValue.field_id), preferenceValue.value),
  ]));
}

export function organisationCustomValuesEqual(field, left, right) {
  const normalizedLeft = normalizeOrganisationCustomValue(field, left);
  const normalizedRight = normalizeOrganisationCustomValue(field, right);
  if (isOrganisationListField(field)) {
    return JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight);
  }
  return normalizedLeft === normalizedRight;
}

export function deriveOrganisationSaveChanges({
  formData,
  persistedFormData,
  customFieldValues,
  persistedCustomFieldValues,
  customFields,
  canEditField,
}) {
  const core = Object.fromEntries(
    Object.entries(formData || {}).filter(([key, value]) => (
      canEditField(key) && value !== persistedFormData?.[key]
    )),
  );
  const fieldsById = new Map((customFields || []).map((field) => [field.id, field]));
  const custom = Object.entries(customFieldValues || {})
    .filter(([fieldId, value]) => (
      canEditField(fieldId)
      && !organisationCustomValuesEqual(
        fieldsById.get(fieldId),
        value,
        persistedCustomFieldValues?.[fieldId],
      )
    ))
    .map(([fieldId, value]) => ({
      fieldId,
      value: normalizeOrganisationCustomValue(fieldsById.get(fieldId), value),
    }));

  return { core, custom };
}

export function serializeOrganisationCustomValue(field, value) {
  const normalized = normalizeOrganisationCustomValue(field, value);
  return isOrganisationListField(field) ? JSON.stringify(normalized) : normalized;
}

export async function executeOrganisationSavePlan({
  changes,
  updateCore,
  updateCustom,
  commitSnapshots,
}) {
  if (Object.keys(changes.core).length > 0) {
    await updateCore(changes.core);
  }
  for (const change of changes.custom) {
    await updateCustom(change);
  }
  commitSnapshots();
}