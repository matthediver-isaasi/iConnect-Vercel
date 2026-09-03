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

export function isAddressLookupComponent(value) {
  return typeof value === 'string' && componentSet.has(value);
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

export const isAddressLookupAnswerFilled = (field, value) => {
  const answer = normalizeAddressLookupAddress(value);
  if (!answer) return false;
  const required = addressLookupRequiredComponents(field);
  return required.length > 0
    ? required.every(component => Boolean(answer[component]))
    : addressLookupVisibleComponents(field).some(component => Boolean(answer[component]));
};