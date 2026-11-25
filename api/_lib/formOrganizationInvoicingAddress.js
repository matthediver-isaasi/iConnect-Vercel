import { INVOICING_ADDRESS_KEYS, invoicingAddressError } from '../../shared/invoicingAddress.js';

export function hasOrganizationInvoicingAddressMappings(form) {
  const isAddress = mapping => mapping?.target_type !== 'custom'
    && INVOICING_ADDRESS_KEYS.includes(mapping?.target_field || mapping?.target_field_id);
  const pipelines = form.entity_pipelines?.organisations || form.entity_pipelines?.organizations || [];
  return pipelines.some(p => (p.mappings || []).some(isAddress)
      || Object.keys(p.field_mappings || {}).some(key => INVOICING_ADDRESS_KEYS.includes(key)))
    || (Array.isArray(form.field_mappings) && form.field_mappings.some(m => m.target_entity === 'organization' && isAddress(m)))
    || (form.fields || []).some(f => typeof f.core_field_mapping === 'string'
      && f.core_field_mapping.startsWith('organization.')
      && INVOICING_ADDRESS_KEYS.includes(f.core_field_mapping.slice('organization.'.length)));
}

// Form mapping destinations look like core fields, but must never be written
// to (or read back through) the publicly readable organization table.
export function takeOrganizationInvoicingAddress(core) {
  const address = {};
  for (const key of INVOICING_ADDRESS_KEYS) {
    if (!Object.hasOwn(core, key)) continue;
    address[key] = core[key] === '__clear__' ? null : core[key];
    delete core[key];
  }
  const error = invoicingAddressError(address);
  if (error) throw Object.assign(new Error(error), { status: 400 });
  return Object.fromEntries(Object.entries(address)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, value?.trim() || null]));
}

// The caller must pass the existing form mutation guard, not reference-use
// authorization. A tenant-valid organisation selection alone grants no writes.
export async function saveFormOrganizationInvoicingAddress({
  db, tenantId, organizationId, address, authorize,
}) {
  if (!Object.keys(address).length) return;
  const error = invoicingAddressError(address);
  if (error) throw Object.assign(new Error(error), { status: 400 });
  if (!tenantId || !organizationId || typeof authorize !== 'function') {
    throw new Error('Organisation invoicing address write requires tenant, owner and mutation authorization');
  }
  await authorize();
  const { data: owner, error: ownerError } = await db.from('organization')
    .select('id').eq('tenant_id', tenantId).eq('id', organizationId).maybeSingle();
  if (ownerError) throw ownerError;
  if (!owner) throw new Error('Organisation invoicing address owner is unavailable in this tenant');
  const { data, error: saveError } = await db.rpc('patch_private_invoicing_address', {
    p_tenant_id: tenantId, p_owner_type: 'organization', p_owner_id: organizationId, p_address: address,
  });
  if (saveError) throw saveError;
  if (!data || (Array.isArray(data) && !data.length)) {
    throw new Error('Organisation invoicing address was not saved');
  }
}
