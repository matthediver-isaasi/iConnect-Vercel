const RECORD_FIELD_KINDS = Object.freeze({
  member_dropdown: 'member',
  organisation_dropdown: 'organization',
  organization_dropdown: 'organization',
  organisation_group_dropdown: 'organization_group',
  organization_group_dropdown: 'organization_group',
});

const normalizeKind = (kind) => ({
  organisation: 'organization',
  organisation_group: 'organization_group',
}[kind] || kind || null);

export function structuredRecordDescriptor(field) {
  if (!field) return null;
  if (['relationship_dropdown', 'custom_object_relationship'].includes(field.type)) {
    const kind = normalizeKind(field.related_kind || (field.custom_object_id ? 'custom_object' : null));
    if (!kind) return null;
    return {
      kind,
      customObjectId: kind === 'custom_object'
        ? (field.related_custom_object_id || field.custom_object_id || null) : null,
    };
  }
  const kind = RECORD_FIELD_KINDS[field.type];
  return kind ? { kind, customObjectId: null } : null;
}

export function structuredActionOutputDescriptor(action) {
  if (!action || action.operation === 'link_relationship') return null;
  const kind = normalizeKind(action.target?.kind);
  if (!kind) return null;
  return {
    kind,
    customObjectId: kind === 'custom_object' ? (action.target?.custom_object_id || null) : null,
  };
}

export function relationshipEndpointDescriptor(definition, side) {
  const kind = normalizeKind(definition?.[`${side}_kind`]);
  if (!kind) return null;
  return {
    kind,
    customObjectId: kind === 'custom_object'
      ? (definition?.[`${side}_custom_object_id`] || null) : null,
  };
}

export function isStructuredRecordDescriptorCompatible(candidate, endpoint) {
  return Boolean(candidate && endpoint
    && normalizeKind(candidate.kind) === normalizeKind(endpoint.kind)
    && (normalizeKind(endpoint.kind) !== 'custom_object'
      || String(candidate.customObjectId || '') === String(endpoint.customObjectId || '')));
}

export function relationshipEndpointLabel(definition, side) {
  const label = definition?.[`${side}_label`]
    || definition?.[`${side}_custom_object`]?.singular_label
    || definition?.[`${side}_custom_object`]?.name;
  if (label) return `${label} (${side})`;
  const descriptor = relationshipEndpointDescriptor(definition, side);
  const fallback = {
    member: 'Member',
    organization: 'Organisation',
    organization_group: 'Organisation group',
    custom_object: 'Custom record',
  }[descriptor?.kind] || 'Record';
  return `${fallback} (${side})`;
}

export function structuredRelationshipEndpointOptions({
  fields = [],
  actions = [],
  actionIndex,
  action,
  definition,
  side,
}) {
  const endpoint = relationshipEndpointDescriptor(definition, side);
  if (!endpoint) return [];
  const repeatableId = action?.source?.scope === 'repeatable_row'
    ? action.source.repeatable_field_id : null;
  const options = [];
  if (repeatableId) {
    const containerIndex = fields.findIndex(field => String(field?.id) === String(repeatableId));
    // A form-level endpoint used by a row action must already have been
    // submitted before the row container. This mirrors repeatable exclusion
    // sources and prevents a row action depending on a later form answer.
    fields.slice(0, Math.max(containerIndex, 0)).forEach(field => {
      if (!isStructuredRecordDescriptorCompatible(structuredRecordDescriptor(field), endpoint)) return;
      options.push({
        value: `field:form:${field.id}`,
        label: `Form field: ${field.label || field.name || field.id}`,
        reference: { type: 'field', scope: 'form', field_id: field.id },
      });
    });
    const container = fields.find(field => String(field?.id) === String(repeatableId));
    const children = container?.repeatable_row?.children
      ?? container?.children ?? container?.child_fields ?? container?.fields ?? [];
    children.forEach(field => {
      if (!isStructuredRecordDescriptorCompatible(structuredRecordDescriptor(field), endpoint)) return;
      options.push({
        value: `field:repeatable_row:${repeatableId}:${field.id}`,
        label: `Same row: ${field.label || field.name || field.id}`,
        reference: { type: 'field', scope: 'row', field_id: field.id },
      });
    });
  } else {
    fields.filter(field => field && !['repeatable_rows', 'repeatable_row', 'repeatable_grid'].includes(field.type))
      .forEach(field => {
        if (!isStructuredRecordDescriptorCompatible(structuredRecordDescriptor(field), endpoint)) return;
        options.push({
          value: `field:form:${field.id}`,
          label: `Submitted field: ${field.label || field.name || field.id}`,
          reference: { type: 'field', scope: 'form', field_id: field.id },
        });
      });
  }

  actions.slice(0, actionIndex).forEach((candidate, index) => {
    if (!isStructuredRecordDescriptorCompatible(structuredActionOutputDescriptor(candidate), endpoint)) return;
    const candidateRepeatable = candidate.source?.scope === 'repeatable_row';
    const sameRow = candidateRepeatable
      && repeatableId
      && String(candidate.source?.repeatable_field_id) === String(repeatableId);
    if ((repeatableId && !sameRow) || (!repeatableId && candidateRepeatable)) return;
    options.push({
      value: `action_output:${candidate.id}`,
      label: `Earlier action: ${candidate.label?.trim() || `Action ${index + 1}`}`,
      reference: { type: 'action_output', action_id: candidate.id },
    });
  });
  return options;
}

export function structuredEndpointReferenceValue(reference, repeatableFieldId = null) {
  if (reference?.type === 'action_output') return `action_output:${reference.action_id}`;
  if (reference?.type !== 'field') return '';
  return reference.scope === 'row' && repeatableFieldId
    ? `field:repeatable_row:${repeatableFieldId}:${reference.field_id}`
    : `field:form:${reference.field_id}`;
}