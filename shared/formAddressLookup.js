// The persisted value contract for an address lookup form field.  This file
// deliberately contains no provider details or credentials so it can be used
// by both server validation and form clients.
export const ADDRESS_LOOKUP_COMPONENTS = Object.freeze([
  'line_1',
  'line_2',
  'line_3',
  'post_town',
  'county',
  'postcode',
  'country',
]);

const componentSet = new Set(ADDRESS_LOOKUP_COMPONENTS);
export const ADDRESS_ENTRY_MODE_OPERATORS = Object.freeze(['equals', 'not_equals']);
const addressEntryModeOperatorSet = new Set(ADDRESS_ENTRY_MODE_OPERATORS);
const ADDRESS_ENTRY_MODE_SOURCE_TYPES = new Set([
  'text', 'email', 'number', 'tel', 'url', 'date', 'time', 'select', 'radio', 'checkbox',
  'boolean', 'country', 'countries', 'list', 'category_dropdown',
  'category_multiselect', 'organisation_dropdown', 'organisation_group_dropdown',
  'relationship_dropdown', 'image_buttons', 'custom_field',
]);

// BS 7666 postcode shapes, including GIR 0AA. Keep this shared so the client
// only triggers billable lookup requests for values the server will accept.
const UK_POSTCODE = /^(?:GIR 0AA|(?:(?:[A-PR-UWYZ][0-9]{1,2})|(?:[A-PR-UWYZ][A-HK-Y][0-9]{1,2})|(?:[A-PR-UWYZ][0-9][A-HJKSTUW])|(?:[A-PR-UWYZ][A-HK-Y][0-9][ABEHMNPRVWXY])) [0-9][ABD-HJLNP-UW-Z]{2})$/;

export function normalizeUkPostcode(value) {
  if (typeof value !== 'string') return null;
  const compact = value.trim().replace(/\s+/g, '').toUpperCase();
  if (compact.length < 5 || compact.length > 7) return null;
  const normalized = `${compact.slice(0, -3)} ${compact.slice(-3)}`;
  return UK_POSTCODE.test(normalized) ? normalized : null;
}

export function isAddressLookupComponent(value) {
  return typeof value === 'string' && componentSet.has(value);
}

export function isEligibleAddressEntryModeSource(field) {
  return Boolean(field?.id && ADDRESS_ENTRY_MODE_SOURCE_TYPES.has(field.type));
}

export function addressEntryModeSourceFields(fields, addressFieldId) {
  if (!Array.isArray(fields)) return [];
  const targetIndex = fields.findIndex(field => field?.id === addressFieldId);
  if (targetIndex < 0) return [];
  return fields.slice(0, targetIndex).filter(isEligibleAddressEntryModeSource);
}

export function normalizeAddressEntryModeRule(rule) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return null;
  const sourceFieldId = typeof rule.source_field_id === 'string' ? rule.source_field_id.trim() : '';
  const operator = typeof rule.operator === 'string' ? rule.operator : '';
  const value = rule.value;
  if (!sourceFieldId || !addressEntryModeOperatorSet.has(operator)) return null;
  if (!['string', 'number', 'boolean'].includes(typeof value)) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  return { source_field_id: sourceFieldId, operator, value };
}

export function validateAddressEntryModeRule(field, fields) {
  if (field?.type !== 'address_lookup' || field?.address_entry_mode_rule == null) {
    return { valid: true, rule: null };
  }
  const rule = normalizeAddressEntryModeRule(field.address_entry_mode_rule);
  if (!rule) return { valid: false, rule: null, error: 'has an incomplete manual-entry condition.' };
  const eligible = addressEntryModeSourceFields(fields, field.id);
  if (!eligible.some(source => source.id === rule.source_field_id)) {
    return { valid: false, rule: null, error: 'must use an earlier compatible field for its manual-entry condition.' };
  }
  return { valid: true, rule };
}

export function resolveAddressManualOnly(field, fields, values) {
  const validation = validateAddressEntryModeRule(field, fields);
  if (!validation.valid || !validation.rule) return false;
  const { source_field_id: sourceFieldId, operator, value: expected } = validation.rule;
  const actual = values?.[sourceFieldId];
  if (
    actual === undefined
    || actual === null
    || (typeof actual === 'string' && actual.trim() === '')
    || (Array.isArray(actual) && actual.length === 0)
  ) return false;
  const equals = Array.isArray(actual)
    ? actual.some(item => String(item) === String(expected))
    : typeof actual === 'boolean'
      ? actual === (expected === true || expected === 'true')
      : String(actual ?? '') === String(expected);
  return operator === 'equals' ? equals : !equals;
}

export function normalizeAddressLookupAddress(address) {
  if (!address || typeof address !== 'object' || Array.isArray(address)) return null;
  const normalized = {};
  for (const component of ADDRESS_LOOKUP_COMPONENTS) {
    // Ideal Postcodes uses this native contract, while a few consumers use
    // conventional aliases. Accept aliases only at the boundary; persisted
    // answers always use the component names above.
    const aliases = {
      line_1: ['address_line_1', 'line1', 'address1'],
      line_2: ['address_line_2', 'line2', 'address2'],
      line_3: ['address_line_3', 'line3', 'address3'],
      post_town: ['city', 'town'],
      county: ['region', 'state'],
      postcode: ['post_code', 'postal_code', 'zip'],
      country: ['country_name'],
    };
    const alias = aliases[component]?.find(key => address[key] !== undefined);
    const value = address[component] ?? (alias ? address[alias] : undefined);
    normalized[component] = typeof value === 'string' ? value.trim() : '';
  }
  return normalized;
}

export function addressLookupHasRequiredComponents(value, requiredComponents = []) {
  const address = normalizeAddressLookupAddress(value);
  if (!address) return false;
  return requiredComponents.every(component =>
    isAddressLookupComponent(component) && Boolean(address[component]),
  );
}

export const normalizeAddressLookupAnswer = value => (
  normalizeAddressLookupAddress(value) || Object.fromEntries(
    ADDRESS_LOOKUP_COMPONENTS.map(component => [component, '']),
  )
);

export const normalizeAddressLookupResult = normalizeAddressLookupAnswer;

export const addressLookupVisibleComponents = field => {
  const configured = field?.visible_components || field?.address_components?.visible;
  if (!Array.isArray(configured)) return [...ADDRESS_LOOKUP_COMPONENTS];
  // The postcode cannot be hidden: it is both the lookup input and part of
  // the submitted normalized answer.
  return [...new Set(['postcode', ...configured.filter(isAddressLookupComponent)])];
};

export const addressLookupRequiredComponents = field => {
  const configured = field?.required_components || field?.address_components?.required;
  if (Array.isArray(configured)) return configured.filter(isAddressLookupComponent);
  if (!field?.required) return [];
  return addressLookupVisibleComponents(field)
    .filter(component => !['line_2', 'line_3', 'county'].includes(component));
};

export const validateAddressLookupMappingComponent = (mapping, fields) => {
  const hasComponent = mapping?.source_component !== undefined;
  if ((mapping?.source_type || 'field') !== 'field') {
    return hasComponent
      ? { valid: false, error: 'must not retain an address component for a non-field source.' }
      : { valid: true };
  }
  const sourceField = (fields || []).find(field => field?.id === mapping?.source_field_id);
  if (sourceField?.type !== 'address_lookup') {
    return hasComponent
      ? { valid: false, error: 'must not retain an address component for a non-address field.' }
      : { valid: true };
  }
  if (!addressLookupVisibleComponents(sourceField).includes(mapping?.source_component)) {
    return { valid: false, error: 'must select a visible supported address component.' };
  }
  return { valid: true };
};

export const validateAddressLookupMappingComponents = (mappings, fields) => {
  const errors = [];
  for (const [index, mapping] of (mappings || []).entries()) {
    const result = validateAddressLookupMappingComponent(mapping, fields);
    if (!result.valid) errors.push(`mapping ${index + 1} ${result.error}`);
  }
  return errors;
};

export const assertValidAddressLookupMappingComponents = (mappings, fields) => {
  const errors = validateAddressLookupMappingComponents(mappings, fields);
  if (errors.length) {
    const error = new Error(`Invalid address lookup mapping contract: ${errors.join('; ')}`);
    error.code = 'INVALID_FORM_ADDRESS_COMPONENT_MAPPING';
    error.details = errors;
    throw error;
  }
};

export const isAddressLookupAnswerFilled = (field, value) => {
  const answer = normalizeAddressLookupAddress(value);
  if (!answer) return false;
  const required = addressLookupRequiredComponents(field);
  return required.length > 0
    ? required.every(component => Boolean(answer[component]))
    : addressLookupVisibleComponents(field).some(component => Boolean(answer[component]));
};