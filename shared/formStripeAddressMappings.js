export const STRIPE_ADDRESS_SOURCES = Object.freeze([
  { value: 'line1', label: 'Address line 1' },
  { value: 'line2', label: 'Address line 2' },
  { value: 'city', label: 'City' },
  { value: 'state', label: 'State / county' },
  { value: 'postal_code', label: 'Postcode' },
  { value: 'country', label: 'Country' },
  { value: 'formatted', label: 'Formatted address' },
]);

export const STRIPE_ADDRESS_TARGET_ENTITIES = Object.freeze([
  { value: 'member', label: 'Member' },
  { value: 'organization', label: 'Organisation' },
]);

const SOURCE_VALUES = new Set(STRIPE_ADDRESS_SOURCES.map(option => option.value));
const TARGET_ENTITIES = new Set(STRIPE_ADDRESS_TARGET_ENTITIES.map(option => option.value));
const TARGET_TYPES = new Set(['core', 'custom']);
const WRITABLE_CUSTOM_TYPES = new Set([
  'text', 'textarea', 'long_text', 'country',
]);

// Only an organisation currently has a writable core address destination.
// Component values are strings, so the existing free-text invoice address is
// safe for either an individual component or Stripe's formatted address.
export const STRIPE_ADDRESS_CORE_TARGETS = Object.freeze({
  member: [],
  organization: [
    { value: 'invoicing_address', label: 'Invoicing Address', field_type: 'textarea' },
  ],
});

const normalizedScope = field => {
  const scope = field?.entity_scope || field?.target_entity || field?.entity_type;
  if (!scope) return 'member';
  if (scope === 'organisation') return 'organization';
  return scope;
};

const isWritableCustomField = field => {
  if (!field || field.is_active === false) return false;
  if (field.read_only === true || field.readonly === true || field.is_read_only === true) return false;
  if (field.is_calculated === true || field.calculated === true || field.computed === true) return false;
  if (field.writable === false || field.editable === false) return false;
  if (field.formula || field.calculation || field.calculation_config) return false;
  return WRITABLE_CUSTOM_TYPES.has(String(field.field_type || field.type || '').toLowerCase());
};

export function stripeAddressTargetKey(mapping) {
  return `${mapping?.target_entity || ''}:${mapping?.target_type || ''}:${mapping?.target_field || ''}`;
}

const stableResolutionValue = value => {
  if (Array.isArray(value)) return value.map(stableResolutionValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .filter(key => value[key] !== undefined)
        .sort()
        .map(key => [key, stableResolutionValue(value[key])]),
    );
  }
  return value;
};

/**
 * Immutable checkout-time description of everything that can affect which
 * primary records ordinary form processing resolves. This intentionally
 * excludes presentation/payment fields, but includes the complete pipeline
 * and legacy processing configuration rather than only the selected ID.
 */
export function stripeAddressTargetResolutionSignature(form) {
  return JSON.stringify(stableResolutionValue({
    entity_pipelines: form?.entity_pipelines || {},
    field_mappings: form?.field_mappings || [],
    application_level: form?.application_level ?? null,
    auto_create_entity: form?.auto_create_entity ?? null,
    create_entity_type: form?.create_entity_type ?? null,
    entity_action: form?.entity_action ?? null,
    member_entity_action: form?.member_entity_action ?? null,
    organization_entity_action: form?.organization_entity_action ?? null,
    additional_member_creations: form?.additional_member_creations || [],
    default_member_role_id: form?.default_member_role_id ?? null,
    implicit_field_bindings: (form?.fields || []).flatMap(field => {
      const customFieldId = field?.custom_field_id || field?.preference_field_id;
      if (!field?.core_field_mapping && !customFieldId) return [];
      return [{
        id: field.id ?? null,
        core_field_mapping: field.core_field_mapping ?? null,
        custom_field_id: customFieldId ?? null,
      }];
    }),
  }));
}

export function buildStripeAddressTargetResolution(form, mappings = []) {
  return {
    version: 1,
    entities: [...new Set((mappings || []).map(mapping => mapping?.target_entity).filter(
      entity => TARGET_ENTITIES.has(entity),
    ))].sort(),
    signature: stripeAddressTargetResolutionSignature(form),
  };
}

export function validateStripeAddressTargetResolution(form, snapshot) {
  if (!snapshot
    || Number(snapshot.version) !== 1
    || !Array.isArray(snapshot.entities)
    || typeof snapshot.signature !== 'string') {
    return { valid: false, error: 'The Stripe target resolution snapshot is invalid.' };
  }
  const currentSignature = stripeAddressTargetResolutionSignature(form);
  if (currentSignature !== snapshot.signature) {
    return {
      valid: false,
      error: 'The form target resolution changed after Stripe checkout began.',
      currentSignature,
    };
  }
  return { valid: true };
}

export function isStripeAddressDestinationCompatible(source, destination) {
  const type = String(destination?.field_type || '').toLowerCase();
  return type !== 'country' || source === 'country';
}

export function resolvePrimaryFormEntities(form) {
  const pipelines = form?.entity_pipelines || {};
  const members = Array.isArray(pipelines.members) ? pipelines.members : [];
  const organizations = Array.isArray(pipelines.organisations)
    ? pipelines.organisations
    : (Array.isArray(pipelines.organizations) ? pipelines.organizations : []);
  const resolve = (pipelinesForEntity, entity) => {
    const explicit = pipelinesForEntity.filter(pipeline => (
      pipeline?.isPrimary === true
      || pipeline?.is_primary === true
      || pipeline?.primary === true
    ));
    if (explicit.length === 1) {
      return { available: true, ambiguous: false, pipeline: explicit[0], legacy: false };
    }
    if (explicit.length > 1 || pipelinesForEntity.length > 1) {
      return { available: false, ambiguous: true, pipeline: null, legacy: false };
    }
    if (pipelinesForEntity.length === 1) {
      return { available: true, ambiguous: false, pipeline: pipelinesForEntity[0], legacy: false };
    }
    const configuredAction = entity === 'member'
      ? (form?.member_entity_action
        || (['member', 'both'].includes(form?.create_entity_type) ? form?.entity_action : null))
      : (form?.organization_entity_action
        || (['organization', 'organisation', 'both'].includes(form?.create_entity_type) ? form?.entity_action : null));
    const legacyAvailable = form?.auto_create_entity !== false
      && configuredAction
      && configuredAction !== 'none';
    return {
      available: Boolean(legacyAvailable),
      ambiguous: false,
      pipeline: null,
      legacy: Boolean(legacyAvailable),
    };
  };
  return {
    member: resolve(members, 'member'),
    organization: resolve(organizations, 'organization'),
  };
}

export function stripeAddressDestinationOptions({ form, customFields = [] } = {}) {
  const resolution = resolvePrimaryFormEntities(form);
  const conflicts = collectOtherMappingTargets(form, customFields);
  return STRIPE_ADDRESS_TARGET_ENTITIES.map(entity => {
    const core = (STRIPE_ADDRESS_CORE_TARGETS[entity.value] || []).map(field => ({
      value: `core:${field.value}`,
      target_entity: entity.value,
      target_type: 'core',
      target_field: field.value,
      label: field.label,
      field_type: field.field_type,
      conflict: conflicts.has(`${entity.value}:core:${field.value}`),
    }));
    const custom = (customFields || [])
      .filter(field => isWritableCustomField(field)
        && normalizedScope(field) === entity.value
      )
      .map(field => ({
        value: `custom:${field.id}`,
        target_entity: entity.value,
        target_type: 'custom',
        target_field: String(field.id),
        label: field.label || field.name || field.id,
        field_type: field.field_type || field.type,
        conflict: conflicts.has(`${entity.value}:custom:${field.id}`),
      }));
    return {
      ...entity,
      available: resolution[entity.value].available,
      ambiguous: resolution[entity.value].ambiguous,
      options: [...core, ...custom],
    };
  });
}

function collectOtherMappingTargets(form, customFields = []) {
  const targets = new Set();
  const resolution = resolvePrimaryFormEntities(form);
  const addMappings = (entity, mappings) => {
    for (const mapping of mappings || []) {
      const targetField = mapping?.target_field || mapping?.target_field_id;
      // Legacy ordinary mappings omitted target_type; the processor treats
      // those destinations as core fields, so conflict detection must too.
      const targetType = mapping?.target_type || 'core';
      if (targetField && TARGET_TYPES.has(targetType)) {
        targets.add(`${entity}:${targetType}:${targetField}`);
      }
    }
  };
  if (resolution.member.pipeline) addMappings('member', resolution.member.pipeline.mappings);
  if (resolution.organization.pipeline) addMappings('organization', resolution.organization.pipeline.mappings);
  // Top-level/legacy mappings usually carry their entity. Older forms omitted
  // it, in which case application_level identifies the resolved record.
  for (const mapping of form?.field_mappings || []) {
    const entity = mapping?.target_entity === 'organisation'
      ? 'organization'
      : mapping?.target_entity;
    if (TARGET_ENTITIES.has(entity)) addMappings(entity, [mapping]);
    else if (form?.application_level === 'member') addMappings('member', [mapping]);
    else if (['organization', 'organisation'].includes(form?.application_level)) {
      addMappings('organization', [mapping]);
    }
  }
  // The processor uses field-level bindings only as its legacy fallback when
  // there are no top-level ordinary mappings. Pipeline mappings suppress only
  // the same destination, which is already present in this target set.
  if (!Array.isArray(form?.field_mappings) || form.field_mappings.length === 0) {
    const customById = new Map((customFields || []).map(field => [String(field.id), field]));
    for (const field of form?.fields || []) {
      if (typeof field?.core_field_mapping === 'string') {
        const [rawEntity, targetField] = field.core_field_mapping.split('.');
        const entity = rawEntity === 'organisation' ? 'organization' : rawEntity;
        if (TARGET_ENTITIES.has(entity) && targetField) {
          targets.add(`${entity}:core:${targetField}`);
        }
      }
      const customFieldId = field?.custom_field_id || field?.preference_field_id;
      const customField = customById.get(String(customFieldId || ''));
      const entity = normalizedScope(customField);
      if (customFieldId && customField && TARGET_ENTITIES.has(entity)) {
        targets.add(`${entity}:custom:${customFieldId}`);
      }
    }
  }
  return targets;
}

export function stripeAddressMappingConflictErrors({ form, mappings = [], customFields = [] } = {}) {
  const ordinaryTargets = collectOtherMappingTargets(form, customFields);
  return (mappings || []).flatMap((mapping, index) => (
    ordinaryTargets.has(stripeAddressTargetKey(mapping))
      ? [`Persisted Stripe address mapping ${index + 1} conflicts with a current form mapping.`]
      : []
  ));
}

export function validateStripeAddressMappings({
  form,
  mappings,
  customFields = [],
} = {}) {
  const value = mappings === undefined
    ? (form?.fields || []).flatMap(field => field?.type === 'payment'
      ? (field.stripe_billing_address_mappings || [])
      : [])
    : mappings;
  const errors = [];
  if (!Array.isArray(value)) {
    return { valid: false, errors: ['Stripe billing address mappings must be an array.'] };
  }

  const resolution = resolvePrimaryFormEntities(form);
  const destinations = stripeAddressDestinationOptions({ form, customFields })
    .flatMap(group => group.options);
  const targetsByKey = new Map(destinations.map(destination => [
    stripeAddressTargetKey(destination),
    destination,
  ]));
  const otherTargets = collectOtherMappingTargets(form, customFields);
  const seenTargets = new Set();

  value.forEach((mapping, index) => {
    const prefix = `Stripe address mapping ${index + 1}`;
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
      errors.push(`${prefix} must be an object.`);
      return;
    }
    const keys = Object.keys(mapping);
    const expectedKeys = ['source', 'target_entity', 'target_type', 'target_field'];
    if (keys.some(key => !expectedKeys.includes(key))) {
      errors.push(`${prefix} contains unsupported properties.`);
    }
    if (!SOURCE_VALUES.has(mapping.source)) errors.push(`${prefix} has an invalid source.`);
    if (!TARGET_ENTITIES.has(mapping.target_entity)) errors.push(`${prefix} has an invalid target entity.`);
    if (!TARGET_TYPES.has(mapping.target_type)) errors.push(`${prefix} has an invalid target type.`);
    if (typeof mapping.target_field !== 'string' || !mapping.target_field.trim()) {
      errors.push(`${prefix} needs a target field.`);
    }
    const entityResolution = resolution[mapping.target_entity];
    if (entityResolution?.ambiguous) {
      errors.push(`${prefix} cannot target ${mapping.target_entity}: the form resolves more than one primary record.`);
    } else if (!entityResolution?.available) {
      errors.push(`${prefix} cannot target ${mapping.target_entity}: the form does not resolve a primary record.`);
    }
    const targetKey = stripeAddressTargetKey(mapping);
    const destination = targetsByKey.get(targetKey);
    if (!destination || !isStripeAddressDestinationCompatible(mapping.source, destination)) {
      errors.push(`${prefix} uses an unavailable or incompatible destination.`);
    }
    if (seenTargets.has(targetKey)) errors.push(`${prefix} duplicates a destination.`);
    if (otherTargets.has(targetKey)) errors.push(`${prefix} conflicts with another form mapping.`);
    seenTargets.add(targetKey);
  });
  return { valid: errors.length === 0, errors };
}
