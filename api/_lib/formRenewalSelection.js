import { resolveFormAccess } from './formAccessPolicy.js';

export class FormRenewalSelectionError extends Error {}
function reject(message) { throw new FormRenewalSelectionError(message); }
// Only a saved, accessible form mapping may select a different renewal class.
// Neither a client config ID nor an arbitrary field override is authority.
export async function resolveFormRenewalSelection(db, {
  req, tenantId, formId, paymentFieldId, fieldOverrides = {}, scheduleAnswer,
}, access = resolveFormAccess) {
  if (!formId || !paymentFieldId) return null;
  const { data: form, error } = await db.from('form').select('*')
    .eq('tenant_id', tenantId).eq('id', formId).maybeSingle();
  if (error) throw new Error('Could not verify the renewal form.');
  const fields = Array.isArray(form?.fields) ? form.fields : [];
  const payment = fields.find(field => field.id === paymentFieldId && field.type === 'membership_payment');
  if (!payment) reject('The membership payment field is unavailable.');
  const scheduleMapping = payment.membership_schedule_mapping;
  if (scheduleMapping != null) {
    if (!form.is_active || form.require_authentication !== true
        || (form.deactivate_at && (!Number.isFinite(Date.parse(form.deactivate_at))
          || Date.parse(form.deactivate_at) <= Date.now()))) reject('This renewal form is unavailable.');
    if (!(await access({ supabase: db, req, tenantId, policy: form.access_policy })).allowed) {
      reject('You do not have access to this renewal form.');
    }
    const source = fields.find(field => field.id === scheduleMapping.source_field_id);
    const choices = (Array.isArray(source?.options) ? source.options : []).map(option =>
      typeof option === 'string' ? option : option?.value ?? option?.label);
    if (!['radio', 'select', 'dropdown'].includes(source?.type)
        || typeof scheduleAnswer !== 'string' || !choices.includes(scheduleAnswer)) {
      reject('Choose a valid answer for the membership schedule before continuing.');
    }
    const matches = (Array.isArray(scheduleMapping.entries) ? scheduleMapping.entries : [])
      .filter(entry => entry.value === scheduleAnswer);
    if (matches.length !== 1 || !matches[0].config_id) {
      reject('No unique membership schedule is configured for this answer. Please contact the membership team.');
    }
    const { data: target, error: targetError } = await db.from('membership_tier_config').select('*')
      .eq('tenant_id', tenantId).eq('id', matches[0].config_id).maybeSingle();
    if (targetError) throw new Error('Could not verify the renewal schedule.');
    if (!target || target.is_active === false || target.structure_scope_type !== 'member') {
      reject('The membership schedule for this answer is unavailable.');
    }
    return { configId: target.id, fieldId: target.structure_field_id || null,
      value: target.structure_match_value ?? null, sourceValue: scheduleAnswer, formId, paymentFieldId };
  }
  // Existing unconfigured payment fields retain their existing renewal path.
  if (!payment.membership_config_id || !Object.keys(payment.field_mappings || {}).length) return null;
  const { data: config, error: configError } = await db.from('membership_tier_config').select('*')
    .eq('tenant_id', tenantId).eq('id', payment.membership_config_id).maybeSingle();
  if (configError) throw new Error('Could not verify the renewal schedule.');
  if (config?.structure_scope_type !== 'member' || !config.structure_field_id) return null;
  const fieldId = config.structure_field_id;
  const sourceId = payment.field_mappings?.[fieldId];
  if (!sourceId) return null;
  if (!form?.is_active || form.require_authentication !== true
      || (form.deactivate_at && (!Number.isFinite(Date.parse(form.deactivate_at))
        || Date.parse(form.deactivate_at) <= Date.now()))) {
    reject('This renewal form is unavailable.');
  }
  if (!(await access({ supabase: db, req, tenantId, policy: form.access_policy })).allowed) {
    reject('You do not have access to this renewal form.');
  }
  const source = fields.find(field => field.id === sourceId);
  // Class selection is bounded to the choices authored by the administrator.
  const choices = (source?.options || []).map(option =>
    typeof option === 'string' ? option : option?.value ?? option?.label);
  const supplied = fieldOverrides?.[fieldId];
  if (typeof supplied !== 'string' || !choices.includes(supplied)) {
    reject('Choose a valid membership class before continuing.');
  }
  return { fieldId, value: supplied, formId, paymentFieldId };
}
