import {
  isRepeatableRowField,
  repeatableRowChildren,
} from '../../shared/formRepeatableRows.js';
import { validateRowSourceConfiguration } from '../../shared/formCustomObjectRowSources.js';
import {
  createFormRelationshipService,
  FormRelationshipError,
} from './formRelationshipOptions.js';

/**
 * Form writes must not be able to persist tenant-external, archived, or
 * structurally invalid row sources. This check deliberately uses only the
 * submitted form topology and tenant-scoped database metadata.
 */
export async function validateFormRowSourceConfiguration({
  db,
  tenantId,
  form,
  relationshipService,
  canConfigure = true,
  isTenantUser = true,
  authorRoleId = null,
}) {
  const service = relationshipService || createFormRelationshipService({ db, tenantId });
  const hasConfiguredSource = (form?.fields || []).some(field => (
    field?.option_source !== undefined
      || (isRepeatableRowField(field)
        && repeatableRowChildren(field).some(child => child?.option_source !== undefined))
  ));
  if (hasConfiguredSource && !canConfigure) {
    return {
      ok: false,
      status: 403,
      code: 'ROW_OPTION_SOURCE_FORBIDDEN',
      error: 'Admin access is required to configure Custom Object row sources',
    };
  }
  const accessCache = new Map();
  async function canReadSource(source) {
    if (isTenantUser) return true;
    if (!authorRoleId) return false;
    const objectId = source.custom_object_id;
    let access = accessCache.get(objectId);
    if (!access) {
      const { data: permission, error: permissionError } = await db
        .from('custom_object_role_permission').select('custom_object_id')
        .eq('tenant_id', tenantId).eq('custom_object_id', objectId)
        .eq('role_id', authorRoleId).eq('can_view_records', true).maybeSingle();
      if (permissionError) throw permissionError;
      const { data: restrictions, error: restrictionError } = await db
        .from('custom_object_field_role_permission').select('field_id, access_level')
        .eq('tenant_id', tenantId).eq('custom_object_id', objectId)
        .eq('role_id', authorRoleId);
      if (restrictionError) throw restrictionError;
      access = {
        canViewRecords: Boolean(permission),
        deniedFields: new Set((restrictions || [])
          .filter(row => row.access_level === 'none').map(row => String(row.field_id))),
      };
      accessCache.set(objectId, access);
    }
    const needed = [
      source.primary_display_field_id,
      ...(source.kind === 'distinct' ? [source.value_field_id] : []),
      ...(source.filters || []).map(filter => filter.field_id),
    ];
    return access.canViewRecords
      && needed.every(fieldId => !access.deniedFields.has(String(fieldId)));
  }
  const rootSource = (form?.fields || []).find(field => (
    field?.option_source !== undefined && !isRepeatableRowField(field)
  ));
  if (rootSource) {
    return {
      ok: false,
      status: 422,
      code: 'INVALID_ROW_OPTION_SOURCE',
      error: 'Custom Object row sources are only available inside repeatable rows',
    };
  }
  for (const container of (form?.fields || []).filter(isRepeatableRowField)) {
    const siblings = repeatableRowChildren(container);
    for (const child of siblings.filter(item => item?.option_source !== undefined)) {
      const structural = validateRowSourceConfiguration(child, siblings);
      if (!structural.valid) {
        return {
          ok: false,
          status: 422,
          code: structural.errors[0]?.code || 'INVALID_ROW_OPTION_SOURCE',
          error: structural.errors[0]?.message || 'Invalid Custom Object row source',
          details: structural.errors,
        };
      }
      if (!await canReadSource(child.option_source)) {
        return {
          ok: false,
          status: 403,
          code: 'ROW_OPTION_SOURCE_FORBIDDEN',
          error: 'Custom Object record and field read access is required to configure this row source',
        };
      }
      try {
        await service.validatePersistedRowSource({
          form,
          fieldId: child.id,
          containerFieldId: container.id,
        });
      } catch (error) {
        if (!(error instanceof FormRelationshipError)) throw error;
        return {
          ok: false,
          status: error.status === 500 ? 500 : 422,
          code: 'INVALID_ROW_OPTION_SOURCE',
          error: error.message,
        };
      }
    }
  }
  return { ok: true };
}