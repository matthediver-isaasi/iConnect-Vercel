/**
 * Helpers for the automatic membership feature.
 *
 * Backend contract:
 *  GET  /api/member-groups/automatic-membership[?group_id=<id>]
 *       → { fields: { member: { core, custom }, organization: { core, custom } }, group? }
 *       Each field descriptor has field_key (backend may also send key — tolerate both).
 *
 *  POST /api/member-groups/automatic-membership
 *       { action: 'preview', groupId?, config: { enabled, role, filterGroups, roles } }
 *       → { matchCount, validationErrors }
 *
 *       { action: 'reconcile', groupId }
 *       → { queued: true } | { synced: true }
 *
 * Canonical operator codes (backend allowlist):
 *   text:    equals, not_equals, contains, is_empty, is_not_empty
 *   number:  equals, not_equals, greater_than, less_than, is_empty, is_not_empty
 *   date:    equals, before, after, is_empty, is_not_empty
 *   boolean: is_true, is_false, is_empty, is_not_empty  (no separate value input)
 *   select:  equals, not_equals, is_one_of, is_not_one_of, is_empty, is_not_empty
 *
 * Sync statuses: idle | queued | running | error
 *   idle = last sync completed successfully (no error).
 */

/**
 * Return the list of operator options for a given data_type.
 * Each entry: { value, label }
 */
export function operatorsForDataType(dataType) {
  switch (dataType) {
    case 'boolean':
      return [
        { value: 'is_true', label: 'is true' },
        { value: 'is_false', label: 'is false' },
        { value: 'is_empty', label: 'is empty' },
        { value: 'is_not_empty', label: 'is not empty' },
      ];
    case 'number':
    case 'decimal':
      return [
        { value: 'equals', label: 'equals' },
        { value: 'not_equals', label: 'not equals' },
        { value: 'greater_than', label: 'greater than' },
        { value: 'less_than', label: 'less than' },
        { value: 'is_empty', label: 'is empty' },
        { value: 'is_not_empty', label: 'is not empty' },
      ];
    case 'date':
      return [
        { value: 'equals', label: 'on' },
        { value: 'before', label: 'before' },
        { value: 'after', label: 'after' },
        { value: 'is_empty', label: 'is empty' },
        { value: 'is_not_empty', label: 'is not empty' },
      ];
    case 'select':
      return [
        { value: 'equals', label: 'equals' },
        { value: 'not_equals', label: 'not equals' },
        { value: 'is_one_of', label: 'is one of' },
        { value: 'is_not_one_of', label: 'is not one of' },
        { value: 'is_empty', label: 'is empty' },
        { value: 'is_not_empty', label: 'is not empty' },
      ];
    case 'multi_select':
      return [
        { value: 'is_one_of', label: 'contains one of' },
        { value: 'is_not_one_of', label: 'contains none of' },
        { value: 'is_empty', label: 'is empty' },
        { value: 'is_not_empty', label: 'is not empty' },
      ];
    default: // text
      return [
        { value: 'contains', label: 'contains' },
        { value: 'equals', label: 'equals' },
        { value: 'not_equals', label: 'not equals' },
        { value: 'is_empty', label: 'is empty' },
        { value: 'is_not_empty', label: 'is not empty' },
      ];
  }
}

/** True when the operator does not need a value input. */
export function isNullaryOperator(op) {
  return (
    op === 'is_empty' ||
    op === 'is_not_empty' ||
    op === 'is_true' ||
    op === 'is_false'
  );
}

/** True when the operator expects an array value (multi-select style). */
export function isMultiValueOperator(op) {
  return op === 'is_one_of' || op === 'is_not_one_of';
}

/**
 * Normalise a condition value before sending to the backend:
 * - is_one_of / is_not_one_of: wrap scalar in array if needed
 * - nullary ops: undefined (no value field)
 * - everything else: string as-is
 */
export function normalizeConditionValue(operator, value) {
  if (isNullaryOperator(operator)) return undefined;
  if (isMultiValueOperator(operator)) {
    if (Array.isArray(value)) return value;
    return value != null && value !== '' ? [value] : [];
  }
  return value;
}

/**
 * Build a flat list of field descriptor options from the fields metadata
 * returned by the GET endpoint.
 *
 * Returns: [ { field_key, label, entity_scope, field_type, data_type, options?, _label } ]
 *
 * Tolerates backends that send `key` instead of (or in addition to) `field_key`.
 */
export function buildFieldOptions(fieldsData) {
  if (!fieldsData) return [];
  const out = [];
  const scopes = [
    { scope: 'member', label: 'Member' },
    { scope: 'organization', label: 'Organisation' },
  ];
  for (const { scope, label: scopeLabel } of scopes) {
    const scopeFields = fieldsData[scope];
    if (!scopeFields) continue;
    for (const fieldType of ['core', 'custom']) {
      const list = scopeFields[fieldType];
      if (!Array.isArray(list)) continue;
      for (const f of list) {
        const fieldKey = f.field_key || f.key || '';
        if (!fieldKey) continue;
        out.push({
          ...f,
          field_key: fieldKey,
          entity_scope: scope,
          field_type: fieldType,
          _label: `${scopeLabel} · ${f.label || fieldKey}`,
        });
      }
    }
  }
  return out;
}

/** A blank filter group with one empty condition. */
export function blankFilterGroup() {
  return { conditions: [blankCondition()] };
}

/** A blank condition. */
export function blankCondition() {
  return {
    entity_scope: 'member',
    field_type: 'core',
    field_key: '',
    data_type: 'text',
    operator: 'contains',
    value: '',
  };
}

/**
 * Validate automatic membership config before save.
 * Returns an array of error strings; empty = valid.
 */
export function validateAutoConfig({ enabled, role, filterGroups, availableRoles }) {
  if (!enabled) return [];
  const errors = [];
  if (!role) {
    errors.push('An automatic membership role must be selected.');
  } else if (availableRoles && availableRoles.length > 0 && !availableRoles.includes(role)) {
    errors.push("The selected automatic membership role is not in the group's role list.");
  }
  if (!Array.isArray(filterGroups) || filterGroups.length === 0) {
    errors.push('At least one filter group with at least one condition is required.');
    return errors;
  }
  let hasAnyCondition = false;
  for (const [gi, fg] of filterGroups.entries()) {
    if (!Array.isArray(fg.conditions) || fg.conditions.length === 0) continue;
    for (const [ci, cond] of fg.conditions.entries()) {
      if (!cond.field_key) {
        errors.push(`Filter group ${gi + 1}, condition ${ci + 1}: a field must be selected.`);
      } else {
        hasAnyCondition = true;
        if (!isNullaryOperator(cond.operator)) {
          const val = cond.value;
          const isEmpty = val === '' || val == null || (Array.isArray(val) && val.length === 0);
          if (isEmpty) {
            errors.push(`Filter group ${gi + 1}, condition ${ci + 1}: a value is required.`);
          }
        }
      }
    }
  }
  if (!hasAnyCondition) {
    errors.push('At least one complete condition is required.');
  }
  return errors;
}
