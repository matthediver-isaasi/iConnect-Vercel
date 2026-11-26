import test from 'node:test';
import assert from 'node:assert/strict';
import { freezeMembershipOrganizationIdentity, membershipOrganizationContactResolver } from './membershipOrganizationIdentity.js';
import { freezeMembershipPreparation, prepareMembershipSourceRequest } from './accountingSourcePreparation.js';
import { createXeroMembershipInvoice } from './xero.js';

const source = { sourceType: 'organisation_membership_history', sourceId: 'history', linkage: { ownerId: 'org' } };
function database({ foreign = false, wrongOwner = false } = {}) {
  return { from(table) {
    const filters = {};
    return {
      select() { return this; }, eq(key, value) { filters[key] = value; return this; },
      async in() { return { data: [] }; },
      async maybeSingle() {
        if (table === 'tenant') return { data: { slug: 'fixture' } };
        assert.equal(filters.tenant_id, 'tenant');
        if (table === 'organisation_membership_history') return { data: { id: 'history', organization_id: wrongOwner ? 'other' : 'org' } };
        if (table === 'organization') return { data: foreign ? null : { id: 'org', name: ' Example University ' } };
        if (table === 'system_settings') return { data: null };
        throw new Error(`Unexpected table ${table}`);
      },
    };
  } };
}
const args = { appTenantId: 'tenant', accountingSource: source, organizationName: 'Untrusted caller name',
  invoicingEmail: 'new-billing@example.test', currency: 'GBP', membershipYear: '2026/2027', finalCost: 10 };
const identity = { version: 1, organizationId: 'org', organizationName: 'Example University' };
const contacts = [{ ContactID: 'contact', Name: '  EXAMPLE   UNIVERSITY ', EmailAddress: 'old-billing@example.test', ContactStatus: 'ACTIVE' }];
const read = async (url, init) => {
  assert.equal(init.method || 'GET', 'GET', 'Contact writes must not occur');
  assert.ok(url.includes('/Contacts?'));
  return new Response(JSON.stringify({ Contacts: contacts }), { status: 200 });
};

test('trusted identity comes from tenant-scoped records, not caller name/email', async () => {
  const result = await freezeMembershipOrganizationIdentity(database(), args);
  assert.equal(result.organizationName, ' Example University ');
  await assert.rejects(freezeMembershipOrganizationIdentity(database({ foreign: true }), args), /UNAVAILABLE/);
  await assert.rejects(freezeMembershipOrganizationIdentity(database({ wrongOwner: true }), args), /MISMATCH/);
});
test('member invoices and untyped display names do not opt into organisation matching', async () => {
  const db = { from() { assert.fail('must not look up an organisation'); } };
  assert.equal(await freezeMembershipOrganizationIdentity(db, { organizationName: 'Example University' }), null);
  assert.equal(await freezeMembershipOrganizationIdentity(db, { ...args, accountingSource: { sourceType: 'member_membership_history' } }), null);
});
test('unique normalized organisation name ignores email without contact mutation', async () => {
  const resolver = membershipOrganizationContactResolver(identity, 'company', read);
  assert.equal(await resolver('fixture-token', 'company', { email: args.invoicingEmail }), 'contact');
  await assert.rejects(resolver('fixture-token', 'other'), /COMPANY_CHANGED/);
});
test('ambiguous contacts fail closed without creating a contact', async () => {
  const resolver = membershipOrganizationContactResolver(identity, 'company', async (url, init) => {
    assert.equal(init.method || 'GET', 'GET', 'Ambiguity must never create a contact');
    return new Response(JSON.stringify({ Contacts: [contacts[0], { ...contacts[0], ContactID: 'second' }] }), { status: 200 });
  });
  await assert.rejects(resolver('fixture-token', 'company'), /AMBIGUOUS/);
});
test('no active match creates one organisation contact from the trusted name', async () => {
  for (const existing of [[], [{ ...contacts[0], ContactStatus: 'ARCHIVED' }]]) {
    const writes = [];
    const resolver = membershipOrganizationContactResolver(identity, 'company', async (url, init) => {
      if ((init.method || 'GET') === 'GET') return new Response(JSON.stringify({ Contacts: existing }), { status: 200 });
      assert.equal(init.method, 'PUT');
      assert.ok(url.endsWith('/Contacts'));
      writes.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ Contacts: [{ ContactID: 'created', Name: 'Example University', ContactStatus: 'ACTIVE' }] }), { status: 200 });
    });
    assert.equal(await resolver('fixture-token', 'company', { name: 'Untrusted caller name', email: 'billing@example.test' }), 'created');
    assert.deepEqual(writes, [{ Contacts: [{ Name: 'Example University', EmailAddress: 'billing@example.test' }] }]);
  }
});
test('creation throttling is retryable and an unverifiable creation fails', async () => {
  const throttled = membershipOrganizationContactResolver(identity, 'company', async (url, init) =>
    (init.method || 'GET') === 'GET' ? new Response('{"Contacts":[]}', { status: 200 })
      : new Response('{}', { status: 429, headers: { 'retry-after': '30' } }));
  await assert.rejects(throttled('fixture-token', 'company'), error => error.retry === true && error.status === 429);
  const mismatched = membershipOrganizationContactResolver(identity, 'company', async (url, init) =>
    new Response(JSON.stringify({ Contacts: (init.method || 'GET') === 'GET' ? []
      : [{ ContactID: 'created', Name: 'Different name', ContactStatus: 'ACTIVE' }] }), { status: 200 }));
  await assert.rejects(mismatched('fixture-token', 'company'), /CREATE_FAILED/);
});
test('provider throttling is retryable and never treated as a missing contact', async () => {
  const resolver = membershipOrganizationContactResolver(identity, 'company',
    async () => new Response('{}', { status: 429, headers: { 'retry-after': '60' } }));
  await assert.rejects(resolver('fixture-token', 'company'), error =>
    error.status === 429 && error.retry === true && error.retryAfter === '60');
});
test('new queued preparation carries verified identity and resolves despite a different email', async () => {
  const invoice = await freezeMembershipPreparation({ db: database(), args, totalMinor: 1000 });
  assert.equal(invoice.organizationIdentity.organizationId, 'org');
  const row = { tenant_id: 'tenant', provider: 'xero', company_id: 'company', source_type: source.sourceType,
    source_id: 'history', snapshot: { preparation: true, invoice, linkage: source.linkage, payment: null } };
  const result = await prepareMembershipSourceRequest({ row, transport: {
    fetch: read, resolveConnection: async () => ({ accessToken: 'fixture-token', companyId: 'company' }),
  } });
  assert.equal(result.invoice.envelope.expected.contactId, 'contact');
  assert.equal(row.snapshot.preparation, true, 'stored request is not rewritten');
  await assert.rejects(prepareMembershipSourceRequest({ row: { ...row, snapshot: { ...row.snapshot, linkage: { ownerId: 'other' } } }, transport: { fetch: read } }), /MISMATCH/);
});
test('direct membership invoice preparation uses the same resolver without issuing an invoice', async () => {
  const prepared = await createXeroMembershipInvoice(args, {
    supabase: database(), prepareOnly: true, fetch: read,
    getValidXeroAccessToken: async () => ({ accessToken: 'fixture-token', tenantId: 'company' }),
  });
  assert.equal(prepared.contactId, 'contact');
});
test('legacy frozen requests do not acquire new organisation identity during replay', async () => {
  const invoice = await freezeMembershipPreparation({ db: database(), args: { ...args, accountingSource: undefined }, totalMinor: 1000 });
  const row = { tenant_id: 'tenant', provider: 'xero', company_id: 'company', source_type: source.sourceType,
    source_id: 'history', snapshot: { preparation: true, invoice, linkage: source.linkage, payment: null } };
  await prepareMembershipSourceRequest({ row, transport: {} }, { prepare: async (_args, dependencies) => {
    assert.equal(dependencies.findOrCreateXeroContact, undefined);
    return { companyId: 'company', contactId: 'contact', payload: { Type: 'ACCREC', Status: 'DRAFT', LineItems: [] } };
  } });
});

test('existing organisation contact receives the invoice address (Xero shows it on earlier invoices too)', async () => {
  const writes = [];
  const resolver = membershipOrganizationContactResolver(identity, 'company', async (url, init = {}) => {
    if ((init.method || 'GET') === 'GET') return new Response(JSON.stringify({ Contacts: contacts }), { status: 200 });
    const body = JSON.parse(init.body);
    writes.push(body);
    return new Response(JSON.stringify({ Contacts: [{ ...contacts[0], Addresses: body.Contacts[0].Addresses }] }), { status: 200 });
  });
  assert.equal(await resolver('fixture-token', 'company', { email: args.invoicingEmail,
    address: '1 Main Street\nCambridge\nCB1 1AA' }), 'contact');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].Contacts[0], { ContactID: 'contact', Addresses: [{ AddressType: 'POBOX',
    AddressLine1: '1 Main Street', City: 'Cambridge', PostalCode: 'CB1 1AA' }] });
  // Never overwrites the contact's email; no address means no write.
  assert.equal('EmailAddress' in writes[0].Contacts[0], false);
  assert.equal(await resolver('fixture-token', 'company', { email: args.invoicingEmail }), 'contact');
  assert.equal(writes.length, 1);
});

test('unverified organisation address update fails closed before invoicing', async () => {
  const resolver = membershipOrganizationContactResolver(identity, 'company', async (url, init = {}) =>
    (init.method || 'GET') === 'GET' ? new Response(JSON.stringify({ Contacts: contacts }), { status: 200 })
      : new Response(JSON.stringify({ Contacts: [{ ...contacts[0], Addresses: [] }] }), { status: 200 }));
  await assert.rejects(resolver('fixture-token', 'company', { address: '1 Main Street' }), /ADDRESS_UNVERIFIED/);
});
