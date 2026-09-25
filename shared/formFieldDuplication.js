// FormBuilder stores repeatable children either on the field (including legacy
// child_fields / fields) or inside repeatable_row. Those are field definitions,
// not the form's top-level fields array.
const CHILD_KEYS = ['children', 'child_fields', 'fields'];
const FIELD_REFERENCES = new Set([
  'source_field_id',
  'parent_field_id',
  'organisation_group_parent_field_id',
  'organization_group_parent_field_id',
  'price_field_id',
  'invoice_address_field_id',
  'repeatable_container_field_id',
  'reference_field_id',
  'selector_field_id',
  'relationship_parent_field_id',
  'set_value_field_id',
  'set_value_prefill_source_field_id',
  'formula_operand_a_field_id',
  'formula_operand_b_field_id',
  'formula_field_a',
  'formula_field_b',
  'trigger_field_id',
  'prefill_source_field_id',
]);

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  }
  return value;
}

function collectIds(value, ids) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach(item => collectIds(item, ids));
  } else {
    if (typeof value.id === 'string') ids.add(value.id);
    Object.values(value).forEach(item => collectIds(item, ids));
  }
}

function nextId(ids) {
  let id;
  do {
    id = globalThis.crypto.randomUUID();
  } while (ids.has(id));
  ids.add(id);
  return id;
}

function childArrays(field) {
  const locations = [field, field?.repeatable_row];
  return locations.flatMap(location => CHILD_KEYS
    .filter(key => Array.isArray(location?.[key]))
    .map(key => location[key]));
}

function assignOwnedIds(field, ids, references) {
  if (typeof field.id === 'string' && field.id) {
    const newId = nextId(ids);
    references.set(field.id, newId);
    field.id = newId;
  }
  const rules = field.conditional_filters?.rules;
  if (Array.isArray(rules)) {
    rules.forEach(rule => {
      if (typeof rule?.id === 'string' && rule.id) rule.id = nextId(ids);
    });
  }
  childArrays(field).forEach(children => children.forEach(child => {
    if (child && typeof child === 'object') assignOwnedIds(child, ids, references);
  }));
}

// Only known form-field references are rewritten. In particular, target_field_id,
// option_source.filters[].field_id, custom_field_id and arbitrary values are
// external data/choice values, even if they happen to equal an old field ID.
function remapReferences(value, references) {
  if (Array.isArray(value)) {
    value.forEach(item => remapReferences(item, references));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [property, item] of Object.entries(value)) {
    if (FIELD_REFERENCES.has(property) && references.has(item)) {
      value[property] = references.get(item);
    } else if (property === 'field_mappings' && item && !Array.isArray(item)
        && typeof item === 'object') {
      // Membership payment field mappings: external DB field ID -> form field ID.
      for (const [externalId, formFieldId] of Object.entries(item)) {
        if (references.has(formFieldId)) item[externalId] = references.get(formFieldId);
      }
    } else if (property !== 'id') {
      remapReferences(item, references);
    }
  }
}

/**
 * Duplicate one top-level form field. Throws for a missing field; neither the
 * input form nor its original field/check objects are mutated.
 */
export function duplicateFormField(form, sourceId) {
  if (!form || !Array.isArray(form.fields)) {
    throw new TypeError('duplicateFormField requires a form with a fields array');
  }
  const index = form.fields.findIndex(field => field?.id === sourceId);
  if (index < 0) throw new Error(`Form field not found: ${sourceId}`);

  const ids = new Set();
  collectIds(form, ids);
  const references = new Map();
  const field = clone(form.fields[index]);
  assignOwnedIds(field, ids, references);
  remapReferences(field, references);
  field.label = `${field.label || 'Untitled field'} (copy)`;

  const fields = [...form.fields];
  fields.splice(index + 1, 0, field);
  const checks = form.uniqueness_checks;
  const originalChecks = Array.isArray(checks)
    ? checks.filter(check => check?.field_id === sourceId)
    : [];
  const uniqueness_checks = originalChecks.length
    ? [...checks, ...originalChecks.map(check => ({ ...clone(check), field_id: field.id }))]
    : checks;
  return { form: { ...form, fields, ...(originalChecks.length ? { uniqueness_checks } : {}) }, field };
}