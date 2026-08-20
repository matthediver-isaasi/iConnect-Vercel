/**
 * Shared validator / evaluator / reconciler for automatic membership rules.
 *
 * Pure-logic: accepts injectable fakes for DB access so it can be unit-tested
 * without a live Supabase connection. Production callers pass the real client.
 */

// ---------------------------------------------------------------------------
// Field allowlists + canonical type maps
// ---------------------------------------------------------------------------

export const ALLOWED_CORE_MEMBER_KEYS = new Set([
  'first_name', 'last_name', 'email', 'job_title',
  'role_id', 'login_enabled', 'communications_opted_out_all',
]);

export const ALLOWED_CORE_ORG_KEYS = new Set(['name', 'status']);

/**
 * Server-authoritative canonical data_type for every core field.
 * Never trust cond.data_type from the client for core fields.
 */
export const CORE_MEMBER_FIELD_TYPES = {
  first_name:                   'text',
  last_name:                    'text',
  email:                        'text',
  job_title:                    'text',
  role_id:                      'text',
  login_enabled:                'boolean',
  communications_opted_out_all: 'boolean',
};

export const CORE_ORG_FIELD_TYPES = {
  name:   'text',
  status: 'text',
};

// ---------------------------------------------------------------------------
// Operator definitions by canonical type
// Each set lists all operators that are valid for that canonical type.
// ---------------------------------------------------------------------------

export const OPERATORS_BY_TYPE = {
  text: new Set([
    'equals', 'not_equals', 'contains',
    'is_empty', 'is_not_empty',
  ]),
  boolean: new Set([
    'is_true', 'is_false',
    'is_empty', 'is_not_empty',
  ]),
  number: new Set([
    'equals', 'not_equals',
    'greater_than', 'less_than',
    'is_empty', 'is_not_empty',
  ]),
  decimal: new Set([
    'equals', 'not_equals',
    'greater_than', 'less_than',
    'is_empty', 'is_not_empty',
  ]),
  date: new Set([
    'equals',
    'before', 'after',
    'is_empty', 'is_not_empty',
  ]),
  select: new Set([
    'equals', 'not_equals',
    'is_one_of', 'is_not_one_of',
    'is_empty', 'is_not_empty',
  ]),
  multi_select: new Set([
    'is_one_of', 'is_not_one_of',
    'is_empty', 'is_not_empty',
  ]),
};

/**
 * Preference fields use several legacy names for the same stored value shape.
 * Collapse those names before exposing metadata to either validation or the UI.
 */
export function normalizePreferenceFieldType(fieldType) {
  switch (String(fieldType || '').toLowerCase()) {
    case 'boolean':
    case 'checkbox':
      return 'boolean';
    case 'number':
    case 'decimal':
    case 'currency':
      return 'number';
    case 'date':
    case 'datetime':
      return 'date';
    case 'dropdown':
    case 'picklist':
    case 'select':
    case 'countries':
      return 'select';
    case 'list':
    case 'multi_select':
      return 'multi_select';
    default:
      // Custom values are persisted as strings, so unknown textual controls
      // receive the conservative text operator set rather than arbitrary ops.
      return 'text';
  }
}

// Nullary operators: no value required/allowed
const NULLARY_OPERATORS = new Set([
  'is_empty', 'is_not_empty', 'is_true', 'is_false',
]);

// Array-value operators: value must be an array
const ARRAY_OPERATORS = new Set(['is_one_of', 'is_not_one_of']);

// All valid operators across all types (for quick first-pass check)
export const ALLOWED_OPERATORS = new Set(
  Object.values(OPERATORS_BY_TYPE).flatMap(s => [...s])
);

export const ALLOWED_SCOPES = new Set(['member', 'organization']);

// ISO YYYY-MM-DD pattern
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The generic entity API remains available for legacy group flows, so the
 * policy boundary must be explicit whenever a request includes one of the new
 * automatic-membership or member-leave controls.
 */
export function authorizeAutomaticMembershipPolicyWrite({ body, isAdmin }) {
  const touchesPolicy = Object.keys(body || {}).some(
    key => key === 'allow_members_to_leave' || key.startsWith('automatic_membership_')
  );
  if (!touchesPolicy || isAdmin) return { ok: true };
  return {
    ok: false,
    status: 403,
    error: 'Only tenant administrators can configure automatic group membership.',
  };
}

// ---------------------------------------------------------------------------
// Condition / filter-group validation
// ---------------------------------------------------------------------------

/**
 * Resolve the canonical type for a condition, using server-authoritative maps.
 * For core fields, type comes entirely from the server map.
 * For custom fields, type comes from metadata (fieldMeta) if available.
 *
 * @param {object} cond
 * @param {object} fieldMeta  - { member: Map<id,{data_type,options}>, organization: Map<id,{data_type,options}> }
 * @returns {string|null}  canonical type name, or null if unknown
 */
export function resolveCanonicalType(cond, fieldMeta) {
  if (cond.field_type === 'core') {
    const map = cond.entity_scope === 'member' ? CORE_MEMBER_FIELD_TYPES : CORE_ORG_FIELD_TYPES;
    return map[cond.field_key] ?? null;
  }
  if (cond.field_type === 'custom') {
    const meta = fieldMeta?.[cond.entity_scope];
    const entry = meta instanceof Map ? meta.get(cond.field_key) : null;
    return entry?.data_type ?? null;
  }
  return null;
}

/**
 * Validate a single condition object.
 * Returns null on success, or an error string on failure.
 *
 * Strict validation:
 * - entity_scope must be 'member' or 'organization'
 * - field_type must be 'core' or 'custom'
 * - For core fields: field_key must be in the server allowlist
 * - For custom fields: field_key must be in the scope-keyed allowed set
 * - operator must be valid for the canonical type of the field
 * - value shape must match the operator: nullary ops have no value,
 *   array ops must have non-empty arrays, scalar ops must have a value
 * - Number values must be finite; date values must match YYYY-MM-DD
 * - For select/multi_select with known options, selected values must be valid
 *
 * @param {object}        cond
 * @param {object|Set}    allowedCustomFieldIdsByScope
 *   { member: Set<string>, organization: Set<string> } or plain Set (member-scope compat)
 * @param {object}        [fieldMeta]
 *   { member: Map<id,{data_type,options}>, organization: Map<id,{data_type,options}> }
 */
export function validateCondition(cond, allowedCustomFieldIdsByScope = {}, fieldMeta = {}) {
  if (!cond || typeof cond !== 'object') return 'condition must be an object';

  if (!ALLOWED_SCOPES.has(cond.entity_scope)) {
    return `unknown entity_scope "${cond.entity_scope}"`;
  }

  if (cond.field_type !== 'core' && cond.field_type !== 'custom') {
    return `field_type must be "core" or "custom", got "${cond.field_type}"`;
  }

  // Field key / scope check
  if (cond.field_type === 'core') {
    const allowed = cond.entity_scope === 'member' ? ALLOWED_CORE_MEMBER_KEYS : ALLOWED_CORE_ORG_KEYS;
    if (!allowed.has(cond.field_key)) {
      return `field_key "${cond.field_key}" is not in the core allowlist for scope "${cond.entity_scope}"`;
    }
  } else {
    // custom field: scope-aware check
    let scopeSet;
    if (allowedCustomFieldIdsByScope instanceof Set) {
      // Backward-compat: treat plain Set as member scope
      scopeSet = cond.entity_scope === 'member' ? allowedCustomFieldIdsByScope : new Set();
    } else {
      scopeSet = allowedCustomFieldIdsByScope[cond.entity_scope];
    }
    if (!scopeSet || !scopeSet.has(cond.field_key)) {
      return `custom field_key "${cond.field_key}" is not an active tenant-owned preference field for scope "${cond.entity_scope}"`;
    }
  }

  // Resolve canonical type (never trust cond.data_type)
  const canonicalType = resolveCanonicalType(cond, fieldMeta);

  // Operator validity
  if (!ALLOWED_OPERATORS.has(cond.operator)) {
    return `unknown operator "${cond.operator}"`;
  }
  if (canonicalType) {
    const validOps = OPERATORS_BY_TYPE[canonicalType];
    if (validOps && !validOps.has(cond.operator)) {
      return `operator "${cond.operator}" is not valid for field type "${canonicalType}"`;
    }
  }

  // Value shape validation
  if (NULLARY_OPERATORS.has(cond.operator)) {
    // No value needed — do not error on extra value in payload, just ignore
  } else if (ARRAY_OPERATORS.has(cond.operator)) {
    if (!Array.isArray(cond.value) || cond.value.length === 0) {
      return `operator "${cond.operator}" requires a non-empty array value`;
    }
    if (
      cond.value.length > 100 ||
      cond.value.some(v => v === null || v === undefined || String(v).trim() === '')
    ) {
      return `operator "${cond.operator}" requires 1 to 100 non-empty values`;
    }
  } else {
    // Empty matching has explicit is_empty/is_not_empty operators.
    if (
      cond.value === null ||
      cond.value === undefined ||
      String(cond.value).trim() === ''
    ) {
      return `operator "${cond.operator}" requires a value`;
    }
  }

  // Numeric value validation for scalar operators
  if (canonicalType === 'number' || canonicalType === 'decimal') {
    if (!NULLARY_OPERATORS.has(cond.operator) && !ARRAY_OPERATORS.has(cond.operator)) {
      const n = Number(cond.value);
      if (!isFinite(n)) {
        return `operator "${cond.operator}" requires a finite numeric value, got "${cond.value}"`;
      }
    }
  }

  // Date value validation for scalar operators
  if (canonicalType === 'date') {
    if (!NULLARY_OPERATORS.has(cond.operator) && !ARRAY_OPERATORS.has(cond.operator)) {
      if (!ISO_DATE_RE.test(String(cond.value))) {
        return `operator "${cond.operator}" requires a date value in YYYY-MM-DD format, got "${cond.value}"`;
      }
    }
  }

  // Options validation for select/multi_select when options are available from metadata
  if ((canonicalType === 'select' || canonicalType === 'multi_select') && cond.field_type === 'custom') {
    const meta = fieldMeta?.[cond.entity_scope];
    const entry = meta instanceof Map ? meta.get(cond.field_key) : null;
    const options = Array.isArray(entry?.options) ? entry.options : null;
    if (options !== null && options.length > 0) {
      const validValues = new Set(options.map(o => (typeof o === 'object' ? String(o.value ?? o.label ?? o) : String(o))));
      if (ARRAY_OPERATORS.has(cond.operator)) {
        for (const v of cond.value) {
          if (!validValues.has(String(v))) {
            return `value "${v}" is not a valid option for field "${cond.field_key}"`;
          }
        }
      } else if (!NULLARY_OPERATORS.has(cond.operator)) {
        if (!validValues.has(String(cond.value))) {
          return `value "${cond.value}" is not a valid option for field "${cond.field_key}"`;
        }
      }
    }
  }

  return null;
}

/**
 * Validate the full automatic_membership_filter_groups array.
 * Returns { ok: true } or { ok: false, error: string }.
 *
 * @param {Array}       filterGroups
 * @param {object|Set}  allowedCustomFieldIdsByScope
 * @param {object}      [fieldMeta]
 */
export function validateFilterGroups(filterGroups, allowedCustomFieldIdsByScope = {}, fieldMeta = {}) {
  if (!Array.isArray(filterGroups)) return { ok: false, error: 'filter_groups must be an array' };
  if (filterGroups.length > 20) return { ok: false, error: 'filter_groups may contain at most 20 groups' };
  for (let gi = 0; gi < filterGroups.length; gi++) {
    const group = filterGroups[gi];
    if (!group || typeof group !== 'object') {
      return { ok: false, error: `filter_groups[${gi}] must be an object` };
    }
    const conditions = group.conditions;
    if (!Array.isArray(conditions) || conditions.length === 0) {
      return { ok: false, error: `filter_groups[${gi}].conditions must be a non-empty array` };
    }
    if (conditions.length > 20) {
      return { ok: false, error: `filter_groups[${gi}].conditions may contain at most 20 conditions` };
    }
    for (let ci = 0; ci < conditions.length; ci++) {
      const err = validateCondition(conditions[ci], allowedCustomFieldIdsByScope, fieldMeta);
      if (err) {
        return { ok: false, error: `filter_groups[${gi}].conditions[${ci}]: ${err}` };
      }
    }
  }
  return { ok: true };
}

/**
 * Validate the entire automatic membership settings block on a MemberGroup row.
 *
 * @param {object} effectiveRow
 * @param {object} opts
 * @param {object|Set} [opts.allowedCustomFieldIdsByScope]
 * @param {object}     [opts.fieldMeta]
 * @param {Function}   [opts.roleExists]  async (roleText) => boolean
 * @returns {Promise<{ ok: true }|{ ok: false, error: string }>}
 */
export async function validateAutomaticMembershipSettings(effectiveRow, {
  allowedCustomFieldIdsByScope = {},
  fieldMeta = {},
  roleExists,
} = {}) {
  const enabled = effectiveRow.automatic_membership_enabled;
  if (!enabled) return { ok: true };

  const role = effectiveRow.automatic_membership_role;
  const filterGroups = effectiveRow.automatic_membership_filter_groups;

  if (!role || typeof role !== 'string' || !role.trim()) {
    return { ok: false, error: 'automatic_membership_role is required when automatic membership is enabled' };
  }

  if (!Array.isArray(filterGroups) || filterGroups.length === 0) {
    return { ok: false, error: 'automatic_membership_filter_groups must be a non-empty array when automatic membership is enabled' };
  }

  const fgValidation = validateFilterGroups(filterGroups, allowedCustomFieldIdsByScope, fieldMeta);
  if (!fgValidation.ok) return fgValidation;

  if (typeof roleExists === 'function') {
    const exists = await roleExists(role);
    if (!exists) {
      return { ok: false, error: `automatic_membership_role "${role}" does not exist or does not belong to this group` };
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Pure AND/OR evaluator (no DB — works on in-memory member/org objects)
// ---------------------------------------------------------------------------

/**
 * Evaluate a single condition against a member data object.
 * Returns true/false.
 *
 * @param {object} cond              - { field_key, operator, value, field_type, entity_scope }
 * @param {object} memberRow         - flat member row { first_name, last_name, ... }
 * @param {object|null} [orgRow]     - flat organization row (may be null)
 * @param {object} [customMemberValues]  - plain object: field_id -> value_string
 * @param {object} [customOrgValues]     - plain object: field_id -> value_string
 */
export function evaluateCondition(cond, memberRow, orgRow, customMemberValues = {}, customOrgValues = {}) {
  let rawValue;
  if (cond.entity_scope === 'member') {
    rawValue = cond.field_type === 'core'
      ? memberRow?.[cond.field_key]
      : customMemberValues?.[cond.field_key];
  } else if (cond.entity_scope === 'organization') {
    rawValue = cond.field_type === 'core'
      ? orgRow?.[cond.field_key]
      : customOrgValues?.[cond.field_key];
  } else {
    return false;
  }

  return applyOperator(cond.operator, rawValue, cond.value);
}

function applyOperator(operator, rawValue, filterValue) {
  const strVal = rawValue == null ? '' : String(rawValue);
  switch (operator) {
    case 'equals':
      return strVal === String(filterValue ?? '');
    case 'not_equals':
      return strVal !== String(filterValue ?? '');
    case 'contains':
      return strVal.toLowerCase().includes(String(filterValue ?? '').toLowerCase());
    case 'is_empty':
      return rawValue == null || strVal === '' || strVal === '[]';
    case 'is_not_empty':
      return rawValue != null && strVal !== '' && strVal !== '[]';
    case 'is_true':
      return rawValue === true || strVal === 'true';
    case 'is_false':
      return rawValue === false || strVal === 'false' || rawValue == null || strVal === '';
    case 'greater_than': {
      const n = parseFloat(strVal);
      return !isNaN(n) && n > Number(filterValue);
    }
    case 'less_than': {
      const n = parseFloat(strVal);
      return !isNaN(n) && n < Number(filterValue);
    }
    case 'before':
      return strVal !== '' && strVal < String(filterValue ?? '');
    case 'after':
      return strVal !== '' && strVal > String(filterValue ?? '');
    case 'is_one_of':
      if (Array.isArray(filterValue)) return filterValue.map(String).includes(strVal);
      return strVal === String(filterValue ?? '');
    case 'is_not_one_of':
      if (Array.isArray(filterValue)) return !filterValue.map(String).includes(strVal);
      return strVal !== String(filterValue ?? '');
    default:
      return false;
  }
}

/**
 * Evaluate all filter groups against a single member.
 * Groups are OR'd; within each group conditions are AND'd.
 */
export function evaluateFilterGroups(filterGroups, memberRow, orgRow, customMemberValues = {}, customOrgValues = {}) {
  if (!Array.isArray(filterGroups) || filterGroups.length === 0) return false;
  for (const group of filterGroups) {
    const conditions = Array.isArray(group.conditions) ? group.conditions : [];
    if (conditions.length === 0) continue;
    const allMatch = conditions.every(cond =>
      evaluateCondition(cond, memberRow, orgRow, customMemberValues, customOrgValues)
    );
    if (allMatch) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Reconciler — action planning
// ---------------------------------------------------------------------------

/**
 * Given the FULL sorted target set and the current assignments for a group,
 * compute the delta for a single batch.
 *
 * Rules:
 * - INSERT: target members in batchSlice who have no existing assignment (any source).
 * - ROLE UPDATE: existing automatic-source rows for members in fullTargetIds get
 *   their role updated to the expected role (callers pass this to the RPC;
 *   the RPC does the actual SQL UPDATE).
 * - DELETE: only on the final batch. Removes automatic-source assignments
 *   whose member_id is NOT in the full target set.
 *   Manual and self_join rows are never deleted.
 *
 * @param {string[]} batchSlice        - sorted slice of targetMemberIds for this batch
 * @param {string[]} fullTargetIds     - the complete sorted target list (all pages)
 * @param {Array}    currentAssignments - rows from member_group_assignment
 *   each: { id, member_id, assignment_source }
 * @param {boolean}  isFinalBatch      - true when this is the last batch
 * @returns {{ toInsert: string[], toDelete: string[] }}
 */
export function planReconciliationActions(batchSlice, fullTargetIds, currentAssignments, isFinalBatch = true) {
  const fullTargetSet = new Set(fullTargetIds);
  const existingMemberIds = new Set(
    (currentAssignments || []).map(a => a.member_id).filter(Boolean)
  );

  // Insert: members in this batch slice not yet assigned under any source
  const toInsert = batchSlice.filter(mid => !existingMemberIds.has(mid));

  // Delete: only on final batch, only automatic-source rows outside full target
  const toDelete = isFinalBatch
    ? (currentAssignments || [])
        .filter(a => a.assignment_source === 'automatic' && !fullTargetSet.has(a.member_id))
        .map(a => a.id)
    : [];

  return { toInsert, toDelete };
}

// ---------------------------------------------------------------------------
// allow_members_to_leave enforcement helper
// ---------------------------------------------------------------------------

/**
 * Check whether a self-leave is allowed given the group's allow_members_to_leave.
 *
 * @param {object} opts
 * @param {boolean} opts.allowMembersToLeave
 * @param {boolean} opts.isAdmin
 * @param {boolean} opts.isSelf
 * @returns {{ ok: true }|{ ok: false, status: number, error: string }}
 */
export function checkAllowMembersToLeave({ allowMembersToLeave, isAdmin, isSelf }) {
  if (isAdmin) return { ok: true };
  if (isSelf && allowMembersToLeave === false) {
    return { ok: false, status: 403, error: 'Members are not allowed to leave this group.' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// DB helpers (injectable for testing)
// ---------------------------------------------------------------------------

/**
 * Fetch scope-keyed custom field metadata for a tenant.
 *
 * Returns:
 * {
 *   member:       Set<string>,               // active member custom field IDs
 *   organization: Set<string>,               // active org custom field IDs
 *   memberTypes:  Map<id, { data_type, options }>,  // metadata by id
 *   organizationTypes: Map<id, { data_type, options }>,
 * }
 *
 * @param {object} supabaseClient
 * @param {string} tenantId
 */
export async function fetchAllowedCustomFieldIdsByScope(supabaseClient, tenantId) {
  const { data, error } = await supabaseClient
    .from('preference_field')
    .select('id, entity_scope, field_type, options')
    .eq('tenant_id', tenantId)
    .eq('is_active', true);

  if (error) {
    console.error('[automaticMembership] fetchAllowedCustomFieldIdsByScope error:', error.message);
    return {
      member: new Set(),
      organization: new Set(),
      memberTypes: new Map(),
      organizationTypes: new Map(),
    };
  }

  const member       = new Set();
  const organization = new Set();
  const memberTypes  = new Map();
  const organizationTypes = new Map();

  for (const r of data || []) {
    if (r.entity_scope === 'member') {
      member.add(r.id);
      memberTypes.set(r.id, {
        data_type: normalizePreferenceFieldType(r.field_type),
        options: Array.isArray(r.options) ? r.options : null,
      });
    } else if (r.entity_scope === 'organization') {
      organization.add(r.id);
      organizationTypes.set(r.id, {
        data_type: normalizePreferenceFieldType(r.field_type),
        options: Array.isArray(r.options) ? r.options : null,
      });
    }
  }

  return { member, organization, memberTypes, organizationTypes };
}

/**
 * Build a fieldMeta object suitable for validateCondition from the result of
 * fetchAllowedCustomFieldIdsByScope.
 *
 * @param {{ memberTypes: Map, organizationTypes: Map }} scopeResult
 * @returns {{ member: Map, organization: Map }}
 */
export function buildFieldMeta(scopeResult) {
  return {
    member: scopeResult.memberTypes instanceof Map ? scopeResult.memberTypes : new Map(),
    organization: scopeResult.organizationTypes instanceof Map ? scopeResult.organizationTypes : new Map(),
  };
}

/**
 * Convenience: fetch only member-scope allowed custom field IDs.
 * Kept for callers that only need a flat Set (query layer, etc.).
 */
export async function fetchAllowedCustomFieldIds(supabaseClient, tenantId) {
  const { member } = await fetchAllowedCustomFieldIdsByScope(supabaseClient, tenantId);
  return member;
}

/**
 * Check whether a role value exists in the group's own roles array.
 *
 * @param {string}   role
 * @param {string[]} groupRoles
 * @returns {boolean}
 */
export function roleExistsInGroup(role, groupRoles) {
  if (!Array.isArray(groupRoles)) return false;
  return groupRoles.includes(role);
}
