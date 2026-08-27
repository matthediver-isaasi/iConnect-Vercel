import {
  CUSTOM_OBJECT_AUDIT_ENTITY_TYPES,
  CustomObjectDomainError,
  assertImmutableInternalKey,
  coerceCustomObjectFieldValue,
  getCustomObjectFieldMetadata,
  resolveCustomObjectDisplayValue,
  resolveCustomObjectLifecycleUpdate,
  resolveCustomObjectPermission,
  validateCustomObjectFieldDefinition,
  validateCustomObjectRecordData,
  validateCustomObjectRelationshipDefinition,
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
const CORE_RELATIONSHIP_KINDS = new Set(['member', 'organization', 'organization_group']);

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
    } else if (/custom_object_relationship_definition.*key/i.test(constraint)) {
      message = 'A relationship with this relationship key already exists';
    } else if (/custom_object_relationship_active_pair_unique/i.test(constraint)) {
      message = 'This relationship already exists';
    } else if (/custom_object_relationship_(source|target)_cardinality/i.test(constraint)) {
      message = 'Relationship cardinality would be exceeded';
    }
    throw new CustomObjectHttpError(409, message);
  }
  if (error.code === '23503' || error.code === '23514') {
    const constraint = error.constraint || error.details || error.message || '';
    if (/custom_object_relationship_required_source/i.test(constraint)) {
      throw new CustomObjectHttpError(409, 'A required relationship cannot lose its final active edge');
    }
    if (/custom_object_relationship_(source|target)_valid|same_tenant|active|bnms_.*_organization_(required|match)/i.test(constraint)) {
      throw new CustomObjectHttpError(400, error.message || 'Relationship endpoint is unavailable');
    }
    throw new CustomObjectHttpError(400, error.message || fallback);
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

  async function activeObject(objectId, message = 'Custom Object endpoint is unavailable') {
    const definition = await object(objectId);
    if (definition.status !== 'active') throw new CustomObjectHttpError(409, message);
    return definition;
  }

  async function fields(objectId, activeOnly = false) {
    let query = db.from('preference_field').select('*')
      .eq('tenant_id', tenantId).eq('custom_object_id', objectId)
      .eq('entity_scope', 'custom_object').order('display_order', { ascending: true })
      .order('id', { ascending: true });
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

  async function requireRelationshipCapabilities(
    definition,
    capability,
    { allowArchivedObjects = false } = {},
  ) {
    if (
      !isAdmin
      && [definition.source_kind, definition.target_kind].some((kind) => kind !== 'custom_object')
    ) {
      throw new CustomObjectHttpError(403, 'Tenant administrator access is required for relationships with core entities');
    }
    for (const relatedObjectId of relationshipObjectIds(definition)) {
      if (allowArchivedObjects) await object(relatedObjectId);
      else await activeObject(relatedObjectId);
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
    const requestedStatus = typeof query?.status === 'string' ? query.status.trim() : '';
    if (requestedStatus && !['draft', 'active', 'archived'].includes(requestedStatus)) {
      throw new CustomObjectHttpError(400, 'status must be draft, active, or archived');
    }
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
      .eq('tenant_id', tenantId).order('created_at', { ascending: false })
      .order('id', { ascending: false });
    if (allowedObjectIds) q = q.in('id', allowedObjectIds);
    if (requestedStatus) q = q.eq('status', requestedStatus);
    if (!canViewSchema && !canManageSchema) {
      if (requestedStatus && requestedStatus !== 'active' && query?.includeArchived !== 'true') {
        return { data: [], total: 0, page: p.page, pageSize: p.pageSize };
      }
      q = query?.includeArchived === 'true'
        ? q.neq('status', 'draft')
        : q.eq('status', 'active');
    }
    else if (query?.includeArchived !== 'true' && requestedStatus !== 'archived') q = q.neq('status', 'archived');
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
    const [catalogueCountResult, permissionResult] = await Promise.all([
      db.rpc('custom_object_catalogue_counts', {
        p_tenant_id: tenantId,
        p_custom_object_ids: objectIds,
      }),
      permissionQuery,
    ]);
    throwDb(catalogueCountResult.error);
    throwDb(permissionResult.error);
    const countsByObjectId = new Map(
      (catalogueCountResult.data || []).map((item) => [item.custom_object_id, item]),
    );
    const permissionsByObjectId = new Map(
      (permissionResult.data || []).map((row) => [row.custom_object_id, row]),
    );
    return {
      data: rows.map((row) => {
        const counts = countsByObjectId.get(row.id) || {};
        return {
          ...row,
          record_count: Number(counts.record_count) || 0,
          field_count: Number(counts.field_count) || 0,
          relationship_count: Number(counts.relationship_count) || 0,
          capabilities: projectCapabilities(row, permissionsByObjectId.get(row.id) || null),
        };
      }),
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
      .eq('entity_scope', 'custom_object').order('display_order', { ascending: true })
      .order('id', { ascending: true });
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
      if (!allowedObjectIds.includes(objectId)) {
        return { data: [], total: 0, page: p.page, pageSize: p.pageSize };
      }
    }
    let q = db.from('custom_object_relationship_definition').select('*', { count: 'exact' })
      .eq('tenant_id', tenantId)
      .or(`source_custom_object_id.eq.${objectId},target_custom_object_id.eq.${objectId}`)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false });
    if (allowedObjectIds) {
      q = q.eq('source_kind', 'custom_object').eq('target_kind', 'custom_object')
        .in('source_custom_object_id', allowedObjectIds)
        .in('target_custom_object_id', allowedObjectIds);
    }
    if (query?.includeArchived !== 'true') q = q.neq('status', 'archived');
    const { data, error, count } = await q.range(p.from, p.to);
    throwDb(error);
    const visible = data || [];
    for (const definition of visible) {
      if (definition.status === 'archived') continue;
      for (const relatedObjectId of relationshipObjectIds(definition)) {
        await activeObject(relatedObjectId);
      }
    }
    return {
      data: visible,
      total: count || 0,
      page: p.page,
      pageSize: p.pageSize,
    };
  }

  async function createRelationshipDefinition(objectId, body) {
    requireSchemaManager();
    const routedObject = await object(objectId);
    requireMutableObject(routedObject);
    if (routedObject.status !== 'active') {
      throw new CustomObjectHttpError(409, 'Relationships can only be configured for active Custom Objects');
    }
    const payload = {
      ...pick(body, RELATIONSHIP_DEFINITION_COLUMNS), tenant_id: tenantId,
      status: body?.status || 'draft', configuration: body?.configuration || {},
      is_required: body?.is_required ?? false,
      show_on_source: body?.show_on_source ?? true,
      show_on_target: body?.show_on_target ?? true,
      edit_from_source: body?.edit_from_source ?? true,
      edit_from_target: body?.edit_from_target ?? false,
      ...authored('created'), ...authored(),
    };
    if (payload.source_kind === 'custom_object' && !payload.source_custom_object_id) payload.source_custom_object_id = objectId;
    if (payload.target_kind === 'custom_object' && !payload.target_custom_object_id) payload.target_custom_object_id = objectId;
    if (payload.source_custom_object_id !== objectId && payload.target_custom_object_id !== objectId) {
      throw new CustomObjectHttpError(400, 'Relationship must reference the routed Custom Object');
    }
    for (const relatedObjectId of relationshipObjectIds(payload)) {
      await activeObject(relatedObjectId);
    }
    const validation = validateCustomObjectRelationshipDefinition(payload);
    if (!validation.ok) throw new CustomObjectHttpError(400, 'Invalid relationship definition', validation.errors);
    if (payload.status !== 'draft') Object.assign(payload, domainGuard(() => resolveCustomObjectLifecycleUpdate({ currentStatus: 'draft', nextStatus: payload.status, hasPrimaryDisplayField: true, now: now() })));
    const { data, error } = await db.from('custom_object_relationship_definition').insert(payload).select('*').single();
    throwDb(error);
    return data;
  }

  async function updateRelationshipDefinition(objectId, id, body, archive = false) {
    requireSchemaManager();
    const routedObject = await object(objectId);
    requireMutableObject(routedObject);
    if (routedObject.status !== 'active') {
      throw new CustomObjectHttpError(409, 'Relationships can only be configured for active Custom Objects');
    }
    const before = await one('custom_object_relationship_definition', id);
    if (before.source_custom_object_id !== objectId && before.target_custom_object_id !== objectId) throw new CustomObjectHttpError(404, 'Resource not found');
    const payload = pick(body, RELATIONSHIP_DEFINITION_COLUMNS);
    if (payload.relationship_key !== undefined) domainGuard(() => assertImmutableInternalKey(before.relationship_key, payload.relationship_key, 'Relationship key'));
    for (const immutable of [
      'source_kind', 'source_custom_object_id', 'target_kind',
      'target_custom_object_id', 'cardinality',
    ]) {
      if (payload[immutable] !== undefined && payload[immutable] !== before[immutable]) {
        throw new CustomObjectHttpError(409, 'Relationship endpoints and cardinality cannot be changed after creation');
      }
    }
    const candidate = { ...before, ...payload, status: archive ? 'archived' : (payload.status || before.status) };
    for (const relatedObjectId of relationshipObjectIds(candidate)) await activeObject(relatedObjectId);
    const validation = validateCustomObjectRelationshipDefinition(candidate);
    if (!validation.ok) throw new CustomObjectHttpError(400, 'Invalid relationship definition', validation.errors);
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

  function endpointLabel(kind, row, definition = null, endpointFields = []) {
    if (kind === 'member') {
      return {
        primary_label: [row.first_name, row.last_name].filter(Boolean).join(' ').trim()
          || row.full_name || row.email || row.id,
        secondary_text: isAdmin ? (row.email || null) : null,
      };
    }
    if (kind === 'organization') {
      return { primary_label: row.name || row.id, secondary_text: isAdmin ? (row.email || null) : null };
    }
    if (kind === 'organization_group') {
      return { primary_label: row.name || row.id, secondary_text: row.description || null };
    }
    return {
      primary_label: resolveCustomObjectDisplayValue({
        objectDefinition: definition, record: row, fields: endpointFields,
      }),
      secondary_text: definition?.singular_label || null,
    };
  }

  async function resolveEndpointRows(kind, customObjectId, ids, { includeArchived = false } = {}) {
    const uniqueIds = [...new Set(ids.filter(Boolean))];
    if (uniqueIds.length === 0) return new Map();
    const table = {
      custom_object: 'custom_object_record', member: 'member',
      organization: 'organization', organization_group: 'organization_group',
    }[kind];
    if (!table) throw new CustomObjectHttpError(400, 'Unsupported relationship endpoint kind');
    let endpointDefinition = null;
    let endpointFields = [];
    if (kind === 'custom_object') {
      endpointDefinition = includeArchived
        ? await object(customObjectId)
        : await activeObject(customObjectId);
      await requireCapability(customObjectId, 'view_records');
      endpointFields = await fields(customObjectId, true);
    }
    let q = db.from(table).select('*').eq('tenant_id', tenantId).in('id', uniqueIds);
    if (kind === 'custom_object') {
      q = q.eq('custom_object_id', customObjectId);
      if (!includeArchived) q = q.is('archived_at', null);
    }
    const { data, error } = await q;
    throwDb(error);
    return new Map((data || []).map((row) => {
      const labels = endpointLabel(kind, row, endpointDefinition, endpointFields);
      return [row.id, {
        id: row.id,
        kind,
        custom_object_id: kind === 'custom_object' ? customObjectId : null,
        ...(kind === 'custom_object' && includeArchived ? {
          archived_at: row.archived_at || null,
          custom_object_status: endpointDefinition.status,
        } : {}),
        ...labels,
      }];
    }));
  }

  function requireCoreKind(kind) {
    if (!CORE_RELATIONSHIP_KINDS.has(kind)) {
      throw new CustomObjectHttpError(400, 'kind must be member, organization, or organization_group');
    }
  }

  function coreSide(definition, kind) {
    const sides = ['source', 'target'].filter((side) => definition[`${side}_kind`] === kind);
    return sides.length === 1 ? sides[0] : null;
  }

  async function coreRelationshipContext(kind, recordId, definitionId, capability = 'view_records') {
    requireCoreKind(kind);
    if (!recordId || !definitionId) {
      throw new CustomObjectHttpError(400, 'kind, recordId, and definitionId are required');
    }
    if (!isAdmin) {
      throw new CustomObjectHttpError(403, 'Tenant administrator access is required for relationships with core entities');
    }
    await endpoint(kind, recordId);
    const definition = await one('custom_object_relationship_definition', definitionId);
    if (definition.status !== 'active') {
      throw new CustomObjectHttpError(409, 'Relationship definition is not active');
    }
    const side = coreSide(definition, kind);
    if (!side) throw new CustomObjectHttpError(404, 'Relationship definition is unavailable for this core entity');
    if (definition[`show_on_${side}`] === false) {
      throw new CustomObjectHttpError(403, 'This relationship is hidden on the routed side');
    }
    await requireRelationshipCapabilities(definition, capability);
    return { definition, side, relatedSide: side === 'source' ? 'target' : 'source' };
  }

  // Optional definition configuration can constrain a core endpoint picker to
  // records whose configured core field matches an active parent edge target.
  // It is deliberately schema-driven, so domain-specific definitions never
  // require branches in this generic service.
  async function configuredPickerScope(definition, sourceRecordId = null, routedCoreRecordId = null) {
    const scope = definition.configuration?.picker_scope;
    if (!scope) return null;
    if (!scope || typeof scope !== 'object' || Array.isArray(scope)
      || typeof scope.via_relationship_key !== 'string'
      || !/^[a-z][a-z0-9_]{0,99}$/.test(scope.via_relationship_key)
      || typeof scope.routed_core_field !== 'string'
      || !/^[a-z][a-z0-9_]{0,99}$/.test(scope.routed_core_field)
      || definition.source_kind !== 'custom_object' || !definition.source_custom_object_id
      || definition.target_kind !== 'member' || definition.target_custom_object_id !== null
      || definition.cardinality !== 'one_to_many') {
      throw new CustomObjectHttpError(409, 'Configured picker scope schema is malformed');
    }
    const sourceObject = await one('custom_object_definition', definition.source_custom_object_id);
    if (sourceObject.status !== 'active') {
      throw new CustomObjectHttpError(409, 'Configured picker scope schema is malformed');
    }
    const { data: parentDefinitions, error: parentError } = await db
      .from('custom_object_relationship_definition').select('*')
      .eq('tenant_id', tenantId).eq('relationship_key', scope.via_relationship_key).eq('status', 'active')
      .eq('is_required', true).eq('source_kind', 'custom_object')
      .eq('source_custom_object_id', sourceObject.id).eq('target_kind', 'organization');
    throwDb(parentError);
    if ((parentDefinitions || []).length !== 1
      || parentDefinitions[0].cardinality !== 'many_to_one'
      || parentDefinitions[0].target_custom_object_id !== null) {
      throw new CustomObjectHttpError(409, 'Configured picker parent relationship schema is malformed');
    }
    const parentDefinition = parentDefinitions[0];
    const readEdges = async (configure) => {
      const result = [];
      for (let from = 0;; from += 1000) {
        const { data, error } = await configure(
          db.from('custom_object_relationship').select('source_record_id, target_record_id')
            .eq('tenant_id', tenantId).eq('relationship_definition_id', parentDefinition.id)
            .is('archived_at', null),
        ).range(from, from + 999);
        throwDb(error);
        result.push(...(data || []));
        if (!data || data.length < 1000) return result;
      }
    };
    if (routedCoreRecordId) {
      const member = await one('member', routedCoreRecordId);
      const routedValue = member[scope.routed_core_field];
      if (!routedValue) return { sourceRecordIds: [] };
      // Read every parent edge (paged) so a corrupt source with multiple
      // organisations is excluded rather than accidentally accepted because
      // one of its edges happens to match this member.
      const edges = await readEdges(q => q);
      const bySource = new Map();
      for (const edge of edges) {
        const organisations = bySource.get(edge.source_record_id) || [];
        organisations.push(edge.target_record_id);
        bySource.set(edge.source_record_id, organisations);
      }
      return {
        sourceRecordIds: [...bySource.entries()]
          .filter(([, organisations]) => organisations.length === 1
            && organisations[0] === routedValue)
          .map(([id]) => id),
      };
    }
    if (sourceRecordId) {
      const edges = await readEdges(q => q.eq('source_record_id', sourceRecordId));
      if (edges.length !== 1 || !edges[0].target_record_id) {
        throw new CustomObjectHttpError(409, 'Configured source record must have exactly one active parent');
      }
      return { organizationId: edges[0].target_record_id };
    }
    return null;
  }

  async function listCoreRelationshipDefinitions(kind, recordId) {
    requireCoreKind(kind);
    if (!recordId) throw new CustomObjectHttpError(400, 'kind and recordId are required');
    if (!isAdmin) {
      throw new CustomObjectHttpError(403, 'Tenant administrator access is required for relationships with core entities');
    }
    await endpoint(kind, recordId);
    const { data, error } = await db.from('custom_object_relationship_definition').select('*')
      .eq('tenant_id', tenantId).eq('status', 'active')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });
    throwDb(error);
    const candidates = (data || []).map((definition) => ({
      definition,
      side: coreSide(definition, kind),
    })).filter(({ definition, side }) => side && definition[`show_on_${side}`] !== false);
    const visible = [];
    for (const candidate of candidates) {
      const { definition, side } = candidate;
      try {
        await requireRelationshipCapabilities(definition, 'view_records');
      } catch (error_) {
        if (error_ instanceof CustomObjectHttpError && [403, 404, 409].includes(error_.status)) continue;
        throw error_;
      }
      const relatedSide = side === 'source' ? 'target' : 'source';
      const relatedObjectId = definition[`${relatedSide}_custom_object_id`];
      if (definition[`${relatedSide}_kind`] !== 'custom_object' || !relatedObjectId) continue;
      const relatedObject = await activeObject(relatedObjectId);
      const { data: edges, error: edgeError, count } = await db.from('custom_object_relationship')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .eq('relationship_definition_id', definition.id)
        .eq(`${side}_record_id`, recordId)
        .is('archived_at', null);
      throwDb(edgeError);
      visible.push({
        definition: {
          id: definition.id,
          relationship_key: definition.relationship_key,
          status: definition.status,
          source_kind: definition.source_kind,
          source_custom_object_id: definition.source_custom_object_id,
          target_kind: definition.target_kind,
          target_custom_object_id: definition.target_custom_object_id,
          source_label: definition.source_label,
          target_label: definition.target_label,
          cardinality: definition.cardinality,
          show_on_source: definition.show_on_source,
          show_on_target: definition.show_on_target,
          edit_from_source: definition.edit_from_source,
          edit_from_target: definition.edit_from_target,
        },
        side,
        label: definition[`${side}_label`],
        related_object: {
          id: relatedObject.id,
          object_key: relatedObject.object_key,
          singular_label: relatedObject.singular_label,
          plural_label: relatedObject.plural_label,
        },
        count: count ?? (edges || []).length,
        can_edit: definition[`edit_from_${side}`] !== false,
      });
    }
    return { data: visible };
  }

  async function listCoreRelationships(kind, recordId, query) {
    const { definition, side, relatedSide } = await coreRelationshipContext(
      kind, recordId, query?.definitionId, 'view_records',
    );
    const p = pagination(query);
    let q = db.from('custom_object_relationship').select('*', { count: 'exact' })
      .eq('tenant_id', tenantId)
      .eq('relationship_definition_id', definition.id)
      .eq(`${side}_record_id`, recordId)
      .is('archived_at', null)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false });
    const { data, error, count } = await q.range(p.from, p.to);
    throwDb(error);
    const rows = data || [];
    const resolved = await resolveEndpointRows(
      definition[`${relatedSide}_kind`],
      definition[`${relatedSide}_custom_object_id`],
      rows.map((edge) => edge[`${relatedSide}_record_id`]),
    );
    if (resolved.size !== new Set(rows.map((edge) => edge[`${relatedSide}_record_id`])).size) {
      throw new CustomObjectHttpError(409, 'A related endpoint is missing, archived, or unavailable');
    }
    return {
      data: rows.map((edge) => ({
        relationship_id: edge.id,
        relationship_definition_id: edge.relationship_definition_id,
        related: resolved.get(edge[`${relatedSide}_record_id`]),
      })),
      total: count || 0,
      page: p.page,
      pageSize: p.pageSize,
    };
  }

  async function coreEntityPicker(kind, recordId, query) {
    const { definition, side, relatedSide } = await coreRelationshipContext(
      kind, recordId, query?.definitionId, 'edit_records',
    );
    if (definition[`edit_from_${side}`] === false) {
      throw new CustomObjectHttpError(403, 'This relationship cannot be edited from the routed side');
    }
    const customObjectId = definition[`${relatedSide}_custom_object_id`];
    if (definition[`${relatedSide}_kind`] !== 'custom_object' || !customObjectId) {
      throw new CustomObjectHttpError(409, 'Core relationship picker requires a Custom Object endpoint');
    }
    const objectDefinition = await activeObject(customObjectId);
    const endpointFields = await fields(customObjectId, true);
    const pickerScope = kind === 'member' && relatedSide === 'source'
      ? await configuredPickerScope(definition, null, recordId) : null;
    if (pickerScope && pickerScope.sourceRecordIds.length === 0) {
      const p = pagination(query);
      return { data: [], total: 0, page: p.page, pageSize: p.pageSize };
    }
    const p = pagination(query);
    let q = db.from('custom_object_record').select('*', { count: 'exact' })
      .eq('tenant_id', tenantId).eq('custom_object_id', customObjectId)
      .is('archived_at', null);
    if (pickerScope) q = q.in('id', pickerScope.sourceRecordIds);
    const search = typeof query?.search === 'string' ? query.search.trim() : '';
    if (search) {
      const primary = endpointFields.find((field) => field.id === objectDefinition.primary_display_field_id);
      const key = getCustomObjectFieldMetadata(primary).key;
      if (key) q = q.filter(`data->>${key}`, 'ilike', `*${search}*`);
    }
    q = q.order('created_at', { ascending: true }).order('id', { ascending: true });
    const { data, error, count } = await q.range(p.from, p.to);
    throwDb(error);
    return {
      data: (data || []).map((row) => ({
        id: row.id,
        kind: 'custom_object',
        custom_object_id: customObjectId,
        ...endpointLabel('custom_object', row, objectDefinition, endpointFields),
      })),
      total: count || 0,
      page: p.page,
      pageSize: p.pageSize,
    };
  }

  async function createCoreRelationship(kind, recordId, body) {
    const { definition, side, relatedSide } = await coreRelationshipContext(
      kind, recordId, body?.relationship_definition_id, 'edit_records',
    );
    if (definition[`edit_from_${side}`] === false) {
      throw new CustomObjectHttpError(403, 'This relationship cannot be edited from the routed side');
    }
    const relatedRecordId = body?.related_record_id;
    if (!relatedRecordId) throw new CustomObjectHttpError(400, 'related_record_id is required');
    const sourceId = side === 'source' ? recordId : relatedRecordId;
    const targetId = side === 'target' ? recordId : relatedRecordId;
    const source = await endpoint(definition.source_kind, sourceId);
    const target = await endpoint(definition.target_kind, targetId);
    domainGuard(() => validateCustomObjectRelationshipEndpoints({ tenantId, definition, source, target }));
    const { data, error } = await db.from('custom_object_relationship').insert({
      tenant_id: tenantId,
      relationship_definition_id: definition.id,
      source_record_id: source.id,
      target_record_id: target.id,
      ...authored('created'),
    }).select('*').single();
    throwDb(error);
    return data;
  }

  async function archiveCoreRelationship(kind, recordId, edgeId) {
    if (!edgeId) throw new CustomObjectHttpError(400, 'relationshipId is required');
    const edge = await one('custom_object_relationship', edgeId);
    if (edge.archived_at) throw new CustomObjectHttpError(409, 'Relationship edge is already archived');
    const { definition, side } = await coreRelationshipContext(
      kind, recordId, edge.relationship_definition_id, 'edit_records',
    );
    if (edge[`${side}_record_id`] !== recordId) throw new CustomObjectHttpError(404, 'Resource not found');
    if (definition[`edit_from_${side}`] === false) {
      throw new CustomObjectHttpError(403, 'This relationship cannot be edited from the routed side');
    }
    const { data, error } = await db.rpc('archive_custom_object_relationship', {
      p_tenant_id: tenantId,
      p_relationship_id: edgeId,
      p_archived_by: currentActorReference,
      p_archived_at: now(),
    }).single();
    throwDb(error);
    return data;
  }

  async function entityPicker(objectId, query) {
    await activeObject(objectId, 'Entity picker is only available for active Custom Objects');
    if (query?.kind !== undefined || query?.customObjectId !== undefined) {
      throw new CustomObjectHttpError(400, 'Picker endpoint type is derived from definitionId and side');
    }
    const definitionId = query?.definitionId;
    const recordId = query?.recordId;
    const side = query?.side;
    if (!definitionId || !recordId || !['source', 'target'].includes(side)) {
      throw new CustomObjectHttpError(400, 'definitionId, recordId, and side are required');
    }
    const definition = await one('custom_object_relationship_definition', definitionId);
    if (definition.status !== 'active') throw new CustomObjectHttpError(409, 'Relationship definition is not active');
    if (
      definition[`${side}_kind`] !== 'custom_object'
      || definition[`${side}_custom_object_id`] !== objectId
    ) {
      throw new CustomObjectHttpError(400, 'Routed side does not match the routed Custom Object');
    }
    if (definition[`show_on_${side}`] === false) {
      throw new CustomObjectHttpError(403, 'This relationship is hidden on the routed side');
    }
    if (definition[`edit_from_${side}`] === false) {
      throw new CustomObjectHttpError(403, 'This relationship cannot be edited from the routed side');
    }
    const routedRecord = await one('custom_object_record', recordId, { custom_object_id: objectId });
    if (routedRecord.archived_at) throw new CustomObjectHttpError(409, 'Routed record is archived');
    await requireRelationshipCapabilities(definition, 'edit_records');
    const oppositeSide = side === 'source' ? 'target' : 'source';
    const pickerScope = side === 'source' && definition.target_kind === 'member'
      ? await configuredPickerScope(definition, recordId, null) : null;
    const kind = definition[`${oppositeSide}_kind`];
    const table = {
      custom_object: 'custom_object_record', member: 'member',
      organization: 'organization', organization_group: 'organization_group',
    }[kind];
    if (!table) throw new CustomObjectHttpError(400, 'kind must be member, organization, organization_group, or custom_object');
    const customObjectId = kind === 'custom_object'
      ? definition[`${oppositeSide}_custom_object_id`]
      : null;
    let endpointDefinition = null;
    let endpointFields = [];
    if (kind === 'custom_object') {
      endpointDefinition = await activeObject(customObjectId);
      await requireCapability(customObjectId, 'view_records');
      endpointFields = await fields(customObjectId, true);
    }
    const p = pagination(query);
    let q = db.from(table).select('*', { count: 'exact' }).eq('tenant_id', tenantId);
    if (pickerScope) q = q.eq(definition.configuration.picker_scope.routed_core_field, pickerScope.organizationId);
    if (kind === 'custom_object') {
      q = q.eq('custom_object_id', customObjectId).is('archived_at', null);
    }
    const search = typeof query?.search === 'string' ? query.search.trim() : '';
    if (search) {
      const pattern = quotePostgrestValue(`*${search}*`);
      if (kind === 'member') {
        q = q.or(`first_name.ilike.${pattern},last_name.ilike.${pattern},email.ilike.${pattern}`);
      }
      else if (kind !== 'custom_object') q = q.ilike('name', `%${search}%`);
      else {
        const primary = endpointFields.find((field) => field.id === endpointDefinition.primary_display_field_id);
        const key = getCustomObjectFieldMetadata(primary).key;
        if (key) q = q.filter(`data->>${key}`, 'ilike', `*${search}*`);
      }
    }
    q = q.order(kind === 'member' ? 'last_name' : (kind === 'custom_object' ? 'created_at' : 'name'), { ascending: true })
      .order('id', { ascending: true });
    const { data, error, count } = await q.range(p.from, p.to);
    throwDb(error);
    return {
      data: (data || []).map((row) => ({
        id: row.id,
        kind,
        custom_object_id: kind === 'custom_object' ? customObjectId : null,
        ...endpointLabel(kind, row, endpointDefinition, endpointFields),
      })),
      page: p.page,
      pageSize: p.pageSize,
      total: count || 0,
    };
  }

  async function listRelationships(objectId, query) {
    const includeArchived = query?.includeArchived === 'true';
    if (includeArchived) await object(objectId);
    else await activeObject(objectId, 'Relationships are only available for active Custom Objects');
    await requireCapability(objectId, 'view_records');
    const recordId = query?.recordId;
    const definitionId = query?.definitionId;
    if (!recordId || !definitionId) {
      throw new CustomObjectHttpError(400, 'recordId and definitionId are required');
    }
    const definition = await one('custom_object_relationship_definition', definitionId);
    if (definition.status !== 'active' && !(includeArchived && definition.status === 'archived')) {
      throw new CustomObjectHttpError(409, 'Relationship definition is not active');
    }
    const sourceSide = definition.source_kind === 'custom_object'
      && definition.source_custom_object_id === objectId;
    const targetSide = definition.target_kind === 'custom_object'
      && definition.target_custom_object_id === objectId;
    const requestedSide = query?.side;
    let side = requestedSide;
    if (!side) {
      if (sourceSide === targetSide) throw new CustomObjectHttpError(400, 'side is required when both endpoints use the routed Custom Object');
      side = sourceSide ? 'source' : 'target';
    }
    if (!['source', 'target'].includes(side)
      || (side === 'source' && !sourceSide)
      || (side === 'target' && !targetSide)) {
      throw new CustomObjectHttpError(400, 'Routed side does not match the relationship definition');
    }
    if (definition[`show_on_${side}`] === false) throw new CustomObjectHttpError(403, 'This relationship is hidden on the routed side');
    const routedRecord = await one('custom_object_record', recordId, { custom_object_id: objectId });
    if (routedRecord.archived_at && !includeArchived) throw new CustomObjectHttpError(409, 'Routed record is archived');
    await requireRelationshipCapabilities(definition, 'view_records', {
      allowArchivedObjects: includeArchived,
    });
    const p = pagination(query);
    let q = db.from('custom_object_relationship').select('*', { count: 'exact' })
      .eq('tenant_id', tenantId).eq('relationship_definition_id', definition.id)
      .eq(`${side}_record_id`, recordId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false });
    if (!includeArchived) q = q.is('archived_at', null);
    const { data, error, count } = await q.range(p.from, p.to);
    throwDb(error);
    const relatedSide = side === 'source' ? 'target' : 'source';
    const rows = data || [];
    const resolved = await resolveEndpointRows(
      definition[`${relatedSide}_kind`],
      definition[`${relatedSide}_custom_object_id`],
      rows.map((edge) => edge[`${relatedSide}_record_id`]),
      { includeArchived },
    );
    if (resolved.size !== new Set(rows.map((edge) => edge[`${relatedSide}_record_id`])).size) {
      throw new CustomObjectHttpError(409, 'A related endpoint is missing, archived, or unavailable');
    }
    return {
      data: rows.map((edge) => ({
        relationship_id: edge.id,
        relationship_definition_id: edge.relationship_definition_id,
        source_record_id: edge.source_record_id,
        target_record_id: edge.target_record_id,
        ...(includeArchived ? { archived_at: edge.archived_at || null } : {}),
        related: resolved.get(edge[`${relatedSide}_record_id`]) || null,
      })),
      total: count || 0, page: p.page, pageSize: p.pageSize,
    };
  }

  function routedRelationshipSide(definition, objectId, suppliedSide) {
    if (!['source', 'target'].includes(suppliedSide)) {
      throw new CustomObjectHttpError(400, 'routed_side must be source or target');
    }
    if (definition[`${suppliedSide}_kind`] !== 'custom_object'
      || definition[`${suppliedSide}_custom_object_id`] !== objectId) {
      throw new CustomObjectHttpError(400, 'Routed side does not match the routed Custom Object');
    }
    return suppliedSide;
  }

  async function createRelationship(objectId, body) {
    await activeObject(objectId, 'Relationships are only available for active Custom Objects');
    const definition = await one('custom_object_relationship_definition', body?.relationship_definition_id);
    if (definition.source_custom_object_id !== objectId && definition.target_custom_object_id !== objectId) throw new CustomObjectHttpError(404, 'Resource not found');
    const routedSide = routedRelationshipSide(definition, objectId, body?.routed_side);
    if (!body?.routed_record_id || body.routed_record_id !== body?.[`${routedSide}_record_id`]) {
      throw new CustomObjectHttpError(400, 'routed_record_id must match the endpoint on routed_side');
    }
    await requireRelationshipCapabilities(definition, 'edit_records');
    if (definition[`edit_from_${routedSide}`] === false) {
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

  async function archiveRelationship(objectId, id, body = {}) {
    await activeObject(objectId, 'Relationships are only available for active Custom Objects');
    const before = await one('custom_object_relationship', id);
    if (before.archived_at) throw new CustomObjectHttpError(409, 'Relationship edge is already archived');
    const definition = await one('custom_object_relationship_definition', before.relationship_definition_id);
    if (definition.source_custom_object_id !== objectId && definition.target_custom_object_id !== objectId) throw new CustomObjectHttpError(404, 'Resource not found');
    const routedSide = routedRelationshipSide(definition, objectId, body?.routed_side);
    if (!body?.routed_record_id || body.routed_record_id !== before[`${routedSide}_record_id`]) {
      throw new CustomObjectHttpError(400, 'routed_record_id does not match this relationship edge');
    }
    await requireRelationshipCapabilities(definition, 'edit_records');
    if (definition[`edit_from_${routedSide}`] === false) {
      throw new CustomObjectHttpError(403, 'This relationship cannot be edited from the routed Custom Object');
    }
    const source = await endpoint(definition.source_kind, before.source_record_id);
    const target = await endpoint(definition.target_kind, before.target_record_id);
    domainGuard(() => validateCustomObjectRelationshipEndpoints({
      tenantId, definition, source, target,
    }));
    if (typeof db.rpc !== 'function') {
      throw new CustomObjectHttpError(503, 'Relationship archive transaction is unavailable');
    }
    const { data, error } = await db.rpc('archive_custom_object_relationship', {
      p_tenant_id: tenantId,
      p_relationship_id: id,
      p_archived_by: currentActorReference,
      p_archived_at: now(),
    }).single();
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
        .order('id', { ascending: false })
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
      .order('created_at', { ascending: false })
      .order('id', { ascending: false });
    if (query?.entityType) {
      if (!CUSTOM_OBJECT_AUDIT_ENTITY_TYPES.includes(query.entityType)) {
        throw new CustomObjectHttpError(400, 'Invalid Custom Object audit entity type');
      }
      q = q.eq('entity_type', query.entityType);
    }
    const { data, error, count } = await q.range(p.from, p.to);
    throwDb(error);
    return { data: data || [], total: count || 0, page: p.page, pageSize: p.pageSize };
  }

  return {
    listObjects, createObject, getObject, updateObject, listFields, createField,
    updateField, listRecords, createRecord, getRecord, updateRecord,
    listRelationshipDefinitions, createRelationshipDefinition,
    updateRelationshipDefinition, entityPicker, listRelationships, createRelationship,
    archiveRelationship, listPermissions, upsertPermission, listAudit,
    listCoreRelationshipDefinitions, listCoreRelationships, coreEntityPicker,
    createCoreRelationship, archiveCoreRelationship,
  };
}