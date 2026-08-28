import { COUNTRIES } from '../../../shared/countries.js';
import {
  FORM_NOT_LISTED_VALUE,
  prependFormNotListedOption,
} from '../../../shared/formNotListedChoice.js';
import {
  FORM_NO_RELATIONSHIP_VALUE,
  formNoRelationshipLabel,
} from '../../../shared/formNoRelationshipChoice.js';

function option(value, label = value) {
  return { value, label: String(label ?? value ?? '') };
}

function configuredOptions(field) {
  const values = Array.isArray(field?.options)
    ? field.options
    : (Array.isArray(field?.choices) ? field.choices : []);
  return values
    .filter(item => item !== '')
    .map(item => {
      if (item && typeof item === 'object') {
        const value = item.value ?? item.id ?? '';
        return option(value, item.label ?? item.name ?? value);
      }
      return option(item);
    });
}

export function getFormLogicConditionOptions({
  field,
  categories = [],
  communicationCategories = [],
  customFields = [],
  organizations = [],
} = {}) {
  if (!field) return [];

  let options = [];
  if (['select', 'radio', 'checkbox'].includes(field.type)) {
    options = configuredOptions(field);
  } else if (field.type === 'image_buttons') {
    options = (field.image_options || [])
      .filter(item => item?.value !== '')
      .map(item => option(item.value, item.label ?? item.value));
  } else if (field.type === 'boolean') {
    options = [option('true', 'True'), option('false', 'False')];
  } else if (field.type === 'organisation_dropdown') {
    options = organizations.map(organization => option(
      organization.id,
      organization.name || organization.id,
    ));
  } else if (field.type === 'relationship_dropdown') {
    options = [
      option(FORM_NO_RELATIONSHIP_VALUE, formNoRelationshipLabel(field)),
      ...configuredOptions(field),
    ];
  } else if (field.type === 'country' || field.type === 'countries') {
    const allowed = field.all_countries === false
      ? new Set(field.selected_countries || [])
      : null;
    options = COUNTRIES
      .filter(country => !allowed || allowed.has(country.code))
      .map(country => option(country.name));
  } else if (field.type === 'category_multiselect') {
    const allowed = new Set(field.allowed_category_ids || []);
    options = categories
      .filter(category => allowed.size === 0 || allowed.has(category.id))
      .flatMap(category => category.subcategories || category.children || category.options || [])
      .map(item => item && typeof item === 'object'
        ? option(item.value ?? item.id ?? item.label ?? item.name, item.label ?? item.name ?? item.value ?? item.id)
        : option(item));
  } else if (field.type === 'category_dropdown') {
    const category = categories.find(item => item.id === field.category_id);
    options = (category?.subcategories || category?.children || category?.options || [])
      .map(item => item && typeof item === 'object'
        ? option(item.value ?? item.id ?? item.label ?? item.name, item.label ?? item.name ?? item.value ?? item.id)
        : option(item));
  } else if (field.type === 'communication_preferences') {
    const allowed = new Set(field.allowed_category_ids || []);
    options = communicationCategories
      .filter(category => allowed.size === 0 || allowed.has(category.id))
      .map(category => option(category.id, category.name || category.id));
  } else if (field.type === 'custom_field') {
    const definition = customFields.find(item => item.id === field.custom_field_id);
    if (definition?.field_type === 'country' || definition?.field_type === 'countries') {
      const allowed = definition.all_countries === false
        ? new Set(definition.selected_countries || [])
        : null;
      options = COUNTRIES
        .filter(country => !allowed || allowed.has(country.code))
        .map(country => option(country.name));
    } else {
      options = configuredOptions(definition || field);
    }
  } else {
    options = configuredOptions(field);
  }

  return prependFormNotListedOption(field, options);
}

function normalizeBooleanCompareValue(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return value;
}

export function evaluateFormLogicCondition(triggerValue, operator, expectedValue, {
  relationshipEmpty = false,
} = {}) {
  if (expectedValue === FORM_NO_RELATIONSHIP_VALUE && !relationshipEmpty) return false;
  const effectiveTriggerValue = expectedValue === FORM_NO_RELATIONSHIP_VALUE
    ? FORM_NO_RELATIONSHIP_VALUE
    : triggerValue;
  const booleanTrigger = typeof effectiveTriggerValue === 'boolean';
  switch (operator) {
    case 'equals':
      if (booleanTrigger) return effectiveTriggerValue === normalizeBooleanCompareValue(expectedValue);
      if (Array.isArray(effectiveTriggerValue)) return effectiveTriggerValue.includes(expectedValue);
      return effectiveTriggerValue === expectedValue;
    case 'not_equals':
      if (booleanTrigger) return effectiveTriggerValue !== normalizeBooleanCompareValue(expectedValue);
      if (Array.isArray(effectiveTriggerValue)) return !effectiveTriggerValue.includes(expectedValue);
      return effectiveTriggerValue !== expectedValue;
    case 'contains':
      if (Array.isArray(effectiveTriggerValue)) return effectiveTriggerValue.includes(expectedValue);
      if (typeof effectiveTriggerValue === 'string') return effectiveTriggerValue.includes(expectedValue);
      return false;
    case 'not_empty':
      return triggerValue !== undefined
        && triggerValue !== null
        && triggerValue !== ''
        && (Array.isArray(triggerValue) ? triggerValue.length > 0 : true);
    case 'is_empty':
      return triggerValue === undefined
        || triggerValue === null
        || triggerValue === ''
        || (Array.isArray(triggerValue) && triggerValue.length === 0);
    default:
      return false;
  }
}

export function isOnlyFormNotListedConditionOption(options) {
  return Array.isArray(options)
    && options.length === 1
    && options[0]?.value === FORM_NOT_LISTED_VALUE;
}