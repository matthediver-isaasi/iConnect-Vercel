/**
 * Immutable, narrow projection of the form shape that a Department current-set
 * configuration is allowed to reconcile.  It deliberately excludes labels,
 * option lists, layout, and unrelated fields, so ordinary form presentation
 * edits remain possible without weakening the protected data boundary.
 */
import {
  isRepeatableRowField,
  repeatableRowChildren,
} from '../../shared/formRepeatableRows.js';

const COMPATIBILITY_VERSION = 1;

const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
const normalizedBoolean = value => value === true;
const normalizedBound = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

// JSONB does not preserve object insertion order.  Compatibility contracts are
// semantic JSON values, so compare a deterministic projection rather than
// JSON.stringify's source-order representation.  Arrays intentionally retain
// their order because row/field ordering is part of the reviewed contract.
function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonicalJson(child)]));
  }
  return value;
}

function semanticallyEqual(left, right) {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function canonicalCompatibility(value) {
  const canonical = canonicalJson(value);
  if (!canonical || typeof canonical !== 'object' || Array.isArray(canonical)
      || !canonical.containers || typeof canonical.containers !== 'object'
      || Array.isArray(canonical.containers)) {
    return canonical;
  }
  return {
    ...canonical,
    containers: Object.fromEntries(Object.entries(canonical.containers).map(([key, container]) => [
      key,
      container && typeof container === 'object' && Array.isArray(container.children)
        ? {
          ...container,
          // Mapped-field membership and properties are protected; the
          // original contract did not make mapping-object insertion order
          // meaningful, so compare children by their stable field IDs.
          children: [...container.children].sort((left, right) => String(left?.id).localeCompare(String(right?.id))),
        }
        : container,
    ])),
  };
}

function configurationError(message) {
  const error = new Error(message);
  error.code = 'CURRENT_SET_CONFIGURATION_INVALID';
  return error;
}

function mappedContainerDefinitions(configuration) {
  if (!configuration || typeof configuration !== 'object') {
    throw configurationError('Current Department form configuration is missing');
  }
  const workforceFields = configuration.workforce_fields;
  const equipmentFields = configuration.equipment_fields;
  if (!workforceFields || typeof workforceFields !== 'object' || Array.isArray(workforceFields)
      || !equipmentFields || typeof equipmentFields !== 'object' || Array.isArray(equipmentFields)) {
    throw configurationError('Current Department form field mappings are invalid');
  }
  return [
    {
      key: 'workforce',
      id: configuration.workforce_container_field_id,
      mappedChildIds: Object.keys(workforceFields),
    },
    {
      key: 'equipment',
      id: configuration.equipment_container_field_id,
      mappedChildIds: Object.keys(equipmentFields),
    },
  ];
}

function formVisibilityTargets(form) {
  const targets = new Set();
  for (const rule of Array.isArray(form?.visibility_rules) ? form.visibility_rules : []) {
    if (!rule || typeof rule !== 'object') continue;
    for (const id of rule.target_field_ids || []) targets.add(String(id));
    if (rule.target_field_id != null) targets.add(String(rule.target_field_id));
    for (const action of Array.isArray(rule.actions) ? rule.actions : []) {
      if (!action || typeof action !== 'object') continue;
      for (const id of action.target_field_ids || []) targets.add(String(id));
      if (action.target_field_id != null) targets.add(String(action.target_field_id));
      for (const id of Object.keys(action.field_states || {})) targets.add(String(id));
    }
  }
  return targets;
}

function hasChildConditionalVisibility(child, targets) {
  return child?.conditional_visibility != null
    || child?.conditionalVisibility != null
    || child?.starts_hidden === true
    || child?.starts_hidden === 'true'
    || targets.has(String(child?.id));
}

function normalizedPreservedRowVisibility(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || !['show_when', 'hide_when'].includes(value.mode)
      || typeof value.source_field_id !== 'string'
      || !own(value, 'value')) {
    throw configurationError('Current Department hidden-value rule is invalid');
  }
  return {
    mode: value.mode,
    source_field_id: value.source_field_id,
    value: value.value,
  };
}

function projectedChild(child, targets, hiddenPreserve) {
  const projected = {
    id: String(child.id),
    type: child.type || null,
    required: normalizedBoolean(child.required),
    unique_across_rows: normalizedBoolean(child.unique_across_rows),
    no_row_visibility: true,
    no_conditional_visibility: true,
  };
  if (child.type === 'date') projected.date_precision = child.date_precision || 'day';
  if (hasChildConditionalVisibility(child, targets)) {
    throw configurationError(`Mapped current-set field ${child.id} must not use conditional visibility`);
  }
  if (child?.row_visibility != null) {
    const actualRule = normalizedPreservedRowVisibility(child.row_visibility);
    const configuredRule = hiddenPreserve?.[String(child.id)];
    if (!configuredRule
        || !semanticallyEqual(actualRule, normalizedPreservedRowVisibility(configuredRule))) {
      throw configurationError(`Mapped current-set field ${child.id} has an unreviewed hidden-value rule`);
    }
    if (projected.required) {
      throw configurationError(`Required current-set field ${child.id} must not be hidden within a row`);
    }
    projected.hidden_value_preserve = actualRule;
  }
  return projected;
}

function assertBlankPolicy(configuration, childById) {
  const policy = configuration.required_blank_policy;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw configurationError('Current Department blank-value policy is missing');
  }
  const existing = policy.existing_equipment_blank_required_field_ids;
  const newRequired = policy.new_equipment_required_field_ids;
  if (!Array.isArray(existing) || !Array.isArray(newRequired)
      || existing.length !== 2 || newRequired.length !== 2
      || new Set(existing).size !== 2 || new Set(newRequired).size !== 2
      || existing.some(id => typeof id !== 'string')
      || newRequired.some(id => typeof id !== 'string')
      || existing.some(id => !newRequired.includes(id))
      || newRequired.some(id => !existing.includes(id))) {
    throw configurationError('Current Department blank-value policy is invalid');
  }
  for (const id of existing) {
    const child = childById.get(id);
    if (!child || child.required !== true) {
      throw configurationError(`Current Department blank-value policy field ${id} must be a required equipment field`);
    }
  }
}

function equipmentHiddenPreserve(configuration, equipmentFieldIds) {
  const rules = configuration.equipment_hidden_preserve;
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) {
    throw configurationError('Current Department equipment hidden-value rules are missing');
  }
  for (const [id, rule] of Object.entries(rules)) {
    if (!equipmentFieldIds.has(id)) {
      throw configurationError(`Current Department hidden-value rule references unmapped field ${id}`);
    }
    normalizedPreservedRowVisibility(rule);
  }
  return rules;
}

/**
 * Build the persisted compatibility contract from the reviewed candidate form.
 * `configuration` supplies the mapped form IDs and expected blank policy.
 */
export function buildDepartmentCurrentSetCompatibilityContract({ form, configuration }) {
  if (!form || !Array.isArray(form.fields)) {
    throw configurationError('Pinned current-set form has no fields');
  }
  const targets = formVisibilityTargets(form);
  const containers = {};
  let equipmentChildren = null;
  const definitions = mappedContainerDefinitions(configuration);
  const equipmentDefinition = definitions.find(definition => definition.key === 'equipment');
  const hiddenPreserve = equipmentHiddenPreserve(
    configuration,
    new Set(equipmentDefinition.mappedChildIds),
  );
  for (const definition of definitions) {
    if (typeof definition.id !== 'string' || !definition.id) {
      throw configurationError(`Current Department ${definition.key} container mapping is invalid`);
    }
    const container = form.fields.find(field => String(field?.id) === definition.id);
    if (!container || !isRepeatableRowField(container)) {
      throw configurationError(`Current Department ${definition.key} container drifted`);
    }
    const children = new Map(repeatableRowChildren(container).map(child => [String(child.id), child]));
    // Mapping membership and each child's projected properties are protected;
    // the original contract did not make mapping-object insertion order
    // meaningful, so compatibility comparison normalizes children by ID.
    const projectedChildren = definition.mappedChildIds.map((id) => {
      const child = children.get(id);
      if (!child) throw configurationError(`Mapped current-set field ${id} is missing`);
      return projectedChild(child, targets, definition.key === 'equipment' ? hiddenPreserve : {});
    });
    containers[definition.key] = {
      id: definition.id,
      type: container.type,
      // Match the repeatable-row validator's effective defaults. Persisting
      // those values makes an omitted bound just as protected as an explicit
      // one without forcing unrelated legacy form normalization.
      min_rows: normalizedBound(container.min_rows, 0),
      max_rows: normalizedBound(container.max_rows, 10),
      required: normalizedBoolean(container.required),
      first_row_required: normalizedBoolean(container.first_row_required),
      children: projectedChildren,
    };
    if (definition.key === 'equipment') equipmentChildren = new Map(projectedChildren.map(child => [child.id, child]));
  }
  assertBlankPolicy(configuration, equipmentChildren);
  const actualHiddenPreserveIds = new Set(containers.equipment.children
    .filter(child => child.hidden_value_preserve)
    .map(child => child.id));
  if (actualHiddenPreserveIds.size !== Object.keys(hiddenPreserve).length
      || Object.keys(hiddenPreserve).some(id => !actualHiddenPreserveIds.has(id))) {
    throw configurationError('Current Department hidden-value rules no longer match the mapped Equipment fields');
  }
  for (const [id, fieldName] of Object.entries(configuration.equipment_fields)) {
    if (['equipment_type_id', 'manufacturer', 'serial_number', 'year_installed'].includes(fieldName)
        && actualHiddenPreserveIds.has(id)) {
      throw configurationError(`Core current-set Equipment field ${id} must remain visible`);
    }
  }
  for (const child of containers.equipment.children) {
    if (child.date_precision !== undefined && child.date_precision !== 'year') {
      throw configurationError(`Mapped current-set date field ${child.id} must be year-only`);
    }
  }
  for (const container of Object.values(containers)) {
    if (container.min_rows !== 0 || container.required || container.first_row_required
      || container.max_rows < 1 || container.max_rows > 100) {
      throw configurationError(`Current Department ${container.id} row bounds do not permit a complete intentional set`);
    }
  }
  return {
    version: COMPATIBILITY_VERSION,
    containers,
    required_blank_policy: {
      existing_equipment_blank_required_field_ids: [
        ...configuration.required_blank_policy.existing_equipment_blank_required_field_ids,
      ],
      new_equipment_required_field_ids: [
        ...configuration.required_blank_policy.new_equipment_required_field_ids,
      ],
    },
    equipment_hidden_preserve: { ...hiddenPreserve },
  };
}

/**
 * Fail closed when the active form no longer matches the reviewed projection.
 */
export function assertDepartmentCurrentSetCompatibility({ form, configuration }) {
  const contract = configuration?.form_compatibility;
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)
      || contract.version !== COMPATIBILITY_VERSION || !contract.containers
      || !contract.required_blank_policy || !contract.equipment_hidden_preserve) {
    throw configurationError('Current Department form compatibility contract is missing or invalid');
  }
  if (!semanticallyEqual(configuration.required_blank_policy, contract.required_blank_policy)) {
    throw configurationError('Current Department blank-value policy no longer matches its reviewed form contract');
  }
  if (!semanticallyEqual(configuration.equipment_hidden_preserve, contract.equipment_hidden_preserve)) {
    throw configurationError('Current Department hidden-value rules no longer match their reviewed form contract');
  }
  const actual = buildDepartmentCurrentSetCompatibilityContract({
    form,
    configuration,
  });
  if (JSON.stringify(canonicalCompatibility(actual)) !== JSON.stringify(canonicalCompatibility(contract))) {
    throw configurationError('Current Department form configuration changed; reload after an administrator reviews the current-set mapping');
  }
  return actual;
}

export function currentSetMappedChildIds(configuration) {
  return mappedContainerDefinitions(configuration)
    .flatMap(definition => definition.mappedChildIds)
    .map(String);
}

export function assertDepartmentCurrentSetLoadedBounds({ loaded, configuration, contract }) {
  const compatibility = contract || assertDepartmentCurrentSetCompatibility({
    form: null,
    configuration,
  });
  for (const [key, container] of Object.entries(compatibility.containers || {})) {
    const values = loaded?.form_values?.[container.id];
    if (!Array.isArray(values)) {
      throw configurationError(`Current Department ${key} data was not loaded as a complete array`);
    }
    if (values.length > container.max_rows) {
      throw configurationError(`Current Department ${key} data exceeds the reviewed form capacity`);
    }
  }
}

export function currentSetCompatibilityError(message) {
  return configurationError(message);
}