import test from 'node:test';
import assert from 'node:assert/strict';
import { uniqueOrganizationContact, normalizeOrganizationName, verifyFrozenOrganizationContact, freezeFormOrganizationCustomer, xeroOrganizationContactCreator } from './formInvoiceOrganization.js';
import { invoiceBillingDetails, prepareFormInvoiceSource } from './formInvoiceOrder.js';
const id = '837cb871-b1ae-472a-8381-bbaaf8efe919';
const contact = { ContactID: id, Name: '  Example \t COMPANY  ', ContactStatus: 'ACTIVE' };
test('free-text, missing, not-listed and cross-tenant organisations cannot establish a contact binding', async () => {
  const field = { invoice_billing_name_field_id: 'org' };
  const form = { fields: [{ id: 'org', type: 'organisation_dropdown' }] };
  const db = { from(table) {
    assert.equal(table, 'organization');
    const query = { select() { return query; }, eq() { return query; }, async maybeSingle() { return { data: null, error: null }; } };
    return query;
  } };
  const dependencies = { tokens: async () => { throw new Error('Provider must not be contacted'); } };
  for (const value of [undefined, 'Example Company', '__not_listed__', id]) {
    await assert.rejects(freezeFormOrganizationCustomer({ db, tenantId: 'tenant', field, form,
      values: { org: value }, binding: {} }, dependencies),
    error => !/Provider must not be contacted/.test(error.message));
  }
  await assert.rejects(freezeFormOrganizationCustomer({ db, tenantId: 'tenant', field,
    form: { fields: [{ id: 'org', type: 'text' }] }, values: { org: id }, binding: {} }, dependencies));
});
test('organisation matching normalizes case and all whitespace without requiring an email', async () => {
  assert.equal(normalizeOrganizationName(' Example\n  Company '), 'example company');
  assert.equal((await uniqueOrganizationContact(async () => ({ Contacts: [contact] }), 'example company')).ContactID, id);
});
test('duplicates after normalization, missing, archived and incomplete results fail closed', async () => {
  for (const contacts of [[], [{ ...contact, ContactStatus: 'ARCHIVED' }],
    [contact, { ...contact, ContactID: 'other', Name: 'example company' }]]) {
    await assert.rejects(uniqueOrganizationContact(async () => ({ Contacts: contacts }), 'example company'));
  }
  await assert.rejects(uniqueOrganizationContact(async () => ({}), 'example company'));
});
test('discovery checks later pages before accepting uniqueness', async () => {
  const first = [contact, ...Array.from({ length: 99 }, (_, i) => ({ ContactID: `other-${i}`, Name: 'Other', ContactStatus: 'ACTIVE' }))];
  let calls = 0;
  await assert.rejects(uniqueOrganizationContact(async () => ({ Contacts: ++calls === 1 ? first :
    [{ ...contact, ContactID: 'duplicate', Name: 'EXAMPLE COMPANY' }] }), 'example company'), /AMBIGUOUS/);
  assert.equal(calls, 2);
});
test('replay reads the frozen contact ID, not its current name or email', async () => {
  const customer = { version: 1, companyId: 'company', contactId: id, organizationId: 'org' };
  let calls = 0;
  const read = async path => { calls++; assert.equal(path, `Contacts/${id}`); return { Contacts: [{ ...contact, Name: 'Renamed company' }] }; };
  assert.equal(await verifyFrozenOrganizationContact(customer, 'company', read), id);
  await assert.rejects(verifyFrozenOrganizationContact(customer, 'different', read));
  assert.equal(calls, 1);
  await assert.rejects(verifyFrozenOrganizationContact(customer, 'company', async () => ({ Contacts: [{ ...contact, ContactStatus: 'ARCHIVED' }] })));
});
test('organisation billing mapping keeps purchaser email and accepts only the actual dropdown type', () => {
  const mapping = { invoice_billing_name_field_id: 'org', invoice_billing_email_field_id: 'email' };
  assert.equal(invoiceBillingDetails(mapping, [{ id: 'org', type: 'organisation_dropdown' }, { id: 'email', type: 'email' }],
    { org: 'org-id', email: 'purchaser@example.invalid' }).email, 'purchaser@example.invalid');
});
test('real source preparation uses frozen contact without contact mutations and retains original invoice lines', async () => {
  const customer = { version: 1, companyId: 'company', connectionId: 'connection', contactId: id, organizationId: 'org' };
  const row = { tenant_id: 'tenant', provider: 'xero', company_id: 'company', connection_id: 'connection',
    source_type: 'form_invoice_order', source_id: 'submission', snapshot: { version: 1, preparation: true,
      organizationCustomer: customer, payment: null, lines: [{ description: 'Stand', quantity: 1, netMinor: 10000, taxMinor: 2000, grossMinor: 12000, taxCode: 'OUTPUT2', accountCode: '210' }],
      linkage: { formId: 'form' }, invoice: { totalMinor: 12000, settings: {}, invoiceDate: '2026-11-19', dueDate: '2026-12-19',
        args: { appTenantId: 'tenant', organizationName: 'Example Company', currency: 'GBP', invoicingEmail: 'purchaser@example.invalid' } } } };
  let reads = 0;
  const prepared = await prepareFormInvoiceSource({ row, transport: { fetch: async (url, init) => {
    reads++; assert.ok(url.endsWith(`/Contacts/${id}`)); assert.equal(init.method, undefined);
    return Response.json({ Contacts: [contact] });
  } } }, { prepare: async (args, options) => {
    assert.equal(args.invoicingEmail, 'purchaser@example.invalid');
    const contactId = await options.findOrCreateXeroContact('fixture', 'company');
    return { companyId: 'company', contactId, payload: { Type: 'ACCREC', Status: 'AUTHORISED', Contact: { ContactID: contactId }, LineItems: [{ UnitAmount: 120 }] } };
  } });
  assert.equal(reads, 1);
  assert.equal(prepared.invoice.envelope.expected.contactId, id);
  assert.equal(prepared.invoice.envelope.expected.totalMinor, 12000);
  assert.deepEqual(prepared.organizationCustomer, customer);
  assert.equal(prepared.payment, null);
});

test('missing contact is created only after exhaustive discovery finds no active match', async () => {
  let reads = 0;
  const payloads = [];
  const created = await uniqueOrganizationContact(async () => { reads++; return { Contacts: [{ ...contact, ContactStatus: 'ARCHIVED' }] }; },
    '  Example \n Company ', { email: ' billing@example.invalid ', create: async payload => {
      payloads.push(payload);
      return { body: { Contacts: [{ ContactID: 'new', Name: 'Example Company', ContactStatus: 'ACTIVE' }] } };
    } });
  assert.equal(created.ContactID, 'new');
  assert.equal(reads, 1);
  assert.deepEqual(payloads, [{ Contacts: [{ Name: 'Example Company', EmailAddress: 'billing@example.invalid' }] }]);
  // Invalid emails are omitted rather than sent to Xero.
  await uniqueOrganizationContact(async () => ({ Contacts: [] }), 'Example Company', { email: 'not-an-email',
    create: async payload => { assert.deepEqual(payload, { Contacts: [{ Name: 'Example Company' }] });
      return { body: { Contacts: [{ ContactID: 'new', Name: 'Example Company', ContactStatus: 'ACTIVE' }] } }; } });
});
test('a refused creation (duplicate name race) rediscovers instead of creating twice', async () => {
  let reads = 0;
  let creates = 0;
  const found = await uniqueOrganizationContact(async () => ({ Contacts: ++reads === 1 ? [] : [contact] }),
    'example company', { create: async () => { creates++; return { rejected: true }; } });
  assert.equal(found.ContactID, id);
  assert.equal(creates, 1);
  await assert.rejects(uniqueOrganizationContact(async () => ({ Contacts: [] }), 'example company',
    { create: async () => ({ rejected: true }) }), /CREATE_FAILED/);
});
test('ambiguous or incomplete discovery never creates a contact', async () => {
  const create = async () => assert.fail('must not create');
  await assert.rejects(uniqueOrganizationContact(async () => ({ Contacts: [contact, { ...contact, ContactID: 'other' }] }),
    'example company', { create }), /AMBIGUOUS/);
  await assert.rejects(uniqueOrganizationContact(async () => ({}), 'example company', { create }), /INCOMPLETE/);
});
test('Xero creator uses create-only PUT and treats 400 as a refusal', async () => {
  const calls = [];
  const creator = xeroOrganizationContactCreator(async (path, init) => {
    calls.push([path, init.method]);
    return new Response('{"Elements":[]}', { status: 400 });
  }, () => assert.fail('400 is not a transport failure'));
  assert.deepEqual(await creator({ Contacts: [{ Name: 'X' }] }), { rejected: true });
  assert.deepEqual(calls, [['Contacts', 'PUT']]);
});
