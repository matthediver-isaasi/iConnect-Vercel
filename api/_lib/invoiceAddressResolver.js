export async function resolveInvoiceAddress(supabase, config, entityId, entityType) {
  if (!config) return null;

  const fieldName = config.invoice_address_field_name;
  const fieldId = config.invoice_address_field_id;

  if (fieldName) {
    try {
      const table = entityType === 'member' ? 'member' : 'organization';
      const { data } = await supabase
        .from(table)
        .select(fieldName)
        .eq('id', entityId)
        .maybeSingle();
      return data?.[fieldName] || null;
    } catch (err) {
      console.error('[InvoiceAddressResolver] Error fetching core field:', err.message);
      return null;
    }
  }

  if (fieldId) {
    try {
      const prefTable = entityType === 'member' ? 'member_preference_value' : 'organization_preference_value';
      const entityCol = entityType === 'member' ? 'member_id' : 'organization_id';
      const { data } = await supabase
        .from(prefTable)
        .select('value')
        .eq(entityCol, entityId)
        .eq('field_id', fieldId)
        .maybeSingle();
      return data?.value || null;
    } catch (err) {
      console.error('[InvoiceAddressResolver] Error fetching custom field:', err.message);
      return null;
    }
  }

  if (entityType === 'organization') {
    try {
      const { data } = await supabase
        .from('organization')
        .select('invoicing_address')
        .eq('id', entityId)
        .maybeSingle();
      return data?.invoicing_address || null;
    } catch (err) {
      console.error('[InvoiceAddressResolver] Error fetching default org address:', err.message);
      return null;
    }
  }

  return null;
}
