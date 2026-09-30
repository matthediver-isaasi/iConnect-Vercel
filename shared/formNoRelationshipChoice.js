export const FORM_NO_RELATIONSHIP_VALUE = '__form_no_relationship__';
export const DEFAULT_FORM_NO_RELATIONSHIP_LABEL = 'No active related records are available for this organisation.';

export function formNoRelationshipLabel(field) {
  if (field?.type !== 'relationship_dropdown') return '';
  const configured = typeof field?.no_relationship_found_label === 'string'
    ? field.no_relationship_found_label.trim()
    : '';
  return configured || DEFAULT_FORM_NO_RELATIONSHIP_LABEL;
}

export function isFormNoRelationshipValue(value) {
  return value === FORM_NO_RELATIONSHIP_VALUE;
}

export function containsFormNoRelationshipValue(value) {
  if (isFormNoRelationshipValue(value)) return true;
  if (Array.isArray(value)) return value.some(containsFormNoRelationshipValue);
  if (value && typeof value === 'object') {
    return Object.values(value).some(containsFormNoRelationshipValue);
  }
  return false;
}

export function stripFormNoRelationshipValues(values, fields) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return values;
  const next = { ...values };
  for (const field of Array.isArray(fields) ? fields : []) {
    if (field?.type !== 'relationship_dropdown') continue;
    for (const key of [field.id, field.name]) {
      if (key && containsFormNoRelationshipValue(next[key])) delete next[key];
    }
  }
  return next;
}