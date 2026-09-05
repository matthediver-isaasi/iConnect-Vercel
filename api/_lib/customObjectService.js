import {
  CUSTOM_OBJECT_AUDIT_ENTITY_TYPES,
  CustomObjectDomainError,
  assertImmutableInternalKey,
  coerceCustomObjectFieldValue,
  getCustomObjectFieldMetadata,
  projectCustomObjectRecordData,
  resolveCustomObjectFieldAccess,
  resolveCustomObjectDisplayValue,
  resolveCustomObjectLifecycleUpdate,
  resolveCustomObjectPermission,
  reconcileCustomObjectPresentationConfiguration,
  validateCustomObjectFieldDefinition,
  validateCustomObjectPresentationConfiguration,
  validateCustomObjectRelationshipPreviewConfiguration,
  validateCustomObjectViewConfiguration,
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
const LIST_FIELD_TYPES = new Set([
  'text', 'textarea', 'email', 'url', 'number', 'decimal', 'date',
  'boolean', 'dropdown', 'picklist', 'country', 'countries', 'list', 'file',
]);
const RELATIONSHIP_FILTER_OPERATORS = new Set([
  'any_of', 'none_of', 'is_empty', 'is_not_empty',
]);
const LIST_RELATIONSHIP_PROJECTION_LIMIT = 100;
const ENDPOINT_ID_BATCH_SIZE = 200;

function listFieldOperators(type) {
  if (TEXT_FILTER_TYPES.has(type)) return ['contains', 'equals', 'is_empty', 'is_not_empty'];
  if (NUMERIC_FILTER_TYPES.has(type) || type === 'date') return ['equals', 'gte', 'lte'];
  if (OPTION_FILTER_TYPES.has(type)) return ['any_of', 'none_of'];
  if (type === 'boolean') return ['equals'];
  return [];
}

function listFieldValueShape(type) {
  if (['picklist', 'countries', 'list'].includes(type)) return 'array';
  if (type === 'file') return 'file';
  if (type === 'boolean') return 'boolean';
  if (['number', 'decimal'].includes(type)) return 'number';
  if (type === 'date') return 'date';
  return 'scalar';
}

function relationshipValueShape(cardinality, side) {
  return cardinality === 'many_to_many'
    || (cardinality === 'one_to_many' && side === 'source')
    || (cardinality === 'many_to_one' && side === 'target')
    ? 'many'
    : 'one';
}

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

function parseJsonObject(value, label) {
  if (value === undefined || value === null || value === '') return {};
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      queryError(`${label} must be valid JSON`);
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    queryError(`${label} must be a JSON object`);
  }
  return parsed;
}

function parseJsonArray(value, label) {
  if (value === undefined || value === null || value === '') return null;
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      queryError(`${label} must be valid JSON`);
    }
  }
  if (!Array.isArray(parsed)) queryError(`${label} must be a JSON array`);
  return parsed;
}

function relationshipListKey(definitionId, side) {
  return `relationship:${definitionId}:${side}`;
}

function parseRelationshipListKey(value) {
  const match = String(value || '').match(/^relationship:([^:]+):(source|target)$/);
  return match ? { definitionId: match[1], side: match[2] } : null;
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

function pagination(query = {}, maximum = 100) {
  const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(Number.parseInt(query.pageSize, 10) || 25, 1), maximum);
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
  if (error.code === '22P02') throw new CustomObjectHttpError(400, error.message || fallback);
  throw new CustomObjectHttpError(500, error.message || fallback);
}

function throwAtomicCreateDb(error) {
  if (
    error?.code === 'PGRST202'
    || /create_custom_object_record_with_relationships.*(schema cache|could not find|does not exist)/i.test(error?.message || '')
  ) {
    throw new CustomObjectHttpError(
      503,
      'Contextual record creation is not available because the atomic database function is missing. Apply migration 20260925_custom_object_record_relationship_create.sql to the destination database and reload the PostgREST schema cache.',
    );
  }
  throwDb(error);
}

function throwRelationshipListRpcDb(error) {
  if (
    error?.code === 'PGRST202'
    || /custom_object_record_relationship_(?:list|projection).*(schema cache|could not find|does not exist)/i.test(error?.message || '')
  ) {
    throw new CustomObjectHttpError(
      503,
      'Relationship list queries are unavailable because the required database function is missing. Apply migration 20260928_custom_object_relationship_list_rpc.sql to the destination database and reload the PostgREST schema cache.',
    );
  }
  throwDb(error);
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

  async function presentationRelationships(objectId) {
    const { data, error } = await db.from('custom_object_relationship_definition').select('*')
      .eq('tenant_id', tenantId)
      .or(`source_custom_object_id.eq.${objectId},target_custom_object_id.eq.${objectId}`);
    throwDb(error);
    return (data || []).filter((definition) =>
      definition.source_custom_object_id === objectId
      || definition.target_custom_object_id === objectId);
  }

  async function validatePresentation(objectId, configuration, definitions = null) {
    const validation = validateCustomObjectPresentationConfiguration(
      configuration,
      definitions || await fields(objectId),
      await presentationRelationships(objectId),
      objectId,
    );
    if (!validation.ok) {
      throw new CustomObjectHttpError(400, 'Invalid CRM presentation configuration', validation.errors);
    }
  }

  async function reconcilePresentation(definition) {
    if (definition.configuration?.views?.detail?.version === undefined) return definition;
    let [definitions, relationships] = await Promise.all([
      fields(definition.id),
      presentationRelationships(definition.id),
    ]);
    if (!isAdmin && !canViewSchema && !canManageSchema) {
      const access = await fieldAccess(definition.id, definitions);
      definitions = allowedFields(definitions, access);
      if (relationships.length === 0 || !context.roleId) relationships = [];
      else {
        const { data: grants, error } = await db.from('custom_object_role_permission')
          .select('custom_object_id')
          .eq('tenant_id', tenantId)
          .eq('role_id', context.roleId)
          .eq('can_view_records', true);
        throwDb(error);
        const allowedObjectIds = new Set((grants || []).map((grant) => grant.custom_object_id));
        relationships = relationships.filter((relationship) =>
          relationship.source_kind === 'custom_object'
          && relationship.target_kind === 'custom_object'
          && allowedObjectIds.has(relationship.source_custom_object_id)
          && allowedObjectIds.has(relationship.target_custom_object_id));
      }
    }
    return {
      ...definition,
      configuration: reconcileCustomObjectPresentationConfiguration(
        definition.configuration, definitions, relationships, definition.id,
      ),
    };
  }

  async function permission(objectId) {
    if (!context.roleId) return null;
    const { data, error } = await db.from('custom_object_role_permission').select('*')
      .eq('tenant_id', tenantId).eq('custom_object_id', objectId)
      .eq('role_id', context.roleId).maybeSingle();
    throwDb(error);
    return data || null;
  }

  async function fieldAccess(objectId, definitions) {
    const ids = (definitions || []).map((field) => String(field.id));
    const access = new Map(ids.map((id) => [id, 'edit']));
    if (isAdmin || !context.roleId || ids.length === 0) return access;
    const { data, error } = await db.from('custom_object_field_role_permission').select('*')
      .eq('tenant_id', tenantId).eq('custom_object_id', objectId)
      .eq('role_id', context.roleId).in('field_id', ids);
    throwDb(error);
    for (const row of data || []) access.set(String(row.field_id), resolveCustomObjectFieldAccess({ permission: row }));
    return access;
  }

  function allowedFields(definitions, access, minimum = 'read') {
    return definitions.filter((field) => {
      const value = access.get(String(field.id));
      return minimum === 'edit' ? value === 'edit' : value !== 'none';
    });
  }

  function projectRecord(definition, record, definitions, access) {
    const visible = allowedFields(definitions, access);
    const projected = { ...record, data: projectCustomObjectRecordData({
      data: record.data, fields: definitions, accessByFieldId: access,
    }) };
    return {
      ...projected,
      display_value: resolveCustomObjectDisplayValue({
        objectDefinition: definition, record: projected, fields: visible,
      }),
    };
  }

  async function recordListMetadata(objectId, readableDefinitions) {
    const scalarFields = readableDefinitions
      .filter((field) => {
        const metadata = getCustomObjectFieldMetadata(field);
        return metadata.active && LIST_FIELD_TYPES.has(metadata.type);
      })
      .map((field) => {
        const metadata = getCustomObjectFieldMetadata(field);
        return {
          id: String(field.id),
          kind: 'field',
          field_id: field.id,
          key: metadata.key,
          label: metadata.label,
          field_type: metadata.type,
          value_shape: listFieldValueShape(metadata.type),
          operators: listFieldOperators(metadata.type),
          filterable: listFieldOperators(metadata.type).length > 0,
          sortable: metadata.type !== 'file',
        };
      });

    const { data, error } = await db.from('custom_object_relationship_definition').select('*')
      .eq('tenant_id', tenantId).eq('status', 'active')
      .or(`source_custom_object_id.eq.${objectId},target_custom_object_id.eq.${objectId}`);
    throwDb(error);
    const candidates = [];
    for (const relationship of data || []) {
      if (relationship.status !== 'active' || relationship.tenant_id !== tenantId) continue;
      for (const side of ['source', 'target']) {
        if (
          relationship[`${side}_kind`] !== 'custom_object'
          || String(relationship[`${side}_custom_object_id`]) !== String(objectId)
          || relationship[`show_on_${side}`] === false
        ) continue;
        const opposite = side === 'source' ? 'target' : 'source';
        const endpointKind = relationship[`${opposite}_kind`];
        const endpointObjectId = relationship[`${opposite}_custom_object_id`] || null;
        // Core endpoints are administrator-only throughout the relationship
        // service. Do not advertise a list column that the caller cannot read.
        if (!isAdmin && endpointKind !== 'custom_object') continue;
        let endpointObject = null;
        let displayField = null;
        if (endpointKind === 'custom_object') {
          try {
            endpointObject = await activeObject(endpointObjectId);
          } catch (caught) {
            if ([404, 409].includes(caught?.status)) continue;
            throw caught;
          }
          if (!(await hasCapability(endpointObjectId, 'view_records'))) continue;
          const endpointDefinitions = await fields(endpointObjectId, true);
          const endpointAccess = await fieldAccess(endpointObjectId, endpointDefinitions);
          const primary = endpointDefinitions.find((field) =>
            String(field.id) === String(endpointObject.primary_display_field_id));
          if (!primary || endpointAccess.get(String(primary.id)) === 'none') continue;
          const metadata = getCustomObjectFieldMetadata(primary);
          displayField = {
            field_id: primary.id,
            key: metadata.key,
            label: metadata.label,
            field_type: metadata.type,
          };
        }
        candidates.push({
          id: relationshipListKey(relationship.id, side),
          kind: 'relationship',
          relationship_definition_id: relationship.id,
          side,
          label: (side === 'source' ? relationship.source_label : relationship.target_label)
            || 'Related records',
          cardinality: relationship.cardinality,
          value_shape: relationshipValueShape(relationship.cardinality, side),
          operators: [...RELATIONSHIP_FILTER_OPERATORS],
          filterable: true,
          // Core endpoint labels are resolved by adapters, not SQL columns.
          // They remain filterable but cannot be label-sorted by this RPC.
          sortable: endpointKind === 'custom_object' && Boolean(displayField),
          endpoint: {
            kind: endpointKind,
            custom_object_id: endpointObjectId,
            ...(endpointObject ? {
              singular_label: endpointObject.singular_label,
              plural_label: endpointObject.plural_label,
            } : {}),
            ...(displayField ? { display_field: displayField } : {}),
          },
        });
      }
    }
    return {
      fields: scalarFields,
      relationships: candidates,
      columns: [...scalarFields, ...candidates],
    };
  }

  function relationshipQuerySpecification(query, metadata) {
    const available = new Map(metadata.relationships.map((item) => [item.id, item]));
    const filters = [];
    const explicit = parseJsonObject(
      query?.relationshipFilters ?? query?.relationship_filters,
      'relationshipFilters',
    );
    const unified = parseRecordFilters(query?.filters);
    for (const [key, raw] of [
      ...Object.entries(explicit),
      ...Object.entries(unified).filter(([key]) => available.has(key)),
    ]) {
      const item = available.get(key);
      if (!item) queryError(`Unknown or inaccessible relationship list field: ${key}`);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)
        || !RELATIONSHIP_FILTER_OPERATORS.has(raw.op)) {
        queryError(`Unsupported relationship filter for ${key}`);
      }
      const values = ['any_of', 'none_of'].includes(raw.op)
        ? filterValues(raw.value ?? raw.values, raw.op).map(String)
        : [];
      filters.push({ item, op: raw.op, values });
    }
    const sortKey = query?.relationshipSort
      ?? query?.relationship_sort
      ?? (parseRelationshipListKey(query?.sortField) ? query.sortField : null);
    if (!sortKey) return { filters, sort: null };
    const item = available.get(sortKey);
    if (!item) queryError(`Unknown or inaccessible relationship list field: ${sortKey}`);
    if (item.sortable === false) queryError('Relationship label sorting is not supported for this endpoint');
    const mode = query?.relationshipSortMode ?? query?.relationship_sort_mode ?? 'label';
    if (!['label', 'count'].includes(mode)) queryError('relationshipSortMode must be label or count');
    const direction = query?.sortDir || 'asc';
    if (!['asc', 'desc'].includes(direction)) queryError('sortDir must be asc or desc');
    return { filters, sort: { item, mode, ascending: direction === 'asc' } };
  }

  function relationshipProjectionItems(query, metadata) {
    const available = new Map(metadata.relationships.map((item) => [item.id, item]));
    const parsed = parseJsonArray(
      query?.relationshipColumns ?? query?.relationship_columns,
      'relationshipColumns',
    );
    const ids = [...new Set((parsed ?? metadata.relationships.map((item) => item.id)).map(String))];
    if (ids.length > LIST_RELATIONSHIP_PROJECTION_LIMIT) {
      queryError(`relationshipColumns supports at most ${LIST_RELATIONSHIP_PROJECTION_LIMIT} items`);
    }
    return ids.map((id) => {
      const item = available.get(id);
      if (!item) queryError(`Unknown or inaccessible relationship list field: ${id}`);
      return item;
    });
  }

  async function projectListRelationships(records, relationshipItems) {
    if (records.length === 0 || relationshipItems.length === 0) return records;
    const { data: projection, error } = await db.rpc(
      'custom_object_record_relationship_projection',
      {
        p_tenant_id: tenantId,
        p_custom_object_id: records[0].custom_object_id,
        p_items: relationshipItems.map((item) => ({
          list_field_id: item.id,
          relationship_definition_id: item.relationship_definition_id,
          side: item.side,
          endpoint_kind: item.endpoint.kind,
          endpoint_custom_object_id: item.endpoint.custom_object_id,
          display_key: item.endpoint.display_field?.key || null,
        })),
        p_record_ids: records.map((row) => row.id),
        p_label_limit: 3,
      },
    );
    throwRelationshipListRpcDb(error);
    const rowsByItem = new Map();
    for (const item of relationshipItems) {
      const rows = (projection || []).filter((row) => row.list_field_id === item.id);
      const ids = rows.map((row) => row.opposite_record_id);
      const endpointRows = await resolveEndpointRows(
        item.endpoint.kind, item.endpoint.custom_object_id, ids,
      );
      rowsByItem.set(item.id, { rows, endpointRows });
    }
    return records.map((record) => ({
      ...record,
      relationships: Object.fromEntries(relationshipItems.map((item) => {
        const projected = rowsByItem.get(item.id);
        const projectionRows = projected.rows
          .filter((row) => String(row.routed_record_id) === String(record.id));
        const linked = projectionRows
          .map((row) => projected.endpointRows.get(row.opposite_record_id))
          .filter(Boolean)
          .map((endpoint) => ({
            id: endpoint.id,
            kind: item.endpoint.kind,
            custom_object_id: item.endpoint.custom_object_id,
            primary_label: endpoint.primary_label,
            secondary_text: endpoint.secondary_text,
            ...(endpoint.compact_fields ? { compact_fields: endpoint.compact_fields } : {}),
          }))
          .sort((a, b) =>
            String(a.primary_label || '').localeCompare(String(b.primary_label || ''))
            || String(a.id).localeCompare(String(b.id)));
        return [item.id, {
          count: Number(projectionRows[0]?.total_count) || 0,
          records: linked,
        }];
      })),
    }));
  }

  async function validateRecordWrite(objectId, bodyData, existingData = null, mode = 'create') {
    const definitions = await fields(objectId, true);
    const access = await fieldAccess(objectId, definitions);
    const writable = allowedFields(definitions, access, 'edit');
    for (const key of Object.keys(bodyData || {})) {
      const definition = definitions.find((field) => getCustomObjectFieldMetadata(field).key === key);
      if (definition && access.get(String(definition.id)) !== 'edit') {
        throw new CustomObjectHttpError(403, `Field is read-only or unavailable: ${key}`);
      }
    }
    const validation = validateCustomObjectRecordData({
      data: bodyData, fields: writable, existingData, mode,
    });
    if (!validation.ok) throw new CustomObjectHttpError(400, 'Invalid record data', validation.errors);
    return validation;
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

  async function validateRelationshipPreview(definition) {
    const fieldsBySide = {};
    for (const side of ['source', 'target']) {
      fieldsBySide[side] = definition[`${side}_kind`] === 'custom_object'
        ? await fields(definition[`${side}_custom_object_id`])
        : [];
    }
    const validation = validateCustomObjectRelationshipPreviewConfiguration(
      definition.configuration,
      fieldsBySide,
    );
    if (!validation.ok) throw new CustomObjectHttpError(400, 'Invalid compact preview configuration', validation.errors);
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
        const projected = {
          ...row,
          record_count: Number(counts.record_count) || 0,
          field_count: Number(counts.field_count) || 0,
          relationship_count: Number(counts.relationship_count) || 0,
          capabilities: projectCapabilities(row, permissionsByObjectId.get(row.id) || null),
        };
        if (!isAdmin && !canViewSchema && !canManageSchema) {
          delete projected.configuration;
          delete projected.primary_display_field_id;
        }
        return projected;
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
    const presentationValidation = validateCustomObjectPresentationConfiguration(
      payload.configuration, [], [], null,
    );
    if (!presentationValidation.ok) {
      throw new CustomObjectHttpError(400, 'Invalid CRM presentation configuration', presentationValidation.errors);
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
    return { ...(await reconcilePresentation(row)), capabilities };
  }

  async function updateObject(objectId, body, archive = false) {
    requireSchemaManager();
    const before = await object(objectId);
    if (before.status === 'archived') {
      if (archive) return before;
      throw new CustomObjectHttpError(409, 'Archived Custom Objects cannot be modified or reactivated');
    }
    const payload = pick(body, OBJECT_COLUMNS);
    if (payload.configuration !== undefined) {
      const validation = validateCustomObjectViewConfiguration(payload.configuration, await fields(objectId));
      if (!validation.ok) throw new CustomObjectHttpError(400, 'Invalid view configuration', validation.errors);
      await validatePresentation(objectId, payload.configuration);
    }
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
    const access = await fieldAccess(objectId, data || []);
    return {
      data: (data || []).filter((field) => canViewSchema || canManageSchema || access.get(String(field.id)) !== 'none')
        .map((field) => ({ ...field, field_access: access.get(String(field.id)) || 'none' })),
      total: count || 0, page: p.page, pageSize: p.pageSize,
    };
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
    const access = await fieldAccess(objectId, definitions);
    const readableDefinitions = allowedFields(definitions, access);
    const metadata = await recordListMetadata(objectId, readableDefinitions);
    const relationshipQuery = relationshipQuerySpecification(query, metadata);
    const projectionItems = relationshipProjectionItems(query, metadata);
    const p = pagination(query, query?._exportPage === true ? 1000 : 100);
    const rawFilters = parseRecordFilters(query?.filters);
    const scalarFilters = Object.fromEntries(Object.entries(rawFilters)
      .filter(([key]) => !metadata.relationships.some((item) => item.id === key)));
    const scalarQuery = parseRelationshipListKey(query?.sortField)
      ? { ...query, filters: scalarFilters, sortField: 'created_at' }
      : { ...query, filters: scalarFilters };
    const plan = buildRecordQueryPlan(scalarQuery, readableDefinitions);
    let q = db.from('custom_object_record').select('*', { count: 'exact' })
      .eq('tenant_id', tenantId).eq('custom_object_id', objectId);
    if (query?.includeArchived !== 'true') q = q.is('archived_at', null);
    q = applyRecordQueryPlan(q, plan);
    if (relationshipQuery.filters.length > 0 || relationshipQuery.sort) {
      // Relationship predicates must be evaluated before range/count.  Do not
      // fetch an unbounded candidate set into the application process.
      const { data: selection, error } = await db.rpc('custom_object_record_relationship_list', {
        p_tenant_id: tenantId,
        p_custom_object_id: objectId,
        p_include_archived: query?.includeArchived === 'true',
        p_scalar_plan: {
          filters: plan.filters,
          search: plan.search,
          searchable_columns: plan.searchableColumns,
          sort_column: relationshipQuery.sort ? null : plan.sortColumn,
          ascending: plan.ascending,
        },
        p_filters: relationshipQuery.filters.map(({ item, op, values }) => ({
          relationship_definition_id: item.relationship_definition_id,
          side: item.side, op, values,
          endpoint_kind: item.endpoint.kind,
          endpoint_custom_object_id: item.endpoint.custom_object_id,
        })),
        p_sort: relationshipQuery.sort && {
          relationship_definition_id: relationshipQuery.sort.item.relationship_definition_id,
          side: relationshipQuery.sort.item.side,
          mode: relationshipQuery.sort.mode,
          ascending: relationshipQuery.sort.ascending,
          endpoint_kind: relationshipQuery.sort.item.endpoint.kind,
          endpoint_custom_object_id: relationshipQuery.sort.item.endpoint.custom_object_id,
          display_key: relationshipQuery.sort.item.endpoint.display_field?.key || null,
        },
        p_offset: p.from,
        p_limit: p.pageSize,
      });
      throwRelationshipListRpcDb(error);
      const selected = selection || [];
      const ids = selected.map((row) => row.record_id).filter(Boolean);
      // The RPC owns relationship filtering, ordering, exact count and range.
      // This bounded projection only loads the selected record page.
      let pageData = [];
      if (ids.length > 0) {
        let pageQuery = db.from('custom_object_record').select('*')
          .eq('tenant_id', tenantId).eq('custom_object_id', objectId).in('id', ids);
        if (query?.includeArchived !== 'true') pageQuery = pageQuery.is('archived_at', null);
        const pageResult = await pageQuery;
        throwDb(pageResult.error);
        pageData = pageResult.data || [];
      }
      const pageById = new Map((pageData || []).map((row) => [String(row.id), row]));
      const pageRows = ids.map((id) => pageById.get(String(id))).filter(Boolean)
        .map((record) => projectRecord(definition, record, definitions, access));
      return {
        data: await projectListRelationships(pageRows, projectionItems),
        total: Number(selected[0]?.total_count) || 0,
        page: p.page,
        pageSize: p.pageSize,
        metadata,
      };
    }
    const { data, error, count } = await q.range(p.from, p.to);
    throwDb(error);
    const projected = (data || []).map((record) =>
      projectRecord(definition, record, definitions, access));
    return {
      data: await projectListRelationships(projected, projectionItems),
      total: count || 0, page: p.page, pageSize: p.pageSize,
      metadata,
    };
  }

  // Export pages are bounded per request, while clients paginate to the exact
  // filtered total. This avoids both oversized responses and silent truncation.
  async function exportRecords(objectId, query) {
    await requireCapability(objectId, 'export_records');
    const definitions = await fields(objectId);
    const access = await fieldAccess(objectId, definitions);
    const readable = allowedFields(definitions, access);
    const requestedPage = Number.parseInt(query?.page, 10);
    const requestedPageSize = Number.parseInt(query?.pageSize, 10);
    const page = Math.max(Number.isFinite(requestedPage) ? requestedPage : 1, 1);
    const pageSize = Math.min(Math.max(Number.isFinite(requestedPageSize) ? requestedPageSize : 500, 1), 1000);
    // listRecords intentionally protects interactive requests at 100 rows;
    // export is the sole 1,000-row bounded transport contract.
    const listed = await listRecords(objectId, { ...query, page, pageSize, _exportPage: true });
    return {
      columns: readable.map((field) => {
        const metadata = getCustomObjectFieldMetadata(field);
        return { field_id: field.id, key: metadata.key, label: metadata.label, field_type: metadata.type };
      }),
      relationship_columns: listed.metadata.relationships,
      metadata: listed.metadata,
      data: listed.data.map((projected) => ({
          id: projected.id,
          display_value: projected.display_value,
          created_at: projected.created_at,
          updated_at: projected.updated_at,
          data: projected.data,
          relationships: projected.relationships,
        })),
      total: listed.total,
      page,
      pageSize,
    };
  }

  async function relationshipFilterOptions(objectId, query = {}) {
    await object(objectId);
    await requireCapability(objectId, 'view_records');
    const definitions = await fields(objectId);
    const access = await fieldAccess(objectId, definitions);
    const metadata = await recordListMetadata(objectId, allowedFields(definitions, access));
    const fieldId = query.fieldId ?? query.field_id;
    const item = metadata.relationships.find((relationship) => relationship.id === fieldId);
    if (!item) queryError('Unknown or inaccessible relationship list field');

    const kind = item.endpoint.kind;
    const customObjectId = item.endpoint.custom_object_id;
    const table = {
      custom_object: 'custom_object_record',
      member: 'member',
      organization: 'organization',
      organization_group: 'organization_group',
    }[kind];
    if (!table) queryError('Unsupported relationship endpoint kind');

    let selectedIds = [];
    if (query.selected !== undefined && query.selected !== '') {
      try {
        selectedIds = Array.isArray(query.selected) ? query.selected : JSON.parse(query.selected);
      } catch {
        queryError('selected must be a JSON array');
      }
      if (
        !Array.isArray(selectedIds)
        || selectedIds.length > 50
        || selectedIds.some((id) => typeof id !== 'string' || id.trim() === '')
      ) {
        queryError('selected must contain at most 50 record IDs');
      }
      selectedIds = [...new Set(selectedIds)];
    }
    const p = pagination(query);
    const endpointQuery = (withCount = false) => {
      let endpoint = db.from(table).select('*', withCount ? { count: 'exact' } : {})
        .eq('tenant_id', tenantId);
      if (kind === 'custom_object') {
        endpoint = endpoint.eq('custom_object_id', customObjectId).is('archived_at', null);
      }
      return endpoint;
    };
    let q = endpointQuery(true);
    const search = typeof query.search === 'string' ? query.search.trim() : '';
    if (search) {
      const pattern = quotePostgrestValue(`*${search}*`);
      if (kind === 'member') {
        q = q.or(`first_name.ilike.${pattern},last_name.ilike.${pattern},email.ilike.${pattern}`);
      } else if (kind === 'custom_object') {
        const key = item.endpoint.display_field?.key;
        if (!key) {
          return { data: [], total: 0, page: p.page, pageSize: p.pageSize };
        }
        q = q.filter(`data->>${key}`, 'ilike', `*${search}*`);
      } else {
        q = q.ilike('name', `%${search}%`);
      }
    }
    q = q.order(
      kind === 'member' ? 'last_name' : (kind === 'custom_object' ? 'created_at' : 'name'),
      { ascending: true },
    ).order('id', { ascending: true });
    const selectedQuery = selectedIds.length
      ? endpointQuery().in('id', selectedIds)
      : Promise.resolve({ data: [], error: null });
    const [{ data, error, count }, selectedResult] = await Promise.all([
      q.range(p.from, p.to),
      selectedQuery,
    ]);
    throwDb(error);
    throwDb(selectedResult.error);

    let endpointDefinition = null;
    let endpointFields = [];
    let endpointAccess = null;
    if (kind === 'custom_object') {
      endpointDefinition = await activeObject(customObjectId);
      endpointFields = await fields(customObjectId, true);
      endpointAccess = await fieldAccess(customObjectId, endpointFields);
    }
    const rows = [];
    const seen = new Set();
    for (const row of [...(selectedResult.data || []), ...(data || [])]) {
      if (!seen.has(String(row.id))) {
        seen.add(String(row.id));
        rows.push(row);
      }
    }
    return {
      data: rows.map((row) => ({
        id: row.id,
        kind,
        custom_object_id: customObjectId,
        ...endpointLabel(kind, row, endpointDefinition, endpointFields, endpointAccess),
      })),
      total: count || 0,
      page: p.page,
      pageSize: p.pageSize,
    };
  }

  async function createRecord(objectId, body) {
    const definition = await object(objectId);
    await requireCapability(objectId, 'create_records');
    if (definition.status !== 'active') {
      throw new CustomObjectHttpError(409, 'Records can only be created for active Custom Objects');
    }
    const validation = await validateRecordWrite(objectId, body?.data, null, 'create');
    const payload = { tenant_id: tenantId, custom_object_id: objectId, data: validation.data, ...authored('created'), ...authored() };
    const { data, error } = await db.from('custom_object_record').insert(payload).select('*').single();
    throwDb(error);
    return data;
  }

  // Creates the record and all of its first edges in one database transaction.
  // The relationship entries are deliberately expressed from the new record's
  // routed side: this works equally for a Custom Object on either definition
  // side and avoids accepting client-supplied source/target identities.
  async function createRecordWithRelationships(objectId, body = {}) {
    const definition = await activeObject(objectId, 'Records can only be created for active Custom Objects');
    await requireCapability(objectId, 'create_records');
    const validation = await validateRecordWrite(objectId, body.data, null, 'create');
    if (typeof db.rpc !== 'function') {
      throw new CustomObjectHttpError(503, 'Record relationship transaction is unavailable');
    }

    const originating = body.originating_relationship ?? body.originatingRelationship ?? null;
    const additional = body.initial_relationships ?? body.initialRelationships ?? body.relationships ?? [];
    if (originating !== null && (!originating || typeof originating !== 'object' || Array.isArray(originating))) {
      throw new CustomObjectHttpError(400, 'originating_relationship must be an object');
    }
    if (!Array.isArray(additional)) {
      throw new CustomObjectHttpError(400, 'initial_relationships must be an array');
    }
    const entries = [...(originating ? [{ ...originating, _originating: true }] : []), ...additional];
    const seen = new Set();
    const relationships = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new CustomObjectHttpError(400, 'Each initial relationship must be an object');
      }
      const relationshipDefinitionId = entry.relationship_definition_id ?? entry.relationshipDefinitionId;
      const relatedRecordId = entry.related_record_id ?? entry.relatedRecordId;
      if (!relationshipDefinitionId || !relatedRecordId) {
        throw new CustomObjectHttpError(400, 'Each initial relationship requires relationship_definition_id and related_record_id');
      }
      const relationship = await one('custom_object_relationship_definition', relationshipDefinitionId);
      if (relationship.status !== 'active') throw new CustomObjectHttpError(409, 'Relationship definition is not active');
      const matchingSides = ['source', 'target'].filter((side) =>
        relationship[`${side}_kind`] === 'custom_object'
        && relationship[`${side}_custom_object_id`] === objectId);
      const side = entry.routed_side ?? entry.routedSide ?? (matchingSides.length === 1 ? matchingSides[0] : null);
      if (!['source', 'target'].includes(side) || !matchingSides.includes(side)) {
        throw new CustomObjectHttpError(400, 'routed_side must identify the new record side of the relationship');
      }
      // An originating edge is initiated from the existing card, not the new
      // record.  `routed_side` still describes where the new row belongs.
      const initiatedSide = entry._originating ? (side === 'source' ? 'target' : 'source') : side;
      if (relationship[`show_on_${initiatedSide}`] === false) {
        throw new CustomObjectHttpError(403, 'This relationship is hidden on the routed side');
      }
      if (relationship[`edit_from_${initiatedSide}`] === false) {
        throw new CustomObjectHttpError(403, 'This relationship cannot be edited from the routed side');
      }
      await requireRelationshipCapabilities(relationship, 'edit_records');
      const relatedSide = side === 'source' ? 'target' : 'source';
      const related = await endpoint(relationship[`${relatedSide}_kind`], relatedRecordId);
      domainGuard(() => validateCustomObjectRelationshipEndpoints({
        tenantId,
        definition: relationship,
        source: side === 'source'
          ? { tenant_id: tenantId, kind: 'custom_object', custom_object_id: objectId, archived_at: null }
          : related,
        target: side === 'target'
          ? { tenant_id: tenantId, kind: 'custom_object', custom_object_id: objectId, archived_at: null }
          : related,
      }));
      const key = `${relationshipDefinitionId}:${side}:${relatedRecordId}`;
      if (seen.has(key)) throw new CustomObjectHttpError(400, 'Initial relationships must not contain duplicates');
      seen.add(key);
      relationships.push({
        relationship_definition_id: relationshipDefinitionId,
        routed_side: side,
        related_record_id: relatedRecordId,
        originating: entry._originating === true,
      });
    }
    const { data, error } = await db.rpc('create_custom_object_record_with_relationships', {
      p_tenant_id: tenantId,
      p_custom_object_id: objectId,
      p_data: validation.data,
      p_relationships: relationships,
      p_created_by: currentActorReference,
    }).single();
    throwAtomicCreateDb(error);
    return data;
  }

  async function initialRelationshipCandidates(objectId, query = {}) {
    await activeObject(objectId, 'Initial relationship candidates are only available for active Custom Objects');
    await requireCapability(objectId, 'create_records');
    const definitionId = query.definitionId;
    const side = query.newRecordSide ?? query.new_record_side ?? query.side;
    if (!definitionId || !['source', 'target'].includes(side)) {
      throw new CustomObjectHttpError(400, 'definitionId and newRecordSide are required');
    }
    const definition = await one('custom_object_relationship_definition', definitionId);
    if (definition.status !== 'active') throw new CustomObjectHttpError(409, 'Relationship definition is not active');
    if (
      definition[`${side}_kind`] !== 'custom_object'
      || definition[`${side}_custom_object_id`] !== objectId
    ) {
      throw new CustomObjectHttpError(400, 'newRecordSide does not match the new Custom Object');
    }
    if (definition[`show_on_${side}`] === false || definition[`edit_from_${side}`] === false) {
      throw new CustomObjectHttpError(403, 'This relationship is not visible and editable from the new record side');
    }
    await requireRelationshipCapabilities(definition, 'edit_records');
    const candidateSide = side === 'source' ? 'target' : 'source';
    const kind = definition[`${candidateSide}_kind`];
    const table = {
      custom_object: 'custom_object_record', member: 'member',
      organization: 'organization', organization_group: 'organization_group',
    }[kind];
    if (!table) throw new CustomObjectHttpError(400, 'Unsupported relationship endpoint kind');
    const customObjectId = kind === 'custom_object' ? definition[`${candidateSide}_custom_object_id`] : null;
    let endpointDefinition = null;
    let endpointFields = [];
    let endpointAccess = null;
    if (kind === 'custom_object') {
      endpointDefinition = await activeObject(customObjectId);
      await requireCapability(customObjectId, 'view_records');
      endpointFields = await fields(customObjectId, true);
      endpointAccess = await fieldAccess(customObjectId, endpointFields);
    }
    const p = pagination(query);
    let q = db.from(table).select('*', { count: 'exact' }).eq('tenant_id', tenantId);
    if (kind === 'custom_object') q = q.eq('custom_object_id', customObjectId).is('archived_at', null);
    const search = typeof query.search === 'string' ? query.search.trim() : '';
    if (search) {
      if (kind === 'member') {
        const pattern = quotePostgrestValue(`*${search}*`);
        q = q.or(`first_name.ilike.${pattern},last_name.ilike.${pattern},email.ilike.${pattern}`);
      } else if (kind !== 'custom_object') q = q.ilike('name', `%${search}%`);
      else {
        const primary = endpointFields.find((field) => field.id === endpointDefinition.primary_display_field_id
          && endpointAccess.get(String(field.id)) !== 'none');
        const key = getCustomObjectFieldMetadata(primary).key;
        if (key) q = q.filter(`data->>${key}`, 'ilike', `*${search}*`);
      }
    }
    // There is no routed record yet: only candidates whose own cardinality is
    // already full are excluded. Passing an impossible id avoids considering
    // routed saturation while retaining the shared generic calculation.
    q = applyPickerExclusions(q, await pickerExcludedRecordIds(definition, side, '__new_record__'));
    q = q.order(kind === 'member' ? 'last_name' : (kind === 'custom_object' ? 'created_at' : 'name'), { ascending: true })
      .order('id', { ascending: true });
    const { data, error, count } = await q.range(p.from, p.to);
    throwDb(error);
    return {
      data: (data || []).map((row) => ({
        id: row.id, kind, custom_object_id: customObjectId,
        ...endpointLabel(
          kind, row, endpointDefinition, endpointFields, endpointAccess,
          configuredCompactPreviewFieldIds(definition, candidateSide),
        ),
      })),
      total: count || 0, page: p.page, pageSize: p.pageSize,
    };
  }

  async function getRecord(objectId, recordId) {
    const definition = await object(objectId);
    await requireCapability(objectId, 'view_records');
    const record = await one('custom_object_record', recordId, { custom_object_id: objectId });
    const definitions = await fields(objectId);
    return projectRecord(definition, record, definitions, await fieldAccess(objectId, definitions));
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
      const validation = await validateRecordWrite(objectId, body?.data, before.data, 'update');
      payload = { data: validation.data, ...authored() };
    }
    const { data, error } = await db.from('custom_object_record').update(payload)
      .eq('tenant_id', tenantId).eq('custom_object_id', objectId).eq('id', recordId)
      .select('*').single();
    throwDb(error);
    const definitions = await fields(objectId);
    return projectRecord(definition, data, definitions, await fieldAccess(objectId, definitions));
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
    await validateRelationshipPreview(payload);
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
    await validateRelationshipPreview(candidate);
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

  function endpointLabel(kind, row, definition = null, endpointFields = [], access = null, previewFieldIds = []) {
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
    const readableFields = access ? allowedFields(endpointFields, access) : endpointFields;
    const preview = previewFieldIds.map(String)
      .map((id) => readableFields.find((field) => String(field.id) === id))
      .filter(Boolean)
      .map((field) => {
        const metadata = getCustomObjectFieldMetadata(field);
        return { field_id: field.id, key: metadata.key, label: metadata.label, value: row.data?.[metadata.key] ?? null };
      });
    return {
      primary_label: resolveCustomObjectDisplayValue({
        objectDefinition: definition, record: row, fields: readableFields,
      }),
      secondary_text: preview.map((item) => String(item.value ?? '')).filter(Boolean).join(' · ') || null,
      compact_fields: preview,
    };
  }

  function configuredCompactPreviewFieldIds(definition, side) {
    const preview = definition?.configuration?.compact_preview
      ?? definition?.configuration?.compact_preview_fields
      ?? {};
    const ids = preview[`${side}_field_ids`] ?? preview[side] ?? [];
    return Array.isArray(ids) ? ids : [];
  }

  async function resolveEndpointRows(kind, customObjectId, ids, { includeArchived = false, previewFieldIds = [] } = {}) {
    const uniqueIds = [...new Set(ids.filter(Boolean))];
    if (uniqueIds.length === 0) return new Map();
    const table = {
      custom_object: 'custom_object_record', member: 'member',
      organization: 'organization', organization_group: 'organization_group',
    }[kind];
    if (!table) throw new CustomObjectHttpError(400, 'Unsupported relationship endpoint kind');
    let endpointDefinition = null;
    let endpointFields = [];
    let endpointAccess = null;
    if (kind === 'custom_object') {
      endpointDefinition = includeArchived
        ? await object(customObjectId)
        : await activeObject(customObjectId);
      await requireCapability(customObjectId, 'view_records');
      endpointFields = await fields(customObjectId, true);
      endpointAccess = await fieldAccess(customObjectId, endpointFields);
    }
    const rows = [];
    for (let offset = 0; offset < uniqueIds.length; offset += ENDPOINT_ID_BATCH_SIZE) {
      const batchIds = uniqueIds.slice(offset, offset + ENDPOINT_ID_BATCH_SIZE);
      let q = db.from(table).select('*').eq('tenant_id', tenantId).in('id', batchIds);
      if (kind === 'custom_object') {
        q = q.eq('custom_object_id', customObjectId);
        if (!includeArchived) q = q.is('archived_at', null);
      }
      const { data, error } = await q;
      throwDb(error);
      rows.push(...(data || []));
    }
    return new Map(rows.map((row) => {
      const labels = endpointLabel(kind, row, endpointDefinition, endpointFields, endpointAccess, previewFieldIds);
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
      || !['one_to_many', 'many_to_many'].includes(definition.cardinality)) {
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

  // The relationship trigger remains the authority for cardinality, but a
  // picker must not offer a choice that the trigger will necessarily reject.
  // Read active edges once so this works identically for Custom Object and
  // every core endpoint table.
  async function pickerExcludedRecordIds(definition, routedSide, routedRecordId) {
    const candidateSide = routedSide === 'source' ? 'target' : 'source';
    const routedHasSingleEdge = routedSide === 'source'
      ? ['one_to_one', 'many_to_one'].includes(definition.cardinality)
      : ['one_to_one', 'one_to_many'].includes(definition.cardinality);
    const candidateHasSingleEdge = candidateSide === 'source'
      ? ['one_to_one', 'many_to_one'].includes(definition.cardinality)
      : ['one_to_one', 'one_to_many'].includes(definition.cardinality);
    const excluded = new Set();
    let routedSaturated = false;
    for (let from = 0;; from += 1000) {
      const { data, error } = await db.from('custom_object_relationship')
        .select('source_record_id, target_record_id')
        .eq('tenant_id', tenantId)
        .eq('relationship_definition_id', definition.id)
        .is('archived_at', null)
        .order('id', { ascending: true })
        .range(from, from + 999);
      throwDb(error);
      const edges = data || [];
      for (const edge of edges) {
        // A duplicate pair is never useful, including for many-to-many.
        if (edge[`${routedSide}_record_id`] === routedRecordId) {
          excluded.add(edge[`${candidateSide}_record_id`]);
          if (routedHasSingleEdge) routedSaturated = true;
        }
        // Only exclude candidates whose own endpoint has reached its limit.
        if (candidateHasSingleEdge) excluded.add(edge[`${candidateSide}_record_id`]);
      }
      if (edges.length < 1000) return { excluded, routedSaturated };
    }
  }

  function applyPickerExclusions(q, eligibility) {
    if (eligibility.excluded.size === 0) return q;
    return q.not('id', 'in', `(${[...eligibility.excluded].map(quotePostgrestValue).join(',')})`);
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
    const eligibility = await pickerExcludedRecordIds(definition, side, recordId);
    if (eligibility.routedSaturated) {
      return { data: [], total: 0, page: p.page, pageSize: p.pageSize };
    }
    q = applyPickerExclusions(q, eligibility);
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
    const pickerScope = await configuredPickerScope(definition, null, target.id);
    if (pickerScope && !pickerScope.sourceRecordIds.includes(source.id)) {
      throw new CustomObjectHttpError(400, 'Related record is outside the configured picker scope');
    }
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
    let endpointAccess = null;
    if (kind === 'custom_object') {
      endpointDefinition = await activeObject(customObjectId);
      await requireCapability(customObjectId, 'view_records');
      endpointFields = await fields(customObjectId, true);
      endpointAccess = await fieldAccess(customObjectId, endpointFields);
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
        const primary = endpointFields.find((field) => field.id === endpointDefinition.primary_display_field_id
          && endpointAccess.get(String(field.id)) !== 'none');
        const key = getCustomObjectFieldMetadata(primary).key;
        if (key) q = q.filter(`data->>${key}`, 'ilike', `*${search}*`);
      }
    }
    const eligibility = await pickerExcludedRecordIds(definition, side, recordId);
    if (eligibility.routedSaturated) {
      return { data: [], total: 0, page: p.page, pageSize: p.pageSize };
    }
    q = applyPickerExclusions(q, eligibility);
    q = q.order(kind === 'member' ? 'last_name' : (kind === 'custom_object' ? 'created_at' : 'name'), { ascending: true })
      .order('id', { ascending: true });
    const { data, error, count } = await q.range(p.from, p.to);
    throwDb(error);
    return {
      data: (data || []).map((row) => ({
        id: row.id,
        kind,
        custom_object_id: kind === 'custom_object' ? customObjectId : null,
        ...endpointLabel(
          kind, row, endpointDefinition, endpointFields, endpointAccess,
          configuredCompactPreviewFieldIds(definition, oppositeSide),
        ),
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
      {
        includeArchived,
        previewFieldIds: configuredCompactPreviewFieldIds(definition, relatedSide),
      },
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
    if (definition[`show_on_${routedSide}`] === false) {
      throw new CustomObjectHttpError(403, 'This relationship is hidden on the routed side');
    }
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
    const pickerScope = await configuredPickerScope(definition, null, target.id);
    if (pickerScope && !pickerScope.sourceRecordIds.includes(source.id)) {
      throw new CustomObjectHttpError(400, 'Related record is outside the configured picker scope');
    }
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
    if (definition[`show_on_${routedSide}`] === false) {
      throw new CustomObjectHttpError(403, 'This relationship is hidden on the routed side');
    }
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
      db.from('role').select('id,name,is_system')
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

  async function listFieldPermissions(objectId, query) {
    requireSchemaViewer();
    await object(objectId);
    const p = pagination(query);
    let q = db.from('custom_object_field_role_permission').select('*', { count: 'exact' })
      .eq('tenant_id', tenantId).eq('custom_object_id', objectId)
      .order('created_at', { ascending: false }).order('id', { ascending: false });
    if (query?.roleId) q = q.eq('role_id', query.roleId);
    const { data, error, count } = await q.range(p.from, p.to);
    throwDb(error);
    return { data: data || [], total: count || 0, page: p.page, pageSize: p.pageSize };
  }

  async function upsertFieldPermission(objectId, body) {
    requireSchemaManager();
    requireMutableObject(await object(objectId));
    if (!body?.role_id || !body?.field_id) {
      throw new CustomObjectHttpError(400, 'role_id and field_id are required');
    }
    const accessLevel = body.access_level ?? body.access;
    if (!['none', 'read', 'edit'].includes(accessLevel)) {
      throw new CustomObjectHttpError(400, 'access_level must be none, read, or edit');
    }
    await one('role', body.role_id);
    await one('preference_field', body.field_id, { custom_object_id: objectId });
    const payload = {
      tenant_id: tenantId, custom_object_id: objectId, field_id: body.field_id,
      role_id: body.role_id, access_level: accessLevel, ...authored('created'), ...authored(),
    };
    const { data, error } = await db.from('custom_object_field_role_permission')
      .upsert(payload, { onConflict: 'tenant_id,custom_object_id,field_id,role_id' }).select('*').single();
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
    updateField, listRecords, exportRecords, relationshipFilterOptions, createRecord, createRecordWithRelationships, initialRelationshipCandidates, getRecord, updateRecord,
    listRelationshipDefinitions, createRelationshipDefinition,
    updateRelationshipDefinition, entityPicker, listRelationships, createRelationship,
    archiveRelationship, listPermissions, upsertPermission, listFieldPermissions, upsertFieldPermission, listAudit,
    listCoreRelationshipDefinitions, listCoreRelationships, coreEntityPicker,
    createCoreRelationship, archiveCoreRelationship,
  };
}