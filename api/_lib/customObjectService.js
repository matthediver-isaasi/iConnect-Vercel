import {
  CustomObjectDomainError,
  assertImmutableInternalKey,
  coerceCustomObjectFieldValue,
  getCustomObjectFieldMetadata,
  resolveCustomObjectDisplayValue,
  resolveCustomObjectLifecycleUpdate,
  resolveCustomObjectPermission,
  validateCustomObjectFieldDefinition,
  validateCustomObjectRecordData,
  validateCustomObjectRelationshipEndpoints,
} from './customObjectDomain.js';

export class CustomObjectHttpError extends Error {
  constructor(status, message, details = null) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const OBJECT_COLUMNS = [
  'object_key', 'singular_label', 'plural_label', 'description', 'icon',
  'primary_display_field_id', 'status', 'configuration',
];
const FIELD_COLUMNS = [
  'name', 'label', 'field_type', 'is_required', 'options', 'min_selections',
  'max_selections', 'min_length', 'max_length', 'all_countries',
  'selected_countries', 'default_country', 'default_countries',
  'allowed_file_types', 'public_access', 'display_order',
];
const RELATIONSHIP_DEFINITION_COLUMNS = [
  'relationship_key', 'source_kind', 'source_custom_object_id', 'target_kind',
  'target_custom_object_id', 'cardinality', 'source_label', 'target_label',
  'is_required', 'show_on_source', 'show_on_target', 'edit_from_source',
  'edit_from_target', 'status', 'configuration',
];
const PERMISSION_COLUMNS = [
  'can_view_records', 'can_create_records', 'can_edit_records',
  'can_archive_records', 'can_export_records',
];
const RECORD_CAPABILITY_KEYS = Object.freeze({
  view: 'view_records',
  create: 'create_records',
  edit: 'edit_records',
  archive: 'archive_records',
  export: 'export_records',
});
const SAFE_JSON_KEY = /^[a-z][a-z0-9_]{0,99}$/;
const SEARCHABLE_FIELD_TYPES = new Set(['text', 'textarea', 'email', 'url', 'dropdown', 'country']);
const TEXT_FILTER_TYPES = new Set(['text', 'textarea', 'email', 'url']);
const NUMERIC_FILTER_TYPES = new Set(['number', 'decimal']);
const OPTION_FILTER_TYPES = new Set(['picklist', 'dropdown', 'country', 'countries', 'list']);

function queryError(message, details = null) {
  throw new CustomObjectHttpError(400, message, details);
}

function parseRecordFilters(rawFilters) {
  if (rawFilters === undefined || rawFilters === null || rawFilters === '') return {};
  let parsed = rawFilters;
  if (typeof rawFilters === 'string') {
    try {
      parsed = JSON.parse(rawFilters);
    } catch {
      queryError('filters must be a valid JSON object');
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    queryError('filters must be a JSON object keyed by field id');
  }
  return parsed;
}

function quotePostgrestValue(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function filterValues(value, label) {
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0) queryError(`${label} requires at least one value`);
  return values;
}

function coerceFilterValue(field, value) {
  const result = coerceCustomObjectFieldValue(value, field);
  if (!result.ok) queryError(`Invalid filter value: ${result.error}`);
  return result.value;
}

function buildRecordQueryPlan(query, definitions) {
  const activeById = new Map();
  for (const field of definitions) {
    const metadata = getCustomObjectFieldMetadata(field);
    if (metadata.active && SAFE_JSON_KEY.test(metadata.key)) activeById.set(String(field.id), { field, metadata });
  }

  const filters = [];
  for (const [fieldId, specification] of Object.entries(parseRecordFilters(query?.filters))) {
    const definition = activeById.get(fieldId);
    if (!definition) queryError(`Unknown or inactive filter field: ${fieldId}`);
    if (!specification || typeof specification !== 'object' || Array.isArray(specification)) {
      queryError(`Filter for ${fieldId} must contain an operator and value`);
    }
    const { field, metadata } = definition;
    const op = specification.op;
    const column = `data->${metadata.key}`;
    const textColumn = `data->>${metadata.key}`;

    if (TEXT_FILTER_TYPES.has(metadata.type)) {
      if (!['contains', 'equals', 'is_empty', 'is_not_empty'].includes(op)) {
        queryError(`Operator ${op || '(empty)'} is not supported for ${metadata.type}`);
      }
      if (op === 'contains') filters.push({ kind: 'filter', column: textColumn, op: 'ilike', value: `*${String(specification.value ?? '')}*` });
      else if (op === 'equals') filters.push({ kind: 'filter', column: textColumn, op: 'eq', value: String(specification.value ?? '') });
      else filters.push({ kind: op, column: textColumn });
      continue;
    }
    if (NUMERIC_FILTER_TYPES.has(metadata.type) || metadata.type === 'date') {
      if (!['equals', 'gte', 'lte'].includes(op)) {
        queryError(`Operator ${op || '(empty)'} is not supported for ${metadata.type}`);
      }
      const value = coerceFilterValue(field, specification.value);
      filters.push({ kind: 'filter', column, op: { equals: 'eq', gte: 'gte', lte: 'lte' }[op], value: JSON.stringify(value) });
      continue;
    }
    if (OPTION_FILTER_TYPES.has(metadata.type)) {
      if (!['any_of', 'none_of'].includes(op)) {
        queryError(`Operator ${op || '(empty)'} is not supported for ${metadata.type}`);
      }
      const values = filterValues(specification.value, op).map((value) => {
        const coerced = coerceFilterValue(field, ['picklist', 'countries', 'list'].includes(metadata.type) ? [value] : value);
        return Array.isArray(coerced) ? coerced[0] : coerced;
      });
      filters.push({
        kind: ['picklist', 'countries', 'list'].includes(metadata.type) ? `${op}_array` : `${op}_scalar`,
        column,
        textColumn,
        values,
      });
      continue;
    }
    if (metadata.type === 'boolean') {
      if (op !== 'equals') queryError(`Operator ${op || '(empty)'} is not supported for boolean`);
      filters.push({ kind: 'filter', column, op: 'eq', value: JSON.stringify(coerceFilterValue(field, specification.value)) });
      continue;
    }
    queryError(`Field type ${metadata.type} cannot be filtered`);
  }

  const sortField = query?.sortField || 'created_at';
  let sortColumn;
  if (['created_at', 'updated_at'].includes(sortField)) {
    sortColumn = sortField;
  } else {
    const definition = activeById.get(String(sortField));
    if (!definition) queryError('sortField must be created_at, updated_at, or an active field id');
    sortColumn = `data->${definition.metadata.key}`;
  }
  const sortDir = query?.sortDir || 'desc';
  if (!['asc', 'desc'].includes(sortDir)) queryError('sortDir must be asc or desc');

  const search = typeof query?.search === 'string' ? query.search.trim() : '';
  const searchableColumns = [...activeById.values()]
    .filter(({ metadata }) => SEARCHABLE_FIELD_TYPES.has(metadata.type))
    .map(({ metadata }) => `data->>${metadata.key}`);
  return { filters, search, searchableColumns, sortColumn, ascending: sortDir === 'asc' };
}

function applyRecordQueryPlan(q, plan) {
  for (const filter of plan.filters) {
    if (filter.kind === 'filter') q = q.filter(filter.column, filter.op, filter.value);
    else if (filter.kind === 'is_empty') q = q.or(`${filter.column}.is.null,${filter.column}.eq.""`);
    else if (filter.kind === 'is_not_empty') {
      q = q.not(filter.column, 'is', null).neq(filter.column, '');
    }
    else if (filter.kind === 'any_of_scalar') {
      q = q.in(filter.textColumn, filter.values.map(String));
    } else if (filter.kind === 'none_of_scalar') {
      q = q.not(filter.textColumn, 'in', `(${filter.values.map(quotePostgrestValue).join(',')})`);
    } else if (filter.kind === 'any_of_array') {
      q = q.or(filter.values.map((value) => `${filter.column}.cs.${quotePostgrestValue(JSON.stringify([value]))}`).join(','));
    } else if (filter.kind === 'none_of_array') {
      for (const value of filter.values) q = q.not(filter.column, 'cs', JSON.stringify([value]));
    }
  }
  if (plan.search && plan.searchableColumns.length > 0) {
    const searchValue = quotePostgrestValue(`*${plan.search}*`);
    q = q.or(plan.searchableColumns.map((column) => `${column}.ilike.${searchValue}`).join(','));
  }
  q = q.order(plan.sortColumn, { ascending: plan.ascending, nullsFirst: false });
  if (plan.sortColumn !== 'id') q = q.order('id', { ascending: plan.ascending });
  return q;
}

function pick(body, columns) {
  return Object.fromEntries(columns.filter((column) => body?.[column] !== undefined)
    .map((column) => [column, body[column]]));
}

function actor(context) {
  if (context.tenantUserId) return { id: String(context.tenantUserId), type: 'tenant_user' };
  if (context.memberId) return { id: String(context.memberId), type: 'member' };
  return { id: null, type: 'system' };
}

function pagination(query = {}) {
  const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(Number.parseInt(query.pageSize, 10) || 25, 1), 100);
  return { page, pageSize, from: (page - 1) * pageSize, to: page * pageSize - 1 };
}

function throwDb(error, fallback = 'Database operation failed') {
  if (!error) return;
  if (error.code === '23505') {
    const constraint = error.constraint || error.details || error.message || '';
    let message = 'A record with this unique key already exists';
    if (/custom_object_definition.*key|tenant_key/i.test(constraint)) {
      message = 'A Custom Object with this object key already exists';
    } else if (/preference_field.*name|field_object/i.test(constraint)) {
      message = 'A field with this field key already exists on this Custom Object';
    }
    throw new CustomObjectHttpError(409, message);
  }
  throw new CustomObjectHttpError(500, error.message || fallback);
}

function domainGuard(fn) {
  try {
    return fn();
  } catch (error) {
    if (error instanceof CustomObjectDomainError) {
      throw new CustomObjectHttpError(400, error.message, error.details);
    }
    throw error;
  }
}

export function createCustomObjectService({
  db,
  context,
  isAdmin = false,
  canViewSchema = false,
  canManageSchema = false,
  now = () => new Date().toISOString(),
}) {
  if (!context?.isAuthenticated) throw new CustomObjectHttpError(401, 'Authentication required');
  if (context.tenantMismatch) throw new CustomObjectHttpError(409, 'Tenant context mismatch');
  if (!context.tenantId) throw new CustomObjectHttpError(400, 'Tenant context not found');
  if (!db) throw new CustomObjectHttpError(503, 'Database unavailable');

  const tenantId = context.tenantId;
  const currentActor = actor(context);
  const currentActorReference = currentActor.id
    ? `${currentActor.type}:${currentActor.id}`
    : null;
  const authored = (kind = 'updated') => ({
    [`${kind}_by`]: currentActorReference,
  });

  async function one(table, id, extra = {}) {
    let query = db.from(table).select('*').eq('tenant_id', tenantId).eq('id', id);
    for (const [column, value] of Object.entries(extra)) query = query.eq(column, value);
    const { data, error } = await query.maybeSingle();
    throwDb(error);
    if (!data) throw new CustomObjectHttpError(404, 'Resource not found');
    return data;
  }

  async function object(objectId) {
    return one('custom_object_definition', objectId);
  }

  async function fields(objectId, activeOnly = false) {
    let query = db.from('preference_field').select('*')
      .eq('tenant_id', tenantId).eq('custom_object_id', objectId)
      .eq('entity_scope', 'custom_object').order('display_order', { ascending: true });
    if (activeOnly) query = query.eq('is_active', true);
    const { data, error } = await query;
    throwDb(error);
    return data || [];
  }

  async function permission(objectId) {
    if (!context.roleId) return null;
    const { data, error } = await db.from('custom_object_role_permission').select('*')
      .eq('tenant_id', tenantId).eq('custom_object_id', objectId)
      .eq('role_id', context.roleId).maybeSingle();
    throwDb(error);
    return data || null;
  }

  function projectCapabilities(definition, permissionRow = null) {
    return Object.fromEntries(Object.entries(RECORD_CAPABILITY_KEYS).map(([name, capability]) => [
      name,
      !(['create', 'edit'].includes(name) && definition.status !== 'active') && (
        isAdmin || (
          definition.status !== 'draft'
          && resolveCustomObjectPermission({
            permission: permissionRow,
            capability,
            isTenantAdmin: false,
          })
        )
      ),
    ]));
  }

  async function hasCapability(objectId, capability) {
    if (!isAdmin) {
      const definition = await object(objectId);
      if (
        definition.status === 'draft'
        || (
          definition.status === 'archived'
          && ['create_records', 'edit_records'].includes(capability)
        )
      ) {
        return false;
      }
    }
    return resolveCustomObjectPermission({
      permission: await permission(objectId),
      capability,
      isTenantAdmin: isAdmin,
    });
  }

  async function requireCapability(objectId, capability) {
    const allowed = await hasCapability(objectId, capability);
    if (!allowed) throw new CustomObjectHttpError(403, 'Access denied');
  }

  function relationshipObjectIds(definition) {
    return [...new Set([
      definition.source_kind === 'custom_object' ? definition.source_custom_object_id : null,
      definition.target_kind === 'custom_object' ? definition.target_custom_object_id : null,
    ].filter(Boolean))];
  }

  async function requireRelationshipCapabilities(definition, capability) {
    for (const relatedObjectId of relationshipObjectIds(definition)) {
      await requireCapability(relatedObjectId, capability);
    }
  }

  function requireSchemaManager() {
    if (!canManageSchema) throw new CustomObjectHttpError(403, 'Data model management access required');
  }

  function requireSchemaViewer() {
    if (!canViewSchema && !canManageSchema) throw new CustomObjectHttpError(403, 'Custom Object catalogue access required');
  }

  function requireMutableObject(definition) {
    if (definition.status === 'archived') {
      throw new CustomObjectHttpError(409, 'Archived Custom Objects cannot have their data model modified');
    }
  }

  async function validatePrimaryDisplayField(objectId, fieldId) {
    if (!fieldId) throw new CustomObjectHttpError(400, 'An active Custom Object requires a primary display field');
    let query = db.from('preference_field').select('*')
      .eq('tenant_id', tenantId).eq('custom_object_id', objectId)
      .eq('entity_scope', 'custom_object').eq('id', fieldId).eq('is_active', true);
    const { data, error } = await query.maybeSingle();
    throwDb(error);
    if (!data) {
      throw new CustomObjectHttpError(400, 'Primary display field must be an active field on the same Custom Object');
    }
    const validation = validateCustomObjectFieldDefinition(data, {
      tenantId,
      customObjectId: objectId,
    });
    if (!validation.ok) {
      throw new CustomObjectHttpError(400, 'Primary display field has an invalid field definition', validation.errors);
    }
    return data;
  }

  async function listObjects(query) {
    const p = pagination(query);
    let allowedObjectIds = null;
    if (!isAdmin && !canViewSchema && !canManageSchema) {
      if (!context.roleId) {
        return { data: [], total: 0, page: p.page, pageSize: p.pageSize };
      }
      const { data: grants, error: grantError } = await db.from('custom_object_role_permission')
        .select('custom_object_id').eq('tenant_id', tenantId).eq('role_id', context.roleId)
        .eq('can_view_records', true);
      throwDb(grantError);
      allowedObjectIds = (grants || []).map((grant) => grant.custom_object_id);
      if (allowedObjectIds.length === 0) {
        return { data: [], total: 0, page: p.page, pageSize: p.pageSize };
      }
    }
    let q = db.from('custom_object_definition').select('*', { count: 'exact' })
      .eq('tenant_id', tenantId).order('created_at', { ascending: false });
    if (allowedObjectIds) q = q.in('id', allowedObjectIds);
    if (!canViewSchema && !canManageSchema) {
      q = query?.includeArchived === 'true'
        ? q.neq('status', 'draft')
        : q.eq('status', 'active');
    }
    else if (query?.includeArchived !== 'true') q = q.neq('status', 'archived');
    const { data, error, count } = await q.range(p.from, p.to);
    throwDb(error);
    const rows = data || [];
    const objectIds = rows.map((row) => row.id);
    if (objectIds.length === 0) {
      return { data: [], total: count || 0, page: p.page, pageSize: p.pageSize };
    }
    const permissionQuery = !isAdmin && context.roleId
      ? db.from('custom_object_role_permission').select('*')
        .eq('tenant_id', tenantId).eq('role_id', context.roleId)
        .in('custom_object_id', objectIds)
      : Promise.resolve({ data: [], error: null });
    const [recordResult, fieldResult, relationshipResult, permissionResult] = await Promise.all([
      db.from('custom_object_record').select('custom_object_id')
        .eq('tenant_id', tenantId).in('custom_object_id', objectIds).is('archived_at', null),
      db.from('preference_field').select('custom_object_id')
        .eq('tenant_id', tenantId).in('custom_object_id', objectIds)
        .eq('entity_scope', 'custom_object').eq('is_active', true),
      db.from('custom_object_relationship_definition')
        .select('source_custom_object_id,target_custom_object_id,status').eq('tenant_id', tenantId),
      permissionQuery,
    ]);
    throwDb(recordResult.error);
    throwDb(fieldResult.error);
    throwDb(relationshipResult.error);
    throwDb(permissionResult.error);
    const countBy = (items, key) => (items || []).reduce((counts, item) => {
      counts[item[key]] = (counts[item[key]] || 0) + 1;
      return counts;
    }, {});
    const recordCounts = countBy(recordResult.data, 'custom_object_id');
    const fieldCounts = countBy(fieldResult.data, 'custom_object_id');
    const relationshipCounts = {};
    const permissionsByObjectId = new Map(
      (permissionResult.data || []).map((row) => [row.custom_object_id, row]),
    );
    for (const relationship of relationshipResult.data || []) {
      if (relationship.status === 'archived') continue;
      for (const id of new Set([
        relationship.source_custom_object_id,
        relationship.target_custom_object_id,
      ].filter((candidate) => objectIds.includes(candidate)))) {
        relationshipCounts[id] = (relationshipCounts[id] || 0) + 1;
      }
    }
    return {
      data: rows.map((row) => ({
        ...row,
        record_count: recordCounts[row.id] || 0,
        field_count: fieldCounts[row.id] || 0,
        relationship_count: relationshipCounts[row.id] || 0,
        capabilities: projectCapabilities(row, permissionsByObjectId.get(row.id) || null),
      })),
      total: count || 0,
      page: p.page,
      pageSize: p.pageSize,
    };
  }

  async function createObject(body) {
    requireSchemaManager();
    const payload = {
      ...pick(body, OBJECT_COLUMNS), tenant_id: tenantId, status: body?.status || 'draft',
      configuration: body?.configuration || {}, ...authored('created'), ...authored(),
    };
    if (payload.status !== 'draft') {
      throw new CustomObjectHttpError(400, 'Custom Objects must be created as draft and activated after fields are configured');
    }
    const { data, error } = await db.from('custom_object_definition').insert(payload).select('*').single();
    throwDb(error);
    return data;
  }

  async function getObject(objectId) {
    const row = await object(objectId);
    const permissionRow = isAdmin ? null : await permission(objectId);
    const capabilities = projectCapabilities(row, permissionRow);
    if (!canViewSchema && !canManageSchema && !capabilities.view) {
      throw new CustomObjectHttpError(403, 'Access denied');
    }
    return { ...row, capabilities };
  }

  async function updateObject(objectId, body, archive = false) {
    requireSchemaManager();
    const before = await object(objectId);
    if (before.status === 'archived') {
      if (archive) return before;
      throw new CustomObjectHttpError(409, 'Archived Custom Objects cannot be modified or reactivated');
    }
    const payload = pick(body, OBJECT_COLUMNS);
    if (payload.object_key !== undefined) domainGuard(() => assertImmutableInternalKey(before.object_key, payload.object_key, 'Object key'));
    const nextStatus = archive ? 'archived' : (payload.status || before.status);
    if (nextStatus === 'active' && (
      before.status !== 'active'
      || payload.primary_display_field_id !== undefined
    )) {
      await validatePrimaryDisplayField(
        objectId,
        payload.primary_display_field_id ?? before.primary_display_field_id,
      );
    }
    if (archive || payload.status !== undefined) {
      Object.assign(payload, domainGuard(() => resolveCustomObjectLifecycleUpdate({
        currentStatus: before.status, nextStatus, currentArchivedAt: before.archived_at,
        hasPrimaryDisplayField: Boolean(payload.primary_display_field_id ?? before.primary_display_field_id),
        now: now(),
      })));
      if (nextStatus === 'archived') payload.archived_by = currentActorReference;
    }
    Object.assign(payload, authored());
    const { data, error } = await db.from('custom_object_definition').update(payload)
      .eq('tenant_id', tenantId).eq('id', objectId).select('*').single();
    throwDb(error);
    return data;
  }

  async function listFields(objectId, query) {
    await object(objectId);
    if (!canViewSchema && !canManageSchema) await requireCapability(objectId, 'view_records');
    const p = pagination(query);
    let q = db.from('preference_field').select('*', { count: 'exact' })
      .eq('tenant_id', tenantId).eq('custom_object_id', objectId)
      .eq('entity_scope', 'custom_object').order('display_order', { ascending: true });
    if (query?.includeInactive !== 'true') q = q.eq('is_active', true);
    const { data, error, count } = await q.range(p.from, p.to);
    throwDb(error);
    return { data: data || [], total: count || 0, page: p.page, pageSize: p.pageSize };
  }

  async function createField(objectId, body) {
    requireSchemaManager();
    requireMutableObject(await object(objectId));
    const payload = {
      ...pick(body, FIELD_COLUMNS), tenant_id: tenantId, custom_object_id: objectId,
      entity_scope: 'custom_object', is_active: true,
      ...authored('created'), ...authored(),
    };
    const validation = validateCustomObjectFieldDefinition(payload, { tenantId, customObjectId: objectId });
    if (!validation.ok) throw new CustomObjectHttpError(400, 'Invalid field definition', validation.errors);
    const { data, error } = await db.from('preference_field').insert(payload).select('*').single();
    throwDb(error);
    return data;
  }

  async function updateField(objectId, fieldId, body, deactivate = false) {
    requireSchemaManager();
    const definition = await object(objectId);
    requireMutableObject(definition);
    const before = await one('preference_field', fieldId, { custom_object_id: objectId });
    if (
      deactivate
      && definition.status === 'active'
      && definition.primary_display_field_id === before.id
    ) {
      throw new CustomObjectHttpError(409, 'The primary display field of an active Custom Object cannot be deactivated');
    }
    const payload = { ...before, ...pick(body, FIELD_COLUMNS), is_active: deactivate ? false : before.is_active };
    if (body?.name !== undefined) domainGuard(() => assertImmutableInternalKey(before.name, body.name, 'Field key'));
    const validation = validateCustomObjectFieldDefinition(payload, { tenantId, customObjectId: objectId });
    if (!validation.ok) throw new CustomObjectHttpError(400, 'Invalid field definition', validation.errors);
    const update = {
      ...pick(payload, FIELD_COLUMNS),
      is_active: payload.is_active,
      ...authored(),
    };
    const { data, error } = await db.from('preference_field').update(update)
      .eq('tenant_id', tenantId).eq('custom_object_id', objectId).eq('id', fieldId)
      .select('*').single();
    throwDb(error);
    return data;
  }

  async function listRecords(objectId, query) {
    const definition = await object(objectId);
    await requireCapability(objectId, 'view_records');
    const definitions = await fields(objectId);
    const p = pagination(query);
    const plan = buildRecordQueryPlan(query, definitions);
    let q = db.from('custom_object_record').select('*', { count: 'exact' })
      .eq('tenant_id', tenantId).eq('custom_object_id', objectId);
    if (query?.includeArchived !== 'true') q = q.is('archived_at', null);
    q = applyRecordQueryPlan(q, plan);
    const { data, error, count } = await q.range(p.from, p.to);
    throwDb(error);
    return {
      data: (data || []).map((record) => ({
        ...record,
        display_value: resolveCustomObjectDisplayValue({ objectDefinition: definition, record, fields: definitions }),
      })),
      total: count || 0, page: p.page, pageSize: p.pageSize,
    };
  }

  async function createRecord(objectId, body) {
    const definition = await object(objectId);
    await requireCapability(objectId, 'create_records');
    if (definition.status !== 'active') {
      throw new CustomObjectHttpError(409, 'Records can only be created for active Custom Objects');
    }
    const validation = validateCustomObjectRecordData({ data: body?.data, fields: await fields(objectId, true), mode: 'create' });
    if (!validation.ok) throw new CustomObjectHttpError(400, 'Invalid record data', validation.errors);
    const payload = { tenant_id: tenantId, custom_object_id: objectId, data: validation.data, ...authored('created'), ...authored() };
    const { data, error } = await db.from('custom_object_record').insert(payload).select('*').single();
    throwDb(error);
    return data;
  }

  async function getRecord(objectId, recordId) {
    const definition = await object(objectId);
    await requireCapability(objectId, 'view_records');
    const record = await one('custom_object_record', recordId, { custom_object_id: objectId });
    const definitions = await fields(objectId);
    return { ...record, display_value: resolveCustomObjectDisplayValue({ objectDefinition: definition, record, fields: definitions }) };
  }

  async function updateRecord(objectId, recordId, body, archive = false) {
    const definition = await object(objectId);
    await requireCapability(objectId, archive ? 'archive_records' : 'edit_records');
    if (!archive && definition.status !== 'active') {
      throw new CustomObjectHttpError(409, 'Records can only be edited for active Custom Objects');
    }
    const before = await one('custom_object_record', recordId, { custom_object_id: objectId });
    let payload;
    if (archive) {
      if (before.archived_at) return before;
      payload = { archived_at: before.archived_at || now(), archived_by: currentActorReference, archive_reason: body?.archive_reason || null, ...authored() };
    } else {
      if (before.archived_at) throw new CustomObjectHttpError(409, 'Archived records cannot be edited');
      const validation = validateCustomObjectRecordData({
        data: body?.data, fields: await fields(objectId, true), existingData: before.data, mode: 'update',
      });
      if (!validation.ok) throw new CustomObjectHttpError(400, 'Invalid record data', validation.errors);
      payload = { data: validation.data, ...authored() };
    }
    const { data, error } = await db.from('custom_object_record').update(payload)
      .eq('tenant_id', tenantId).eq('custom_object_id', objectId).eq('id', recordId)
      .select('*').single();
    throwDb(error);
    return data;
  }

  async function listRelationshipDefinitions(objectId, query) {
    await object(objectId);
    if (!canViewSchema && !canManageSchema) await requireCapability(objectId, 'view_records');
    const p = pagination(query);
    let q = db.from('custom_object_relationship_definition').select('*', { count: 'exact' })
      .eq('tenant_id', tenantId)
      .or(`source_custom_object_id.eq.${objectId},target_custom_object_id.eq.${objectId}`)
      .order('created_at', { ascending: false });
    if (query?.includeArchived !== 'true') q = q.neq('status', 'archived');
    const { data, error, count } = await q.range(p.from, p.to);
    throwDb(error);
    let visible = data || [];
    if (!isAdmin && !canViewSchema && !canManageSchema) {
      const checks = await Promise.all(visible.map(async (definition) => {
        for (const relatedObjectId of relationshipObjectIds(definition)) {
          if (!(await hasCapability(relatedObjectId, 'view_records'))) return false;
        }
        return true;
      }));
      visible = visible.filter((_, index) => checks[index]);
    }
    return {
      data: visible,
      total: isAdmin ? (count || 0) : visible.length,
      page: p.page,
      pageSize: p.pageSize,
    };
  }

  async function createRelationshipDefinition(objectId, body) {
    requireSchemaManager();
    requireMutableObject(await object(objectId));
    const payload = {
      ...pick(body, RELATIONSHIP_DEFINITION_COLUMNS), tenant_id: tenantId,
      status: body?.status || 'draft', configuration: body?.configuration || {},
      ...authored('created'), ...authored(),
    };
    if (payload.source_kind === 'custom_object' && !payload.source_custom_object_id) payload.source_custom_object_id = objectId;
    if (payload.target_kind === 'custom_object' && !payload.target_custom_object_id) payload.target_custom_object_id = objectId;
    if (payload.source_custom_object_id !== objectId && payload.target_custom_object_id !== objectId) {
      throw new CustomObjectHttpError(400, 'Relationship must reference the routed Custom Object');
    }
    if (payload.status !== 'draft') Object.assign(payload, domainGuard(() => resolveCustomObjectLifecycleUpdate({ currentStatus: 'draft', nextStatus: payload.status, hasPrimaryDisplayField: true, now: now() })));
    const { data, error } = await db.from('custom_object_relationship_definition').insert(payload).select('*').single();
    throwDb(error);
    return data;
  }

  async function updateRelationshipDefinition(objectId, id, body, archive = false) {
    requireSchemaManager();
    requireMutableObject(await object(objectId));
    const before = await one('custom_object_relationship_definition', id);
    if (before.source_custom_object_id !== objectId && before.target_custom_object_id !== objectId) throw new CustomObjectHttpError(404, 'Resource not found');
    const payload = pick(body, RELATIONSHIP_DEFINITION_COLUMNS);
    if (payload.relationship_key !== undefined) domainGuard(() => assertImmutableInternalKey(before.relationship_key, payload.relationship_key, 'Relationship key'));
    if (archive || payload.status !== undefined) Object.assign(payload, domainGuard(() => resolveCustomObjectLifecycleUpdate({
      currentStatus: before.status, nextStatus: archive ? 'archived' : payload.status,
      currentArchivedAt: before.archived_at, hasPrimaryDisplayField: true, now: now(),
    })));
    if ((payload.status || (archive && 'archived')) === 'archived') payload.archived_by = currentActorReference;
    Object.assign(payload, authored());
    const { data, error } = await db.from('custom_object_relationship_definition').update(payload)
      .eq('tenant_id', tenantId).eq('id', id).select('*').single();
    throwDb(error);
    return data;
  }

  async function endpoint(kind, id) {
    const table = {
      custom_object: 'custom_object_record', member: 'member',
      organization: 'organization', organization_group: 'organization_group',
    }[kind];
    if (!table) throw new CustomObjectHttpError(400, 'Unsupported relationship endpoint kind');
    return { ...(await one(table, id)), kind };
  }

  async function listRelationships(objectId, query) {
    await object(objectId);
    await requireCapability(objectId, 'view_records');
    const definitionsResult = await listRelationshipDefinitions(objectId, { page: 1, pageSize: 100, includeArchived: 'false' });
    const ids = definitionsResult.data.map((row) => row.id);
    const p = pagination(query);
    if (ids.length === 0) return { data: [], total: 0, page: p.page, pageSize: p.pageSize };
    let q = db.from('custom_object_relationship').select('*', { count: 'exact' })
      .eq('tenant_id', tenantId).in('relationship_definition_id', ids)
      .order('created_at', { ascending: false });
    if (query?.includeArchived !== 'true') q = q.is('archived_at', null);
    const { data, error, count } = await q.range(p.from, p.to);
    throwDb(error);
    return { data: data || [], total: count || 0, page: p.page, pageSize: p.pageSize };
  }

  async function createRelationship(objectId, body) {
    await object(objectId);
    const definition = await one('custom_object_relationship_definition', body?.relationship_definition_id);
    if (definition.source_custom_object_id !== objectId && definition.target_custom_object_id !== objectId) throw new CustomObjectHttpError(404, 'Resource not found');
    await requireRelationshipCapabilities(definition, 'edit_records');
    if (
      (definition.source_custom_object_id === objectId && definition.edit_from_source === false)
      || (definition.target_custom_object_id === objectId && definition.edit_from_target === false)
    ) {
      throw new CustomObjectHttpError(403, 'This relationship cannot be edited from the routed Custom Object');
    }
    const source = await endpoint(definition.source_kind, body?.source_record_id);
    const target = await endpoint(definition.target_kind, body?.target_record_id);
    domainGuard(() => validateCustomObjectRelationshipEndpoints({ tenantId, definition, source, target }));
    const payload = {
      tenant_id: tenantId, relationship_definition_id: definition.id,
      source_record_id: source.id, target_record_id: target.id, ...authored('created'),
    };
    const { data, error } = await db.from('custom_object_relationship').insert(payload).select('*').single();
    throwDb(error);
    return data;
  }

  async function archiveRelationship(objectId, id) {
    await object(objectId);
    const before = await one('custom_object_relationship', id);
    const definition = await one('custom_object_relationship_definition', before.relationship_definition_id);
    if (definition.source_custom_object_id !== objectId && definition.target_custom_object_id !== objectId) throw new CustomObjectHttpError(404, 'Resource not found');
    await requireRelationshipCapabilities(definition, 'edit_records');
    if (
      (definition.source_custom_object_id === objectId && definition.edit_from_source === false)
      || (definition.target_custom_object_id === objectId && definition.edit_from_target === false)
    ) {
      throw new CustomObjectHttpError(403, 'This relationship cannot be edited from the routed Custom Object');
    }
    const { data, error } = await db.from('custom_object_relationship')
      .update({ archived_at: before.archived_at || now(), archived_by: currentActorReference })
      .eq('tenant_id', tenantId).eq('id', id).select('*').single();
    throwDb(error);
    return data;
  }

  async function listPermissions(objectId, query) {
    requireSchemaViewer();
    await object(objectId);
    const p = pagination(query);
    const [permissionResult, roleResult] = await Promise.all([
      db.from('custom_object_role_permission')
        .select('*', { count: 'exact' }).eq('tenant_id', tenantId)
        .eq('custom_object_id', objectId).order('created_at', { ascending: false })
        .range(p.from, p.to),
      db.from('role').select('id,name,label,is_system')
        .eq('tenant_id', tenantId).order('name', { ascending: true }),
    ]);
    throwDb(permissionResult.error);
    throwDb(roleResult.error);
    return {
      data: permissionResult.data || [],
      roles: roleResult.data || [],
      total: permissionResult.count || 0,
      page: p.page,
      pageSize: p.pageSize,
    };
  }

  async function upsertPermission(objectId, body) {
    requireSchemaManager();
    requireMutableObject(await object(objectId));
    if (!body?.role_id) throw new CustomObjectHttpError(400, 'role_id is required');
    await one('role', body.role_id);
    for (const column of PERMISSION_COLUMNS) {
      if (body[column] !== undefined && typeof body[column] !== 'boolean') {
        throw new CustomObjectHttpError(400, `${column} must be a boolean`);
      }
    }
    const { data: existing, error: existingError } = await db
      .from('custom_object_role_permission')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('custom_object_id', objectId)
      .eq('role_id', body.role_id)
      .maybeSingle();
    throwDb(existingError);
    const capabilities = Object.fromEntries(PERMISSION_COLUMNS.map((column) => [
      column,
      body[column] ?? existing?.[column] ?? false,
    ]));
    if (
      !capabilities.can_view_records
      && [
        'can_create_records',
        'can_edit_records',
        'can_archive_records',
        'can_export_records',
      ].some((column) => capabilities[column])
    ) {
      throw new CustomObjectHttpError(
        400,
        'View records permission is required for create, edit, archive, or export permissions',
      );
    }
    const payload = {
      tenant_id: tenantId, custom_object_id: objectId, role_id: body.role_id,
      ...capabilities,
      ...(!existing ? authored('created') : {}),
      ...authored(),
    };
    const { data, error } = await db.from('custom_object_role_permission')
      .upsert(payload, { onConflict: 'tenant_id,custom_object_id,role_id' }).select('*').single();
    throwDb(error);
    return data;
  }

  async function listAudit(objectId, query) {
    requireSchemaViewer();
    await object(objectId);
    const p = pagination(query);
    let q = db.from('custom_object_audit_event').select('*', { count: 'exact' })
      .eq('tenant_id', tenantId).eq('custom_object_id', objectId)
      .order('created_at', { ascending: false });
    if (query?.entityType) q = q.eq('entity_type', query.entityType);
    const { data, error, count } = await q.range(p.from, p.to);
    throwDb(error);
    return { data: data || [], total: count || 0, page: p.page, pageSize: p.pageSize };
  }

  return {
    listObjects, createObject, getObject, updateObject, listFields, createField,
    updateField, listRecords, createRecord, getRecord, updateRecord,
    listRelationshipDefinitions, createRelationshipDefinition,
    updateRelationshipDefinition, listRelationships, createRelationship,
    archiveRelationship, listPermissions, upsertPermission, listAudit,
  };
}