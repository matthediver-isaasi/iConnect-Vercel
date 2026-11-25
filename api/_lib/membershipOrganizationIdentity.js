import { uniqueOrganizationContact, xeroOrganizationContactCreator } from './formInvoiceOrganization.js';

const fail = code => { throw Object.assign(new Error(code), { code, permanent: true }); };

export async function freezeMembershipOrganizationIdentity(db, args) {
  const source = args.accountingSource;
  if (source && source.sourceType !== 'organisation_membership_history') return null;
  let organizationId = args.organizationId;
  if (source) {
    if (!args.appTenantId || !source.sourceId || !source.linkage?.ownerId) fail('MEMBERSHIP_ORGANIZATION_AUTHORITY_REQUIRED');
    const history = await db.from('organisation_membership_history').select('id,organization_id')
      .eq('tenant_id', args.appTenantId).eq('id', source.sourceId).maybeSingle();
    if (history.error || !history.data || history.data.organization_id !== source.linkage.ownerId
      || (organizationId && organizationId !== history.data.organization_id)) {
      fail('MEMBERSHIP_ORGANIZATION_AUTHORITY_MISMATCH');
    }
    organizationId = history.data.organization_id;
  }
  if (!organizationId) return null;
  if (!args.appTenantId) fail('MEMBERSHIP_ORGANIZATION_AUTHORITY_REQUIRED');
  const org = await db.from('organization').select('id,name')
    .eq('tenant_id', args.appTenantId).eq('id', organizationId).maybeSingle();
  if (org.error || !org.data?.name?.trim()) fail('MEMBERSHIP_ORGANIZATION_UNAVAILABLE');
  return { version: 1, organizationId: org.data.id, organizationName: org.data.name };
}

export function membershipOrganizationContactResolver(identity, expectedCompanyId, fetcher) {
  if (identity?.version !== 1 || !identity.organizationId || !identity.organizationName) fail('MEMBERSHIP_ORGANIZATION_AUTHORITY_REQUIRED');
  return async (token, companyId, contactInfo = null) => {
    if (expectedCompanyId && companyId !== expectedCompanyId) fail('INVOICE_ORGANIZATION_COMPANY_CHANGED');
    const send = (path, init = {}) => fetcher(`https://api.xero.com/api.xro/2.0/${path}`, { ...init,
      headers: { ...init.headers, Authorization: `Bearer ${token}`, 'xero-tenant-id': companyId, Accept: 'application/json' },
    });
    const providerFailure = response => {
      if (response.status === 429 || response.status >= 500) {
        throw Object.assign(new Error('XERO_ORGANIZATION_LOOKUP_RETRY_REQUIRED'), {
          code: 'XERO_ORGANIZATION_LOOKUP_RETRY_REQUIRED', status: response.status,
          retry: true, retryAfter: response.headers.get('retry-after'),
        });
      }
      fail('XERO_ORGANIZATION_LOOKUP_FAILED');
    };
    const contact = await uniqueOrganizationContact(async path => {
      const response = await send(path);
      if (!response.ok) providerFailure(response);
      return response.json();
    }, identity.organizationName, {
      // Name comes only from the trusted identity; email is creation detail only.
      email: contactInfo?.email || null,
      create: xeroOrganizationContactCreator(send, providerFailure),
    });
    return contact.ContactID;
  };
}
