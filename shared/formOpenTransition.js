const DISPLAY_ONLY_TYPES = new Set([
  'instructions', 'image', 'section_header', 'heading', 'paragraph', 'divider', 'spacer', 'html',
]);

const COLLECTION_TYPES = new Set([
  'checkbox', 'list', 'countries', 'category_multiselect', 'communication_preferences',
]);

const BOOLEAN_TYPES = new Set(['boolean', 'terms_conditions']);
const OBJECT_TYPES = new Set(['contact', 'address_lookup', 'grouped_question', 'score', 'repeatable_rows']);
const UNSAFE_TYPES = new Set(['file', 'signature', 'payment', 'membership_payment']);
const TEXT_TYPES = new Set(['text', 'textarea', 'email', 'url', 'tel', 'phone', 'hidden']);

export const OPEN_FORM_ACTION_TYPE = 'open_form';
export const MAX_FORM_TRANSITIONS = 8;

export function isFormTransitionField(field) {
  return !!field?.id
    && !DISPLAY_ONLY_TYPES.has(field.type)
    && !UNSAFE_TYPES.has(field.type)
    && !field.repeatable_field_id
    && !field.parent_repeatable_field_id;
}

function valueShape(field) {
  if (!isFormTransitionField(field)) return 'unsupported';
  if (COLLECTION_TYPES.has(field.type)) return 'collection';
  if (BOOLEAN_TYPES.has(field.type)) return 'boolean';
  if (TEXT_TYPES.has(field.type)) return 'text';
  if (OBJECT_TYPES.has(field.type)) return `object:${field.type}`;
  return `scalar:${field.type}`;
}

export function areFormTransitionFieldsCompatible(source, target) {
  const sourceShape = valueShape(source);
  const targetShape = valueShape(target);
  return sourceShape !== 'unsupported' && sourceShape === targetShape;
}

export function findPersistedOpenFormAction(rules, actionId) {
  for (const rule of Array.isArray(rules) ? rules : []) {
    for (const action of Array.isArray(rule?.actions) ? rule.actions : []) {
      if (String(action?.id || '') === String(actionId || '')
          && (action.action_type || action.rule_type || action.action) === OPEN_FORM_ACTION_TYPE) {
        return { rule, action };
      }
    }
  }
  return null;
}

export function normalizeFormTransitionMappings(action, sourceFields, targetFields) {
  const sourceById = new Map((sourceFields || []).map(field => [String(field?.id), field]));
  const targetById = new Map((targetFields || []).map(field => [String(field?.id), field]));
  const seenTargets = new Set();
  const mappings = [];

  for (const raw of Array.isArray(action?.mappings) ? action.mappings : []) {
    const sourceFieldId = String(raw?.source_field_id || '');
    const targetFieldId = String(raw?.target_field_id || '');
    const source = sourceById.get(sourceFieldId);
    const target = targetById.get(targetFieldId);
    if (!sourceFieldId || !targetFieldId || seenTargets.has(targetFieldId)
        || !areFormTransitionFieldsCompatible(source, target)) {
      return { valid: false, mappings: [] };
    }
    seenTargets.add(targetFieldId);
    mappings.push({
      id: String(raw?.id || `${sourceFieldId}:${targetFieldId}`),
      source_field_id: sourceFieldId,
      target_field_id: targetFieldId,
    });
  }
  return { valid: true, mappings };
}

export function mapFormTransitionValues(mappings, answers) {
  const values = {};
  for (const mapping of mappings || []) {
    if (Object.prototype.hasOwnProperty.call(answers || {}, mapping.source_field_id)) {
      values[mapping.target_field_id] = answers[mapping.source_field_id];
    }
  }
  return values;
}