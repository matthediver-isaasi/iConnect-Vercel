export function getEligibleRelationshipParents(fields, fieldId) {
  const list = Array.isArray(fields) ? fields : [];
  const index = list.findIndex((field) => field?.id === fieldId);
  const preceding = index < 0 ? list : list.slice(0, index);
  return preceding.filter((field) => field?.type === 'organisation_dropdown' && field.id);
}

export function resolveSavedFormField(fields, key) {
  if (key == null) return undefined;
  const list = Array.isArray(fields) ? fields : [];
  return list.find((field) => field?.id === key)
    || list.find((field) => field?.name === key);
}

export function getSavedFormFieldValue(values, field) {
  if (!values || typeof values !== 'object' || !field) return undefined;
  if (field.id != null && values[field.id] !== undefined) return values[field.id];
  if (field.name != null) return values[field.name];
  return undefined;
}

export function resolveFormRendererFieldValue({
  field,
  fields,
  values,
  value,
}) {
  const list = Array.isArray(fields) ? fields : [];
  const participatesInRelationship = field?.type === 'relationship_dropdown'
    || (field?.type === 'organisation_dropdown' && list.some((candidate) => (
      candidate?.type === 'relationship_dropdown'
      && candidate.parent_field_id === field.id
    )));
  if (!participatesInRelationship) {
    return { value, needsCanonicalValue: false };
  }

  const savedValue = getSavedFormFieldValue(values, field);
  const hasCanonicalValue = field?.id != null
    && values != null
    && typeof values === 'object'
    && values[field.id] !== undefined;
  const hasLegacyValue = field?.name != null
    && values != null
    && typeof values === 'object'
    && values[field.name] !== undefined;

  return {
    value: savedValue !== undefined ? savedValue : value,
    needsCanonicalValue: !hasCanonicalValue && hasLegacyValue && field?.id != null,
  };
}

export function resolveRelationshipDropdownValues({
  field,
  fields,
  values,
  value,
}) {
  const parentField = resolveSavedFormField(fields, field?.parent_field_id);
  const parentValue = getSavedFormFieldValue(values, parentField);
  const savedValue = getSavedFormFieldValue(values, field);
  const currentValue = savedValue !== undefined ? savedValue : value;
  const hasCanonicalValue = field?.id != null
    && values != null
    && typeof values === 'object'
    && values[field.id] !== undefined;
  const hasLegacyValue = field?.name != null
    && values != null
    && typeof values === 'object'
    && values[field.name] !== undefined;

  return {
    parentField,
    parentValue,
    currentValue,
    needsCanonicalValue: !hasCanonicalValue && hasLegacyValue && field?.id != null,
  };
}

export function normalizeRelationshipOptions(payload) {
  const items = Array.isArray(payload)
    ? payload
    : payload?.options || payload?.data || payload?.relationships || [];
  const seen = new Set();
  return items
    .map((item) => ({
      id: String(item?.id ?? item?.value ?? item?.record_id ?? ''),
      label: String(item?.label ?? item?.name ?? item?.display_label ?? ''),
    }))
    .filter((item) => {
      if (!item.id || !item.label || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
}

export function shouldClearRelationshipValue({
  value,
  parentValue,
  previousParentValue,
  options,
  optionsLoaded = false,
}) {
  if (!value) return false;
  if (!parentValue) return true;
  if (previousParentValue !== undefined && previousParentValue !== parentValue) return true;
  return optionsLoaded && !(options || []).some((option) => option.id === value);
}

export function normalizeEligibleRelationships(payload) {
  const items = Array.isArray(payload)
    ? payload
    : payload?.relationships || payload?.data || [];
  return items.filter((relationship) => {
    if (!relationship?.id || (relationship.status && relationship.status !== 'active')) return false;
    const sourceIsOrg = ['organization', 'organisation'].includes(relationship.source_kind);
    const targetIsOrg = ['organization', 'organisation'].includes(relationship.target_kind);
    const sourceIsCustom = relationship.source_kind === 'custom_object';
    const targetIsCustom = relationship.target_kind === 'custom_object';
    if (sourceIsOrg && targetIsCustom) return relationship.show_on_source !== false;
    if (targetIsOrg && sourceIsCustom) return relationship.show_on_target !== false;
    // A dedicated discovery endpoint may return an already-normalised item.
    return !!(relationship.custom_object || relationship.related_custom_object || relationship.related_custom_object_id);
  });
}

export function relationshipFieldConfig(relationship) {
  if (!relationship?.id) return {};
  const organizationIsSource = ['organization', 'organisation'].includes(relationship.source_kind);
  const object = relationship.custom_object
    || relationship.related_custom_object
    || (organizationIsSource ? relationship.target_custom_object : relationship.source_custom_object)
    || {};
  return {
    relationship_definition_id: relationship.id,
    relationship_key: relationship.relationship_key || relationship.key || null,
    organization_side: relationship.organization_side || relationship.relationship_side || relationship.side
      || (organizationIsSource ? 'source' : (['organization', 'organisation'].includes(relationship.target_kind) ? 'target' : null)),
    custom_object_id: relationship.custom_object_id || relationship.related_custom_object_id
      || (organizationIsSource ? relationship.target_custom_object_id : relationship.source_custom_object_id)
      || object.id || null,
    custom_object_name: relationship.custom_object_name || relationship.related_custom_object_name
      || object.name || object.singular_label || object.label || null,
    custom_object_primary_display_field_id:
      relationship.related_custom_object_primary_display_field_id || object.primary_display_field_id || null,
    relationship_definition: relationship,
    custom_object: object,
  };
}