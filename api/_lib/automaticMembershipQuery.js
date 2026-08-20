/**
 * DB query layer for automatic membership filter evaluation.
 *
 * Translates a filter_groups structure (OR between groups, AND within group)
 * into Supabase queries and returns a deterministically-sorted string[] of
 * matching member IDs.
 *
 * Key design decisions:
 * - Keyset pagination (WHERE id > lastId) instead of OFFSET for correctness.
 * - Canonical field types are derived from server-authoritative metadata maps,
 *   never from cond.data_type supplied by the client.
 * - is_not_one_of on preference_value tables uses a JS post-filter over fetched
 *   rows (no raw value injection into PostgREST filter syntax).
 * - DB errors throw immediately (never silently return partial matches).
 * - All final result sets are intersected with the tenant's own member IDs to
 *   prevent foreign member IDs from entering the target set.
 */

import {
  ALLOWED_CORE_MEMBER_KEYS,
  ALLOWED_CORE_ORG_KEYS,
  ALLOWED_OPERATORS,
  ALLOWED_SCOPES,
  CORE_MEMBER_FIELD_TYPES,
  CORE_ORG_FIELD_TYPES,
  OPERATORS_BY_TYPE,
} from './automaticMembership.js';

const PAGE = 1000;

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run a filter_groups query against the DB.
 *
 * @param {object} opts
 * @param {object}   opts.supabase
 * @param {string}   opts.tenantId
 * @param {Array}    opts.filterGroups
 * @param {object}   opts.allowedCustomFieldIdsByScope
 *   { member: Set<string>, organization: Set<string>,
 *     memberTypes: Map<id,{data_type,options}>,
 *     organizationTypes: Map<id,{data_type,options}> }
 *   Also accepts a plain Set<string> for backward compatibility (treated as member-scope).
 * @returns {Promise<string[]>}  sorted matched member IDs (deduped, tenant-owned only)
 */
export async function runFilterQuery({ supabase, tenantId, filterGroups, allowedCustomFieldIdsByScope }) {
  if (!Array.isArray(filterGroups) || filterGroups.length === 0) return [];

  // Normalise scope map
  const scopeMap = normaliseScopeMap(allowedCustomFieldIdsByScope);
  // Field metadata maps (data_type + options per custom field id)
  const memberTypesMap = scopeMap.memberTypes instanceof Map ? scopeMap.memberTypes : new Map();
  const orgTypesMap    = scopeMap.organizationTypes instanceof Map ? scopeMap.organizationTypes : new Map();

  const groupMemberSets = [];

  for (const group of filterGroups) {
    const conditions = (group.conditions || []).filter(c => isAllowedCondition(c, scopeMap));
    if (conditions.length === 0) continue;

    const memberConditions = conditions.filter(c => c.entity_scope === 'member');
    const orgConditions    = conditions.filter(c => c.entity_scope === 'organization');

    let memberIds = null;

    if (memberConditions.length > 0) {
      const coreConds   = memberConditions.filter(c => c.field_type === 'core');
      const customConds = memberConditions.filter(c => c.field_type === 'custom');

      let coreMatchedIds = null;
      if (coreConds.length > 0) {
        coreMatchedIds = await fetchCoreMemberIds(supabase, tenantId, coreConds);
      }

      let customMatchedIds = null;
      for (const cond of customConds) {
        const condMeta = memberTypesMap.get(cond.field_key) || null;
        const condSet = await fetchCustomMemberConditionSet({ supabase, tenantId, cond, condMeta });
        // Intersect with tenant member IDs to prevent foreign IDs
        const tenantIntersected = await intersectWithTenantMemberIds(supabase, tenantId, condSet);
        customMatchedIds = customMatchedIds
          ? new Set([...customMatchedIds].filter(id => tenantIntersected.has(id)))
          : tenantIntersected;
      }

      if (coreMatchedIds !== null && customMatchedIds !== null) {
        memberIds = new Set([...coreMatchedIds].filter(id => customMatchedIds.has(id)));
      } else if (coreMatchedIds !== null) {
        memberIds = coreMatchedIds;
      } else {
        memberIds = customMatchedIds;
      }
    }

    if (orgConditions.length > 0) {
      const coreConds   = orgConditions.filter(c => c.field_type === 'core');
      const customConds = orgConditions.filter(c => c.field_type === 'custom');

      let matchedOrgIds = null;

      if (coreConds.length > 0) {
        matchedOrgIds = await fetchCoreOrgIds(supabase, tenantId, coreConds);
      }

      for (const cond of customConds) {
        const condMeta = orgTypesMap.get(cond.field_key) || null;
        const condSet = await fetchCustomOrgConditionSet({ supabase, tenantId, cond, condMeta });
        // Intersect with tenant org IDs to prevent foreign IDs
        const tenantIntersected = await intersectWithTenantOrgIds(supabase, tenantId, condSet);
        matchedOrgIds = matchedOrgIds
          ? new Set([...matchedOrgIds].filter(id => tenantIntersected.has(id)))
          : tenantIntersected;
      }

      if (matchedOrgIds && matchedOrgIds.size > 0) {
        const orgMemberIds = await fetchMemberIdsByOrgIds(supabase, tenantId, [...matchedOrgIds]);
        memberIds = memberIds
          ? new Set([...memberIds].filter(id => orgMemberIds.has(id)))
          : orgMemberIds;
      } else if (matchedOrgIds) {
        // matchedOrgIds is empty Set — no members qualify
        memberIds = new Set();
      }
    }

    if (memberIds !== null) {
      groupMemberSets.push(memberIds);
    }
  }

  if (groupMemberSets.length === 0) return [];

  // OR between groups, then sort for determinism
  const result = new Set();
  for (const s of groupMemberSets) {
    for (const id of s) result.add(id);
  }
  return [...result].sort();
}

// ---------------------------------------------------------------------------
// Core field fetchers
// ---------------------------------------------------------------------------

/**
 * Fetch member IDs matching a set of core member conditions (AND'd together).
 * Uses keyset pagination on member.id.
 * Always filters to tenant + excludes soft-deleted emails.
 */
async function fetchCoreMemberIds(supabase, tenantId, coreConds) {
  const makeQuery = (afterId) => {
    let q = supabase
      .from('member')
      .select('id')
      .eq('tenant_id', tenantId)
      .not('email', 'ilike', 'deleted_%@deleted.local')
      .order('id')
      .limit(PAGE);
    if (afterId) q = q.gt('id', afterId);
    for (const cond of coreConds) {
      const canonType = CORE_MEMBER_FIELD_TYPES[cond.field_key] || 'text';
      q = applyConditionToQuery(q, cond.field_key, cond.operator, cond.value, canonType);
    }
    return q;
  };
  const ids = await fetchAllKeyset(makeQuery, 'id');
  return new Set(ids);
}

/**
 * Fetch org IDs matching a set of core org conditions (AND'd together).
 * Uses keyset pagination on organization.id.
 */
async function fetchCoreOrgIds(supabase, tenantId, coreConds) {
  const makeQuery = (afterId) => {
    let q = supabase
      .from('organization')
      .select('id')
      .eq('tenant_id', tenantId)
      .order('id')
      .limit(PAGE);
    if (afterId) q = q.gt('id', afterId);
    for (const cond of coreConds) {
      const canonType = CORE_ORG_FIELD_TYPES[cond.field_key] || 'text';
      q = applyConditionToQuery(q, cond.field_key, cond.operator, cond.value, canonType);
    }
    return q;
  };
  const ids = await fetchAllKeyset(makeQuery, 'id');
  return new Set(ids);
}

// ---------------------------------------------------------------------------
// Custom field set fetchers
// ---------------------------------------------------------------------------

async function fetchCustomMemberConditionSet({ supabase, tenantId, cond, condMeta }) {
  const canonType = condMeta?.data_type ?? 'text';
  const options   = Array.isArray(condMeta?.options) ? condMeta.options : null;

  if (cond.operator === 'is_empty') {
    return buildIsEmptySet({
      supabase, tenantId,
      entityTable: 'member', entityIdField: 'id',
      prefTable: 'member_preference_value', prefIdField: 'member_id',
      fieldId: cond.field_key,
    });
  }
  if (canonType === 'boolean' && cond.operator === 'is_false') {
    return buildBooleanFalseSet({
      supabase, tenantId,
      entityTable: 'member', entityIdField: 'id',
      prefTable: 'member_preference_value', prefIdField: 'member_id',
      fieldId: cond.field_key,
    });
  }
  const emptyMatches = shouldIncludeMissingPreferenceValue(cond.operator)
    ? await buildIsEmptySet({
        supabase, tenantId,
        entityTable: 'member', entityIdField: 'id',
        prefTable: 'member_preference_value', prefIdField: 'member_id',
        fieldId: cond.field_key,
      })
    : null;

  const needsValue =
    ((canonType === 'number' || canonType === 'decimal') &&
      (cond.operator === 'greater_than' || cond.operator === 'less_than')) ||
    cond.operator === 'is_not_one_of' ||
    (canonType === 'multi_select' && cond.operator === 'is_one_of');
  const selectCols = needsValue ? 'id, member_id, value' : 'id, member_id';

  const makeQuery = (afterId) => {
    let q = supabase
      .from('member_preference_value')
      .select(selectCols)
      .eq('field_id', cond.field_key)
      .order('id')
      .limit(PAGE);
    if (afterId) q = q.gt('id', afterId);
    const { query: qFiltered } = applyPrefValueCondition(q, cond.operator, cond.value, canonType, options);
    return qFiltered;
  };

  const allRows = await fetchAllKeyset(makeQuery, 'id', true);
  const filtered = applyPrefValuePostFilter(allRows, cond.operator, cond.value, canonType);
  const result = new Set(filtered.map(r => r.member_id));
  for (const id of emptyMatches || []) result.add(id);
  return result;
}

async function fetchCustomOrgConditionSet({ supabase, tenantId, cond, condMeta }) {
  const canonType = condMeta?.data_type ?? 'text';
  const options   = Array.isArray(condMeta?.options) ? condMeta.options : null;

  if (cond.operator === 'is_empty') {
    return buildIsEmptySet({
      supabase, tenantId,
      entityTable: 'organization', entityIdField: 'id',
      prefTable: 'organization_preference_value', prefIdField: 'organization_id',
      fieldId: cond.field_key,
    });
  }
  if (canonType === 'boolean' && cond.operator === 'is_false') {
    return buildBooleanFalseSet({
      supabase, tenantId,
      entityTable: 'organization', entityIdField: 'id',
      prefTable: 'organization_preference_value', prefIdField: 'organization_id',
      fieldId: cond.field_key,
    });
  }
  const emptyMatches = shouldIncludeMissingPreferenceValue(cond.operator)
    ? await buildIsEmptySet({
        supabase, tenantId,
        entityTable: 'organization', entityIdField: 'id',
        prefTable: 'organization_preference_value', prefIdField: 'organization_id',
        fieldId: cond.field_key,
      })
    : null;

  const needsValue =
    ((canonType === 'number' || canonType === 'decimal') &&
      (cond.operator === 'greater_than' || cond.operator === 'less_than')) ||
    cond.operator === 'is_not_one_of' ||
    (canonType === 'multi_select' && cond.operator === 'is_one_of');
  const selectCols = needsValue ? 'id, organization_id, value' : 'id, organization_id';

  const makeQuery = (afterId) => {
    let q = supabase
      .from('organization_preference_value')
      .select(selectCols)
      .eq('field_id', cond.field_key)
      .order('id')
      .limit(PAGE);
    if (afterId) q = q.gt('id', afterId);
    const { query: qFiltered } = applyPrefValueCondition(q, cond.operator, cond.value, canonType, options);
    return qFiltered;
  };

  const allRows = await fetchAllKeyset(makeQuery, 'id', true);
  const filtered = applyPrefValuePostFilter(allRows, cond.operator, cond.value, canonType);
  const result = new Set(filtered.map(r => r.organization_id));
  for (const id of emptyMatches || []) result.add(id);
  return result;
}

export function shouldIncludeMissingPreferenceValue(operator) {
  return operator === 'not_equals' || operator === 'is_not_one_of';
}

// ---------------------------------------------------------------------------
// Tenant defence: intersect result sets with tenant-owned entity IDs
// ---------------------------------------------------------------------------

/**
 * Intersect a set of member IDs with the tenant's actual member IDs.
 * This prevents any foreign member ID (leaked from cross-tenant preference
 * value rows or other bugs) from appearing in the target set.
 */
async function intersectWithTenantMemberIds(supabase, tenantId, idSet) {
  if (idSet.size === 0) return new Set();
  const idsArr = [...idSet];
  const tenantOwned = new Set();
  // Batch the IN query to avoid URL length limits
  for (let i = 0; i < idsArr.length; i += 500) {
    const slice = idsArr.slice(i, i + 500);
    const { data, error } = await supabase
      .from('member')
      .select('id')
      .eq('tenant_id', tenantId)
      .in('id', slice);
    if (error) throw new Error(`tenant member intersection failed: ${error.message}`);
    if (data) data.forEach(r => tenantOwned.add(r.id));
  }
  return tenantOwned;
}

/**
 * Intersect a set of org IDs with the tenant's actual org IDs.
 */
async function intersectWithTenantOrgIds(supabase, tenantId, idSet) {
  if (idSet.size === 0) return new Set();
  const idsArr = [...idSet];
  const tenantOwned = new Set();
  for (let i = 0; i < idsArr.length; i += 500) {
    const slice = idsArr.slice(i, i + 500);
    const { data, error } = await supabase
      .from('organization')
      .select('id')
      .eq('tenant_id', tenantId)
      .in('id', slice);
    if (error) throw new Error(`tenant org intersection failed: ${error.message}`);
    if (data) data.forEach(r => tenantOwned.add(r.id));
  }
  return tenantOwned;
}

/**
 * Fetch member IDs for members belonging to given org IDs (tenant-scoped).
 */
async function fetchMemberIdsByOrgIds(supabase, tenantId, orgIdArr) {
  const result = new Set();
  for (let i = 0; i < orgIdArr.length; i += 500) {
    const slice = orgIdArr.slice(i, i + 500);
    const { data, error } = await supabase
      .from('member')
      .select('id')
      .eq('tenant_id', tenantId)
      .in('organization_id', slice)
      .not('email', 'ilike', 'deleted_%@deleted.local');
    if (error) throw new Error(`org-member lookup failed: ${error.message}`);
    if (data) data.forEach(m => result.add(m.id));
  }
  return result;
}

// ---------------------------------------------------------------------------
// is_empty set builder
// ---------------------------------------------------------------------------

async function buildIsEmptySet({ supabase, tenantId, entityTable, entityIdField, prefTable, prefIdField, fieldId }) {
  // Fetch all entity IDs (keyset paginated)
  const makeEntityQuery = (afterId) => {
    let q = supabase
      .from(entityTable)
      .select(entityIdField)
      .eq('tenant_id', tenantId)
      .order(entityIdField)
      .limit(PAGE);
    if (afterId) q = q.gt(entityIdField, afterId);
    return q;
  };
  const allIds = await fetchAllKeyset(makeEntityQuery, entityIdField);

  // Fetch IDs that DO have a value (keyset on the pref row's own id column)
  const makeHvQuery = (afterId) => {
    let q = supabase
      .from(prefTable)
      .select(`id, ${prefIdField}`)
      .eq('field_id', fieldId)
      .not('value', 'is', null)
      .neq('value', '')
      .neq('value', '[]')
      .order('id')
      .limit(PAGE);
    if (afterId) q = q.gt('id', afterId);
    return q;
  };
  const hvRows = await fetchAllKeyset(makeHvQuery, 'id', true);
  const hasValueSet = new Set(hvRows.map(r => r[prefIdField]));

  return new Set(allIds.filter(id => !hasValueSet.has(id)));
}

async function buildBooleanFalseSet(args) {
  const emptyIds = await buildIsEmptySet(args);
  const { supabase, prefTable, prefIdField, fieldId } = args;
  const makeFalseQuery = (afterId) => {
    let q = supabase
      .from(prefTable)
      .select(`id, ${prefIdField}`)
      .eq('field_id', fieldId)
      .eq('value', 'false')
      .order('id')
      .limit(PAGE);
    if (afterId) q = q.gt('id', afterId);
    return q;
  };
  const falseRows = await fetchAllKeyset(makeFalseQuery, 'id', true);
  for (const row of falseRows) emptyIds.add(row[prefIdField]);
  return emptyIds;
}

// ---------------------------------------------------------------------------
// Keyset pagination
// ---------------------------------------------------------------------------

/**
 * Fetch all rows using keyset pagination.
 * @param {Function} makeQuery   (afterId: string|null) => SupabaseQuery
 * @param {string}   idField     field name to use as the keyset cursor
 * @param {boolean}  returnRows  if true return full row objects; else just id strings
 */
async function fetchAllKeyset(makeQuery, idField, returnRows = false) {
  const result = [];
  let lastId = null;
  while (true) {
    const { data: batch, error } = await makeQuery(lastId);
    if (error) throw new Error(`DB query failed: ${error.message}`);
    if (!batch || batch.length === 0) break;
    result.push(...(returnRows ? batch : batch.map(r => r[idField])));
    if (batch.length < PAGE) break;
    lastId = batch[batch.length - 1][idField];
  }
  return result;
}

// ---------------------------------------------------------------------------
// Query condition builders
// ---------------------------------------------------------------------------

/**
 * Apply a condition to a core-table query (member or organization).
 * Uses canonical type from server maps, never from client-supplied data_type.
 */
function applyConditionToQuery(query, fieldKey, operator, value, canonType) {
  switch (operator) {
    case 'equals':       return query.eq(fieldKey, value);
    case 'not_equals':   return query.neq(fieldKey, value);
    case 'contains':     return query.ilike(fieldKey, `%${value}%`);
    case 'is_empty':     return query.or(`${fieldKey}.is.null,${fieldKey}.eq.`);
    case 'is_not_empty': return query.not(fieldKey, 'is', null).neq(fieldKey, '');
    case 'is_true':      return query.eq(fieldKey, true);
    case 'is_false':     return query.or(`${fieldKey}.eq.false,${fieldKey}.is.null`);
    case 'greater_than': return query.gt(fieldKey, value);
    case 'less_than':    return query.lt(fieldKey, value);
    case 'before':       return query.lt(fieldKey, value);
    case 'after':        return query.gt(fieldKey, value);
    case 'is_one_of':
      return Array.isArray(value) ? query.in(fieldKey, value) : query.eq(fieldKey, value);
    case 'is_not_one_of':
      // Safe: use repeated .neq() calls instead of raw value injection
      if (Array.isArray(value)) {
        let q = query;
        for (const v of value) q = q.neq(fieldKey, v);
        return q;
      }
      return query.neq(fieldKey, value);
    default:
      return query;
  }
}

/**
 * Apply a condition to a preference_value query.
 * Returns { query } only (no postFilter — post-filtering is handled separately
 * via applyPrefValuePostFilter for all operators that can't be safely expressed
 * as a single PostgREST filter).
 *
 * is_not_one_of: fetch all rows and post-filter in JS (no raw join of values).
 * Numeric comparisons: fetch all non-null rows and post-filter in JS.
 */
function applyPrefValueCondition(query, operator, value, canonType, options) {
  const isNumeric = canonType === 'number' || canonType === 'decimal';

  switch (operator) {
    case 'equals':
      return { query: query.eq('value', String(value)) };
    case 'not_equals':
      return { query: query.neq('value', String(value)) };
    case 'contains':
      return { query: query.ilike('value', `%${value}%`) };
    case 'is_not_empty':
      return { query: query.not('value', 'is', null).neq('value', '').neq('value', '[]') };
    case 'is_empty':
      // handled by buildIsEmptySet — should not reach here
      return { query };
    case 'is_true':
      return { query: query.eq('value', 'true') };
    case 'is_false':
      return { query: query.or('value.eq.false,value.eq.,value.is.null') };
    case 'greater_than':
    case 'less_than':
      if (isNumeric) {
        // Fetch non-null rows, post-filter by numeric comparison
        return { query: query.not('value', 'is', null).neq('value', '') };
      }
      // For date (before/after) this operator name is not used, but handle gracefully
      return { query: operator === 'greater_than' ? query.gt('value', String(value)) : query.lt('value', String(value)) };
    case 'before':
      return { query: query.lt('value', String(value)) };
    case 'after':
      return { query: query.gt('value', String(value)) };
    case 'is_one_of':
      if (canonType === 'multi_select') {
        return { query: query.not('value', 'is', null).neq('value', '').neq('value', '[]') };
      }
      if (Array.isArray(value) && value.length > 0) {
        return { query: query.in('value', value.map(String)) };
      }
      return { query: query.eq('value', String(value)) };
    case 'is_not_one_of':
      // SAFE: fetch all rows (with value not null) and post-filter in JS
      // Never inject raw values into PostgREST filter syntax
      return { query: query.not('value', 'is', null).neq('value', '') };
    default:
      return { query: query.eq('value', String(value)) };
  }
}

/**
 * Post-filter rows that were fetched with a broadened DB query.
 * Used for operators where the DB filter alone can't be relied on safely
 * (is_not_one_of, numeric comparisons).
 */
function applyPrefValuePostFilter(rows, operator, value, canonType) {
  const isNumeric = canonType === 'number' || canonType === 'decimal';

  if (canonType === 'multi_select' && (operator === 'is_one_of' || operator === 'is_not_one_of')) {
    const selected = new Set(Array.isArray(value) ? value.map(String) : [String(value)]);
    return rows.filter(r => {
      const stored = parseStoredMultiValue(r.value);
      const overlaps = stored.some(v => selected.has(v));
      return operator === 'is_one_of' ? overlaps : !overlaps;
    });
  }

  if (operator === 'is_not_one_of') {
    const excluded = new Set(Array.isArray(value) ? value.map(String) : [String(value)]);
    return rows.filter(r => !excluded.has(String(r.value ?? '')));
  }

  if (isNumeric && (operator === 'greater_than' || operator === 'less_than')) {
    const n = Number(value);
    return rows.filter(r => {
      const v = parseFloat(r.value);
      if (isNaN(v)) return false;
      return operator === 'greater_than' ? v > n : v < n;
    });
  }

  return rows;
}

function parseStoredMultiValue(raw) {
  if (Array.isArray(raw)) return raw.map(String);
  if (raw == null || raw === '') return [];
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
  } catch {
    return [String(raw)];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normaliseScopeMap(v) {
  if (!v) return { member: new Set(), organization: new Set(), memberTypes: new Map(), organizationTypes: new Map() };
  if (v instanceof Set) return { member: v, organization: new Set(), memberTypes: new Map(), organizationTypes: new Map() };
  return {
    member:       v.member instanceof Set       ? v.member       : new Set(),
    organization: v.organization instanceof Set ? v.organization : new Set(),
    memberTypes:  v.memberTypes instanceof Map  ? v.memberTypes  : new Map(),
    organizationTypes: v.organizationTypes instanceof Map ? v.organizationTypes : new Map(),
  };
}

/**
 * Determine whether a condition should be included in a query
 * (basic structural validity check — full validation is done before this point).
 */
function isAllowedCondition(c, scopeMap) {
  if (!ALLOWED_SCOPES.has(c.entity_scope)) return false;
  if (!ALLOWED_OPERATORS.has(c.operator)) return false;
  if (c.field_type === 'core') {
    const allowed = c.entity_scope === 'member' ? ALLOWED_CORE_MEMBER_KEYS : ALLOWED_CORE_ORG_KEYS;
    if (!allowed.has(c.field_key)) return false;
  } else if (c.field_type === 'custom') {
    const scopeSet = scopeMap[c.entity_scope];
    if (!scopeSet || !scopeSet.has(c.field_key)) return false;
  } else {
    return false;
  }
  return true;
}
