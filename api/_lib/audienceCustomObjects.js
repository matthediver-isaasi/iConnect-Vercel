import { CUSTOM_OBJECT_OPERATORS, customObjectSelectionKey, isCustomObjectCondition } from '../../shared/audienceCustomObjectContract.js';
import { getCustomObjectFieldMetadata, resolveCustomObjectFieldAccess, resolveCustomObjectPermission } from './customObjectDomain.js';

export class AudienceCustomObjectError extends Error {
  constructor(message) {
    super(`Custom Object audience: ${message}`);
    this.status = 400;
  }
}

// Small pages work with PostgREST's row cap. A safety bound fails explicitly,
// never returning a truncated audience.
export async function audienceRows(build, description, maxRows = 100000) {
  const rows = [];
  for (let offset = 0; offset <= maxRows; offset += 500) {
    const { data, error } = await build().order('id').range(offset, offset + 499);
    if (error) throw new AudienceCustomObjectError(`${description}: ${error.message}`);
    rows.push(...(data || []));
    if (rows.length > maxRows) break;
    if (!data || data.length < 500) return rows;
  }
  throw new AudienceCustomObjectError(`${description} exceeds the safe evaluation limit (${maxRows}); narrow this audience or contact support.`);
}

function fieldDescriptor(field) {
  if (!field.id || !field.key || !CUSTOM_OBJECT_OPERATORS[field.type]) return null;
  return { id: field.id, key: field.key, label: field.label || field.key,
    data_type: field.type, operators: CUSTOM_OBJECT_OPERATORS[field.type], options: field.options || [] };
}

export async function discoverAudienceCustomObjects(db, tenantId, { context = null, isAdmin = false } = {}) {
  const load = (table, configure = q => q) => audienceRows(
    () => configure(db.from(table).select('*').eq('tenant_id', tenantId)), `Loading ${table}`);
  let permissions = [], fieldPermissions = [];
  if (context && !isAdmin) {
    if (!context.roleId) return [];
    permissions = await load('custom_object_role_permission', q => q.eq('role_id', context.roleId));
    fieldPermissions = await load('custom_object_field_role_permission', q => q.eq('role_id', context.roleId));
  }
  const objects = await load('custom_object_definition', q => q.eq('status', 'active').is('archived_at', null));
  const definitions = await load('custom_object_relationship_definition', q => q.eq('status', 'active').is('archived_at', null));
  const fields = await load('preference_field', q => q.eq('entity_scope', 'custom_object').eq('is_active', true));
  return objects.filter(object => !context || resolveCustomObjectPermission({
    permission: permissions.find(p => p.custom_object_id === object.id), capability: 'view_records', isTenantAdmin: isAdmin,
  })).map(object => {
    const recordFields = fields.filter(f => f.custom_object_id === object.id && !f.archived_at
      && (!context || resolveCustomObjectFieldAccess({
        permission: fieldPermissions.find(p => p.field_id === f.id), isTenantAdmin: isAdmin,
      }) !== 'none')).map(f => fieldDescriptor(getCustomObjectFieldMetadata(f))).filter(Boolean);
    const relationships = definitions.flatMap(definition => {
      const side = definition.source_kind === 'custom_object' && definition.source_custom_object_id === object.id
        && definition.target_kind === 'member' ? 'source'
        : definition.target_kind === 'custom_object' && definition.target_custom_object_id === object.id
          && definition.source_kind === 'member' ? 'target' : null;
      if (!side || definition[`show_on_${side}`] === false) return [];
      const raw = definition.configuration?.relationship_fields ?? definition.configuration?.relationshipFields ?? [];
      if (!Array.isArray(raw)) throw new AudienceCustomObjectError(`Relationship ${definition.id} has invalid field metadata.`);
      const relationshipFields = raw.filter(f => (f.display_on_source ?? f.show_on_source ?? f.display?.source ?? f.display ?? true) !== false || side !== 'source')
        .filter(f => (f.display_on_target ?? f.show_on_target ?? f.display?.target ?? f.display ?? true) !== false || side !== 'target')
        .map(f => fieldDescriptor({ ...f, id: f.id ?? f.field_id, key: f.key ?? f.name, type: f.type ?? f.field_type })).filter(Boolean);
      return [{ id: definition.id, label: definition[`${side}_label`], object_side: side,
        record_fields: recordFields, relationship_fields: relationshipFields }];
    });
    return { id: object.id, label: object.singular_label || object.plural_label, relationships };
  }).filter(object => object.relationships.length);
}

export function validateCustomObjectCondition(condition, metadata) {
  const fail = message => { throw new AudienceCustomObjectError(`${message} Reopen the audience and reselect its object, relationship and field.`); };
  if (condition.version !== 1) fail('Unsupported condition version.');
  const object = metadata.find(o => o.id === condition.custom_object_id);
  const relationship = object?.relationships.find(r => r.id === condition.relationship_definition_id && r.object_side === condition.object_side);
  if (!relationship) fail('Object or member relationship is unavailable or not authorized.');
  if (!['record', 'relationship'].includes(condition.field_type)) fail('Invalid field source.');
  const field = relationship[`${condition.field_type}_fields`].find(f => f.id === condition.field_id && f.key === condition.field_key);
  if (!field || field.data_type !== condition.data_type) fail('Field is unavailable or its type has changed.');
  if (!field.operators.includes(condition.operator)) fail('Unsupported operator for the selected field.');
  if (['is_true', 'is_false', 'is_empty', 'is_not_empty'].includes(condition.operator)) return;
  const values = ['is_one_of', 'is_not_one_of'].includes(condition.operator) ? condition.value : [condition.value];
  if (!Array.isArray(values) || !values.length) fail('Select at least one value.');
  for (const value of values) {
    if (value === null || value === undefined || typeof value === 'object') fail('A scalar comparison value is required.');
    if (['number', 'decimal'].includes(field.data_type)) {
      if (String(value).trim() === '' || !Number.isFinite(Number(value))) fail('Enter a valid number.');
    } else if (['date', 'datetime'].includes(field.data_type)) {
      if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail('Enter a valid date.');
    } else if (typeof value !== 'string') fail('Enter a text value.');
    if (['select', 'dropdown'].includes(field.data_type) && !field.options.some(o => (typeof o === 'object' ? o.value : o) === value)) fail('The selected option is no longer available.');
  }
}

export async function validateAudienceCustomObjects(db, tenantId, audiences, authorization) {
  const conditions = (audiences || []).filter(s => s.type === 'field_filter')
    .flatMap(s => (s.filter_groups || []).flatMap(g => g.conditions || [])).filter(isCustomObjectCondition);
  if (!conditions.length) return;
  const metadata = await discoverAudienceCustomObjects(db, tenantId, authorization);
  conditions.forEach(c => validateCustomObjectCondition(c, metadata));
}

export function matchesCustomObjectValue(raw, condition) {
  const empty = raw === null || raw === undefined || raw === '';
  if (condition.operator === 'is_empty') return empty;
  if (condition.operator === 'is_not_empty') return !empty;
  if (empty) return false;
  if (condition.operator === 'is_true') return raw === true;
  if (condition.operator === 'is_false') return raw === false;
  let value = raw, expected = condition.value;
  if (['number', 'decimal'].includes(condition.data_type)) {
    value = typeof raw === 'number' ? raw : NaN;
    expected = Number(expected);
    if (!Number.isFinite(value)) return false;
  } else if (['date', 'datetime'].includes(condition.data_type)) {
    value = Date.parse(raw); expected = Date.parse(expected);
    if (!Number.isFinite(value)) return false;
  } else if (typeof raw !== 'string') return false;
  switch (condition.operator) {
    case 'equals': return value === expected;
    case 'not_equals': return value !== expected;
    case 'contains': return value.toLowerCase().includes(expected.toLowerCase());
    case 'greater_than': case 'after': return value > expected;
    case 'less_than': case 'before': return value < expected;
    case 'is_one_of': return expected.includes(value);
    case 'is_not_one_of': return !expected.includes(value);
    default: throw new AudienceCustomObjectError('Unsupported operator.');
  }
}

// Each selection is an existential predicate over ONE record AND ONE edge.
// Different selections intersect; the campaign service unions filter groups.
export async function resolveCustomObjectConditions(db, tenantId, conditions, metadata) {
  if (!conditions.length) return null;
  metadata ||= await discoverAudienceCustomObjects(db, tenantId);
  conditions.forEach(c => validateCustomObjectCondition(c, metadata));
  const selections = new Map();
  for (const condition of conditions) {
    const key = customObjectSelectionKey(condition);
    if (!selections.has(key)) selections.set(key, []);
    selections.get(key).push(condition);
  }
  let result = null;
  for (const predicates of selections.values()) {
    const first = predicates[0], matches = new Set();
    const recordSide = `${first.object_side}_record_id`;
    const memberSide = first.object_side === 'source' ? 'target_record_id' : 'source_record_id';
    const edges = await audienceRows(() => db.from('custom_object_relationship').select('id,source_record_id,target_record_id,field_values')
      .eq('tenant_id', tenantId).eq('relationship_definition_id', first.relationship_definition_id)
      .is('archived_at', null), 'Loading active member relationships');
    const ids = [...new Set(edges.map(e => e[recordSide]))], records = new Map();
    for (let i = 0; i < ids.length; i += 200) {
      const rows = await audienceRows(() => db.from('custom_object_record').select('id,data')
        .eq('tenant_id', tenantId).eq('custom_object_id', first.custom_object_id)
        .is('archived_at', null).in('id', ids.slice(i, i + 200)), 'Loading related records');
      rows.forEach(r => records.set(r.id, r));
    }
    for (const edge of edges) {
      const record = records.get(edge[recordSide]);
      if (record && predicates.every(c => matchesCustomObjectValue(
        (c.field_type === 'record' ? record.data : edge.field_values)?.[c.field_key], c))) matches.add(edge[memberSide]);
    }
    result = result === null ? matches : new Set([...result].filter(id => matches.has(id)));
  }
  return result;
}