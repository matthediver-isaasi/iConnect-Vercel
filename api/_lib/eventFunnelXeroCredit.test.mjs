import test from 'node:test';
import assert from 'node:assert/strict';
import {executeFunnelXeroCredit} from './eventFunnelXeroCredit.js';
import {createXeroCreditNote} from './xero.js';
function fixture(){
  const calls=[],line={LineItemID:'line',Description:'Booking one',Quantity:1,UnitAmount:12,LineAmount:12,TaxAmount:2,
    TaxType:'OUTPUT2',AccountCode:'200'};
  const invoice={InvoiceID:'invoice',Status:'AUTHORISED',Contact:{ContactID:'customer'},CurrencyCode:'GBP',LineAmountTypes:'Inclusive',
    Total:12,TotalTax:2,AmountDue:0,AmountCredited:0,LineItems:[line]};
  const job={id:'job',status:'pending',prior_amounts:{},known_credit_ids:[],
    tenant_id:'tenant',company_id:'company',invoice_id:'invoice',original_invoice:structuredClone(invoice),
    selected:[{source:'booking',id:'one',amountMinor:1200}],line_allocations:[{index:0,source:'booking',bookingId:'one',amountMinor:1200}]};
  const note={CreditNoteID:'credit',Contact:{ContactID:'customer'},Type:'ACCRECCREDIT',Status:'AUTHORISED',
    Reference:'event-funnel-credit:job',CurrencyCode:'GBP',Total:12,TotalTax:2,RemainingCredit:12,LineItems:[line]};
  const store={prepare:async()=>true,begin:async()=>{calls.push('begin');return true;},
    beginAllocation:async()=>{calls.push('allocation');return true;},complete:async()=>{calls.push('complete');return true;}};
  const fetcher=async(url,options)=>{calls.push(options.method);return Response.json({
    Allocations:[{Invoice:{InvoiceID:'invoice'},Amount:12}],
  });};
  const create=async(args,dependencies)=>{
    const amounts=await dependencies.buildAmounts(invoice);
    assert.equal(amounts.LineItems[0].UnitAmount,12);
    await dependencies.fetcher('https://api.xero.com/api.xro/2.0/CreditNotes',{method:'POST'});
    await dependencies.verifyCredit(note,invoice);
    return {creditNoteId:'credit',allocated:false};
  };
  return {job,invoice,note,calls,store,fetcher,create,loadToken:async()=>({accessToken:'fixture-token',tenantId:'company'})};
}
test('exact-line credit persists its write barrier before provider submission',async()=>{
  const f=fixture();assert.equal((await executeFunnelXeroCredit(f)).status,'complete');
  assert.deepEqual(f.calls,['begin','POST','complete']);
});
test('an uncertain prior write cannot be repeated when discovery finds nothing',async()=>{
  const f=fixture();f.store.begin=async()=>false;
  await assert.rejects(executeFunnelXeroCredit(f),/reconciliation/);assert.deepEqual(f.calls,[]);
});
test('missing refund history is not interpreted as no earlier credits',async()=>{
  const f=fixture();delete f.job.prior_amounts;
  await assert.rejects(executeFunnelXeroCredit(f),/authority/);assert.deepEqual(f.calls,[]);
});
test('observed credit is reconciled without a second POST and can finish its first allocation',async()=>{
  const f=fixture();f.invoice.AmountDue=12;
  f.create=async(args,deps)=>{await deps.verifyCredit(f.note,f.invoice);return {creditNoteId:'credit',allocated:false};};
  assert.equal((await executeFunnelXeroCredit(f)).status,'complete');
  assert.deepEqual(f.calls,['allocation','PUT','complete']);
});
test('changed company or unrelated credited lines cannot be adopted',async()=>{
  const f=fixture();f.loadToken=async()=>({tenantId:'other'});
  await assert.rejects(executeFunnelXeroCredit(f),/company/);assert.deepEqual(f.calls,[]);
  const g=fixture();g.note.LineItems=[{...g.note.LineItems[0],Description:'another booking'}];
  g.create=async(args,deps)=>{await deps.verifyCredit(g.note,g.invoice);return {creditNoteId:'credit'};};
  await assert.rejects(executeFunnelXeroCredit(g),/approved lines/);assert.deepEqual(g.calls,[]);
});
test('real Xero credit helper uses only the selected lines and validates allocation receipts',async()=>{
  for(const mismatch of [false,true]){
    const f=fixture();f.create=createXeroCreditNote;f.invoice.AmountDue=12;
    f.fetcher=async(url,options)=>{
      if(options.method==='GET')return Response.json(url.includes('/Invoices/')?{Invoices:[f.invoice]}:{CreditNotes:[]});
      f.calls.push(options.method);
      if(options.method==='POST'){
        const posted=JSON.parse(options.body).CreditNotes[0];
        assert.equal(posted.Reference,'event-funnel-credit:job');
        assert.equal(posted.LineItems.length,1);assert.equal(posted.LineItems[0].TaxAmount,2);
        return Response.json({CreditNotes:[f.note]});
      }
      return Response.json({Allocations:[{Invoice:{InvoiceID:mismatch?'unrelated':'invoice'},Amount:12}]});
    };
    const result=await executeFunnelXeroCredit(f);
    assert.equal(result.status,mismatch?'needs_review':'complete');
    assert.deepEqual(f.calls,['begin','POST','allocation','PUT','complete']);
  }
});
