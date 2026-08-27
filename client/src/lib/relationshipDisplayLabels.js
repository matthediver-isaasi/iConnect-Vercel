export const UNAVAILABLE_RELATIONSHIP_RECORD = 'Unavailable record';

export function isRelationshipDropdownField(field) {
  return field?.type === 'relationship_dropdown';
}

export function getSubmissionFieldValue(values, field) {
  if (!values || typeof values !== 'object' || !field) return undefined;
  if (field.id != null && values[field.id] !== undefined) return values[field.id];
  if (field.name != null) return values[field.name];
  return undefined;
}

export function resolveSubmissionField(fields, key) {
  if (key == null) return undefined;
  const candidates = Array.isArray(fields) ? fields : [];
  return candidates.find((field) => field?.id === key)
    || candidates.find((field) => field?.name === key);
}

export function collectRelationshipRecordIds(fields, values) {
  const ids = new Set();
  if (!values || typeof values !== 'object') return [];

  for (const field of fields || []) {
    if (!isRelationshipDropdownField(field) || (field.id == null && field.name == null)) continue;
    const raw = getSubmissionFieldValue(values, field);
    const entries = Array.isArray(raw) ? raw : [raw];
    for (const entry of entries) {
      if (entry != null && entry !== '') ids.add(String(entry));
    }
  }
  return [...ids];
}

export function collectRelationshipRecordIdsFromSubmissions(formsById, submissions) {
  const ids = new Set();
  for (const submission of submissions || []) {
    const fields = formsById?.[submission?.form_id]?.fields || [];
    for (const id of collectRelationshipRecordIds(fields, submission?.submission_data)) ids.add(id);
  }
  return [...ids];
}

export function resolveRelationshipDisplayLabel(
  value,
  labelsByRecordId,
  fallback = UNAVAILABLE_RELATIONSHIP_RECORD,
) {
  if (value == null || value === '') return '';
  const key = String(value);
  const label = labelsByRecordId instanceof Map
    ? labelsByRecordId.get(key)
    : labelsByRecordId?.[key];
  return typeof label === 'string' && label.trim() ? label.trim() : fallback;
}

export function formatRelationshipDisplayValue(value, labelsByRecordId, fallback) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => resolveRelationshipDisplayLabel(entry, labelsByRecordId, fallback))
      .filter(Boolean)
      .join(', ');
  }
  return resolveRelationshipDisplayLabel(value, labelsByRecordId, fallback);
}