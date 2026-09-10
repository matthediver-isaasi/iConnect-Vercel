import {
  getCustomObjectFieldMetadata,
  resolveCustomObjectDisplayValue,
  resolveCustomObjectFieldAccess,
  resolveCustomObjectPermission,
} from './customObjectDomain.js';

export const CUSTOM_OBJECT_DIRECTORY_PAGE_SIZE = 25;
const QUERY_ID_CHUNK_SIZE = 200;
const QUERY_PAGE_SIZE = 500;
const MAX_QUERY_PAGES = 100;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const SOURCE_RE = new RegExp(`^object-field:(${UUID}):(source|target):(${UUID}):(${UUID})$`, 'i');

export class CustomObjectDirectoryError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function customObjectDirectorySourceKey({
  relationshipId, direction, objectId, fieldId,
}) {
  if (![relationshipId, objectId, fieldId].every((value) => new RegExp(`^${UUID}$`, 'i').test(String(value)))
    || !['source', 'target'].includes(direction)) {
    throw new TypeError('Invalid custom object directory source');
  }
  return `object-field:${relationshipId}:${direction}:${objectId}:${fieldId}`;
}

export function parseCustomObjectDirectorySourceKey(key) {
  const match = SOURCE_RE.exec(String(key || ''));
  return match ? {
    relationshipId: match[1],
    direction: match[2],
    objectId: match[3],
    fieldId: match[4],
  } : null;
}

export function encodeCustomObjectDirectoryCursor(recordId) {
  return Buffer.from(String(recordId), 'utf8').toString('base64url');
}

export function decodeCustomObjectDirectoryCursor(cursor) {
  if (!cursor) return null;
  try {
    const value = Buffer.from(String(cursor), 'base64url').toString('utf8');
    return new RegExp(`^${UUID}$`, 'i').test(value) ? value : null;
  } catch {
    return null;
  }
}

function configuredDirectorySources(definitions) {
  const output = [];
  const seen = new Set();
  for (const definition of definitions || []) {
    const config = definition?.configuration?.views?.organisation_directory;
    if (!config || config.enabled !== true || !Array.isArray(config.relationships)
      || !Array.isArray(config.field_ids)) continue;
    const fields = new Set(config.field_ids.map(String));
    for (const relationship of config.relationships) {
      if (!relationship || !['source', 'target'].includes(relationship.direction)) continue;
      for (const fieldId of fields) {
        const relationshipId = String(relationship.relationship_id || '');
        const key = `${relationshipId}:${relationship.direction}:${definition.id}:${fieldId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        output.push({
          definition,
          relationshipId,
          direction: relationship.direction,
          fieldId,
        });
      }
    }
  }
  return output;
}

function parseArray(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string' && item);
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string' && item) : [];
  } catch {
    return [];
  }
}

async function rows(query, message) {
  const { data, error } = await query;
  if (error) throw new Error(message || error.message);
  return data || [];
}

async function one(query, message) {
  const result = await query;
  if (result.error) throw new Error(message || result.error.message);
  return result.data || null;
}

async function chunkedRows(ids, buildQuery) {
  const output = [];
  for (let offset = 0; offset < ids.length; offset += QUERY_ID_CHUNK_SIZE) {
    output.push(...await rows(buildQuery(ids.slice(offset, offset + QUERY_ID_CHUNK_SIZE))));
  }
  return output;
}

async function pagedRows(buildQuery) {
  const output = [];
  for (let page = 0; page < MAX_QUERY_PAGES; page += 1) {
    const offset = page * QUERY_PAGE_SIZE;
    const batch = await rows(buildQuery().range(offset, offset + QUERY_PAGE_SIZE - 1));
    output.push(...batch);
    if (batch.length < QUERY_PAGE_SIZE) return output;
  }
  throw new Error('Custom Object directory metadata exceeds the supported inventory size');
}

async function resolveDirectory({ db, context, directoryId, settings, featureCheck, settingsCheck }) {
  const isDirectoryAdmin = settings && await settingsCheck(context, directoryId || 'main');
  if (settings && !isDirectoryAdmin) throw new CustomObjectDirectoryError(403, 'Directory settings access denied');

  if (!directoryId || directoryId === 'main') {
    if (!isDirectoryAdmin) {
      const allowed = context.tenantUserId || (context.roleId
        && await featureCheck(context.roleId, 'membership.organisation-directory'));
      if (!allowed) throw new CustomObjectDirectoryError(403, 'Directory access denied');
    }
    return { id: 'main', entity_type: 'organization', isDirectoryAdmin };
  }

  const directory = await one(db.from('dynamic_directory')
    .select('id, entity_type, allowed_role_ids, filter_field_id, filter_value, is_active')
    .eq('tenant_id', context.tenantId).eq('id', directoryId)
    .eq('is_active', true).maybeSingle(), 'Failed to look up directory');
  if (!directory || directory.entity_type !== 'organization') {
    throw new CustomObjectDirectoryError(404, 'Organisation directory not found');
  }
  if (!isDirectoryAdmin && !context.tenantUserId) {
    const allowedRoles = parseArray(directory.allowed_role_ids);
    if (!context.roleId || (allowedRoles.length && !allowedRoles.includes(context.roleId))) {
      throw new CustomObjectDirectoryError(403, 'Directory access denied');
    }
  }
  return { ...directory, isDirectoryAdmin };
}

async function settingArray(db, tenantId, key) {
  const settings = await rows(db.from('system_settings').select('setting_value')
    .eq('tenant_id', tenantId).eq('setting_key', key).limit(1));
  return parseArray(settings[0]?.setting_value);
}

function booleanCanonical(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim().toLowerCase();
  if (['true', 'yes', '1'].includes(normalized)) return 'true';
  if (['false', 'no', '0'].includes(normalized)) return 'false';
  return null;
}

// Kept equivalent to dynamic-directory/members.js so this projection cannot
// broaden the source directory's saved-field eligibility.
export function matchesDirectoryValue(storedValue, filterValue) {
  if (Array.isArray(filterValue)) {
    return filterValue.some((candidate) => matchesDirectoryValue(storedValue, candidate));
  }
  if (storedValue === filterValue) return true;
  if (Array.isArray(storedValue)) return storedValue.includes(filterValue);
  if (typeof storedValue === 'string' && storedValue.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(storedValue.trim());
      if (Array.isArray(parsed) && parsed.includes(filterValue)) return true;
    } catch {}
  }
  const storedBoolean = booleanCanonical(storedValue);
  return storedBoolean !== null && booleanCanonical(filterValue) === storedBoolean;
}

async function matchesNamedPreference(db, tenantId, organizationId, names, allowed) {
  const fields = await rows(db.from('preference_field').select('id')
    .eq('tenant_id', tenantId).eq('entity_scope', 'organization').in('name', names));
  if (!fields.length) return false;
  const values = await rows(db.from('organization_preference_value')
    .select('value').eq('organization_id', organizationId).in('field_id', fields.map((field) => field.id)));
  return values.some((row) => matchesDirectoryValue(row.value, allowed));
}

export async function isDirectoryOrganizationEligible({
  db, context, directory, organizationId,
}) {
  const organizations = await rows(db.from('organization').select('id, name')
    .eq('tenant_id', context.tenantId).eq('id', organizationId).limit(1));
  const organization = organizations[0];
  if (!organization) return null;
  const ownOrganization = String(context.organizationId || '') === String(organizationId);

  if (!ownOrganization && (await settingArray(
    db, context.tenantId, 'org_directory_excluded_orgs',
  )).includes(organizationId)) return null;

  if (directory.id === 'main' && !ownOrganization) {
    const statuses = await settingArray(db, context.tenantId, 'org_directory_allowed_application_statuses');
    if (statuses.length && !await matchesNamedPreference(
      db, context.tenantId, organizationId, ['application_status'], statuses,
    )) return null;
    const types = await settingArray(db, context.tenantId, 'org_directory_visible_org_types');
    if (types.length && !await matchesNamedPreference(
      db, context.tenantId, organizationId,
      ['org_type', 'organisation_type', 'organization_type'], types,
    )) return null;
  }

  if (directory.id !== 'main' && directory.filter_field_id && directory.filter_value) {
    const values = await rows(db.from('organization_preference_value').select('value')
      .eq('organization_id', organizationId).eq('field_id', directory.filter_field_id));
    if (!values.some((row) => matchesDirectoryValue(row.value, directory.filter_value))) return null;
  }
  return organization;
}

function minimalField(field) {
  const metadata = getCustomObjectFieldMetadata(field);
  return {
    field_type: metadata.type,
    options: metadata.options,
    all_countries: metadata.allCountries,
    selected_countries: metadata.selectedCountries,
    allowed_file_types: metadata.allowedFileTypes,
  };
}

function parseFile(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export const DIRECTORY_FILE_REUPLOAD_REASON =
  'This file must be re-uploaded in Data Studio before it can appear in a directory.';

export function isDirectoryObjectFilePath(storagePath, tenantId, objectId, fieldId) {
  if (!tenantId || !objectId || !fieldId || typeof storagePath !== 'string') return false;
  const prefix = `${tenantId}/custom-object-files/${objectId}/${fieldId}/`;
  if (!storagePath.startsWith(prefix) || storagePath.includes('..')) return false;
  const fileName = storagePath.slice(prefix.length);
  // Exact shape emitted by custom-object-upload-url: a UUID plus a sanitized
  // filename in an object- and field-bound private namespace.
  return new RegExp(`^${UUID}-[A-Za-z0-9._-]{1,200}$`, 'i').test(fileName);
}

function directoryFileDescriptors(value, tenantId, objectId, fieldId) {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((raw) => {
    const file = parseFile(raw);
    const storagePath = String(file?.storage_path || file?.path || '');
    const bucket = file?.bucket;
    // Gallery, opportunity, attachment, document, generic upload, another
    // Custom Object, and forged same-tenant paths all fail this namespace check.
    // Consequently this proxy cannot bypass the extra policies enforced for
    // those asset classes by storage/secure-url.
    if (bucket !== 'private-uploads'
      || !isDirectoryObjectFilePath(storagePath, tenantId, objectId, fieldId)) return [];
    return [{
      storage_path: storagePath,
      bucket,
      file_name: String(file.file_name || file.name || 'File').slice(0, 255),
      ...(Number.isFinite(Number(file.file_size)) ? { file_size: Number(file.file_size) } : {}),
      ...(typeof file.mime_type === 'string' ? { mime_type: file.mime_type } : {}),
      is_private: true,
    }];
  });
}

export function projectDirectoryFileValue(value, tenantId, link) {
  const rawValues = Array.isArray(value) ? value : [value];
  const nonempty = rawValues.filter((item) => item !== null && item !== undefined && item !== '');
  const descriptors = directoryFileDescriptors(
    value, tenantId, link.objectId, link.fieldId,
  );
  if (nonempty.length && descriptors.length !== nonempty.length) {
    return { unavailable: true, reason: DIRECTORY_FILE_REUPLOAD_REASON };
  }
  const projected = descriptors.map((file, fileIndex) => {
    const params = new URLSearchParams({
      directory_id: link.directoryId || 'main',
      organization_id: link.organizationId,
      source_key: link.sourceKey,
      record_id: link.recordId,
      file_index: String(fileIndex),
    });
    return {
      file_name: file.file_name,
      ...(file.file_size !== undefined ? { file_size: file.file_size } : {}),
      ...(file.mime_type ? { mime_type: file.mime_type } : {}),
      file_url: `/api/organisation-directory/custom-object-file?${params}`,
    };
  });
  if (Array.isArray(value)) return projected;
  return projected[0] || null;
}

function safeDisplayValue(definition, record, fields, tenantId) {
  const primary = fields.find((field) => String(field.id) === String(definition.primary_display_field_id));
  if (!primary) return '';
  if (getCustomObjectFieldMetadata(primary).type === 'file') {
    const files = directoryFileDescriptors(
      record.data?.[getCustomObjectFieldMetadata(primary).key],
      tenantId,
      definition.id,
      primary.id,
    );
    const file = files[0];
    return file?.file_name || 'File';
  }
  return resolveCustomObjectDisplayValue({ objectDefinition: definition, record, fields: [primary] });
}

async function resolveSources({ db, context, settings, isAdmin = false }) {
  // PostgREST defaults to 1,000 rows. Page explicitly and deterministically so
  // opted-in objects above that boundary are not silently omitted.
  const definitions = await pagedRows(() => db.from('custom_object_definition')
    .select('id, singular_label, primary_display_field_id, status, configuration')
    .eq('tenant_id', context.tenantId).eq('status', 'active')
    .is('archived_at', null).order('id', { ascending: true }));
  const configured = configuredDirectorySources(definitions);
  if (!configured.length) return [];

  const relationshipIds = [...new Set(configured.map((item) => item.relationshipId).filter(Boolean))];
  const relationships = await chunkedRows(relationshipIds, (ids) =>
    db.from('custom_object_relationship_definition')
      .select('id, source_kind, target_kind, source_custom_object_id, target_custom_object_id, source_label, target_label, status, archived_at')
      .eq('tenant_id', context.tenantId).eq('status', 'active')
      .is('archived_at', null).in('id', ids));
  const relationshipById = new Map(relationships.map((item) => [String(item.id), item]));
  const objectIds = [...new Set(configured.map((item) => String(item.definition.id)))];
  // Only the explicitly enabled value fields and primary-label fields are
  // needed. Never load every field belonging to each configured object.
  const requiredFieldIds = [...new Set(configured.flatMap((item) => [
    item.fieldId,
    item.definition.primary_display_field_id
      ? String(item.definition.primary_display_field_id) : null,
  ]).filter(Boolean))];
  const fields = await chunkedRows(requiredFieldIds, (ids) =>
    db.from('preference_field')
      .select('id, tenant_id, custom_object_id, name, label, field_type, options, all_countries, selected_countries, allowed_file_types, is_active')
      .eq('tenant_id', context.tenantId).eq('entity_scope', 'custom_object')
      .eq('is_active', true).in('id', ids));
  const fieldById = new Map(fields.map((item) => [String(item.id), item]));

  let objectGrants = [];
  let fieldGrants = [];
  if (!settings && !context.tenantUserId && !isAdmin && context.roleId) {
    [objectGrants, fieldGrants] = await Promise.all([
      chunkedRows(objectIds, (ids) => db.from('custom_object_role_permission')
        .select('custom_object_id, can_view_records')
        .eq('tenant_id', context.tenantId).eq('role_id', context.roleId).in('custom_object_id', ids)),
      chunkedRows(requiredFieldIds, (ids) => db.from('custom_object_field_role_permission')
        .select('custom_object_id, field_id, access_level')
        .eq('tenant_id', context.tenantId).eq('role_id', context.roleId).in('field_id', ids)),
    ]);
  }
  const objectGrantById = new Map(objectGrants.map((item) => [String(item.custom_object_id), item]));
  const fieldGrantById = new Map(fieldGrants.map((item) => [String(item.field_id), item]));

  return configured.flatMap((item) => {
    const objectId = String(item.definition.id);
    const relationship = relationshipById.get(item.relationshipId);
    const field = fieldById.get(item.fieldId);
    const objectIsOpposite = item.direction === 'source'
      ? relationship?.target_custom_object_id : relationship?.source_custom_object_id;
    if (!relationship || !field
      || relationship[`${item.direction}_kind`] !== 'organization'
      || relationship[item.direction === 'source' ? 'target_kind' : 'source_kind'] !== 'custom_object'
      || String(objectIsOpposite || '') !== objectId
      || String(field.custom_object_id) !== objectId) return [];

    const hasActivePrimary = item.definition.primary_display_field_id
      && fieldById.has(String(item.definition.primary_display_field_id));
    if (!settings && !hasActivePrimary) return [];
    if (!settings && !context.tenantUserId && !isAdmin) {
      if (!context.roleId || !resolveCustomObjectPermission({
        permission: objectGrantById.get(objectId), capability: 'view_records',
      })) return [];
      const readable = (fieldId) => resolveCustomObjectFieldAccess({
        permission: fieldGrantById.get(String(fieldId)),
      }) !== 'none';
      if (!readable(field.id)
        || !readable(item.definition.primary_display_field_id)) return [];
    }

    const key = customObjectDirectorySourceKey({
      relationshipId: relationship.id,
      direction: item.direction,
      objectId,
      fieldId: field.id,
    });
    const relationshipLabel = relationship[`${item.direction}_label`];
    return [{
      key,
      label: `${item.definition.singular_label}: ${field.label || field.name}${relationshipLabel ? ` (${relationshipLabel})` : ''}`,
      object_id: objectId,
      field_id: String(field.id),
      relationship_id: String(relationship.id),
      direction: item.direction,
      field: minimalField(field),
      _definition: item.definition,
      _field: field,
      _fields: fields.filter((candidate) => String(candidate.custom_object_id) === objectId),
    }];
  }).sort((a, b) => a.key.localeCompare(b.key));
}

function publicSource(source) {
  const { _definition, _field, _fields, ...result } = source;
  return result;
}

export function createCustomObjectDirectory({
  db, context, featureCheck, settingsCheck, isAdmin = false,
}) {
  return {
    async metadata({ directoryId = 'main', settings = false } = {}) {
      await resolveDirectory({ db, context, directoryId, settings, featureCheck, settingsCheck });
      return {
        sources: (await resolveSources({
          db, context, settings, isAdmin,
        })).map(publicSource),
      };
    },

    async values({
      directoryId = 'main', organizationId, sourceKey, cursor = null,
    }) {
      const directory = await resolveDirectory({
        db, context, directoryId, settings: false, featureCheck, settingsCheck,
      });
      if (!organizationId) throw new CustomObjectDirectoryError(400, 'organization_id is required');
      if (!await isDirectoryOrganizationEligible({ db, context, directory, organizationId })) {
        throw new CustomObjectDirectoryError(404, 'Organisation not found in this directory');
      }
      const parsed = parseCustomObjectDirectorySourceKey(sourceKey);
      if (!parsed) throw new CustomObjectDirectoryError(400, 'source_key is invalid');
      const source = (await resolveSources({
        db, context, settings: false, isAdmin,
      }))
        .find((item) => item.key.toLowerCase() === String(sourceKey).toLowerCase());
      if (!source) throw new CustomObjectDirectoryError(404, 'Source not found');
      const after = decodeCustomObjectDirectoryCursor(cursor);
      if (cursor && !after) throw new CustomObjectDirectoryError(400, 'cursor is invalid');

      const organizationColumn = `${parsed.direction}_record_id`;
      const recordColumn = parsed.direction === 'source' ? 'target_record_id' : 'source_record_id';
      let edgeQuery = db.from('custom_object_relationship').select(recordColumn)
        .eq('tenant_id', context.tenantId)
        .eq('relationship_definition_id', parsed.relationshipId)
        .eq(organizationColumn, organizationId).is('archived_at', null)
        .order(recordColumn, { ascending: true }).limit(CUSTOM_OBJECT_DIRECTORY_PAGE_SIZE + 1);
      if (after) edgeQuery = edgeQuery.gt(recordColumn, after);
      const edges = await rows(edgeQuery);
      const pageEdges = edges.slice(0, CUSTOM_OBJECT_DIRECTORY_PAGE_SIZE);
      const recordIds = pageEdges.map((edge) => edge[recordColumn]);
      const records = recordIds.length ? await rows(db.from('custom_object_record')
        .select('id, data').eq('tenant_id', context.tenantId)
        .eq('custom_object_id', parsed.objectId).is('archived_at', null).in('id', recordIds)) : [];
      const recordsById = new Map(records.map((record) => [String(record.id), record]));
      const items = pageEdges.flatMap((edge) => {
        const record = recordsById.get(String(edge[recordColumn]));
        if (!record) return [];
        const metadata = getCustomObjectFieldMetadata(source._field);
        const rawValue = record.data?.[metadata.key];
        const value = metadata.type === 'file'
          ? projectDirectoryFileValue(rawValue, context.tenantId, {
            directoryId,
            organizationId,
            sourceKey: source.key,
            recordId: record.id,
            objectId: parsed.objectId,
            fieldId: parsed.fieldId,
          }) : rawValue;
        if (value === null || value === undefined || value === ''
          || (Array.isArray(value) && !value.length)) return [];
        return [{
          record_id: String(record.id),
          label: safeDisplayValue(source._definition, record, source._fields, context.tenantId),
          value,
        }];
      });
      return {
        source: publicSource(source),
        items,
        nextCursor: edges.length > CUSTOM_OBJECT_DIRECTORY_PAGE_SIZE && pageEdges.length
          ? encodeCustomObjectDirectoryCursor(pageEdges.at(-1)[recordColumn]) : null,
      };
    },

    async file({
      directoryId = 'main', organizationId, sourceKey, recordId, fileIndex = 0,
    }) {
      const directory = await resolveDirectory({
        db, context, directoryId, settings: false, featureCheck, settingsCheck,
      });
      if (!organizationId || !recordId) {
        throw new CustomObjectDirectoryError(400, 'organization_id and record_id are required');
      }
      if (!new RegExp(`^${UUID}$`, 'i').test(String(recordId))) {
        throw new CustomObjectDirectoryError(400, 'record_id is invalid');
      }
      if (!await isDirectoryOrganizationEligible({ db, context, directory, organizationId })) {
        throw new CustomObjectDirectoryError(404, 'Organisation not found in this directory');
      }
      const parsed = parseCustomObjectDirectorySourceKey(sourceKey);
      if (!parsed) throw new CustomObjectDirectoryError(400, 'source_key is invalid');
      const source = (await resolveSources({
        db, context, settings: false, isAdmin,
      }))
        .find((item) => item.key.toLowerCase() === String(sourceKey).toLowerCase());
      if (!source || getCustomObjectFieldMetadata(source._field).type !== 'file') {
        throw new CustomObjectDirectoryError(404, 'File source not found');
      }
      const index = Number(fileIndex);
      if (!Number.isInteger(index) || index < 0 || index > 100) {
        throw new CustomObjectDirectoryError(400, 'file_index is invalid');
      }

      const organizationColumn = `${parsed.direction}_record_id`;
      const recordColumn = parsed.direction === 'source' ? 'target_record_id' : 'source_record_id';
      const edges = await rows(db.from('custom_object_relationship').select('id')
        .eq('tenant_id', context.tenantId)
        .eq('relationship_definition_id', parsed.relationshipId)
        .eq(organizationColumn, organizationId).eq(recordColumn, recordId)
        .is('archived_at', null).limit(1));
      if (!edges.length) throw new CustomObjectDirectoryError(404, 'File not found');

      const records = await rows(db.from('custom_object_record').select('id, data')
        .eq('tenant_id', context.tenantId).eq('custom_object_id', parsed.objectId)
        .eq('id', recordId).is('archived_at', null).limit(1));
      const record = records[0];
      if (!record) throw new CustomObjectDirectoryError(404, 'File not found');
      const metadata = getCustomObjectFieldMetadata(source._field);
      const descriptors = directoryFileDescriptors(
        record.data?.[metadata.key], context.tenantId, parsed.objectId, parsed.fieldId,
      );
      const descriptor = descriptors[index];
      if (!descriptor) throw new CustomObjectDirectoryError(404, 'File not found');
      return descriptor;
    },
  };
}