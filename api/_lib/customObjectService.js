import {
  CustomObjectDomainError,
  assertImmutableInternalKey,
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
  'selected_countries', 'allowed_file_types', 'display_order',
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
  if (error) throw new CustomObjectHttpError(500, error.message || fallback);
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
  now = () => new Date().toISOString(),
}) {
  if (!context?.isAuthenticated) throw new CustomObjectHttpError(401, 'Authentication required');
  if (context.tenantMismatch) throw new CustomObjectHttpError(409, 'Tenant context mismatch');
  if (!context.tenantId) throw new CustomObjectHttpError(400, 'Tenant context not found');
  if (!db) throw new CustomObjectHttpError(503, 'Database unavailable');

  const tenantId = context.tenantId;
  const currentActor = actor(context);
  const authored = (kind = 'updated') => ({ [`${kind}_by`]: currentActor.id });

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

  async function hasCapability(objectId, capability) {
    if (!isAdmin) {
      const definition = await object(objectId);
      if (definition.status !== 'active') {
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

  function requireAdmin() {
    if (!isAdmin) throw new CustomObjectHttpError(403, 'Administrator access required');
  }

  async function listObjects(query) {
    const p = pagination(query);
    let allowedObjectIds = null;
    if (!isAdmin) {
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
    if (!isAdmin) q = q.eq('status', 'active');
    else if (query?.includeArchived !== 'true') q = q.neq('status', 'archived');
    const { data, error, count } = await q.range(p.from, p.to);
    throwDb(error);
    return {
      data: data || [],
      total: count || 0,
      page: p.page,
      pageSize: p.pageSize,
    };
  }

  async function createObject(body) {
    requireAdmin();
    const payload = {
      ...pick(body, OBJECT_COLUMNS), tenant_id: tenantId, status: body?.status || 'draft',
      configuration: body?.configuration || {}, ...authored('created'), ...authored(),
    };
    if (payload.status !== 'draft') {
      Object.assign(payload, domainGuard(() => resolveCustomObjectLifecycleUpdate({
        currentStatus: 'draft', nextStatus: payload.status,
        hasPrimaryDisplayField: Boolean(payload.primary_display_field_id), now: now(),
      })));
    }
    const { data, error } = await db.from('custom_object_definition').insert(payload).select('*').single();
    throwDb(error);
    return data;
  }

  async function getObject(objectId) {
    const row = await object(objectId);
    await requireCapability(objectId, 'view_records');
    return row;
  }

  async function updateObject(objectId, body, archive = false) {
    requireAdmin();
    const before = await object(objectId);
    const payload = pick(body, OBJECT_COLUMNS);
    if (payload.object_key !== undefined) domainGuard(() => assertImmutableInternalKey(before.object_key, payload.object_key, 'Object key'));
    const nextStatus = archive ? 'archived' : (payload.status || before.status);
    if (archive || payload.status !== undefined) {
      Object.assign(payload, domainGuard(() => resolveCustomObjectLifecycleUpdate({
        currentStatus: before.status, nextStatus, currentArchivedAt: before.archived_at,
        hasPrimaryDisplayField: Boolean(payload.primary_display_field_id ?? before.primary_display_field_id),
        now: now(),
      })));
      if (nextStatus === 'archived') payload.archived_by = currentActor.id;
    }
    Object.assign(payload, authored());
    const { data, error } = await db.from('custom_object_definition').update(payload)
      .eq('tenant_id', tenantId).eq('id', objectId).select('*').single();
    throwDb(error);
    return data;
  }

  async function listFields(objectId, query) {
    await object(objectId);
    await requireCapability(objectId, 'view_records');
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
    requireAdmin();
    await object(objectId);
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
    requireAdmin();
    await object(objectId);
    const before = await one('preference_field', fieldId, { custom_object_id: objectId });
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
    let q = db.from('custom_object_record').select('*', { count: 'exact' })
      .eq('tenant_id', tenantId).eq('custom_object_id', objectId)
      .order('created_at', { ascending: false });
    if (query?.includeArchived !== 'true') q = q.is('archived_at', null);
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
    await object(objectId);
    await requireCapability(objectId, 'create_records');
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
    await object(objectId);
    await requireCapability(objectId, archive ? 'archive_records' : 'edit_records');
    const before = await one('custom_object_record', recordId, { custom_object_id: objectId });
    let payload;
    if (archive) {
      payload = { archived_at: before.archived_at || now(), archived_by: currentActor.id, archive_reason: body?.archive_reason || null, ...authored() };
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
    await requireCapability(objectId, 'view_records');
    const p = pagination(query);
    let q = db.from('custom_object_relationship_definition').select('*', { count: 'exact' })
      .eq('tenant_id', tenantId)
      .or(`source_custom_object_id.eq.${objectId},target_custom_object_id.eq.${objectId}`)
      .order('created_at', { ascending: false });
    if (query?.includeArchived !== 'true') q = q.neq('status', 'archived');
    const { data, error, count } = await q.range(p.from, p.to);
    throwDb(error);
    let visible = data || [];
    if (!isAdmin) {
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
    requireAdmin();
    await object(objectId);
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
    requireAdmin();
    await object(objectId);
    const before = await one('custom_object_relationship_definition', id);
    if (before.source_custom_object_id !== objectId && before.target_custom_object_id !== objectId) throw new CustomObjectHttpError(404, 'Resource not found');
    const payload = pick(body, RELATIONSHIP_DEFINITION_COLUMNS);
    if (payload.relationship_key !== undefined) domainGuard(() => assertImmutableInternalKey(before.relationship_key, payload.relationship_key, 'Relationship key'));
    if (archive || payload.status !== undefined) Object.assign(payload, domainGuard(() => resolveCustomObjectLifecycleUpdate({
      currentStatus: before.status, nextStatus: archive ? 'archived' : payload.status,
      currentArchivedAt: before.archived_at, hasPrimaryDisplayField: true, now: now(),
    })));
    if ((payload.status || (archive && 'archived')) === 'archived') payload.archived_by = currentActor.id;
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
      .update({ archived_at: before.archived_at || now(), archived_by: currentActor.id })
      .eq('tenant_id', tenantId).eq('id', id).select('*').single();
    throwDb(error);
    return data;
  }

  async function listPermissions(objectId, query) {
    requireAdmin();
    await object(objectId);
    const p = pagination(query);
    const { data, error, count } = await db.from('custom_object_role_permission')
      .select('*', { count: 'exact' }).eq('tenant_id', tenantId)
      .eq('custom_object_id', objectId).order('created_at', { ascending: false })
      .range(p.from, p.to);
    throwDb(error);
    return { data: data || [], total: count || 0, page: p.page, pageSize: p.pageSize };
  }

  async function upsertPermission(objectId, body) {
    requireAdmin();
    await object(objectId);
    if (!body?.role_id) throw new CustomObjectHttpError(400, 'role_id is required');
    await one('role', body.role_id);
    const payload = {
      tenant_id: tenantId, custom_object_id: objectId, role_id: body.role_id,
      ...pick(body, PERMISSION_COLUMNS), ...authored('created'), ...authored(),
    };
    const { data, error } = await db.from('custom_object_role_permission')
      .upsert(payload, { onConflict: 'tenant_id,custom_object_id,role_id' }).select('*').single();
    throwDb(error);
    return data;
  }

  async function listAudit(objectId, query) {
    requireAdmin();
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