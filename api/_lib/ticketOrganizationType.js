import { ORGANIZATION_TYPE_ALIASES, organizationTypeOptions } from '../../shared/ticketOrganizationType.js';
import { normalizeOrganizationPreferenceValues } from './organizationEligibility.js';

export async function loadTicketOrganizationTypeFields(db, tenantId) {
  const { data, error } = await db.from('preference_field')
    .select('id,name,label,options').eq('tenant_id', tenantId)
    .eq('entity_scope', 'organization').eq('is_active', true)
    .in('name', ORGANIZATION_TYPE_ALIASES).order('id').limit(101);
  if (error || !Array.isArray(data) || data.length > 100) {
    throw new Error('Unable to load organisation type definitions. Retry before saving.');
  }
  return data.map(field => {
    try { return { ...field, options: organizationTypeOptions(field.options) }; }
    catch (error) { return { ...field, options: [], warning: error.message }; }
  });
}

// Session identity only. Never use a submitted organisation or attendee snapshot.
export async function loadTicketOrganizationTypes(db, tenantId, memberId) {
  try {
    const { data: member, error } = await db.from('member')
      .select('id,organization_id').eq('tenant_id', tenantId).eq('id', memberId).maybeSingle();
    if (error || !member?.organization_id) return {};
    const { data: org, error: orgError } = await db.from('organization')
      .select('id').eq('tenant_id', tenantId).eq('id', member.organization_id).maybeSingle();
    if (orgError || !org) return {};
    const fields = await loadTicketOrganizationTypeFields(db, tenantId);
    const result = {};
    for (const field of fields) {
      if (field.warning || !field.options.length) continue;
      const { data, error: valueError } = await db.from('organization_preference_value')
        .select('value').eq('organization_id', org.id).eq('field_id', field.id).maybeSingle();
      if (valueError) return {};
      result[field.id] = { options: field.options.map(o => o.value),
        values: normalizeOrganizationPreferenceValues(data?.value) || [] };
    }
    return result;
  } catch {
    // A failed read is not an unrestricted ticket. No preference data is exposed.
    return {};
  }
}

export async function validateTicketOrganizationType({ db, tenantId, ticket }) {
  if (ticket.organization_type_enabled != null && typeof ticket.organization_type_enabled !== 'boolean') {
    throw new Error('Organisation Type enabled must be a boolean.');
  }
  if (!ticket.organization_type_enabled) return;
  if (ticket.audience_mode === 'selected_members') {
    throw new Error('Selected-members tickets cannot also restrict Organisation Type.');
  }
  const fields = await loadTicketOrganizationTypeFields(db, tenantId);
  const field = fields.find(f => f.id === ticket.organization_type_field_id);
  const values = ticket.organization_type_values;
  if (!field || field.warning || !Array.isArray(values) || !values.length
      || values.some(v => typeof v !== 'string' || !field.options.some(o => o.value === v))) {
    throw new Error('Choose at least one valid Organisation Type from an active organisation field in this tenant. Remove unavailable selections explicitly.');
  }
}
