export const ORG_DIRECTORY_FILTER_SETTING = 'org_directory_filterable_back_fields';

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Parse the persisted filter override map. Invalid persisted configuration is
 * deliberately an error: treating corruption as an empty map can unexpectedly
 * broaden or narrow a directory.
 */
export function parseOrganisationDirectoryFilterOverrides(value) {
  if (value === undefined || value === null) return {};
  let parsed = value;
  if (typeof parsed === 'string') {
    parsed = JSON.parse(parsed);
  }
  if (!plainObject(parsed)) {
    throw new TypeError('Organisation directory filter overrides must be an object');
  }
  const output = {};
  for (const [key, enabled] of Object.entries(parsed)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) {
      throw new TypeError(`Unsafe organisation directory filter override key: ${key}`);
    }
    if (typeof enabled !== 'boolean') {
      throw new TypeError(`Organisation directory filter override "${key}" must be boolean`);
    }
    output[key] = enabled;
  }
  return output;
}

export function isOrganisationDirectoryFieldFilterable(key, overrides, field) {
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, key)
      && typeof overrides[key] === 'boolean') {
    return overrides[key];
  }
  return String(key).startsWith('custom:') && field?.is_filterable === true;
}