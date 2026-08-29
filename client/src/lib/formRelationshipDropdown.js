import {
  FORM_NOT_LISTED_VALUE,
  hasEnabledFormNotListedChoice,
} from '../../../shared/formNotListedChoice.js';

export function getEligibleRelationshipParents(fields, fieldId) {
  const list = Array.isArray(fields) ? fields : [];
  const index = list.findIndex((field) => field?.id === fieldId);
  const preceding = index < 0 ? list : list.slice(0, index);
  return preceding.filter((field) => (
    ['organisation_dropdown', 'organisation_group_dropdown', 'relationship_dropdown'].includes(field?.type)
    && field.id
  ));
}

export function relationshipParentDescriptor(field) {
  if (!field) return {};
  if (field.type === 'organisation_dropdown') return { kind: 'organization' };
  if (field.type === 'organisation_group_dropdown') return { kind: 'organization_group' };
  if (field.type === 'relationship_dropdown') {
    return {
      kind: field.related_kind || (field.custom_object_id ? 'custom_object' : null),
      custom_object_id: field.related_custom_object_id || field.custom_object_id || null,
    };
  }
  return {};
}

export function isRelationshipCompatibleWithParent(relationship, parentField) {
  const parent = relationshipParentDescriptor(parentField);
  if (!parent.kind) return false;
  const sides = relationship?.relationship_parent_side ? [{
    side: relationship.relationship_parent_side,
    kind: relationship.relationship_parent_kind,
    customObjectId: relationship.relationship_parent_custom_object_id,
  }] : [
    { side: 'source', kind: relationship?.source_kind, customObjectId: relationship?.source_custom_object_id },
    { side: 'target', kind: relationship?.target_kind, customObjectId: relationship?.target_custom_object_id },
  ];
  return sides.some(({ kind, customObjectId }) => (
    (parent.kind === 'organization' && ['organization', 'organisation'].includes(kind))
    || (parent.kind === 'organization_group' && ['organization_group', 'organisation_group'].includes(kind))
    || (parent.kind === 'custom_object' && kind === 'custom_object'
      && String(customObjectId || '') === String(parent.custom_object_id || ''))
  ));
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
  rootFields,
  rootValues,
}) {
  const parentScope = field?.parent_field_scope
    || (field?.repeatable_container_field_id ? 'row' : 'form');
  const parentFields = parentScope === 'form' ? (rootFields || fields) : fields;
  const parentValues = parentScope === 'form' ? (rootValues || values) : values;
  const parentField = resolveSavedFormField(parentFields, field?.parent_field_id);
  const parentValue = getSavedFormFieldValue(parentValues, parentField);
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

export function isConfirmedEmptyRelationshipResult({
  fieldType,
  parentValue,
  options,
  optionsLoaded = false,
  optionsError = false,
}) {
  return fieldType === 'relationship_dropdown'
    && optionsLoaded
    && !optionsError
    && !!parentValue
    && parentValue !== '__form_not_listed__'
    && Array.isArray(options)
    && options.length === 0;
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

export function resolveRelationshipParentTransition({
  field,
  value,
  parentValue,
  previousParentValue,
  options,
  optionsLoaded = false,
}) {
  if (field?.type !== 'relationship_dropdown') return null;
  if (parentValue === FORM_NOT_LISTED_VALUE) {
    if (hasEnabledFormNotListedChoice(field)) {
      return value === FORM_NOT_LISTED_VALUE ? null : FORM_NOT_LISTED_VALUE;
    }
    return value ? '' : null;
  }
  return shouldClearRelationshipValue({
    value,
    parentValue,
    previousParentValue,
    options,
    optionsLoaded,
  }) ? '' : null;
}

export function shouldClearFilteredOrganisationValue({
  field,
  value,
  organisations,
  optionsLoaded = false,
}) {
  if (field?.type !== 'organisation_dropdown'
      || !field.organisation_group_parent_field_id
      || !optionsLoaded
      || !value) {
    return false;
  }
  if (value === FORM_NOT_LISTED_VALUE) {
    return !hasEnabledFormNotListedChoice(field);
  }
  return !(Array.isArray(organisations) ? organisations : [])
    .some(organisation => String(organisation?.id) === String(value));
}

export function normalizeEligibleRelationships(payload) {
  const items = Array.isArray(payload)
    ? payload
    : payload?.relationships || payload?.data || [];
  return items.filter((relationship) => {
    if (!relationship?.id || (relationship.status && relationship.status !== 'active')) return false;
    // New discovery responses are already side-specific and carry both
    // descriptors, including non-custom record kinds.
    if (relationship.relationship_parent_side) {
      return !!relationship.relationship_parent_kind && !!relationship.related_kind;
    }
    const sourceIsOrg = ['organization', 'organisation'].includes(relationship.source_kind);
    const targetIsOrg = ['organization', 'organisation'].includes(relationship.target_kind);
    const sourceIsCustom = relationship.source_kind === 'custom_object';
    const targetIsCustom = relationship.target_kind === 'custom_object';
    if (sourceIsOrg && targetIsCustom) return relationship.show_on_source !== false;
    if (targetIsOrg && sourceIsCustom) return relationship.show_on_target !== false;
    // Generic descriptors may chain custom-object relationships. Require
    // endpoint metadata so incomplete legacy definitions are not offered.
    if (sourceIsCustom && targetIsCustom) {
      return !!(
        relationship.source_custom_object_id || relationship.source_custom_object
      ) && !!(
        relationship.target_custom_object_id || relationship.target_custom_object
      );
    }
    const supportedKinds = new Set(['organization', 'organisation', 'organization_group', 'organisation_group', 'custom_object']);
    if (supportedKinds.has(relationship.source_kind) && supportedKinds.has(relationship.target_kind)
      && (relationship.source_kind !== 'custom_object' || relationship.target_kind !== 'custom_object')) {
      return relationship.show_on_source !== false || relationship.show_on_target !== false;
    }
    // A dedicated discovery endpoint may return an already-normalised item.
    return !!(relationship.custom_object || relationship.related_custom_object || relationship.related_custom_object_id);
  });
}

export function relationshipFieldConfig(relationship, parentField = null) {
  if (!relationship?.id) return {};
  if (relationship.relationship_parent_side) {
    const parentObject = relationship.parent_object || relationship.relationship_parent_object || {};
    const relatedObject = relationship.related_object || relationship.custom_object
      || relationship.related_custom_object || {};
    const parentKind = relationship.relationship_parent_kind;
    const relatedKind = relationship.related_kind;
    const relatedCustomObjectId = relationship.related_custom_object_id
      || (relatedKind === 'custom_object' ? relationship.custom_object_id : null)
      || (relatedKind === 'custom_object' ? relatedObject.id : null) || null;
    return {
      relationship_definition_id: relationship.id,
      relationship_key: relationship.relationship_key || relationship.key || null,
      relationship_parent_side: relationship.relationship_parent_side,
      relationship_parent_kind: parentKind,
      relationship_parent_custom_object_id: relationship.relationship_parent_custom_object_id
        || (parentKind === 'custom_object' ? relationship.custom_object_id : null)
        || (parentKind === 'custom_object' ? parentObject.id : null) || null,
      related_kind: relatedKind,
      related_custom_object_id: relatedCustomObjectId,
      related_primary_display_field_id: relationship.related_primary_display_field_id
        || relationship.related_custom_object_primary_display_field_id
        || relatedObject.primary_display_field_id || null,
      // Legacy aliases retained for existing forms and API consumers.
      organization_side: relationship.relationship_parent_side,
      custom_object_id: relatedCustomObjectId,
      custom_object_name: relatedObject.name || relatedObject.singular_label || relatedObject.label || null,
      custom_object_primary_display_field_id: relationship.related_primary_display_field_id
        || relationship.related_custom_object_primary_display_field_id
        || relatedObject.primary_display_field_id || null,
      relationship_definition: relationship,
      custom_object: relatedObject,
    };
  }
  const organizationIsSource = ['organization', 'organisation'].includes(relationship.source_kind);
  const parent = relationshipParentDescriptor(parentField);
  const parentIsSource = parent.kind && (
    (parent.kind === 'organization' && ['organization', 'organisation'].includes(relationship.source_kind))
    || (parent.kind === 'organization_group' && relationship.source_kind === 'organization_group')
    || (parent.kind === 'custom_object' && relationship.source_kind === 'custom_object'
      && String(relationship.source_custom_object_id || '') === String(parent.custom_object_id || ''))
  );
  const parentSide = parent.kind
    ? (parentIsSource ? 'source' : 'target')
    : (relationship.organization_side || relationship.relationship_side || relationship.side
      || (organizationIsSource ? 'source' : (['organization', 'organisation'].includes(relationship.target_kind) ? 'target' : null)));
  const relatedIsSource = parentSide === 'target';
  const sideObject = relatedIsSource ? relationship.source_custom_object : relationship.target_custom_object;
  const object = (parentField ? sideObject : null)
    || relationship.custom_object
    || relationship.related_custom_object
    || sideObject
    || {};
  const sideCustomObjectId = relatedIsSource
    ? relationship.source_custom_object_id : relationship.target_custom_object_id;
  const relatedCustomObjectId = (parentField ? sideCustomObjectId : null)
    || relationship.custom_object_id || relationship.related_custom_object_id
    || sideCustomObjectId
    || object.id || null;
  return {
    relationship_definition_id: relationship.id,
    relationship_key: relationship.relationship_key || relationship.key || null,
    relationship_parent_side: parentSide,
    relationship_parent_kind: parentSide === 'source' ? relationship.source_kind : relationship.target_kind,
    relationship_parent_custom_object_id: parentSide === 'source'
      ? relationship.source_custom_object_id : relationship.target_custom_object_id,
    related_kind: (relatedIsSource ? relationship.source_kind : relationship.target_kind)
      || (relatedCustomObjectId ? 'custom_object' : null),
    related_custom_object_id: relatedCustomObjectId,
    related_primary_display_field_id:
      relationship.related_custom_object_primary_display_field_id || object.primary_display_field_id || null,
    // Legacy aliases retained for existing forms and API consumers.
    organization_side: parentSide,
    custom_object_id: relatedCustomObjectId,
    custom_object_name: relationship.custom_object_name || relationship.related_custom_object_name
      || object.name || object.singular_label || object.label || null,
    custom_object_primary_display_field_id:
      relationship.related_custom_object_primary_display_field_id || object.primary_display_field_id || null,
    relationship_definition: relationship,
    custom_object: object,
  };
}