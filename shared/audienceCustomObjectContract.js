export const CUSTOM_OBJECT_AUDIENCE_VERSION = 1;
export const CUSTOM_OBJECT_AUDIENCE_SCOPE = 'custom_object';
export const CUSTOM_OBJECT_OPERATORS = {
  text: ['equals', 'not_equals', 'contains', 'is_empty', 'is_not_empty'],
  textarea: ['equals', 'not_equals', 'contains', 'is_empty', 'is_not_empty'],
  email: ['equals', 'not_equals', 'contains', 'is_empty', 'is_not_empty'],
  url: ['equals', 'not_equals', 'contains', 'is_empty', 'is_not_empty'],
  number: ['equals', 'not_equals', 'greater_than', 'less_than', 'is_empty', 'is_not_empty'],
  decimal: ['equals', 'not_equals', 'greater_than', 'less_than', 'is_empty', 'is_not_empty'],
  date: ['equals', 'not_equals', 'before', 'after', 'is_empty', 'is_not_empty'],
  datetime: ['equals', 'not_equals', 'before', 'after', 'is_empty', 'is_not_empty'],
  boolean: ['is_true', 'is_false', 'is_empty', 'is_not_empty'],
  select: ['equals', 'not_equals', 'is_one_of', 'is_not_one_of', 'is_empty', 'is_not_empty'],
  dropdown: ['equals', 'not_equals', 'is_one_of', 'is_not_one_of', 'is_empty', 'is_not_empty'],
  country: ['equals', 'not_equals', 'is_one_of', 'is_not_one_of', 'is_empty', 'is_not_empty'],
};
export function customObjectSelectionKey(condition) {
  return JSON.stringify([condition.custom_object_id, condition.relationship_definition_id, condition.object_side]);
}
export function isCustomObjectCondition(condition) {
  return condition?.entity_scope === CUSTOM_OBJECT_AUDIENCE_SCOPE;
}