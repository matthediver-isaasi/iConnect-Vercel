import { getValidXeroAccessToken } from './xero.js';
import { fetchFormAccountingTransport } from './formAccountingTransport.js';
import { createFormRelationshipService } from './formRelationshipOptions.js';
import { isOrganizationEligibleForField } from './organizationEligibility.js';
import { conditionalSelectionAllowed, resolveConditionalFilter } from './formConditionalFilters.js';
import { INVOICING_ADDRESS_KEYS } from '../../shared/invoicingAddress.js';
import { structuredInvoiceAddress } from '../../shared/formInvoiceBilling.js';

export const normalizeOrganizationName = value => String(value || '').trim().replace(/\s+/gu, ' ').toLowerCase();
const fail = code => { throw Object.assign(new Error(code), { code, permanent: true, status: 409 }); };

export async function readOrganizationInvoiceBilling(db, tenantId, organization) {
  const email = typeof organization.invoicing_email === 'string' ? organization.invoicing_email.trim() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw Object.assign(new Error('The selected organisation needs a valid invoicing email on its account.'), { status:400 });
  }
  const stored = await db.from('invoicing_address_private').select(INVOICING_ADDRESS_KEYS.join(','))
    .eq('tenant_id', tenantId).eq('owner_type', 'organization').eq('owner_id', organization.id).maybeSingle();
  if (stored.error) fail('INVOICE_ORGANIZATION_ADDRESS_UNAVAILABLE');
  try { return { name: organization.name, email, address: structuredInvoiceAddress(stored.data) }; }
  catch (error) { throw Object.assign(new Error(`Organisation invoice details: ${error.message}`), { status:400 }); }
}

const VALID_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function discoverOrganizationContact(read, expected) {
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
    if (result.Contacts.length < 100) return matches.size ? [...matches.values()][0] : null;
  }
  fail('XERO_CONTACT_DISCOVERY_INCOMPLETE');
}

/**
 * Owner-approved policy: when exhaustive normalized-name discovery proves no
 * active contact exists, create one for the verified organisation. Ambiguous,
 * invalid and incomplete discovery still fail closed; nothing is ever updated.
 * Xero rejects duplicate active names, so a concurrent or previously
 * timed-out creation is resolved by rediscovering rather than creating twice.
 */
export async function uniqueOrganizationContact(read, name, { create = null, email = null } = {}) {
  const expected = normalizeOrganizationName(name);
  if (!expected) fail('INVOICE_ORGANIZATION_NAME_REQUIRED');
  const found = await discoverOrganizationContact(read, expected);
  if (found) return found;
  if (!create) fail('XERO_ORGANIZATION_CONTACT_NOT_FOUND');
  const contact = { Name: String(name).trim().replace(/\s+/gu, ' ') };
  const trimmedEmail = typeof email === 'string' ? email.trim() : '';
  if (VALID_EMAIL.test(trimmedEmail) && trimmedEmail.length <= 254) contact.EmailAddress = trimmedEmail;
  const outcome = await create({ Contacts: [contact] });
  if (outcome?.rejected) {
    const existing = await discoverOrganizationContact(read, expected);
    if (existing) return existing;
    fail('XERO_ORGANIZATION_CONTACT_CREATE_FAILED');
  }
  const created = outcome?.body?.Contacts;
  if (!Array.isArray(created) || created.length !== 1 || !created[0].ContactID
    || created[0].ContactStatus !== 'ACTIVE' || created[0].HasErrors || created[0].HasValidationErrors
    || created[0].ValidationErrors?.length || normalizeOrganizationName(created[0].Name) !== expected) {
    fail('XERO_ORGANIZATION_CONTACT_CREATE_FAILED');
  }
  return created[0];
}

/** PUT is create-only in Xero; a 400 means it refused (e.g. duplicate name). */
export function xeroOrganizationContactCreator(send, onTransportFailure) {
  return async payload => {
    const response = await send('Contacts', {
      method: 'PUT', body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' },
    });
    if (response.status === 400) return { rejected: true };
    if (!response.ok) return onTransportFailure(response);
    return { body: await response.json() };
  };
}

export async function freezeFormOrganizationCustomer({ db, tenantId, form, field, values, binding }, dependencies = {}) {
  const source = form.fields.find(f => f.id === (field.invoice_billing_source === 'organization'
    ? field.invoice_organization_field_id : field.invoice_billing_name_field_id));
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
  let billing;
  if (field.invoice_billing_source === 'organization') {
    billing = await readOrganizationInvoiceBilling(db, tenantId, result.data);
  }
  const tokens = await (dependencies.tokens || getValidXeroAccessToken)(tenantId);
  if (tokens.tenantId !== binding.companyId) fail('INVOICE_ORGANIZATION_COMPANY_CHANGED');
  const deadlineAt = Date.now() + 15000;
  const send = (path, init = {}) => fetchFormAccountingTransport(dependencies.fetch || fetch,
    `https://api.xero.com/api.xro/2.0/${path}`, { ...init,
      headers: { ...init.headers, Authorization: `Bearer ${tokens.accessToken}`, 'xero-tenant-id': tokens.tenantId, Accept: 'application/json' },
    }, { deadlineAt, timeoutMs: 5000 });
  const read = async path => {
    const response = await send(path);
    if (!response.ok) fail('XERO_ORGANIZATION_LOOKUP_FAILED');
    return response.json();
  };
  const contact = await uniqueOrganizationContact(read, result.data.name, {
    email: billing?.email ?? result.data.invoicing_email,
    create: xeroOrganizationContactCreator(send, () => fail('XERO_ORGANIZATION_CONTACT_CREATE_FAILED')),
  });
  return { version: 1, organizationId: id, organizationName: result.data.name,
    contactId: contact.ContactID, companyId: binding.companyId, connectionId: binding.connectionId,
    matchPolicy: 'unique_normalized_name', ...(billing ? { billing } : {}) };
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
