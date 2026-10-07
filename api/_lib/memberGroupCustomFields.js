import { GROUP_FIELDS_KEY, validateGroupDefinitions, validateGroupValues, groupDisplayValues } from '../../shared/memberGroupCustomFields.js';

export async function groupCustomFieldsAvailable(db, tenantId) {
  const { error } = await db.from('member_group').select('custom_field_values').eq('tenant_id', tenantId).limit(0);
  if (!error) return true;
  if (['42703', 'PGRST204'].includes(error.code) && /custom_field_values/.test(error.message || '')) return false;
  throw new Error('Unable to verify custom field availability.');
}

export async function loadGroupDefinitions(db, tenantId) {
  if (!tenantId) throw new Error('Tenant required');
  const { data, error } = await db.from('system_settings').select('setting_value').eq('tenant_id', tenantId).eq('setting_key', GROUP_FIELDS_KEY).maybeSingle();
  if (error) throw new Error('Unable to load member group custom fields.');
  if (!data) return { fields: [], revision: 0 };
  const stored = typeof data.setting_value === 'string' ? JSON.parse(data.setting_value) : data.setting_value;
  return { fields: validateGroupDefinitions(stored.fields), revision: stored.revision };
}

export async function validateGroupValueWrite(db, context, body, hasAdminAccess) {
  if (!Object.hasOwn(body || {}, 'custom_field_values')) return;
  if (!context.isAuthenticated || !context.tenantId || !(await hasAdminAccess(context))) {
    throw Object.assign(new Error('Tenant administrator access is required to edit custom fields.'), { status: 403 });
  }
  if (!(await groupCustomFieldsAvailable(db, context.tenantId))) {
    if (body.custom_field_values && typeof body.custom_field_values === 'object' && !Array.isArray(body.custom_field_values) && !Object.keys(body.custom_field_values).length) {
      delete body.custom_field_values;
      return;
    }
    throw Object.assign(new Error('Custom fields require the database migration before values can be saved.'), { status: 503 });
  }
  const { fields } = await loadGroupDefinitions(db, context.tenantId);
  body.custom_field_values = validateGroupValues(body.custom_field_values, fields);
}

export async function projectGroupCustomFields(db, context, rows, hasAdminAccess) {
  const { fields } = await loadGroupDefinitions(db, context.tenantId);
  const admin = context.isAuthenticated && await hasAdminAccess(context);
  return rows.map(row => {
    const { custom_field_values: values, ...safe } = row;
    safe.custom_fields_display = groupDisplayValues(values, fields);
    if (admin) safe.custom_field_values = Object.fromEntries(fields.filter(f => Object.hasOwn(values || {}, f.id)).map(f => [f.id, values[f.id]]));
    return safe;
  });
}
