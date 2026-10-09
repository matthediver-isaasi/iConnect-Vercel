import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertGoCardlessAccountingSource, findGoCardlessAccountingRequest,
  linkGoCardlessAccountingSource, prepareGoCardlessSourceRequest,
  queueGoCardlessAccountingPayment, resumeGoCardlessAccountingRequest,
} from './accountingQueueGoCardless.js';
import { getAccountingQueueAdapter } from './accountingQueueIntegration.js';
import { postDdInstalmentToAccounting } from './gocardlessAccounting.js';
import { processAccountingRequest } from './accountingRequestQueue.js';
import { reconcileAccounting } from './directDebitReconciliationPipeline.js';

const tenant = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function fixture(provider = 'xero', mode = 'per_instalment', persist = value => value) {
  const agreement = { id: 'agreement', tenant_id: tenant, member_id: 'member', provider: 'gocardless',
    environment: 'live', gocardless_mandate_id: 'MD1', metadata: { dd: { invoicing_mode: mode, currency: 'GBP' } } };
  const payment = { id: 'payment', tenant_id: tenant, plan_id: 'plan', gocardless_payment_id: 'PM1',
    gocardless_mandate_id: 'MD1', environment: 'live', status: 'confirmed', currency: 'GBP',
    amount_minor: 1200, charge_date: '2026-10-05' };
  const row = { id: 'queue', tenant_id: tenant, provider, source_type: 'gocardless_payment', source_id: payment.id,
    connection_id: 'connection', company_id: 'company', state: 'pending', operation: 'invoice',
    invoice_status: 'pending', payment_status: 'pending', link_status: 'pending',
    snapshot: { version: 1, preparation: true, linkage: { paymentId: payment.id, agreementId: agreement.id },
      invoice: { args: {} }, payment: { collection: { amountMinor: 1200, currency: 'GBP' } },
      evidence: { agreement: structuredClone(agreement), payment: structuredClone(payment), snapshot: agreement.metadata.dd,
        context: { contactName: 'Original member', currency: 'GBP', nominalCode: '200', vatRate: 'NONE' } } } };
  const tables = { membership_billing_agreements: [agreement], gocardless_payments: [payment],
    membership_payment_plans: [{ id: 'plan', tenant_id: tenant, billing_agreement_id: agreement.id }],
    membership_monthly_collection_intent: [], accounting_request_queue: [] };
  const writes = [];
  const db = { rpc: async () => ({ data: null, error: null }), from(table) {
    const filters = [];
    let patch = null;
    const query = {
      select() { return query; }, order() { return query; }, limit() { return query; },
      eq(key, value) { filters.push(x => x[key] === value); return query; },
      in(key, values) { filters.push(x => values.includes(x[key])); return query; },
      is(key, value) { filters.push(x => (x[key] ?? null) === value); return query; },
      update(value) { patch = value; return query; },
      maybeSingle: async () => execute(true),
      then(resolve, reject) { return Promise.resolve(execute(false)).then(resolve, reject); },
    };
    function execute(single) {
      const rows = (tables[table] || []).filter(x => filters.every(f => f(x)));
      if (patch) { writes.push({ table, patch }); rows.forEach(x => Object.assign(x, persist(patch))); }
      return { data: structuredClone(single ? rows[0] || null : rows), error: null };
    }
    return query;
  } };
  return { db, row, tables, writes, agreement, payment, provider: { name: provider } };
}

test('source linkage accepts PostgreSQL timestamp formatting but rejects missing or changed timestamps', async () => {
  for (const provider of ['xero', 'quickbooks']) {
    for (const variant of ['equivalent', 'changed', 'invalid', 'missing', 'wrongInvoice']) {
      const f = fixture(provider, 'per_instalment', patch => ({
        ...patch,
        accounting_synced_at: variant === 'changed'
          ? new Date(Date.parse(patch.accounting_synced_at) + 1000).toISOString()
          : variant === 'invalid' ? 'invalid'
          : variant === 'missing' ? null
          : patch.accounting_synced_at.replace('Z', '+00:00'),
        ...(variant === 'wrongInvoice' ? { accounting_invoice_id: 'OTHER' } : {}),
      }));
      Object.assign(f.row, { invoice_status: 'done', invoice_result: { id: 'INV1', invoiceNumber: '1' },
        payment_status: 'done', payment_result: { id: 'PAY1', payment_recorded: true } });
      if (variant === 'equivalent') {
        assert.equal((await linkGoCardlessAccountingSource({ db: f.db, row: f.row })).linked, true);
        assert.equal((await linkGoCardlessAccountingSource({ db: f.db, row: f.row })).linked, true);
      } else {
        await assert.rejects(linkGoCardlessAccountingSource({ db: f.db, row: f.row }), /SOURCE_LINK_NOT_PERSISTED/);
      }
    }
  }
});

test('JSONB object-key reordering preserves frozen GC authority', async () => {
  const f = fixture();
  f.agreement.metadata.dd.collection_policy = {
    mode: 'monthly', details: { amount: 1200, currency: 'GBP' }, dates: ['2026-10-05', '2026-11-05'],
  };
  f.row.snapshot.evidence.agreement.metadata.dd.collection_policy = {
    dates: ['2026-10-05', '2026-11-05'], details: { currency: 'GBP', amount: 1200 }, mode: 'monthly',
  };
  await assertGoCardlessAccountingSource({ db: f.db, row: f.row });
  assert.equal(f.writes.length, 0);
});

for (const changed of [
  { amount: 1300, currency: 'GBP', dates: ['2026-10-05', '2026-11-05'] },
  { amount: '1200', currency: 'GBP', dates: ['2026-10-05', '2026-11-05'] },
  { amount: 1200, currency: 'EUR', dates: ['2026-10-05', '2026-11-05'] },
  { amount: 1200, currency: 'GBP', dates: ['2026-11-05', '2026-10-05'] },
]) {
  test(`GC authority still rejects changed values: ${JSON.stringify(changed)}`, async () => {
    const f = fixture();
    f.row.snapshot.evidence.agreement.metadata.dd.collection_policy = {
      amount: 1200, currency: 'GBP', dates: ['2026-10-05', '2026-11-05'],
    };
    f.agreement.metadata.dd.collection_policy = changed;
    await assert.rejects(assertGoCardlessAccountingSource({ db: f.db, row: f.row }),
      { code: 'GC_QUEUE_AGREEMENT_ECONOMICS_CHANGED' });
    assert.equal(f.writes.length, 0);
  });
}

for (const provider of ['xero', 'quickbooks']) {
  test(`${provider}: original authority, preparation args and verified source linkage`, async () => {
    const f = fixture(provider);
    await assertGoCardlessAccountingSource({ db: f.db, row: f.row });
    const original = structuredClone(f.row.snapshot);
    const prepared = await prepareGoCardlessSourceRequest({ db: f.db, row: f.row }, {
      prepare: async ({ row, args }) => {
        assert.deepEqual(row.snapshot, original);
        assert.equal(args.organizationName, 'Original member');
        return { ...row.snapshot, preparation: false };
      },
    });
    assert.equal(prepared.preparation, false);
    assert.deepEqual(f.row.snapshot, original);
    await assert.rejects(linkGoCardlessAccountingSource({ db: f.db, row: f.row }), /NOT_VERIFIED/);
    Object.assign(f.row, { invoice_status: 'done', invoice_result: { id: 'INV1', invoiceNumber: '1' },
      payment_status: 'done', payment_result: { id: 'PAY1', payment_recorded: true } });
    const linked = await linkGoCardlessAccountingSource({ db: f.db, row: f.row });
    assert.equal(linked.linked, true);
    assert.equal(f.payment.accounting_sync_status, 'posted');
    assert.equal(f.payment.accounting_provider, provider);
    assert.equal(f.payment.xero_invoice_id, provider === 'xero' ? 'INV1' : undefined);
    await linkGoCardlessAccountingSource({ db: f.db, row: f.row });
  });

  test(`${provider}: enqueue freezes local tax/contact failure without provider calls`, async () => {
    const f = fixture(provider);
    let accepted;
    const result = await queueGoCardlessAccountingPayment({
      db: f.db, agreement: f.agreement, paymentRow: f.payment, provider: f.provider,
    }, {
      enabled: true, resolveBinding: async () => ({ connectionId: 'connection', companyId: 'company' }),
      resolveContext: async () => { throw new Error('contact/tax config failed'); },
      enqueue: async args => {
        accepted = args;
        return { ...f.row, snapshot: args.snapshot };
      },
    });
    assert.equal(accepted.snapshot.preparation, true);
    assert.equal(accepted.snapshot.evidence.preparationError, 'GC_QUEUE_LOCAL_CONTEXT_PREPARATION_FAILED');
    assert.equal(result.status, 'pending');
    assert.equal(result.payment_recorded, false);
    await assert.rejects(prepareGoCardlessSourceRequest({ db: f.db,
      row: { ...f.row, snapshot: accepted.snapshot } }, {
      prepare: () => assert.fail('provider must not run'),
    }), /LOCAL_CONTEXT_PREPARATION_FAILED/);
  });

  test(`${provider}: annual existing invoice has payment-only identity and preserved history binding`, async () => {
    const f = fixture(provider, 'annual');
    f.tables.member_membership_history = [{ id: 'history', tenant_id: tenant, member_id: 'member',
      billing_agreement_id: 'agreement', accounting_provider: provider, accounting_invoice_id: 'ANNUAL' }];
    let accepted;
    await queueGoCardlessAccountingPayment({
      db: f.db, agreement: f.agreement, paymentRow: f.payment, provider: f.provider,
    }, {
      enabled: true, resolveBinding: async () => ({ connectionId: 'connection', companyId: 'company' }),
      resolveContext: () => assert.fail('annual must not rebuild invoice'),
      enqueue: async args => { accepted = args; return { ...f.row, operation: args.operation, snapshot: args.snapshot }; },
    });
    assert.equal(accepted.operation, 'payment');
    assert.equal(accepted.snapshot.existingInvoice.id, 'ANNUAL');
    assert.equal(accepted.snapshot.linkage.historyId, 'history');
    f.tables.member_membership_history[0].accounting_invoice_id = 'OTHER';
    await assert.rejects(assertGoCardlessAccountingSource({ db: f.db,
      row: { ...f.row, snapshot: accepted.snapshot } }), /HISTORY_AUTHORITY_CHANGED/);
  });
}

test('missing annual invoice waits and cannot create a new annual invoice', async () => {
  const f = fixture('xero', 'annual');
  await assert.rejects(queueGoCardlessAccountingPayment({
    db: f.db, agreement: f.agreement, paymentRow: f.payment, provider: f.provider,
  }, { enabled: true, resolveBinding: async () => ({ connectionId: 'c', companyId: 'co' }),
    enqueue: () => assert.fail('must not invent existing invoice') }), /Waiting for a genuine/);
});

test('changed source economics, unconfirmed payment and arrears allocation block provider authority', async () => {
  for (const mutate of [
    f => { f.payment.amount_minor++; },
    f => { f.payment.status = 'charged_back'; },
    f => { f.agreement.gocardless_mandate_id = 'OTHER'; },
    f => { f.tables.membership_monthly_collection_intent.push({ id: 'intent', tenant_id: tenant, plan_id: 'plan', provider_reference: 'PM1' }); },
    f => { f.payment.accounting_invoice_id = 'OTHER'; },
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(assertGoCardlessAccountingSource({ db: f.db, row: f.row }), /GC_QUEUE_/);
    assert.equal(f.writes.length, 0);
  }
});

test('accepted identity is resumed with flags off before binding/current catalogue lookups', async () => {
  const f = fixture();
  f.tables.accounting_request_queue.push(f.row);
  const result = await queueGoCardlessAccountingPayment({
    db: f.db, agreement: f.agreement, paymentRow: f.payment, provider: f.provider,
  }, { enabled: false, resolveBinding: () => assert.fail('original authority must win') });
  assert.equal(result.status, 'pending');
  assert.equal(result.accounting_request_id, f.row.id);
});

test('only genuine completion returns posted and payment_recorded', async () => {
  const f = fixture();
  Object.assign(f.row, { state: 'complete', invoice_status: 'done', invoice_result: { id: 'INV1' },
    payment_status: 'done', payment_result: { id: 'PAY1', payment_recorded: true },
    link_status: 'done', link_result: { linked: true } });
  assert.equal((await resumeGoCardlessAccountingRequest({ db: f.db, row: f.row })).status, 'posted');
  f.row.link_result = { linked: false };
  assert.equal((await resumeGoCardlessAccountingRequest({ db: f.db, row: f.row })).status, 'pending');
});

test('queue lookup tolerates only missing schema when OFF', async () => {
  for (const code of ['42P01', '42501']) {
    const db = { from() { const q = { select: () => q, eq: () => q,
      maybeSingle: async () => ({ error: { code } }) }; return q; } };
    const promise = findGoCardlessAccountingRequest({ db, tenantId: tenant, paymentId: 'p', allowMissingQueue: true });
    if (code === '42P01') assert.equal(await promise, null);
    else await assert.rejects(promise, /LOOKUP_FAILED/);
  }
});

test('GC adapter dispatch uses original fenced row and preparation forbids financial writes', async () => {
  const f = fixture();
  let calls = 0, fences = 0;
  const adapter = await getAccountingQueueAdapter(f.row, {
    beforeRequest: async candidate => {
      assert.deepEqual(candidate.snapshot, f.row.snapshot);
      fences++;
      return { timeoutMs: 1000 };
    }, deadlineAt: Date.now() + 10000,
  }, {
    db: f.db, resolveConnection: async () => ({ tenantId: tenant, provider: 'xero',
      connectionId: 'connection', companyId: 'company', accessToken: 'fixture-only' }),
    fetchImpl: async () => { calls++; return new Response(JSON.stringify({ Contacts: [] })); },
    preparation: {
      prepare: async ({ row, args, transport }) => {
        assert.equal(args.organizationName, 'Original member');
        await transport.fetch('https://api.xero.com/api.xro/2.0/Contacts');
        await assert.rejects(transport.fetch('https://api.xero.com/api.xro/2.0/Invoices', { method: 'POST' }),
          /PREPARATION_ENDPOINT_FORBIDDEN/);
        return { ...row.snapshot, preparation: false };
      },
    },
  });
  await assert.rejects(adapter.prepare(f.row), /PREPARATION_ENDPOINT_FORBIDDEN/);
  assert.equal(calls, 1);
  assert.ok(fences >= 2);
});

test('concurrent/lost enqueue response resumes durable winner rather than replacing evidence', async () => {
  const f = fixture();
  const result = await queueGoCardlessAccountingPayment({
    db: f.db, agreement: f.agreement, paymentRow: f.payment, provider: f.provider,
  }, {
    enabled: true, resolveBinding: async () => ({ connectionId: 'connection', companyId: 'company' }),
    resolveContext: async () => ({ contactName: 'New context', currency: 'GBP' }),
    enqueue: async () => {
      f.tables.accounting_request_queue.push(f.row);
      throw new Error('lost/conflicting enqueue response');
    },
  });
  assert.equal(result.accounting_request_id, f.row.id);
  assert.equal(f.tables.accounting_request_queue[0].snapshot.evidence.context.contactName, 'Original member');
  assert.equal(result.status, 'pending');
});

test('annual legacy facade cannot report posted when provider did not record payment', async () => {
  const f = fixture('xero', 'annual');
  f.tables.member_membership_history = [{ id: 'history', tenant_id: tenant, member_id: 'member',
    billing_agreement_id: 'agreement', accounting_provider: 'xero', accounting_invoice_id: 'ANNUAL' }];
  const result = await postDdInstalmentToAccounting({ agreement: f.agreement, paymentRow: f.payment }, {
    db: f.db, findQueuedRequest: async () => null, queueAccounting: async () => undefined,
    getProvider: async () => ({ name: 'xero', applyStripePaymentToInvoice: async () => ({ invoice_id: 'ANNUAL', payment_recorded: false }) }),
  });
  assert.equal(result.status, 'invoice_unpaid');
  assert.equal(f.payment.accounting_sync_status, 'invoice_unpaid');
});

test('webhook/accounting retry entrance resumes queue without resolving provider or legacy writer', async () => {
  const f = fixture();
  const result = await postDdInstalmentToAccounting({ agreement: f.agreement, paymentRow: f.payment }, {
    db: f.db, findQueuedRequest: async () => f.row,
    getProvider: () => assert.fail('must not prepare again'),
    queueAccounting: () => assert.fail('must not enqueue again'),
  });
  assert.equal(result.status, 'pending');
  assert.equal(result.accounting_request_id, f.row.id);
  assert.equal(f.writes.length, 0);
});

// Real producer -> real queue engine -> default integration -> real membership
// preparation -> real guarded provider adapter -> verified source linker.
// Only durable storage and external provider HTTP are in-memory fixtures.
function combinedFixture(provider, annual, failure) {
  const f = fixture(provider, annual ? 'annual' : 'per_instalment');
  const xero = provider === 'xero';
  f.tables.member = [{ id: 'member', first_name: 'Original', last_name: 'Member', email: null }];
  f.tables.tenant_accounting_settings = [{ tenant_id: tenant, active_provider: provider }];
  f.tables[xero ? 'xero_token' : 'quickbooks_token'] = [{
    id: 'connection', app_tenant_id: tenant, tenant_id: 'company', realm_id: 'company',
    environment: 'sandbox', access_token: 'isolated-fixture-token', expires_at: '2099-01-01T00:00:00Z',
  }];
  f.tables.system_settings = [
    { tenant_id: tenant, setting_key: xero ? 'xero_gocardless_bank_account_code' : 'quickbooks_gocardless_bank_account_id',
      setting_value: xero ? '090' : 'bank' },
    { tenant_id: tenant, setting_key: 'quickbooks_membership_item_id', setting_value: 'membership-item' },
  ];
  if (annual) f.tables.member_membership_history = [{ id: 'history', tenant_id: tenant, member_id: 'member',
    billing_agreement_id: 'agreement', accounting_provider: provider, accounting_invoice_id: 'INV1' }];
  let durable = null, usedFailure = false, clock = 0, due = 0, cooldown = 0;
  const requests = [], rpcCalls = [], financeBodies = { invoice: [], payment: [] };
  const remote = { invoice: annual ? (xero ? {
    InvoiceID: 'INV1', Contact: { ContactID: 'contact' }, CurrencyCode: 'GBP', Type: 'ACCREC',
    Status: 'AUTHORISED', Total: 120, AmountDue: 120, InvoiceNumber: 'ANNUAL-1',
  } : { Id: 'INV1', CustomerRef: { value: 'contact' }, CurrencyRef: { value: 'GBP' },
    TotalAmt: 120, Balance: 120, DocNumber: 'ANNUAL-1' }) : null, payment: null };
  const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  f.db.rpc = async (name, a) => {
    rpcCalls.push({ name, args: structuredClone(a) });
    if (name.endsWith('_enqueue')) {
      assert.equal(durable, null);
      durable = { id: 'queue', tenant_id: a.p_tenant_id, provider: a.p_provider,
        connection_id: a.p_connection_id, company_id: a.p_company_id, source_type: a.p_source_type,
        source_id: a.p_source_id, operation: a.p_operation, snapshot: structuredClone(a.p_snapshot),
        resolved_snapshot: null, preparation_status: 'pending', state: 'pending', attempts: 0,
        invoice_status: annual ? 'done' : 'pending', invoice_result: null,
        payment_status: 'pending', payment_result: null, link_status: 'pending', link_result: null };
      f.tables.accounting_request_queue.push(durable);
    } else if (name.endsWith('_claim')) {
      if (clock < due || clock < cooldown || durable.state === 'complete') return { data: null };
      durable.lease_token = `lease-${++durable.attempts}`;
      durable.state = 'running';
      for (const stage of ['invoice', 'payment']) if (durable[`${stage}_status`] === 'writing') durable[`${stage}_status`] = 'unknown';
    } else if (name.endsWith('_guard')) {
      assert.equal(a.p_lease_token, durable.lease_token);
      assert.ok(clock >= cooldown);
      if (a.p_stage) {
        assert.equal(durable.preparation_status, 'done');
        assert.equal(durable[`${a.p_stage}_status`], 'writing');
      }
      return { data: true };
    } else if (name.endsWith('_prepare')) {
      assert.equal(durable.resolved_snapshot, null);
      assert.notEqual(a.p_snapshot.preparation, true);
      assert.deepEqual(a.p_snapshot.linkage, durable.snapshot.linkage);
      if (annual) {
        assert.equal(a.p_snapshot.existingInvoice.id, durable.snapshot.existingInvoice.id);
        durable.invoice_result = structuredClone(a.p_snapshot.existingInvoice);
      } else assert.equal(a.p_snapshot.invoice.envelope.kind, 'invoice');
      assert.equal(a.p_snapshot.payment.envelope.kind, 'payment');
      durable.resolved_snapshot = structuredClone(a.p_snapshot);
      durable.preparation_status = 'done';
    } else if (name.endsWith('_checkpoint')) {
      durable[`${a.p_stage}_status`] = a.p_status;
      if (a.p_status === 'done') durable[`${a.p_stage}_result`] = structuredClone(a.p_result);
    } else if (name.endsWith('_finish')) {
      durable.state = a.p_state;
      due = clock + a.p_retry_seconds;
      cooldown = Math.max(cooldown, clock + a.p_cooldown_seconds);
    } else assert.fail(`Unexpected RPC ${name}`);
    return { data: structuredClone(durable) };
  };
  const fetchImpl = async (url, init = {}) => {
    assert.ok(durable?.snapshot, 'original evidence must commit before ANY provider request');
    const parsed = new URL(url), path = parsed.pathname, method = init.method || 'GET';
    const invoicePath = /\/(?:Invoices|invoice)(?:\/|$)/.test(path);
    const paymentPath = /\/(?:Payments|payment)(?:\/|$)/.test(path);
    const kind = invoicePath ? 'invoice' : paymentPath ? 'payment' : 'preparation';
    requests.push({ url, method, kind, body: init.body || null,
      key: xero ? init.headers?.['Idempotency-Key'] : parsed.searchParams.get('requestid') });
    if ((kind === 'preparation' && failure === 'prep429')
      || (failure === 'contact429' && (/\/Contacts$/.test(path) || parsed.searchParams.get('query')?.includes('FROM Customer')))
      || (failure === 'tax429' && /\/item\/membership-item$/.test(path))
      || (method === 'POST' && failure === `${kind}429`)
      || (method === 'GET' && failure === `${kind}Read429` && financeBodies[kind]?.length)) {
      if (!usedFailure) {
        usedFailure = true;
        return new Response('', { status: 429, headers: { 'Retry-After': '120' } });
      }
    }
    if (/\/Accounts$/.test(path)) return json({ Accounts: [{ AccountID: 'bank', Code: '090', Type: 'BANK', Status: 'ACTIVE' }] });
    if (/\/account\/bank$/.test(path)) return json({ Account: { Id: 'bank', Active: true, AccountType: 'Bank' } });
    if (/\/Contacts$/.test(path)) return json({ Contacts: [{ ContactID: 'contact', Name: 'Original Member' }] });
    if (/\/item\/membership-item$/.test(path)) return json({ Item: { Id: 'membership-item', SalesTaxCodeRef: { value: 'NONE' } } });
    if (/\/query$/.test(path)) {
      const query = parsed.searchParams.get('query');
      if (query.includes('FROM Customer')) return json({ QueryResponse: { Customer: [{ Id: 'contact', DisplayName: 'Original Member' }] } });
      if (query.includes('FROM Invoice')) return json({ QueryResponse: { Invoice: remote.invoice ? [remote.invoice] : [] } });
      if (query.includes('FROM Payment')) return json({ QueryResponse: { Payment: remote.payment ? [remote.payment] : [] } });
      assert.fail(`Unexpected QBO query ${query}`);
    }
    if (kind === 'invoice' || kind === 'payment') {
      if (method === 'POST') {
        assert.equal(durable.preparation_status, 'done');
        assert.equal(durable[`${kind}_status`], 'writing');
        const body = JSON.parse(init.body);
        financeBodies[kind].push({ body, key: xero ? init.headers['Idempotency-Key'] : parsed.searchParams.get('requestid') });
        const payload = xero ? body[kind === 'invoice' ? 'Invoices' : 'Payments'][0] : body;
        remote[kind] = kind === 'invoice' ? (xero ? {
          ...payload, InvoiceID: 'INV1', InvoiceNumber: 'INV-1', Total: 12, AmountDue: 12,
        } : { ...payload, Id: 'INV1', DocNumber: 'INV-1', TotalAmt: 12, Balance: 12 }) : (xero ? {
          ...payload, PaymentID: 'PAY1', Status: 'AUTHORISED',
          Invoice: { InvoiceID: 'INV1', Contact: { ContactID: 'contact' }, CurrencyCode: 'GBP' },
        } : { ...payload, Id: 'PAY1', UnappliedAmt: 0 });
        if (kind === 'payment') remote.invoice[xero ? 'AmountDue' : 'Balance'] -= 12;
        if (!usedFailure && failure === `${kind}Lost`) {
          usedFailure = true; throw new Error('response lost after provider committed');
        }
      }
      return json(xero ? { [kind === 'invoice' ? 'Invoices' : 'Payments']: remote[kind] ? [remote[kind]] : [] }
        : { [kind === 'invoice' ? 'Invoice' : 'Payment']: remote[kind] });
    }
    assert.fail(`Unexpected external request ${method} ${url}`);
  };
  const adapters = (row, controls) => getAccountingQueueAdapter(row, controls, { db: f.db, fetchImpl });
  return { ...f, requests, rpcCalls, financeBodies, remote,
    get durable() { return durable; },
    async start() {
      return queueGoCardlessAccountingPayment({ db: f.db, agreement: f.agreement, paymentRow: f.payment,
        provider: f.provider }, { enabled: true, adapters });
    },
    async retry() { clock += 1000; return processAccountingRequest({ db: f.db, requestId: durable.id, adapters }); },
  };
}

for (const provider of ['xero', 'quickbooks']) for (const annual of [false, true]) {
  for (const failure of [null, 'prep429', ...(annual ? [] : ['contact429', ...(provider === 'quickbooks' ? ['tax429'] : []), 'invoice429', 'invoiceLost', 'invoiceRead429']), 'payment429', 'paymentLost', 'paymentRead429']) {
    test(`combined real stages: ${provider} ${annual ? 'annual' : 'instalment'} ${failure || 'success'}`, async () => {
      const f = combinedFixture(provider, annual, failure);
      const first = await f.start();
      const original = structuredClone(f.durable.snapshot);
      if (failure) {
        assert.equal(first.status, 'pending');
        assert.notEqual(f.payment.accounting_sync_status, 'posted');
        assert.ok(['retry', 'unknown'].includes(f.durable.state), `${failure}: ${f.durable.state}`);
        if (failure.endsWith('429')) assert.ok(f.rpcCalls.some(c => c.name.endsWith('_finish') && c.args.p_cooldown_seconds === 120));
        if (failure === 'prep429') {
          f.tables.system_settings[0].setting_value = 'changed-after-acceptance';
          assert.equal(f.durable.snapshot.payment.bankSetting.value, provider === 'xero' ? '090' : 'bank');
        }
        const finished = await f.retry();
        assert.equal(finished.state, 'complete', JSON.stringify(finished));
      } else assert.equal(first.status, 'posted', JSON.stringify(f.durable));
      assert.deepEqual(f.durable.snapshot, original);
      assert.equal(f.payment.accounting_sync_status, 'posted');
      assert.equal(f.payment.accounting_invoice_id, 'INV1');
      assert.equal(f.durable.payment_result.payment_recorded, true);
      assert.equal(f.durable.link_result.linked, true);
      assert.equal(f.financeBodies.invoice.length, annual ? 0 : 1);
      assert.equal(f.financeBodies.payment.length, 1, 'no duplicate payment after ambiguous response');
      if (['invoice429', 'payment429'].includes(failure)) {
        const kind = failure.replace('429', '');
        const posts = f.requests.filter(r => r.method === 'POST' && r.kind === kind);
        assert.equal(posts.length, 2);
        assert.equal(posts[0].body, posts[1].body, 'throttle retry uses byte-identical financial JSON');
        assert.equal(posts[0].key, posts[1].key, 'throttle retry preserves provider idempotency key');
      }
      assert.ok(f.writes.every(w => w.table === 'gocardless_payments'), 'no collection/activation/workflow effects');
      if (failure?.endsWith('Lost')) assert.ok(f.requests.some(r => r.method === 'GET'
        && (r.url.includes('where=') || r.url.includes('query='))), 'unknown write must be discovered');
    });
  }
}

test('annual failed accounting retry is accounting-only, never historical webhook replay', async () => {
  const f = fixture('xero', 'annual');
  const effects = [];
  const result = await reconcileAccounting({ db: f.db, now: new Date(), effects: {
    perform: async operation => { effects.push(operation); return { status: 'pending' }; },
  } }, f.payment);
  assert.equal(result.skipped, 1);
  assert.deepEqual(effects.map(e => e.type), ['reconciliation.accounting']);
});

test('annual missing invoice stays failed/waiting and never touches provider preparation', async () => {
  const f = combinedFixture('xero', true, null);
  f.tables.member_membership_history = [];
  const result = await postDdInstalmentToAccounting({ agreement: f.agreement, paymentRow: f.payment }, {
    db: f.db, getProvider: async () => f.provider, queueDependencies: { enabled: true },
  });
  assert.equal(result.status, 'pending');
  assert.equal(f.payment.accounting_sync_status, 'failed');
  assert.match(f.payment.accounting_sync_error, /Waiting for a genuine linked/);
  assert.equal(f.requests.length, 0);
});

test('missing dedicated bank setting is durably reviewed, never replaced with Stripe bank', async () => {
  const f = combinedFixture('xero', false, null);
  f.tables.system_settings = [{ tenant_id: tenant, setting_key: 'xero_stripe_bank_account_code', setting_value: '090' }];
  const result = await f.start();
  assert.equal(result.status, 'pending');
  assert.equal(f.durable.state, 'review');
  assert.equal(f.durable.snapshot.payment.bankSetting.value, null);
  assert.equal(f.requests.length, 0);
  assert.equal(f.durable.invoice_status, 'pending');
});

test('uncertain legacy writer receives durable review instead of a fresh financial identity', async () => {
  const f = combinedFixture('quickbooks', false, null);
  f.payment.accounting_sync_status = 'failed';
  f.payment.accounting_sync_error = 'legacy transport timed out';
  const result = await f.start();
  assert.equal(result.status, 'pending');
  assert.equal(f.durable.state, 'review');
  assert.equal(f.durable.snapshot.evidence.legacyWriteUncertain, true);
  assert.equal(f.requests.length, 0);
});