export const ORGANIZATION_TYPE_ALIASES = ['org_type', 'organisation_type', 'organization_type'];

export function organizationTypeOptions(raw) {
  if (typeof raw === 'string') raw = JSON.parse(raw);
  if (!Array.isArray(raw)) throw new Error('The organisation type field has no valid options.');
  const options = new Map();
  for (const item of raw) {
    const value = item && typeof item === 'object' ? item.value : item;
    if (!['string', 'number', 'boolean'].includes(typeof value) || !String(value).trim()) {
      throw new Error('The organisation type options are malformed.');
    }
    options.set(String(value), { value: String(value), label: String(item?.label ?? value) });
  }
  return [...options.values()];
}

export function ticketOrganizationTypeAllowed(ticket, viewer, tenantId) {
  if (!ticket?.organization_type_enabled) return true;
  if (ticket.organization_type_enabled !== true || !tenantId || viewer?.tenantId !== tenantId
      || !viewer.memberId || (ticket.tenant_id && ticket.tenant_id !== tenantId)) return false;
  const field = viewer.organizationTypes?.[ticket.organization_type_field_id];
  const selected = ticket.organization_type_values;
  return !!field && Array.isArray(selected) && selected.length > 0
    && selected.every(v => typeof v === 'string' && field.options.includes(v))
    && field.values.some(v => selected.includes(v));
}

export function organizationTypePolicy(ticket) {
  return {
    organization_type_enabled: ticket?.organization_type_enabled ?? false,
    organization_type_field_id: ticket?.organization_type_field_id ?? null,
    organization_type_values: ticket?.organization_type_values ?? [],
  };
}
