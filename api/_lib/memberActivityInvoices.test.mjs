import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeMemberActivityInvoices, loadMemberActivityInvoices } from './memberActivityInvoices.js';
import { createHistoricalInvoicesHandler } from '../membership/historical-invoices.js';

const memberId = '12113f4d-8cd2-428e-9722-c4cf008dbcf2';
const current = { id:'current', accounting_provider:'xero', accounting_invoice_id:'provider-id',
  accounting_invoice_number:'INV-9387', total_with_vat:128, currency:'GBP', payment_status:'paid',
  paid_at:'2026-10-08T08:06:53Z', term_start_date:'2026-10-08', term_end_date:'2027-10-07' };
test('paid current invoice uses payment chronology without fabricating invoice date', () => {
  const [row] = mergeMemberActivityInvoices([], [current], true);
  assert.equal(row.invoice_number, 'INV-9387');
  assert.equal(row.amount_minor, 12800);
  assert.equal(row.invoice_date, null);
  assert.equal(row.activity_date, current.paid_at);
  assert.equal(row.date_label, 'Payment date');
  assert.equal(row.status, 'paid');
  assert.equal(row.can_download, true);
});
test('mixed invoices sort by occurrence; unknown dates last; unlinked rows excluded', () => {
  const rows = mergeMemberActivityInvoices([{id:'old',invoice_date:'2020-01-01'}],
    [current,{...current,id:'unknown',accounting_invoice_id:'other',paid_at:null,term_start_date:null},
      {...current,id:'unlinked',accounting_invoice_id:null}],false);
  assert.deepEqual(rows.map(r=>r.id),['current','old','unknown']);
  assert.ok(rows.every(r=>!r.can_download));
});
test('dedupe by provider document, legacy Xero number and repeated history linkage', () => {
  for (const archive of [
    {id:'archive',record_kind:'invoice',invoice_number:'renamed',xero_document_id:'provider-id'},
    {id:'archive',record_kind:'invoice',invoice_number:'INV-9387'},
  ]) assert.equal(mergeMemberActivityInvoices([archive],[current],true).length,1);
  assert.equal(mergeMemberActivityInvoices([],[current,{...current,id:'duplicate'}],true).length,1);
  assert.equal(mergeMemberActivityInvoices([{id:'archive',record_kind:'invoice',invoice_number:'INV-9387',
    xero_document_id:'different'}],[current],true).length,2);
  assert.equal(mergeMemberActivityInvoices([{id:'archive',record_kind:'invoice',invoice_number:'INV-9387'}],
    [{...current,accounting_provider:'quickbooks'}],true).length,2);
});
function fixture({fail=false, role='admin'}={}) {
  const calls=[];
  const db={from(table) {
    const filters=[];
    const q={select(){return q},eq(k,v){filters.push([k,v]);return q},order(){return q},
      range(start,end) {
        calls.push({table,filters,start,end});
        const rows=table==='historical_member_invoice'?[]:Array.from({length:501},(_,i)=>({...current,id:`h${i}`,accounting_invoice_id:`invoice${i}`}));
        return Promise.resolve(fail && table==='member_membership_history'?{error:new Error('unavailable')}:
          {data:rows.slice(start,end+1),count:rows.length});
      }};
    return q;
  }};
  const deps={db,getSessionMember:async()=>({id:memberId,tenant_id:'tenant',role_id:'role'}),
    getTenantContext:async()=>({tenantId:'tenant',isAuthenticated:true}),
    hasAdminAccess:async()=>role==='admin',hasFeatureAccess:async(_id,key)=>key==='commerce.history'};
  return {db,calls,deps};
}
test('all pages are read with tenant and member isolation',async()=>{
  const f=fixture();
  const rows=await loadMemberActivityInvoices(f.db,{tenantId:'tenant',memberId,canAccessInvoices:true});
  assert.equal(rows.length,501);
  assert.ok(f.calls.some(c=>c.start===500));
  assert.ok(f.calls.every(c=>c.filters.some(([k,v])=>k==='tenant_id'&&v==='tenant')
    &&c.filters.some(([k,v])=>k==='member_id'&&v===memberId)));
});
function response(){return {code:200,setHeader(){},status(n){this.code=n;return this},json(body){this.body=body;return this}}}
test('combined endpoint paginates after merging and retains invoice permissions',async()=>{
  const f=fixture({role:'member'}),r=response();
  await createHistoricalInvoicesHandler(f.deps)({method:'GET',query:{memberId,page:'10',includeMembership:'true'}},r);
  assert.equal(r.code,200);assert.equal(r.body.total,501);assert.equal(r.body.records.length,1);
  assert.equal(r.body.canAccessInvoices,false);assert.equal(r.body.records[0].can_download,false);
});
test('other member request denied before any table read',async()=>{
  const f=fixture({role:'member'}),r=response();
  await createHistoricalInvoicesHandler(f.deps)({method:'GET',query:{memberId:'22113f4d-8cd2-428e-9722-c4cf008dbcf2',includeMembership:'true'}},r);
  assert.equal(r.code,403);assert.equal(f.calls.length,0);
});
test('current invoice load failure does not publish incomplete archive-only timeline',async()=>{
  const f=fixture({fail:true}),r=response();
  await createHistoricalInvoicesHandler(f.deps)({method:'GET',query:{memberId,includeMembership:'true'}},r);
  assert.equal(r.code,500);assert.equal(r.body.records,undefined);
});
test('invalid selector fails before access or data calls',async()=>{
  const f=fixture(),r=response();
  await createHistoricalInvoicesHandler(f.deps)({method:'GET',query:{memberId,includeMembership:['true']}},r);
  assert.equal(r.code,400);assert.equal(f.calls.length,0);
});
