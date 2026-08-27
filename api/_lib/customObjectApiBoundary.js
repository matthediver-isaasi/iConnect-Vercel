const CUSTOM_OBJECT_STORAGE_ENTITIES = new Set([
  'customobjectdefinition',
  'customobjectrecord',
  'customobjectrelationshipdefinition',
  'customobjectrelationship',
  'customobjectrolepermission',
  'customobjectauditevent',
]);

const CORE_PREFERENCE_VALUE_ENTITIES = new Set([
  'memberpreferencevalue',
  'organizationpreferencevalue',
  'organizationgrouppreferencevalue',
]);

export function isCustomObjectStorageEntity(entity) {
  const normalised = String(entity || '').replace(/[-_]/g, '').toLowerCase();
  return CUSTOM_OBJECT_STORAGE_ENTITIES.has(normalised);
}

export function isCorePreferenceValueEntity(entity) {
  const normalised = String(entity || '').replace(/[-_]/g, '').toLowerCase();
  return CORE_PREFERENCE_VALUE_ENTITIES.has(normalised);
}

export function isCustomObjectFieldWrite(body) {
  return body?.entity_scope === 'custom_object'
    || (body?.custom_object_id !== undefined && body?.custom_object_id !== null);
}

export async function loadCorePreferenceValueBeforeUpdate({
  supabase,
  tableName,
  id,
}) {
  if (!supabase || !tableName || !id) {
    throw new Error('Preference value lookup requires a database, table, and id');
  }

  const { data, error } = await supabase
    .from(tableName)
    .select('value, field_id')
    .eq('id', id)
    .single();

  if (error) throw error;
  if (!data?.field_id) {
    const missingFieldError = new Error('Preference value row has no field_id');
    missingFieldError.code = 'PREFERENCE_VALUE_FIELD_MISSING';
    throw missingFieldError;
  }

  return {
    value: data.value,
    fieldId: data.field_id,
  };
}

export async function isCorePreferenceField({ supabase, tenantId, fieldId }) {
  if (!supabase || !tenantId || !fieldId) return false;
  const { data, error } = await supabase
    .from('preference_field')
    .select('id')
    .eq('id', fieldId)
    .eq('tenant_id', tenantId)
    .or('entity_scope.is.null,entity_scope.neq.custom_object')
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

export async function filterCorePreferenceValueRows({
  supabase,
  tenantId,
  rows,
}) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const fieldIds = [...new Set(sourceRows.map((row) => row?.field_id).filter(Boolean))];
  if (!supabase || !tenantId || fieldIds.length === 0) return [];
  const { data, error } = await supabase
    .from('preference_field')
    .select('id')
    .eq('tenant_id', tenantId)
    .in('id', fieldIds)
    .or('entity_scope.is.null,entity_scope.neq.custom_object');
  if (error) throw error;
  const allowed = new Set((data || []).map((field) => field.id));
  return sourceRows.filter((row) => allowed.has(row.field_id));
}