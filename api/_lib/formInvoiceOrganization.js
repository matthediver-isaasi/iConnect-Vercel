import { getValidXeroAccessToken } from './xero.js';
import { fetchFormAccountingTransport } from './formAccountingTransport.js';
import { createFormRelationshipService } from './formRelationshipOptions.js';
import { isOrganizationEligibleForField } from './organizationEligibility.js';
import { conditionalSelectionAllowed, resolveConditionalFilter } from './formConditionalFilters.js';

export const normalizeOrganizationName = value => String(value || '').trim().replace(/\s+/gu, ' ').toLowerCase();
const fail = code => { throw Object.assign(new Error(code), { code, permanent: true, status: 409 }); };

export async function uniqueOrganizationContact(read, name) {
  const expected = normalizeOrganizationName(name);
  if (!expected) fail('INVOICE_ORGANIZATION_NAME_REQUIRED');
  const matches = new Map();
  const seen = new Set();
  // Exhaust active contacts: server-side name equality cannot account for
  // internal whitespace. Never accept a first-page match as unique.
  for (let page = 1; page <= 100; page++) {
    const result = await read(`Contacts?page=${page}&pageSize=100&includeArchived=false`);
    if (!Array.isArray(result?.Contacts)) fail('XERO_CONTACT_DISCOVERY_INCOMPLETE');
    for (const contact of result.Contacts) {
      if (!contact.ContactID || seen.has(contact.ContactID)) fail('XERO_CONTACT_DISCOVERY_INCOMPLETE');
      seen.add(contact.ContactID);
      if (contact.ContactStatus === 'ACTIVE' && normalizeOrganizationName(contact.Name) === expected) {
        if (contact.HasErrors || contact.ValidationErrors?.length) fail('XERO_ORGANIZATION_CONTACT_INVALID');
        matches.set(contact.ContactID, contact);
      }
    }
    if (matches.size > 1) fail('XERO_ORGANIZATION_CONTACT_AMBIGUOUS');
    if (result.Contacts.length < 100) {
      if (matches.size !== 1) fail('XERO_ORGANIZATION_CONTACT_NOT_FOUND');
      return [...matches.values()][0];
    }
  }
  fail('XERO_CONTACT_DISCOVERY_INCOMPLETE');
}

export async function freezeFormOrganizationCustomer({ db, tenantId, form, field, values, binding }, dependencies = {}) {
  const source = form.fields.find(f => f.id === field.invoice_billing_name_field_id);
  const id = values[source?.id];
  if (source?.type !== 'organisation_dropdown' || typeof id !== 'string'
    || !/^[0-9a-f-]{36}$/i.test(id)) fail('INVOICE_ORGANIZATION_SELECTION_REQUIRED');
  await createFormRelationshipService({ db, tenantId }).validateSubmission({ form, submissionData: values });
  const result = await db.from('organization').select('*').eq('tenant_id', tenantId).eq('id', id).maybeSingle();
  if (result.error || !result.data) fail('INVOICE_ORGANIZATION_UNAVAILABLE');
  // Billing authority must not inherit renewal-only retained-selection bypasses,
  // or skip eligibility because the source field was hidden during validation.
  const conditional = resolveConditionalFilter(source, values, form.fields);
  if (!conditionalSelectionAllowed(id, conditional)
    || !await isOrganizationEligibleForField({ db, tenantId, organization: result.data, field: source })
    || (conditional.orgFilter && !await isOrganizationEligibleForField({
      db, tenantId, organization: result.data, field: { org_filter: conditional.orgFilter },
    }))) fail('INVOICE_ORGANIZATION_SELECTION_NOT_ALLOWED');
  const tokens = await (dependencies.tokens || getValidXeroAccessToken)(tenantId);
  if (tokens.tenantId !== binding.companyId) fail('INVOICE_ORGANIZATION_COMPANY_CHANGED');
  const deadlineAt = Date.now() + 15000;
  const read = async path => {
    const response = await fetchFormAccountingTransport(dependencies.fetch || fetch,
      `https://api.xero.com/api.xro/2.0/${path}`, {
        headers: { Authorization: `Bearer ${tokens.accessToken}`, 'xero-tenant-id': tokens.tenantId, Accept: 'application/json' },
      }, { deadlineAt, timeoutMs: 5000 });
    if (!response.ok) fail('XERO_ORGANIZATION_LOOKUP_FAILED');
    return response.json();
  };
  const contact = await uniqueOrganizationContact(read, result.data.name);
  return { version: 1, organizationId: id, organizationName: result.data.name,
    contactId: contact.ContactID, companyId: binding.companyId, connectionId: binding.connectionId,
    matchPolicy: 'unique_normalized_name' };
}

export async function verifyFrozenOrganizationContact(customer, companyId, read) {
  if (customer?.version !== 1 || customer.companyId !== companyId || !customer.organizationId
    || !/^[0-9a-f-]{36}$/i.test(customer.contactId || '')) fail('INVOICE_ORGANIZATION_BINDING_INVALID');
  const response = await read(`Contacts/${encodeURIComponent(customer.contactId)}`);
  const contacts = response?.Contacts;
  if (!Array.isArray(contacts) || contacts.length !== 1 || contacts[0].ContactID !== customer.contactId
    || contacts[0].ContactStatus !== 'ACTIVE' || contacts[0].HasErrors || contacts[0].ValidationErrors?.length) {
    fail('XERO_ORGANIZATION_CONTACT_UNAVAILABLE');
  }
  return customer.contactId;
}
