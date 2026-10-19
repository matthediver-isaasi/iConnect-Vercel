import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoricalInvoicesHandler } from './historical-invoices.js';
import { createHistoricalInvoiceHandler } from './historical-invoice.js';
import { getHistoricalInvoicePdf } from '../_lib/historicalInvoicePdf.js';
import { prepareRows } from '../../scripts/import-bnms-historical-invoices.mjs';

const memberId = '4abbf667-bed2-451d-95eb-b20341de9a48';
const recordId = '3dedbedb-edb1-43ee-a80e-644b0f38434a';
const otherId = '7cb18e14-5a67-4d11-9b51-ecca61c29dd7';
const baseRow = { id: recordId, member_id: memberId, tenant_id: 'tenant', invoice_number: 'INV-1',
  invoice_date: '2020-11-26', amount_minor: 1000, record_kind: 'invoice', xero_company_id: 'company' };
function response() {
  return { code: 200, headers: {}, status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; }, send(body) { this.body = body; return this; },
    setHeader(k,v) { this.headers[k] = v; } };
}
function setup(overrides = {}) {
  const calls = [];
  const builder = {
    select(...a) { calls.push(['select', ...a]); return this; },
    eq(...a) { calls.push(['eq', ...a]); return this; },
    is(...a) { calls.push(['is', ...a]); return this; },
    order(...a) { calls.push(['order', ...a]); return this; },
    range(...a) { calls.push(['range', ...a]); return Promise.resolve({ data: [baseRow], count: 1 }); },
    maybeSingle() { return Promise.resolve({ data: baseRow }); },
    update(...a) { calls.push(['update', ...a]); return this; },
    then(resolve) { return Promise.resolve({ error: null }).then(resolve); },
  };
  const deps = {
    db: { from(table) { calls.push(['from', table]); return builder; } },
    getSessionMember: async () => ({ id: memberId, tenant_id: 'tenant', role_id: 'role' }),
    getTenantContext: async () => ({ tenantId: 'tenant', isAuthenticated: true }),
    hasAdminAccess: async () => false,
    hasFeatureAccess: async () => true,
    getPdf: async () => ({ pdf: Buffer.from('%PDF-test'), id: otherId, type: 'Invoices' }),
    ...overrides,
  };
  return { calls, builder, deps };
}
test('list is tenant and member scoped, paginated, and makes no PDF requests', async () => {
  const { deps, calls } = setup({ getPdf: () => assert.fail('PDF called on list') });
  const res = response();
  await createHistoricalInvoicesHandler(deps)({ method: 'GET', query: { memberId, page: '2' } }, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.total, 1);
  assert.deepEqual(calls.filter(x => x[0] === 'eq'), [['eq','tenant_id','tenant'], ['eq','member_id',memberId]]);
  assert.deepEqual(calls.find(x => x[0] === 'range'), ['range',100,149]);
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
});
test('other member list is denied before database access', async () => {
  const { deps, calls } = setup(); const res = response();
  await createHistoricalInvoicesHandler(deps)({ method: 'GET', query: { memberId: otherId } }, res);
  assert.equal(res.code, 403); assert.equal(calls.length, 0);
});
test('list returns verified accounting provenance without exposing raw refresh errors', async () => {
  const { deps, builder } = setup();
  builder.range = async () => ({ data: [{
    ...baseRow, status: 'Imported unpaid', accounting_payment_status: 'paid',
    accounting_status: 'PAID', accounting_status_checked_at: '2026-01-01T00:00:00Z',
    accounting_status_error: 'private provider error',
  }], count: 1 });
  const res = response();
  await createHistoricalInvoicesHandler(deps)({ method: 'GET', query: { memberId } }, res);
  assert.equal(res.body.records[0].status, 'Imported unpaid');
  assert.equal(res.body.records[0].accounting_payment_status, 'paid');
  assert.equal(res.body.records[0].accounting_status_refresh_pending, true);
  assert.equal(Object.hasOwn(res.body.records[0], 'accounting_status_error'), false);
});
test('anonymous, wrong tenant and missing history permission fail closed', async () => {
  for (const [overrides, expected] of [
    [{ getSessionMember: async () => null, getTenantContext: async () => ({}) },401],
    [{ getTenantContext: async () => ({ tenantId: 'other', isAuthenticated: true }) },409],
    [{ hasFeatureAccess: async () => false },403],
  ]) {
    const { deps, calls } = setup(overrides); const res = response();
    await createHistoricalInvoicesHandler(deps)({ method: 'GET', query: { memberId } }, res);
    assert.equal(res.code, expected); assert.equal(calls.length, 0);
  }
});
test('list without invoice permission has no download affordance', async () => {
  const { deps } = setup({ hasFeatureAccess: async (_role, key) => key === 'commerce.history' }); const res = response();
  await createHistoricalInvoicesHandler(deps)({ method: 'GET', query: { memberId } }, res);
  assert.equal(res.body.canAccessInvoices, false); assert.equal(res.body.records[0].can_download, false);
});
test('admin can list another member but still scoped to tenant', async () => {
  const { deps, calls } = setup({ hasAdminAccess: async () => true }); const res = response();
  await createHistoricalInvoicesHandler(deps)({ method: 'GET', query: { memberId: otherId } }, res);
  assert.equal(res.code, 200); assert.ok(calls.some(c => c[1] === 'tenant_id' && c[2] === 'tenant'));
});
test('PDF endpoint authorizes member and caches only successful resolution', async () => {
  const { deps, calls } = setup(); const res = response();
  await createHistoricalInvoiceHandler(deps)({ method: 'GET', query: { recordId, inline: 'true' } }, res);
  assert.equal(res.code, 200); assert.equal(res.headers['Content-Type'], 'application/pdf');
  assert.match(res.headers['Content-Disposition'], /^inline/);
  assert.ok(calls.some(c => c[1] === 'member_id' && c[2] === memberId));
  assert.deepEqual(calls.find(c => c[0] === 'update')[1], { xero_document_id: otherId, xero_document_type: 'Invoices' });
});
test('missing/foreign PDF and overpayment never contact Xero', async () => {
  for (const [row, expected] of [[null,404],[{ ...baseRow, record_kind: 'overpayment' },422]]) {
    const { deps, builder, calls } = setup({ getPdf: () => assert.fail('must not fetch PDF') });
    builder.maybeSingle = async () => ({ data: row });
    const res = response();
    await createHistoricalInvoiceHandler(deps)({ method: 'GET', query: { recordId } }, res);
    assert.equal(res.code, expected); assert.ok(!calls.some(c => c[0] === 'update'));
  }
});
test('PDF permission denied before record query', async () => {
  const { deps, calls } = setup({ hasFeatureAccess: async (_role,key) => key === 'commerce.history' });
  const res = response();
  await createHistoricalInvoiceHandler(deps)({ method: 'GET', query: { recordId } }, res);
  assert.equal(res.code,403); assert.equal(calls.length,0);
});
test('provider failure does not cache and exposes retryable message', async () => {
  const { deps, calls } = setup({ getPdf: async () => { throw Object.assign(new Error('Try later'), { status:429 }); } });
  const res = response();
  await createHistoricalInvoiceHandler(deps)({ method:'GET',query:{recordId} },res);
  assert.equal(res.code,429); assert.ok(!calls.some(c=>c[0]==='update'));
});
test('malformed and write requests rejected', async () => {
  for (const req of [{method:'POST',query:{}},{method:'GET',query:{recordId:'invalid'}}]) {
    const {deps,calls}=setup();const res=response();
    await createHistoricalInvoiceHandler(deps)(req,res);
    assert.ok([400,405].includes(res.code));assert.equal(calls.length,0);
  }
});
const token = async () => ({ accessToken:'fixture-token',tenantId:'company' });
test('Xero number lookup uses pinned company, exact receivable identity, then PDF', async () => {
  const urls=[];
  const result=await getHistoricalInvoicePdf(baseRow,{getToken:token,fetch:async (url,options)=>{
    urls.push(url);assert.equal(options.headers['xero-tenant-id'],'company');
    if(url.includes('?'))return new Response(JSON.stringify({Invoices:[{InvoiceNumber:'INV-1',InvoiceID:otherId,Type:'ACCREC',Total:10}]}));
    return new Response('%PDF-fixture');
  }});
  assert.equal(result.id,otherId);assert.equal(urls.length,2);
  assert.match(decodeURIComponent(urls[0]),/InvoiceNumber=="INV-1"/);
});
test('cached PDF uses one request and company mismatch uses none', async () => {
  let requests=0;
  const deps={getToken:token,fetch:async()=>{requests++;return new Response('%PDF-fixture');}};
  await getHistoricalInvoicePdf({...baseRow,xero_document_id:otherId,xero_document_type:'Invoices'},deps);
  assert.equal(requests,1);
  await assert.rejects(getHistoricalInvoicePdf({...baseRow,xero_company_id:'different'},deps),/organisation differs/);
  assert.equal(requests,1);
});
test('credit lookup uses CreditNotes and preserves source negative amount', async () => {
  const urls=[];
  await getHistoricalInvoicePdf({...baseRow,amount_minor:-1000,record_kind:'credit'},{getToken:token,fetch:async url=>{
    urls.push(url);
    return url.includes('?')?new Response(JSON.stringify({CreditNotes:[{CreditNoteNumber:'INV-1',CreditNoteID:otherId,Type:'ACCRECCREDIT',Total:10}]})):new Response('%PDF-fixture');
  }});
  assert.ok(urls.every(url=>url.includes('CreditNotes')));
});
test('provider absent, amount mismatch and rate limit fail explicitly', async () => {
  for (const [response, status] of [
    [new Response(JSON.stringify({Invoices:[]})),404],
    [new Response(JSON.stringify({Invoices:[{InvoiceNumber:'INV-1',InvoiceID:otherId,Type:'ACCREC',Total:50}]})),409],
    [new Response('',{status:429}),429],
  ]) await assert.rejects(getHistoricalInvoicePdf(baseRow,{getToken:token,fetch:async()=>response}),e=>e.status===status);
});
test('import identities preserve pre-2025, credits, zero and repeated overpayments', () => {
  const make=(number,amount,source_row)=>({...baseRow,invoice_number:number,amount_minor:amount,source_row,description:'Historic'});
  const rows=prepareRows([make('INV-A',0,2),make('INV-B',-100,3),make('Overpayment',-25,4),make('Overpayment',-25,5)]);
  assert.deepEqual(rows.map(r=>r.record_kind),['invoice','credit','overpayment','overpayment']);
  assert.equal(rows[0].invoice_date,'2020-11-26');
  assert.notEqual(rows[2].source_key,rows[3].source_key);
  assert.deepEqual(prepareRows([make('INV-A',0,2)])[0].source_key,rows[0].source_key);
  assert.throws(()=>prepareRows([make('INV-A',1,2),make('inv-a',2,3)]),/Duplicate/);
});
