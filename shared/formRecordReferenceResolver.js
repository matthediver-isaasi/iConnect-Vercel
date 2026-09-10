import { formNotListedChoiceLabel } from './formNotListedChoice.js';
import { repeatableRowChildren } from './formRepeatableRows.js';
import {
  relationshipSelectionMode,
  RELATIONSHIP_SELECTION_SINGLE,
} from './formRelationshipSelection.js';
import {
  isCustomObjectRowSource,
  isDistinctRowSource,
} from './formCustomObjectRowSources.js';

export const RESOLVE_RECORD_REFERENCE_OPERATION = 'resolve_record_reference';
export const RESOLVE_RECORD_REFERENCES_OPERATION = 'resolve_record_references';
export const RECORD_REFERENCE_IDENTITY_SOURCE = 'not_listed_text';
export const NOT_LISTED_RECORD_OPERATIONS = Object.freeze(['create', 'upsert']);
// Scalar Custom Object identity destinations supported by both the builder's
// upsert selector and the server resolver. Target-domain validation remains
// authoritative for the submitted value.
export const RECORD_REFERENCE_CUSTOM_IDENTITY_FIELD_TYPES = Object.freeze([
  'text', 'email', 'url', 'number', 'decimal', 'date', 'dropdown', 'country',
]);

const PICKER_ADAPTERS = Object.freeze({
  member_dropdown: { kind: 'member' },
  organisation_dropdown: { kind: 'organization' },
  organization_dropdown: { kind: 'organization' },
  organisation_group_dropdown: { kind: 'organization_group' },
  organization_group_dropdown: { kind: 'organization_group' },
  relationship_dropdown: { dynamicTarget: true },
});

export function recordReferencePickerCapability(field) {
  // A present but malformed source must not silently regain record semantics.
  if (field?.option_source !== undefined
      && (!isCustomObjectRowSource(field) || isDistinctRowSource(field))) return null;
  const adapter = PICKER_ADAPTERS[field?.type];
  if (!adapter) return null;
  const cardinality = field.type === 'relationship_dropdown'
    ? relationshipSelectionMode(field)
    : RELATIONSHIP_SELECTION_SINGLE;
  const sourceObjectId = isCustomObjectRowSource(field)
    ? field.option_source.custom_object_id : null;
  const kind = adapter.dynamicTarget
    ? (field.related_kind || (sourceObjectId || field.related_custom_object_id || field.custom_object_id
      ? 'custom_object' : null))
    : adapter.kind;
  const customObjectId = kind === 'custom_object'
    ? (sourceObjectId || field.related_custom_object_id || field.custom_object_id || null)
    : null;
  return {
    adapter: field.type,
    target: kind ? { kind, custom_object_id: customObjectId } : null,
    selection_cardinality: cardinality,
    companion_value_scope: 'action_source',
    identity_source: RECORD_REFERENCE_IDENTITY_SOURCE,
    supports_not_listed: Boolean(formNotListedChoiceLabel(field)),
  };
}

export function recordReferenceTargetMatches(capability, target) {
  if (!capability?.target || !target?.kind) return false;
  return capability.target.kind === target.kind
    && (target.kind !== 'custom_object'
      || String(capability.target.custom_object_id || '') === String(target.custom_object_id || ''));
}

export function recordReferencePickerCompatibility(field, target, expectedCardinality = RELATIONSHIP_SELECTION_SINGLE) {
  const capability = recordReferencePickerCapability(field);
  if (!capability) {
    return { compatible: false, code: 'unsupported_picker', message: 'This field is not a record-backed picker.' };
  }
  if (capability.selection_cardinality !== expectedCardinality) {
    return expectedCardinality === RELATIONSHIP_SELECTION_SINGLE
      ? { compatible: false, code: 'multiple_selection', message: 'Resolve record reference supports single-record pickers only.' }
      : { compatible: false, code: 'single_selection', message: 'Resolve several record references supports multi-record pickers only.' };
  }
  if (!capability.target) {
    return { compatible: false, code: 'ambiguous_target', message: 'This picker does not declare an authoritative record target.' };
  }
  if (!capability.supports_not_listed) {
    return { compatible: false, code: 'not_listed_disabled', message: 'Enable a labelled Not listed choice before resolving this picker.' };
  }
  if (target && !recordReferenceTargetMatches(capability, target)) {
    return { compatible: false, code: 'incompatible_target', message: 'The picker record type does not match the selected target.' };
  }
  return { compatible: true, capability };
}

export function recordReferenceSourceFields(fields, source = {}) {
  const list = Array.isArray(fields) ? fields : [];
  if (source.scope !== 'repeatable_row') return list;
  const container = list.find(field => String(field?.id) === String(source.repeatable_field_id));
  return container ? repeatableRowChildren(container) : [];
}

export function compatibleRecordReferencePickers(
  fields,
  source,
  target,
  expectedCardinality = RELATIONSHIP_SELECTION_SINGLE,
) {
  return recordReferenceSourceFields(fields, source)
    .filter(field => recordReferencePickerCompatibility(field, target, expectedCardinality).compatible);
}

export function recordReferenceConfigurationWarning(action, fields) {
  if (![RESOLVE_RECORD_REFERENCE_OPERATION, RESOLVE_RECORD_REFERENCES_OPERATION].includes(action?.operation)) return '';
  const candidates = recordReferenceSourceFields(fields, action.source);
  const selected = candidates.find(field => String(field?.id) === String(action.reference_field_id));
  if (!selected) return 'Select a record-backed picker from this action scope.';
  const expectedCardinality = action.operation === RESOLVE_RECORD_REFERENCES_OPERATION
    ? 'multiple'
    : RELATIONSHIP_SELECTION_SINGLE;
  const compatibility = recordReferencePickerCompatibility(selected, action.target, expectedCardinality);
  if (!compatibility.compatible) return compatibility.message;
  if (!action.identity_mapping?.target_field_id) {
    return 'Map the picker Not listed text to an identity field.';
  }
  if (!NOT_LISTED_RECORD_OPERATIONS.includes(action.not_listed_operation)) {
    return 'Choose whether Not listed creates a record or upserts by its identity.';
  }
  return '';
}