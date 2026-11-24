import { INVOICING_ADDRESS_KEYS } from '../../shared/invoicingAddress.js';
import { OpportunityHttpError } from './opportunityRules.js';

// Called only after opportunity access has been authorised. Structured invoice
// fields live in protected storage, not on the public organisation record.
export async function loadOpportunityBillingOrganization(db, tenantId, organizationId) {
  const organization = await db.from('organization').select('invoicing_address')
    .eq('tenant_id', tenantId).eq('id', organizationId).maybeSingle();
  if (organization.error) throw organization.error;
  if (!organization.data) throw new OpportunityHttpError(404, 'Opportunity organisation not found');
  const structured = await db.from('invoicing_address_private').select(INVOICING_ADDRESS_KEYS.join(','))
    .eq('tenant_id', tenantId).eq('owner_type', 'organization').eq('owner_id', organizationId).maybeSingle();
  if (structured.error) {
    throw new OpportunityHttpError(503, 'The organisation invoice address could not be loaded. Please retry.');
  }
  return {
    invoicing_address: organization.data.invoicing_address || '',
    ...Object.fromEntries(INVOICING_ADDRESS_KEYS.map(key => [key, structured.data?.[key] || ''])),
  };
}
