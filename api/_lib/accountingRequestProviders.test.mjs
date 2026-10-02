import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountingRequestProviders, prepareAccountingRequestEnvelope, validateAccountingRequestResult } from './accountingRequestProviders.js';

function fixture(provider = 'quickbooks', overrides = {}) {
  const xero = provider === 'xero';
  const payload = xero
    ? { Type: 'ACCREC', Contact: { ContactID: 'customer' }, CurrencyCode: 'GBP', Reference: 'PO 42' }
    : { CustomerRef: { value: 'customer' }, CurrencyRef: { value: 'GBP' }, PrivateNote: 'Original note' };
  const env = prepareAccountingRequestEnvelope({ provider, operationKey: 'tenant/source/invoice', payload,
    environment: 'production', expected: { contactId: 'customer', currency: 'GBP', totalMinor: 1234,
      fields: xero ? { Type: 'ACCREC', Status: 'AUTHORISED', TotalTax: 0 } : { TxnTaxDetail: { TotalTax: 0 } } } });
  const row = { provider, tenant_id: 'tenant', connection_id: 'connection', company_id: 'company',
    invoice_status: 'writing', snapshot: { invoice: { envelope: env } } };
  const record = xero ? { ...env.payload, InvoiceID: 'invoice', Total: 12.34, TotalTax: 0, Status: 'AUTHORISED' }
    : { ...env.payload, Id: 'invoice', TotalAmt: 12.34, TxnTaxDetail: { TotalTax: 0 } };
  const calls = [];
  const wrap = record => xero ? { Invoices: [record] } : { Invoice: record };
  const adapter = createAccountingRequestProviders({
    resolveConnection: async () => ({ tenantId: 'tenant', provider, connectionId: 'connection',
      companyId: 'company', environment: 'production', accessToken: 'test-token' }),
    beforeRequest: async () => {},
    fetchImpl: async (url, init) => { calls.push({ url, init }); return Response.json(wrap(record)); },
    ...overrides,
  });
  return { row, record, adapter, calls, env };
}

test('absolute batch deadline bounds provider timeout and forbids starting after expiry', async () => {
  const expired = fixture('xero', { deadlineAt: Date.now() - 1 });
  await assert.rejects(expired.adapter.createInvoice(expired.row), error =>
    error.code === 'REQUEST_BUDGET_EXHAUSTED' && error.definitelyNotWritten === true);
  assert.equal(expired.calls.length, 0);
  let signal;
  const limited = fixture('xero', {
    deadlineAt: Date.now() + 30, timeoutMs: 30000,
    fetchImpl: async (_url, init) => { signal = init.signal; return new Promise(() => {}); },
  });
  const started = Date.now();
  await assert.rejects(limited.adapter.createInvoice(limited.row), /TIMEOUT/);
  assert.equal(signal.aborted, true);
  assert.ok(Date.now() - started < 2000, 'uses remaining deadline, not nominal 30-second timeout');
});

for (const provider of ['xero', 'quickbooks']) {
  test(`${provider}: immutable envelope, separate create/readback and idempotency`, async () => {
    const { row, env, adapter, calls } = fixture(provider);
    assert.ok(Object.isFrozen(env.payload));
    const result = await adapter.createInvoice(row);
    assert.equal(result.id, 'invoice');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].init.method, 'GET');
    if (provider === 'xero') assert.ok(calls.every(call => new URL(call.url).searchParams.get('unitdp') === '4'));
    assert.ok(provider === 'xero' ? calls[0].init.headers['Idempotency-Key'] : calls[0].url.includes('requestid=inv-'));
    assert.equal(row.snapshot.invoice.envelope, env);
  });
  test(`${provider}: exact identity/economics required`, () => {
    const { row, record } = fixture(provider);
    assert.throws(() => validateAccountingRequestResult(row, 'invoice', {
      ...record, [provider === 'xero' ? 'Total' : 'TotalAmt']: 12.35,
    }), { code: 'PROVIDER_RESULT_MISMATCH' });
    assert.throws(() => validateAccountingRequestResult(row, 'invoice', {
      ...record, [provider === 'xero' ? 'Reference' : 'PrivateNote']: 'wrong',
    }), { code: 'PROVIDER_RESULT_MISMATCH' });
  });
}

test('binding switch and uncertain prior write prevent all POSTs', async () => {
  const f = fixture('quickbooks', { resolveConnection: async () => ({ companyId: 'another' }) });
  await assert.rejects(f.adapter.createInvoice(f.row), { code: 'CONNECTION_CHANGED', definitelyNotWritten: true });
  const g = fixture();
  g.row.invoice_status = 'unknown';
  await assert.rejects(g.adapter.createInvoice(g.row), { code: 'RECREATION_FORBIDDEN' });
  assert.equal(g.calls.length, 0);
});

test('documented direct 429 retains Retry-After and permits identical POST retry', async () => {
  const f = fixture('quickbooks', { fetchImpl: async () => new Response('', { status: 429, headers: { 'Retry-After': '120' } }) });
  await assert.rejects(f.adapter.createInvoice(f.row), error =>
    error.status === 429 && error.retryAfter === '120' && !error.ambiguous && error.definitelyNotWritten === true);
});

test('QuickBooks HTTP 200 Fault / duplicate request never counted as success', async () => {
  const f = fixture('quickbooks', { fetchImpl: async () => Response.json({ Fault: { Error: [{ code: '600', Detail: 'secret' }] } }) });
  await assert.rejects(f.adapter.createInvoice(f.row), error =>
    error.code === 'DUPLICATE_REQUEST' && error.ambiguous && !JSON.stringify(error).includes('secret'));
});

test('timeout and network exceptions are bounded, sanitized and unknown', async () => {
  for (const fetchImpl of [async () => { throw new Error('Bearer secret'); }, async () => new Promise(() => {})]) {
    const f = fixture('quickbooks', { fetchImpl, timeoutMs: 5 });
    await assert.rejects(f.adapter.createInvoice(f.row), error =>
      ['TIMEOUT', 'TRANSPORT_FAILURE'].includes(error.code) && error.definitelyNotWritten !== true && !error.message.includes('secret'));
  }
});

test('discovery proves unique permanent marker then performs exact readback', async () => {
  const f = fixture();
  const calls = [];
  const adapter = createAccountingRequestProviders({
    resolveConnection: async () => ({ tenantId: 'tenant', provider: 'quickbooks', connectionId: 'connection',
      companyId: 'company', environment: 'production', accessToken: 'test-token' }),
    beforeRequest: async () => {},
    fetchImpl: async (url, init) => {
      calls.push(init.method);
      return Response.json(url.includes('/query?') ? { QueryResponse: { Invoice: [f.record] } } : { Invoice: f.record });
    },
  });
  assert.equal((await adapter.discoverInvoice(f.row)).result.id, 'invoice');
  assert.deepEqual(calls, ['GET', 'GET']);
});

test('discovery never adopts ambiguous or incomplete scans', async () => {
  for (const length of [2, 100]) {
    const f = fixture();
    const records = length === 2 ? [f.record, { ...f.record, Id: 'other' }]
      : Array.from({ length }, (_, i) => i ? { Id: String(i), PrivateNote: '' } : f.record);
    const adapter = createAccountingRequestProviders({
      resolveConnection: async () => ({ tenantId: 'tenant', provider: 'quickbooks', connectionId: 'connection',
        companyId: 'company', environment: 'production', accessToken: 'test-token' }),
      beforeRequest: async () => {}, maxPages: 1,
      fetchImpl: async () => Response.json({ QueryResponse: { Invoice: records } }),
    });
    assert.equal((await adapter.discoverInvoice(f.row)).outcome, length === 2 ? 'ambiguous' : 'incomplete');
  }
});

test('payment validates exact allocation, bank and durable invoice result independently', () => {
  const f = fixture();
  const payload = { CustomerRef: { value: 'customer' }, CurrencyRef: { value: 'GBP' },
    DepositToAccountRef: { value: 'bank' }, TotalAmt: 12.34,
    Line: [{ Amount: 12.34, LinkedTxn: [{ TxnId: '$invoice', TxnType: 'Invoice' }] }] };
  const env = prepareAccountingRequestEnvelope({ provider: 'quickbooks', kind: 'payment',
    environment: 'production', operationKey: 'tenant/source/payment', payload,
    expected: { contactId: 'customer', currency: 'GBP', totalMinor: 1234, invoiceId: '$invoice',
      accountId: 'bank', fields: { UnappliedAmt: 0 } } });
  f.row.snapshot.payment = { envelope: env };
  f.row.invoice_result = { id: 'invoice' };
  const record = { ...env.payload, Id: 'payment', UnappliedAmt: 0,
    Line: [{ Amount: 12.34, LinkedTxn: [{ TxnId: 'invoice', TxnType: 'Invoice' }] }] };
  assert.equal(validateAccountingRequestResult(f.row, 'payment', record).id, 'payment');
  assert.throws(() => validateAccountingRequestResult(f.row, 'payment', { ...record, UnappliedAmt: 1 }),
    { code: 'PROVIDER_RESULT_MISMATCH' });
  assert.throws(() => validateAccountingRequestResult(f.row, 'payment', { ...record, DepositToAccountRef: { value: 'wrong' } }),
    { code: 'PAYMENT_BINDING_MISMATCH' });
});

test('readback binding failure after successful POST can never enable recreation', async () => {
  let lookups = 0;
  const f = fixture('quickbooks', { resolveConnection: async () => ({
    tenantId: 'tenant', provider: 'quickbooks', connectionId: ++lookups === 1 ? 'connection' : 'changed',
    companyId: 'company', environment: 'production', accessToken: 'test-token',
  }) });
  await assert.rejects(f.adapter.createInvoice(f.row), error =>
    error.code === 'CONNECTION_CHANGED' && error.definitelyNotWritten === false && error.ambiguous);
  assert.equal(f.calls.length, 1);
});

test('mandatory authority guard blocks writes and response size is bounded', async () => {
  const f = fixture('xero', { beforeRequest: async () => { throw new Error('Lease expired'); } });
  await assert.rejects(f.adapter.createInvoice(f.row), /Lease expired/);
  assert.equal(f.calls.length, 0);
  const g = fixture('xero', { maxResponseBytes: 4 });
  await assert.rejects(g.adapter.createInvoice(g.row), { code: 'RESPONSE_TOO_LARGE' });
});

test('QBO ignores provider subtotal rows, not financial line or tax differences', () => {
  const f = fixture();
  const line = { DetailType: 'SalesItemLineDetail', Amount: 12.34,
    SalesItemLineDetail: { ItemRef: { value: 'item' }, Qty: 1, UnitPrice: 12.34, TaxCodeRef: { value: 'NON' } } };
  const env = prepareAccountingRequestEnvelope({ provider: 'quickbooks', environment: 'production',
    operationKey: 'tenant/source/invoice', payload: { ...f.env.payload, Line: [line] },
    expected: { contactId: 'customer', currency: 'GBP', totalMinor: 1234,
      fields: { Line: [line], TxnTaxDetail: { TotalTax: 0 } } } });
  f.row.snapshot.invoice.envelope = env;
  const record = { ...f.record, ...env.payload, Line: [line, { DetailType: 'SubTotalLineDetail', Amount: 12.34 }] };
  assert.equal(validateAccountingRequestResult(f.row, 'invoice', record).id, 'invoice');
  for (const changed of [
    { ...record, Line: [...record.Line, { DetailType: 'DiscountLineDetail', Amount: 1 }] },
    { ...record, Line: [{ ...line, Amount: 11 }, record.Line[1]] },
    { ...record, Line: [record.Line[1]] },
    { ...record, Line: [line, line, record.Line[1]] },
    { ...record, TxnTaxDetail: { TotalTax: 1 } },
    { ...record, TotalAmt: 13.34 },
  ]) assert.throws(() => validateAccountingRequestResult(f.row, 'invoice', changed), { code: 'PROVIDER_RESULT_MISMATCH' });
});

for (const status of [429, 503]) {
test(`real core maps adapter HTTP ${status} to ${status === 429 ? 'retry with cooldown' : 'unknown'}`, async () => {
  const { processAccountingRequest } = await import('./accountingRequestQueue.js');
  const f = fixture('quickbooks', { fetchImpl: async () => new Response('{}', { status,
    headers: { 'Retry-After': '125' } }) });
  let row = { ...f.row, id: 'request', source_type: 'booking', source_id: 'source',
    lease_token: 'lease', attempts: 1, invoice_status: 'pending', payment_status: 'skipped', link_status: 'pending' };
  let finish;
  const db = { rpc: async (name, args) => {
    if (name.endsWith('_guard')) return { data: true };
    if (name.endsWith('_checkpoint')) row[`${args.p_stage}_status`] = args.p_status;
    if (name.endsWith('_finish')) { finish = args; row.state = args.p_state; }
    return { data: structuredClone(row) };
  } };
  const result = await processAccountingRequest({ db, requestId: row.id,
    adapters: async () => ({ ...f.adapter, linkSource: async () => { throw new Error('must not link'); } }) });
  assert.equal(result.state, status === 429 ? 'retry' : 'unknown');
  assert.equal(result.invoice_status, status === 429 ? 'pending' : 'unknown');
  assert.equal(finish.p_cooldown_seconds, status === 429 ? 125 : 0);
});
}

for (const provider of ['xero', 'quickbooks']) {
  test(`${provider}: core retries throttle with identical body/key, then completes`, async () => {
    const { processAccountingRequest } = await import('./accountingRequestQueue.js');
    const posts = [];
    let f;
    f = fixture(provider, { fetchImpl: async (url, init) => {
      if (init.method === 'POST') {
        posts.push({ url, body: init.body, key: init.headers['Idempotency-Key'] });
        if (posts.length === 1) return new Response('', { status: 429, headers: { 'Retry-After': '120' } });
      }
      return Response.json(provider === 'xero' ? { Invoices: [f.record] } : { Invoice: f.record });
    } });
    const row = { ...f.row, id: 'request', source_type: 'booking', source_id: 'source',
      lease_token: 'lease', attempts: 1, invoice_status: 'pending', payment_status: 'skipped', link_status: 'pending' };
    const finishes = [];
    const db = { rpc: async (name, args) => {
      if (name.endsWith('_guard')) return { data: true };
      if (name.endsWith('_checkpoint')) {
        row[`${args.p_stage}_status`] = args.p_status;
        if (args.p_status === 'done') row[`${args.p_stage}_result`] = args.p_result;
      }
      if (name.endsWith('_finish')) { finishes.push(args); row.state = args.p_state; }
      return { data: structuredClone(row) };
    } };
    const run = () => processAccountingRequest({ db, requestId: row.id,
      adapters: async () => ({ ...f.adapter, linkSource: async () => ({ linked: true }) }) });
    assert.equal((await run()).state, 'retry');
    assert.equal(posts.length, 1); // No in-process retry.
    assert.equal(finishes[0].p_cooldown_seconds, 120);
    assert.ok(finishes[0].p_retry_seconds >= 120);
    // The real SQL claim enforces next_attempt_at; this mocked second claim
    // represents the next worker invocation after that cooldown.
    assert.equal((await run()).state, 'complete');
    assert.equal(posts.length, 2);
    assert.deepEqual(posts[0], posts[1]);
  });
}

test('successful POST followed by readback 429 stays ambiguous, never safe retry', async () => {
  let f;
  f = fixture('quickbooks', { fetchImpl: async (url, init) => init.method === 'POST'
    ? Response.json({ Invoice: f.record })
    : new Response('', { status: 429, headers: { 'Retry-After': '120' } }) });
  await assert.rejects(f.adapter.createInvoice(f.row), error =>
    error.status === 429 && error.retryAfter === '120' && error.ambiguous && error.definitelyNotWritten === false);
});

test('HTTP 5xx remains ambiguous, never equivalent to a documented throttle rejection', async () => {
  const f = fixture('xero', { fetchImpl: async () => Response.json({ ErrorNumber: 10 }, { status: 503 }) });
  await assert.rejects(f.adapter.createInvoice(f.row), error =>
    error.status === 503 && error.ambiguous && error.definitelyNotWritten !== true);
});