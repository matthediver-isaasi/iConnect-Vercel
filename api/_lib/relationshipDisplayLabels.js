import { resolveCustomObjectDisplayValue } from './customObjectDomain.js';

const MAX_IDS = 2000;
export const UNAVAILABLE_RELATIONSHIP_RECORD = 'Unavailable record';

export function isRelationshipDropdownField(field) {
  return field?.type === 'relationship_dropdown';
}

export function getSubmissionRelationshipValue(values, field) {
  if (!values || typeof values !== 'object' || !field) return undefined;
  if (field.id != null && values[field.id] !== undefined) return values[field.id];
  if (field.name != null) return values[field.name];
  return undefined;
}

export function collectRelationshipRecordIds(fields, values) {
  const ids = new Set();
  for (const field of fields || []) {
    if (!isRelationshipDropdownField(field)) continue;
    const value = getSubmissionRelationshipValue(values, field);
    for (const entry of (Array.isArray(value) ? value : [value])) {
      if (entry != null && entry !== '') ids.add(String(entry));
    }
  }
  return [...ids];
}

export function formatRelationshipDisplayValue(
  value,
  labelsByRecordId,
  fallback = UNAVAILABLE_RELATIONSHIP_RECORD,
) {
  const resolveOne = (entry) => {
    if (entry == null || entry === '') return '';
    const label = labelsByRecordId instanceof Map
      ? labelsByRecordId.get(String(entry))
      : labelsByRecordId?.[String(entry)];
    return typeof label === 'string' && label.trim() ? label.trim() : fallback;
  };
  return (Array.isArray(value) ? value : [value])
    .map(resolveOne)
    .filter(Boolean)
    .join(', ');
}

function uniqueIds(recordIds) {
  return [...new Set((recordIds || [])
    .filter((id) => id != null && id !== '')
    .map(String))]
    .slice(0, MAX_IDS);
}

function chunks(values, size = 500) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function fetchChunks(buildQuery, ids) {
  const rows = [];
  for (const part of chunks(ids)) {
    const { data, error } = await buildQuery(part);
    if (error) throw error;
    rows.push(...(data || []));
  }
  return rows;
}

/**
 * Returns only labels for active records belonging to the supplied tenant.
 * Missing, archived, cross-tenant, or unlabelled records are intentionally
 * omitted so callers use the non-identifying fallback from the pure resolver.
 */
export async function loadTenantRelationshipDisplayLabels(db, tenantId, recordIds) {
  const ids = uniqueIds(recordIds);
  if (!db || !tenantId || ids.length === 0) return {};

  // IDs are ordinarily globally unique, but retain a stable precedence for
  // legacy/corrupt collisions: core records are added first and an active
  // custom-object record replaces them below.
  const [organizations, groups, records] = await Promise.all([
    fetchChunks(
      (part) => db.from('organization')
        .select('id, name')
        .eq('tenant_id', tenantId)
        .in('id', part),
      ids,
    ),
    fetchChunks(
      (part) => db.from('organization_group')
        .select('id, name')
        .eq('tenant_id', tenantId)
        .in('id', part),
      ids,
    ),
    fetchChunks(
      (part) => db.from('custom_object_record')
        .select('id, custom_object_id, data')
        .eq('tenant_id', tenantId)
        .is('archived_at', null)
        .in('id', part),
      ids,
    ),
  ]);
  const labels = {};
  for (const group of groups) {
    if (typeof group.name === 'string' && group.name.trim()) {
      labels[String(group.id)] = group.name.trim();
    }
  }
  for (const organization of organizations) {
    if (typeof organization.name === 'string' && organization.name.trim()) {
      labels[String(organization.id)] = organization.name.trim();
    }
  }
  if (records.length === 0) return labels;

  const objectIds = [...new Set(records.map((record) => record.custom_object_id).filter(Boolean))];
  const objects = await fetchChunks(
    (part) => db.from('custom_object_definition')
      .select('id, primary_display_field_id')
      .eq('tenant_id', tenantId)
      .eq('status', 'active')
      .is('archived_at', null)
      .in('id', part),
    objectIds,
  );

  const activeObjects = new Map(objects.map((object) => [String(object.id), object]));
  const primaryFieldIds = [...new Set(objects
    .map((object) => object.primary_display_field_id)
    .filter(Boolean))];
  if (primaryFieldIds.length === 0) return labels;

  const fields = await fetchChunks(
    (part) => db.from('preference_field')
      .select('id, custom_object_id, name, label, field_type, options, is_active')
      .eq('tenant_id', tenantId)
      .eq('entity_scope', 'custom_object')
      .eq('is_active', true)
      .in('id', part),
    primaryFieldIds,
  );
  const fieldsById = new Map(fields.map((field) => [String(field.id), field]));

  for (const record of records) {
    const object = activeObjects.get(String(record.custom_object_id));
    if (!object) continue;
    const primaryField = fieldsById.get(String(object.primary_display_field_id));
    if (!primaryField || String(primaryField.custom_object_id) !== String(object.id)) continue;
    const label = resolveCustomObjectDisplayValue({
      objectDefinition: object,
      record,
      fields: [primaryField],
    });
    if (!label || String(label) === String(record.id)) continue;
    labels[String(record.id)] = String(label);
  }
  return labels;
}