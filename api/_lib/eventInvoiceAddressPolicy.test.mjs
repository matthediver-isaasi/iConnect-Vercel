import test from 'node:test';
import assert from 'node:assert/strict';
import { eventAddressContext, lookupEventXeroContact, selectedEventInvoiceAddress,
  prepareEventInvoiceAddressPolicy, loadPaidEventInvoicePolicy, policyInvoiceContact, createPolicyPaymentIntent } from './eventInvoiceAddressPolicy.js';
import { enqueueCheckoutEventInvoice } from './eventInvoiceProducer.js';
import { createEventInvoiceRecoveryXero } from './eventInvoiceRecoveryXero.js';

const address = { invoicing_address_line1: 'Personal street', invoicing_city: 'London',
  invoicing_postal_code: 'SW1A 1AA', invoicing_country: 'United Kingdom' };
const contact = { name: 'Member Buyer', email: 'member@example.test', isOrganization: false,
  provenance: { kind: 'member', id: 'member' } };
const provider = { connectionId: 'connection', xeroTenantId: 'company' };
const requestId = '10000000-0000-4000-8000-000000000001';
const existing = { ContactID: 'customer', ContactStatus: 'ACTIVE', Name: contact.name, EmailAddress: contact.email };
function fixture(overrides = {}) {
  const calls = [], stored = [];
  const rows = { event: { id: 'event' }, complex_event: { id: 'event' },
    member: { id: 'member', tenant_id: 'tenant', first_name: 'Member', last_name: 'Buyer', email: contact.email, organization_id: 'org' },
    organization: { id: 'org', name: 'Employer', invoicing_address: 'Legacy employer address' },
    tenant_accounting_settings: { active_provider: 'xero' },
    tenant_integrations: { is_enabled: true },
    system_settings: { setting_value: 'true' },
    xero_token: [{ id: 'connection', tenant_id: 'company' }],
    invoicing_address_private: address, ...overrides };
  rows.bnms_dd_beta_invoice_link ||= [];
  rows.bnms_dd_alpha_invoice_link ||= [];
  const db = { from(table) {
    const call = { table, filters: {} }; calls.push(call);
    const q = { select() { return q; }, limit() { return q; }, eq(k, v) { call.filters[k] = v; return q; }, maybeSingle() { return q; }, single() { return q; },
      insert(row) { stored.push(row); call.insert = { ...row, created_at: new Date().toISOString() }; rows[table] = call.insert; return q; },
      then(resolve, reject) { return Promise.resolve({ data: call.insert || rows[table],
        error: rows[table]?.error || null }).then(resolve, reject); } };
    return q;
  } };
  return { db, calls, stored, rows, input: { db, tenantId: 'tenant', memberId: 'member', eventId: 'event', source: 'simple', requestId, lookup: async () => null } };
}

test('exact lookup exhausts pages and rejects duplicates, archived, namesakes, errors and incomplete results', async () => {
  assert.equal(await lookupEventXeroContact(async () => ({ Contacts: [] }), contact), null);
  let calls = 0;
  assert.equal((await lookupEventXeroContact(async () => ({ Contacts: calls++ ? [] : [existing] }), contact)).ContactID, 'customer');
  assert.equal(calls, 2);
  for (const first of [[existing, { ...existing, ContactID: 'other' }], [{ ...existing, ContactStatus: 'ARCHIVED' }],
    [{ ...existing, EmailAddress: 'namesake@example.test' }], [{ ...existing, HasErrors: true }]]) {
    let i = 0;
    await assert.rejects(lookupEventXeroContact(async () => ({ Contacts: i++ ? [] : first }), contact));
  }
  await assert.rejects(lookupEventXeroContact(async () => ({}), contact));
  await assert.rejects(lookupEventXeroContact(async () => { throw new Error('offline'); }, contact));
  await assert.rejects(lookupEventXeroContact(async () => ({ Contacts: [existing] }), contact));
  await assert.rejects(lookupEventXeroContact(async () => ({ Contacts: [existing] }), { ...contact, contactId: 'different' }));
});

for (const source of ['simple', 'complex']) test(`${source}: existing customer skips all private address reads and ignores supplied address`, async () => {
  const f = fixture();
  const context = await eventAddressContext({ ...f.input, source, lookup: async () => existing });
  assert.equal(context.required, false);
  assert.equal(context.existingContactId, 'customer');
  assert.equal(f.calls.some(c => c.table === 'invoicing_address_private'), false);
  assert.equal(selectedEventInvoiceAddress(context, { mode: 'personal', address: { bad: true } }), null);
  assert.deepEqual(policyInvoiceContact({ existingContactId: 'customer' }), { ContactID: 'customer' });
});

test('new customer uses personal snapshot or server linked organization; never changes customer identity', async () => {
  const f = fixture();
  const context = await eventAddressContext(f.input);
  assert.equal(context.required, true);
  const selected = selectedEventInvoiceAddress(context, { mode: 'personal', address });
  assert.equal(selected.address.invoicing_address_line1, 'Personal street');
  assert.throws(() => selectedEventInvoiceAddress(context, { mode: 'personal', address: {} }), /required/);
  assert.throws(() => selectedEventInvoiceAddress(context, { mode: 'personal', address: { ...address, tenant_id: 'other' } }));
  assert.throws(() => selectedEventInvoiceAddress({ required: true }, { mode: 'organization' }));
  const result = await prepareEventInvoiceAddressPolicy({ ...f.input, selection: { mode: 'organization', address: { forged: true } } });
  assert.equal(result.policy.contact.name, 'Member Buyer');
  assert.equal(f.stored.length, 1);
  assert.equal(result.policy.address.address.invoicing_address_line1, 'Personal street');
  assert.equal(f.calls.filter(c => c.table === 'organization')[0].filters.tenant_id, 'tenant');
  assert.equal(f.calls.filter(c => c.table === 'organization')[0].filters.id, 'org');
});

test('known legacy ContactID is verified in the selected company; invalid mappings never become absent', async () => {
  const f = fixture();
  f.rows.member.xero_contact_id = 'customer';
  let observed;
  const context = await eventAddressContext({ ...f.input, lookup: async identity => { observed = identity; return existing; } });
  assert.equal(observed.contactId, 'customer');
  assert.equal(context.required, false);
  await assert.rejects(eventAddressContext({ ...f.input, lookup: async () => null }), /Saved Xero/);
  await assert.rejects(eventAddressContext({ ...f.input, lookup: async () => ({ ...existing, EmailAddress: 'another@example.test' }) }), /Saved Xero/);
  f.rows.member.xero_tenant_id = 'different-company';
  await assert.rejects(eventAddressContext({ ...f.input, lookup: () => assert.fail('must not look up wrong company') }), /different company/);
});

test('immutable company/member invoice mappings outrank changed email; conflicting mappings fail closed', async () => {
  const link = { tenant_id: 'tenant', member_id: 'member', xero_tenant_id: 'company', xero_contact_id: 'customer',
    evidence: { contact: { ContactID: 'customer' }, invoice: { Contact: { ContactID: 'customer' } } } };
  const f = fixture({ bnms_dd_beta_invoice_link: [link] });
  const result = await eventAddressContext({ ...f.input, lookup: async identity => {
    assert.equal(identity.contactId, 'customer');
    return { ...existing, EmailAddress: 'previous-email@example.test' };
  } });
  assert.equal(result.required, false);
  f.rows.member.xero_contact_id = 'different-customer';
  await assert.rejects(eventAddressContext(f.input), /ambiguous/);
  delete f.rows.member.xero_contact_id;
  f.rows.bnms_dd_beta_invoice_link = [{ ...link, xero_tenant_id: 'foreign-company' }];
  await assert.rejects(eventAddressContext(f.input), /inconsistent/);
  f.rows.bnms_dd_beta_invoice_link = { error: { code: 'network-error' } };
  await assert.rejects(eventAddressContext(f.input), /could not be verified/);
});

test('same request reuses original policy; edits fail and current organization/provider are not reread', async () => {
  const f = fixture();
  const input = { ...f.input, charge: { amount: 1000 }, selection: { mode: 'personal', address } };
  const first = await prepareEventInvoiceAddressPolicy(input);
  f.rows.member = null;
  const replay = await prepareEventInvoiceAddressPolicy({ ...input, lookup: () => assert.fail('no mutable provider relookup') });
  assert.deepEqual(replay, first);
  assert.equal(f.stored.length, 1);
  await assert.rejects(prepareEventInvoiceAddressPolicy({ ...input, charge: { amount: 2000 } }), /changed after/);
  await assert.rejects(prepareEventInvoiceAddressPolicy({ ...input, selection: { mode: 'organization' } }), /changed after/);
});

test('frozen Stripe parameters survive lost response, bind actual PI, and retrieve on subsequent retry', async () => {
  const f = fixture();
  const preparation = await prepareEventInvoiceAddressPolicy({ ...f.input, selection: { mode: 'personal', address } });
  const parameters = { amount: 1000, currency: 'gbp', metadata: { tenant_id: 'tenant', event_id: 'event',
    event_invoice_policy_id: preparation.id, event_invoice_member_id: 'member' } };
  const pi = { id: 'pi_frozen', ...parameters };
  const keys = [];
  let retrieved = 0;
  const stripe = { paymentIntents: {
    create: async (_parameters, options) => { keys.push(options.idempotencyKey); if (keys.length === 1) throw new Error('lost response'); return pi; },
    retrieve: async id => { assert.equal(id, pi.id); retrieved++; return pi; },
  } };
  const input = { db: f.db, stripe, preparation, parameters };
  await assert.rejects(createPolicyPaymentIntent(input), /lost response/);
  assert.equal(f.rows.event_invoice_payment_binding, undefined);
  assert.equal((await createPolicyPaymentIntent(input)).id, pi.id);
  assert.equal(keys[0], keys[1]);
  assert.equal(f.rows.event_invoice_payment_binding.payment_intent_id, pi.id);
  assert.equal((await createPolicyPaymentIntent(input)).id, pi.id);
  assert.equal(keys.length, 2);
  assert.equal(retrieved, 1);
  await assert.rejects(createPolicyPaymentIntent({ ...input, parameters: { ...parameters, amount: 1100 } }), /changed after/);
  delete f.rows.event_invoice_payment_binding;
  f.rows.event_invoice_payment_request.created_at = '2020-01-01T00:00:00Z';
  await assert.rejects(createPolicyPaymentIntent(input), /requires review/);
  assert.equal(keys.length, 2);
});

test('pre-rollout PI without markers/binding preserves legacy charge evidence; marked missing binding fails closed', async () => {
  const f = fixture();
  const input = { db: f.db, tenantId: 'tenant', eventId: 'event', source: 'booking', contact, provider,
    paymentIntent: { id: 'pi_legacy', metadata: { tenant_id: 'tenant', event_id: 'event' } } };
  assert.equal(await loadPaidEventInvoicePolicy(input), null);
  input.paymentIntent.metadata.event_invoice_policy_version = '1';
  await assert.rejects(loadPaidEventInvoicePolicy(input), /binding is missing/);
});

test('QuickBooks, disabled invoices and guest discovery unchanged; errors never mean absent', async () => {
  for (const overrides of [{ tenant_accounting_settings: { active_provider: 'quickbooks' } },
    { system_settings: { setting_value: 'false' } }]) {
    const f = fixture(overrides);
    assert.equal((await eventAddressContext({ ...f.input, lookup: () => assert.fail('No provider lookup') })).applicable, false);
  }
  const f = fixture();
  assert.equal((await eventAddressContext({ ...f.input, memberId: null })).applicable, false);
  for (const overrides of [{ member: null }, { event: null }, { xero_token: [] },
    { xero_token: [{ id: 'a', tenant_id: 'one' }, { id: 'b', tenant_id: 'two' }] },
    { tenant_accounting_settings: { error: {} } }, { tenant_integrations: { is_enabled: false } },
    { organization: null }, { invoicing_address_private: { error: {} } }]) {
    const bad = fixture(overrides);
    await assert.rejects(eventAddressContext(bad.input));
  }
});

test('frozen policy requires matching member, company, event, tenant and server PI metadata', async () => {
  const f = fixture();
  const prepared = await prepareEventInvoiceAddressPolicy({ ...f.input, selection: { mode: 'personal', address } });
  f.rows.event_invoice_address_policy = { snapshot: prepared.policy };
  f.rows.event_invoice_payment_binding = { policy_id: prepared.id };
  const input = { db: f.db, tenantId: 'tenant', eventId: 'event', source: 'booking', contact, provider,
    paymentIntent: { metadata: { event_invoice_policy_id: prepared.id, event_invoice_member_id: 'member', tenant_id: 'tenant', event_id: 'event' } } };
  assert.deepEqual(await loadPaidEventInvoicePolicy(input), prepared.policy);
  for (const change of [{ provider: { ...provider, xeroTenantId: 'other' } }, { eventId: 'other' },
    { tenantId: 'other' }, { contact: { provenance: { id: 'other' } } }, { paymentIntent: { metadata: {} } }]) {
    await assert.rejects(loadPaidEventInvoicePolicy({ ...input, ...change }));
  }
});

test('producer uses frozen personal address, not subsequent charge address; missing policy requires review', async () => {
  const f = fixture();
  const prepared = await prepareEventInvoiceAddressPolicy({ ...f.input, selection: { mode: 'personal', address } });
  f.rows.event_invoice_address_policy = { snapshot: prepared.policy };
  f.rows.event_invoice_payment_binding = { policy_id: prepared.id };
  f.rows.system_settings = [{ setting_key: 'xero_invoice_enabled', setting_value: 'true' },
    { setting_key: 'xero_stripe_bank_account_code', setting_value: '090' }];
  const originalFrom = f.db.from;
  f.db.from = table => { const q = originalFrom(table); q.in = () => q; return q; };
  const pi = { id: 'pi_test', status: 'succeeded', livemode: true, amount: 1000, amount_received: 1000, currency: 'gbp',
    metadata: { event_invoice_policy_id: prepared.id, event_invoice_member_id: 'member', tenant_id: 'tenant', event_id: 'event' },
    latest_charge: { id: 'ch_test', status: 'succeeded', livemode: true, paid: true, captured: true, amount_captured: 1000,
      currency: 'gbp', created: 1767225900, billing_details: { address: { line1: 'Never invoice this card address' } } } };
  const input = { db: f.db, tenantId: 'tenant', source: 'booking', bookingGroupReference: 'group', event: { id: 'event', tenant_id: 'tenant' },
    amount: 10, currency: 'gbp', paymentMethod: 'card', paymentIntentId: pi.id, paymentIntent: pi, contact,
    buildLines: () => [{ Description: 'Ticket', Quantity: 1, UnitAmount: 10, TaxAmount: 0, TaxType: 'NONE', AccountCode: '200', _invoiceLineAmountType: 'Inclusive' }] };
  let snapshot;
  const deps = { enqueue: async args => { snapshot = args.snapshot; return { status: 'pending' }; } };
  await enqueueCheckoutEventInvoice(input, deps);
  assert.equal(snapshot.invoice.Contact.Addresses[0].AddressLine1, 'Personal street');
  assert.equal(snapshot.contact.stripeBillingAddress, undefined);
  delete pi.metadata.event_invoice_policy_id;
  await enqueueCheckoutEventInvoice(input, deps);
  assert.equal(snapshot.invoice, null);
  assert.match(snapshot.reviewReasons.join(), /mismatch/);
});

for (const legacy of [false, true]) test(`writer strips addresses when customer appears later (legacy=${legacy})`, async () => {
  const row = { tenant_id: 'tenant', snapshot: { provider, contact, paymentMethod: 'stripe',
    invoice: { Contact: { Name: contact.name, Addresses: [{ AddressLine1: 'MUST NOT SEND' }] }, LineItems: [{ Description: 'Ticket' }] },
    ...(!legacy ? { invoiceAddressPolicy: { version: 1, tenantId: 'tenant', memberId: 'member', provider, contact,
      address: { source: 'structured', address } } } : {}) } };
  const writes = [];
  const db = { from: table => ({ select() { return this; }, eq() { return this; },
    async maybeSingle() { return { data: table === 'tenant_accounting_settings' ? { active_provider: 'xero' }
      : table === 'tenant_integrations' ? { is_enabled: true }
        : { tenant_id: 'company', access_token: 'isolated-test', expires_at: new Date(Date.now() + 3600000).toISOString() } }; } }) };
  let reads = 0;
  const writer = await createEventInvoiceRecoveryXero({ db, row, identity: 'identity', guard: async () => {},
    deadlineAt: Date.now() + 20000, fetchImpl: async (url, init) => {
      if (url.includes('Contacts')) return { ok: true, json: async () => ({ Contacts: reads++ ? [] : [existing] }) };
      writes.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ Invoices: [{ InvoiceID: 'invoice' }] }) };
    } });
  await writer.createInvoice();
  assert.deepEqual(writes[0].Invoices[0].Contact, { ContactID: 'customer' });
  assert.equal(row.snapshot.invoice.Contact.Addresses[0].AddressLine1, 'MUST NOT SEND');
});

for (const collision of [false, true]) test(`absent customer uses create-only PUT, concurrent collision cannot upsert (collision=${collision})`, async () => {
  const row = { tenant_id: 'tenant', snapshot: { provider, contact, paymentMethod: 'stripe',
    invoice: { Contact: { Name: contact.name, EmailAddress: contact.email, Addresses: [{ AddressLine1: 'Selected' }] },
      LineItems: [{ Description: 'Ticket' }] } } };
  const calls = [];
  const db = { from: table => ({ select() { return this; }, eq() { return this; },
    async maybeSingle() { return { data: table === 'tenant_accounting_settings' ? { active_provider: 'xero' }
      : table === 'tenant_integrations' ? { is_enabled: true }
        : { tenant_id: 'company', access_token: 'isolated-test', expires_at: new Date(Date.now() + 3600000).toISOString() } }; } }) };
  const writer = await createEventInvoiceRecoveryXero({ db, row, identity: 'identity', guard: async () => {},
    deadlineAt: Date.now() + 20000, fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method, body: init.body && JSON.parse(init.body) });
      if (init.method === 'GET') return { ok: true, json: async () => ({ Contacts: [] }) };
      if (url.endsWith('/Contacts')) return collision ? { ok: false, status: 400 }
        : { ok: true, json: async () => ({ Contacts: [existing] }) };
      return { ok: true, json: async () => ({ Invoices: [{ InvoiceID: 'invoice' }] }) };
    } });
  await writer.prepareInvoice();
  assert.equal(calls.length, 1, 'preparation must be read-only');
  if (collision) await assert.rejects(writer.createInvoice(), /provider_rejected/);
  else await writer.createInvoice();
  const contactWrite = calls.find(c => c.url.endsWith('/Contacts'));
  assert.equal(contactWrite.method, 'PUT');
  assert.equal(contactWrite.body.Contacts[0].ContactID, undefined);
  assert.equal(contactWrite.body.Contacts[0].Addresses[0].AddressLine1, 'Selected');
  const invoiceWrite = calls.find(c => c.url.endsWith('/Invoices'));
  if (collision) assert.equal(invoiceWrite, undefined);
  else assert.deepEqual(invoiceWrite.body.Invoices[0].Contact, { ContactID: 'customer' });
});
