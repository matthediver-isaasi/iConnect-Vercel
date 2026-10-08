import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  accountingQueueEnabled, accountingMembershipQueueEnabled, accountingQueueFacadeResult, assertAccountingSource,
  getAccountingQueueAdapter, linkAccountingMembershipSource,
  prepareMembershipAccountingRequest, queueMembershipInvoice,
  resolveAccountingQueueBinding, resumeAccountingSource, submitPreparedAccountingRequest,
  supportsPreparedMembershipSource,
} from './accountingQueueIntegration.js';
import { prepareAccountingRequestEnvelope } from './accountingRequestProviders.js';

const tenant = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function database(tables, rpc = async () => ({ data: null, error: null })) {
  const writes = [];
  return { writes, rpc, from(table) {
    const filters = [];
    let update;
    const query = {
      select() { return query; },
      eq(key, value) { filters.push(row => row[key] === value); return query; },
      is(key, value) { filters.push(row => (row[key] ?? null) === value); return query; },
      update(value) { update = value; return query; },
      async maybeSingle() { return execute(true); },
      then(resolve, reject) { return Promise.resolve(execute(false)).then(resolve, reject); },
    };
    function execute(single) {
      const matches = (tables[table] || []).filter(row => filters.every(fn => fn(row)));
      if (update) {
        writes.push({ table, update });
        matches.forEach(row => Object.assign(row, update));
      }
      return { data: single ? matches[0] || null : matches, error: null };
    }
    return query;
  } };
}
const source = () => ({ id: 'record', tenant_id: tenant, member_id: 'member', payment_status: 'pending' });
function request(provider = 'xero') {
  return { id: 'request', tenant_id: tenant, provider, connection_id: 'connection', company_id: 'company',
    source_type: 'member_membership_history', source_id: 'record', operation: 'invoice', state: 'pending',
    snapshot: { version: 1, linkage: { recordId: 'record', ownerId: 'member' }, payment: null },
    invoice_result: { id: 'invoice', invoiceNumber: 'INV-1' } };
}
const args = () => ({ appTenantId: tenant, currency: 'GBP', finalCost: 10,
  accountingSource: { sourceType: 'member_membership_history', sourceId: 'record',
    totalMinor: 1000, linkage: { recordId: 'record', ownerId: 'member' },
    notification: { memberId: 'member', memberEmail: 'test@example.invalid',
      membershipYear: '2026', note: 'Membership renewed.' } } });
function envelope(provider = 'xero') {
  return prepareAccountingRequestEnvelope({ provider, operationKey: 'stable-operation', environment: provider === 'quickbooks' ? 'production' : undefined,
    payload: provider === 'xero' ? { Type: 'ACCREC', Reference: 'Membership' } : { PrivateNote: 'Membership' },
    expected: { contactId: 'contact', currency: 'GBP', totalMinor: 1000,
      fields: provider === 'xero' ? { Type: 'ACCREC' } : { CustomerRef: { value: 'contact' } } } });
}

test('rollout defaults OFF and prepared source allowlist excludes independent owners', () => {
  const previous = process.env.ACCOUNTING_REQUEST_QUEUE_ENABLED;
  const previousSources = process.env.ACCOUNTING_REQUEST_QUEUE_SOURCES;
  try {
    delete process.env.ACCOUNTING_REQUEST_QUEUE_ENABLED;
    assert.equal(accountingQueueEnabled(), false);
    process.env.ACCOUNTING_REQUEST_QUEUE_ENABLED = 'true';
    delete process.env.ACCOUNTING_REQUEST_QUEUE_SOURCES;
    assert.equal(accountingMembershipQueueEnabled('member_membership_history'), false);
    process.env.ACCOUNTING_REQUEST_QUEUE_SOURCES = 'member_membership_history';
    assert.equal(accountingMembershipQueueEnabled('member_membership_history'), true);
    assert.equal(accountingMembershipQueueEnabled('organisation_membership_history'), false);
    assert.equal(accountingMembershipQueueEnabled('arbitrary_table'), false);
    assert.equal(supportsPreparedMembershipSource(args()), true);
    for (const extra of [{ markAsPaid: true }, { deferStripeSettlement: true },
      { stripePaymentIntentId: 'pi_exact' }, { ddAccountingMigration: {} }, { extraLineItems: [{}] }]) {
      assert.equal(supportsPreparedMembershipSource({ ...args(), ...extra }), false);
    }
    assert.equal(supportsPreparedMembershipSource({}), false);
  } finally {
    if (previous === undefined) delete process.env.ACCOUNTING_REQUEST_QUEUE_ENABLED;
    else process.env.ACCOUNTING_REQUEST_QUEUE_ENABLED = previous;
    if (previousSources === undefined) delete process.env.ACCOUNTING_REQUEST_QUEUE_SOURCES;
    else process.env.ACCOUNTING_REQUEST_QUEUE_SOURCES = previousSources;
  }
});

for (const provider of ['xero', 'quickbooks']) {
  test(`${provider} linkage is scoped, idempotent, accounting-only and verifies persistence`, async () => {
    const history = source();
    const db = database({ member_membership_history: [history] });
    const row = request(provider);
    assert.deepEqual(await linkAccountingMembershipSource({ db, row }), { linked: true, recordId: 'record' });
    await linkAccountingMembershipSource({ db, row });
    assert.equal(db.writes.length, 1);
    assert.equal(history.accounting_invoice_id, 'invoice');
    assert.equal(history.accounting_provider, provider);
    assert.equal(history.xero_invoice_id, provider === 'xero' ? 'invoice' : undefined);
    assert.equal(history.payment_status, 'pending');
    assert.ok(Object.keys(db.writes[0].update).every(key => /^(accounting_|xero_)/.test(key)));
  });
  test(`${provider} producer extracts before write and freezes binding and exact economics`, async () => {
    const db = database({
      tenant_accounting_settings: [{ tenant_id: tenant, active_provider: provider }],
      [provider === 'xero' ? 'xero_token' : 'quickbooks_token']: [{
        app_tenant_id: tenant, id: 'connection', tenant_id: 'company', realm_id: 'company',
        environment: 'production', access_token: 'must-not-persist',
      }],
    });
    let called = 0;
    const prepared = await prepareMembershipAccountingRequest({
      db, provider, args: args(), ...args().accountingSource,
    }, { prepare: async (_args, dependencies) => {
      assert.equal(dependencies.prepareOnly, true);
      called++;
      return { companyId: 'company', environment: 'production', contactId: 'contact',
        payload: provider === 'xero'
          ? { Type: 'ACCREC', Status: 'DRAFT', LineItems: [{ UnitAmount: '10.00', Quantity: 1, TaxType: 'NONE' }] }
          : { CustomerRef: { value: 'contact' }, Line: [{ Amount: 10 }], GlobalTaxCalculation: 'TaxExcluded' } };
    } });
    assert.equal(called, 1);
    assert.equal(prepared.invoiceEnvelope.expected.totalMinor, 1000);
    assert.equal(prepared.connectionId, 'connection');
    assert.equal(prepared.paymentEnvelope, null);
    assert.ok(Object.isFrozen(prepared.invoiceEnvelope));
    assert.equal(JSON.stringify(prepared.invoiceEnvelope).includes('must-not-persist'), false);
  });
}

test('foreign tenant, wrong owner, form ownership and competing links fail closed', async () => {
  for (const change of [{ tenant_id: 'other' }, { member_id: 'other' }, { form_submission_id: 'form' },
    { accounting_invoice_id: 'different' }, { accounting_invoice_id: 'invoice', accounting_provider: 'quickbooks' }]) {
    const db = database({ member_membership_history: [{ ...source(), ...change }] });
    await assert.rejects(linkAccountingMembershipSource({ db, row: request() }));
    assert.equal(db.writes.length, 0);
  }
  await assert.rejects(assertAccountingSource({ db: database({}), row: { ...request(), source_type: 'arbitrary_table' } }), /UNSUPPORTED_SOURCE/);
});

test('accepted pending survives worker persistence failure, without legacy replay', async () => {
  const calls = [];
  const row = request();
  delete row.invoice_result;
  const db = database({}, async (name, values) => {
    calls.push(name);
    if (name === 'accounting_request_enqueue') {
      assert.equal(values.p_snapshot.payment, null);
      return { data: row, error: null };
    }
    throw new Error('worker persistence unavailable');
  });
  const result = await submitPreparedAccountingRequest({ db, tenantId: tenant, provider: 'xero',
    connectionId: 'connection', companyId: 'company', sourceType: row.source_type,
    sourceId: row.source_id, invoiceEnvelope: envelope(), linkage: row.snapshot.linkage });
  assert.equal(result.accounting_pending, true);
  assert.equal(result.accounting_request_id, 'request');
  assert.equal(result.invoiceId, undefined);
  assert.deepEqual(calls, ['accounting_request_enqueue', 'accounting_request_claim']);
});

test('lost enqueue response instructs advance callers to retain genuine history', async () => {
  const row = request();
  const db = database({}, async () => ({ data: null, error: { code: '57014' } }));
  await assert.rejects(submitPreparedAccountingRequest({ db, tenantId: tenant, provider: 'xero',
    connectionId: 'connection', companyId: 'company', sourceType: row.source_type,
    sourceId: row.source_id, invoiceEnvelope: envelope(), linkage: row.snapshot.linkage }),
  error => error.accountingSourceRetained === true);
  const handler = readFileSync(new URL('../membership/org-membership-invoicing.js', import.meta.url), 'utf8');
  assert.ok(handler.indexOf('if (xeroErr.accountingSourceRetained)') < handler.indexOf(".delete()"));
});

test('retry resumes immutable request before inspecting todays paid/addon arguments', async () => {
  const row = request();
  const db = database({ accounting_request_queue: [row] });
  const result = await queueMembershipInvoice({ db, provider: 'quickbooks',
    args: { ...args(), finalCost: 999, markAsPaid: true, extraLineItems: [{}] } });
  assert.equal(result.provider, 'xero');
  assert.equal(result.accounting_request_id, 'request');
  assert.equal(db.writes.length, 0);
});

test('turning rollout OFF never hands an accepted membership identity back to legacy writer', async () => {
  const old = process.env.ACCOUNTING_REQUEST_QUEUE_ENABLED;
  try {
    process.env.ACCOUNTING_REQUEST_QUEUE_ENABLED = 'false';
    const row = request();
    const db = database({ accounting_request_queue: [row] });
    const result = await queueMembershipInvoice({ db, provider: 'quickbooks', args: args() });
    assert.equal(result.accounting_request_id, row.id);
    assert.equal(result.provider, 'xero');
    assert.equal(result.accounting_pending, true);
  } finally {
    if (old === undefined) delete process.env.ACCOUNTING_REQUEST_QUEUE_ENABLED;
    else process.env.ACCOUNTING_REQUEST_QUEUE_ENABLED = old;
  }
});

test('pre-migration OFF compatibility distinguishes absent queue from query failures', async () => {
  for (const code of ['42P01', 'PGRST205', '42703', '42501', '57014']) {
    const query = { select() { return query; }, eq() { return query; },
      async maybeSingle() { return { error: { code, message: 'accounting_request_queue missing' } }; } };
    const operation = () => resumeAccountingSource({ db: { from: () => query }, tenantId: tenant,
      sourceType: 'member_membership_history', sourceId: 'record', allowMissingQueue: true });
    if (['42P01', 'PGRST205'].includes(code)) assert.equal(await operation(), null);
    else await assert.rejects(operation(), /LOOKUP_FAILED/);
    await assert.rejects(resumeAccountingSource({ db: { from: () => query }, tenantId: tenant,
      sourceType: 'member_membership_history', sourceId: 'record' }), /LOOKUP_FAILED/);
  }
});

test('completion requires persisted invoice and source evidence; retries never invent success', async () => {
  const bad = { ...request(), state: 'complete' };
  assert.equal(accountingQueueFacadeResult(bad).accounting_pending, true);
  assert.equal(accountingQueueFacadeResult(bad).accounting_state, 'review');
  const complete = { ...bad, invoice_status: 'done', payment_status: 'skipped',
    link_status: 'done', link_result: { linked: true } };
  const db = database({ accounting_request_queue: [complete] }, async () => {
    throw new Error('Completed row must not be processed again');
  });
  const result = await resumeAccountingSource({ db, tenantId: tenant,
    sourceType: 'member_membership_history', sourceId: 'record' });
  assert.equal(result.accounting_pending, false);
  assert.equal(result.accounting_state, 'complete');
  const pending = request();
  const failingDb = database({ accounting_request_queue: [pending] }, async () => { throw new Error('claim failed'); });
  const accepted = await resumeAccountingSource({ db: failingDb, tenantId: tenant,
    sourceType: 'member_membership_history', sourceId: 'record' });
  assert.equal(accepted.accounting_pending, true);
  assert.notEqual(accepted.accounting_state, 'complete');
});

test('unadopted paid/addon identities explicitly retain existing writer before any enqueue', async () => {
  const db = database({});
  assert.equal(await queueMembershipInvoice({ db, provider: 'xero',
    args: { ...args(), markAsPaid: true } }), undefined);
});

test('binding uses strict active selection and original token row identity', async () => {
  const db = database({ tenant_accounting_settings: [{ tenant_id: tenant, active_provider: 'quickbooks' }] });
  await assert.rejects(resolveAccountingQueueBinding({ db, tenantId: tenant, provider: 'xero' }), /PROVIDER_CHANGED/);
});

test('adapter requires core fence; switched company is rejected without network', async () => {
  const row = request();
  row.snapshot.invoice = { envelope: envelope() };
  const db = database({ member_membership_history: [source()] });
  await assert.rejects(getAccountingQueueAdapter(row, {}, { db }), /MISSING_FENCE/);
  let guards = 0;
  const adapter = await getAccountingQueueAdapter(row, { beforeRequest: async () => { guards++; } }, {
    db, resolveConnection: async () => ({ tenantId: tenant, provider: 'xero',
      connectionId: 'connection', companyId: 'different', accessToken: 'secret' }),
    fetchImpl: async () => { throw new Error('MUST NOT CALL PROVIDER'); },
  });
  await assert.rejects(adapter.assertBinding(row), /CONNECTION_CHANGED/);
  assert.ok(guards > 0);
});

test('adapter guards every mocked provider call and validates exact readback without live I/O', async () => {
  const row = request();
  delete row.invoice_result;
  row.invoice_status = 'writing';
  row.snapshot.invoice = { envelope: envelope() };
  const db = database({ member_membership_history: [source()] });
  let guards = 0;
  const calls = [];
  const adapter = await getAccountingQueueAdapter(row, { beforeRequest: async () => { guards++; } }, {
    db, resolveConnection: async () => ({ tenantId: tenant, provider: 'xero',
      connectionId: 'connection', companyId: 'company', accessToken: 'test-only' }),
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method, guards });
      return new Response(JSON.stringify({ Invoices: [{
        InvoiceID: 'invoice', InvoiceNumber: 'INV-1', Type: 'ACCREC',
        Reference: row.snapshot.invoice.envelope.payload.Reference,
        Contact: { ContactID: 'contact' }, CurrencyCode: 'GBP', Total: 10,
      }] }), { status: 200 });
    },
  });
  const invoice = await adapter.createInvoice(row);
  assert.equal(invoice.id, 'invoice');
  assert.deepEqual(calls.map(call => call.method), ['POST', 'GET']);
  assert.ok(calls[1].guards > calls[0].guards);
});

test('real Xero preparation exits before invoice transport and stores no access token', async () => {
  const { createXeroMembershipInvoice } = await import('./xero.js');
  let writes = 0;
  const prepared = await createXeroMembershipInvoice({
    appTenantId: tenant, organizationName: 'Prepared member', membershipYear: '2030',
    tierLabel: 'Member', finalCost: 10, currency: 'GBP', vatRate: 'NONE',
  }, {
    prepareOnly: true, supabase: database({}),
    getValidXeroAccessToken: async () => ({ accessToken: 'test-secret', tenantId: 'company' }),
    findOrCreateXeroContact: async () => 'contact',
    fetch: async () => { writes++; throw new Error('No invoice transport during preparation'); },
  });
  assert.equal(prepared.payload.Contact.ContactID, 'contact');
  assert.equal(prepared.payload.CurrencyCode, 'GBP');
  assert.equal(prepared.payload.LineItems[0].TaxType, 'NONE');
  assert.equal(writes, 0);
  assert.equal(JSON.stringify(prepared).includes('test-secret'), false);
});

test('facade payment evidence is retained independently from invoice completion', () => {
  assert.equal(accountingQueueFacadeResult({ ...request(), payment_status: 'done', payment_result: { id: 'payment', payment_recorded: true } }).payment_recorded, true);
  assert.equal(accountingQueueFacadeResult(request()).payment_recorded, false);
  const facade = readFileSync(new URL('./accountingProvider.js', import.meta.url), 'utf8');
  assert.equal((facade.match(/payment_recorded: result\.payment_recorded === true/g) || []).length, 4);
});

test('advance accepted pending branch precedes destructive legacy rollback', () => {
  const code = readFileSync(new URL('../membership/org-membership-invoicing.js', import.meta.url), 'utf8');
  const advance = code.slice(code.indexOf('// Strict: the whole point'));
  assert.ok(advance.indexOf('accounting_pending') < advance.indexOf(".delete()"));
});