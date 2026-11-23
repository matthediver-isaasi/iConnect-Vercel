import test from 'node:test';
import assert from 'node:assert/strict';
import {executeFunnelQuickBooksCredit} from './eventFunnelQuickBooksCredit.js';
function fixture({due=0}={}){
  const original={Id:'invoice',CustomerRef:{value:'customer'},CurrencyRef:{value:'GBP'},GlobalTaxCalculation:'TaxInclusive',
    TotalAmt:12,TxnTaxDetail:{TotalTax:2,TaxLine:[{Amount:2,TaxLineDetail:{TaxRateRef:{value:'rate'}}}]},
    Line:[{Id:'line',Description:'Original booking',Amount:12,DetailType:'SalesItemLineDetail',
      SalesItemLineDetail:{ItemRef:{value:'item'},TaxCodeRef:{value:'tax'},Qty:1,UnitPrice:12}}],
    taxAllocations:[{index:0,amountMinor:1200,grossMinor:1200,taxMinor:200,taxRateId:'rate',percentage:20}]};
  const job={id:'job',tenant_id:'tenant',provider:'quickbooks',company_id:'realm',environment:'production',
    status:'pending',credit_date:'2026-11-23',original_native_invoice:original,invoice_id:'invoice',
    selected:[{source:'booking',id:'booking',amountMinor:1200}],prior_amounts:{},known_credit_ids:[],
    line_allocations:[{index:0,source:'booking',bookingId:'booking',amountMinor:1200}]};
  const calls=[],state={note:null,payment:null,writing:false,allocation:false};
  const store={prepare:async()=>true,begin:async()=>{
    if(state.writing)return false;state.writing=true;calls.push('begin');return true;},
    beginAllocation:async()=>{if(state.allocation)return false;state.allocation=true;calls.push('allocation');return true;},
    complete:async(_id,receipt)=>{state.receipt=receipt;calls.push('complete');return true;}};
  const fetcher=async(url,options)=>{
    const parsed=new URL(url),path=parsed.pathname;
    if(path.endsWith('/invoice/invoice'))return Response.json({Invoice:{...original,Balance:due}});
    if(path.endsWith('/query')){
      const q=parsed.searchParams.get('query'),entity=q.includes('FROM CreditMemo')?'CreditMemo':'Payment';
      const first=q.includes('STARTPOSITION 1 '),value=entity==='CreditMemo'?state.note:state.payment;
      return Response.json({QueryResponse:first&&value?{[entity]:[value]}:{}});
    }
    if(options.method==='POST'){
      calls.push(path.endsWith('/creditmemo')?'credit POST':'payment POST');
      assert.ok(parsed.searchParams.get('requestid'));
      const body=JSON.parse(options.body);
      if(path.endsWith('/creditmemo')){
        state.note={...body,Id:'credit',TotalAmt:12,RemainingCredit:12};
        return Response.json({CreditMemo:state.note});
      }
      state.payment={...body,Id:'payment',UnappliedAmt:0};state.note.RemainingCredit=0;
      return Response.json({Payment:state.payment});
    }
    if(path.endsWith('/creditmemo/credit'))return Response.json({CreditMemo:state.note});
    if(path.endsWith('/payment/payment'))return Response.json({Payment:state.payment});
    throw new Error(`Unexpected fixture request ${path}`);
  };
  return {job,store,fetcher,calls,state,loadToken:async()=>({accessToken:'fixture',realmId:'realm',environment:'production'})};
}
for(const due of [0,12])test(`native QuickBooks credit and allocation retain the original invoice: ${due}`,async()=>{
  const f=fixture({due}),result=await executeFunnelQuickBooksCredit(f);
  assert.equal(result.status,'complete');assert.equal(result.receipt.amountMinor,1200);
  assert.deepEqual(f.calls,due?['begin','credit POST','allocation','payment POST','complete']:['begin','credit POST','complete']);
});
test('unknown creation is reconciled without a second credit memo',async()=>{
  const f=fixture(),real=f.fetcher;
  f.fetcher=async(url,options)=>{
    const response=await real(url,options);
    if(options.method==='POST')throw new Error('lost response');
    return response;
  };
  await assert.rejects(executeFunnelQuickBooksCredit(f),/lost response/);
  f.fetcher=real;assert.equal((await executeFunnelQuickBooksCredit(f)).status,'complete');
  assert.equal(f.calls.filter(c=>c==='credit POST').length,1);
});
test('empty discovery never permits repeating an uncertain credit POST',async()=>{
  const f=fixture();f.state.writing=true;
  await assert.rejects(executeFunnelQuickBooksCredit(f),/reconciliation/);
  assert.deepEqual(f.calls,[]);
});
test('changed company blocks reads and writes',async()=>{
  const f=fixture();f.loadToken=async()=>({accessToken:'fixture',realmId:'different',environment:'production'});
  await assert.rejects(executeFunnelQuickBooksCredit(f),/company/);assert.deepEqual(f.calls,[]);
});
test('lost allocation response recovers its payment without creating either transaction again',async()=>{
  const f=fixture({due:12}),real=f.fetcher;
  f.fetcher=async(url,options)=>{
    const response=await real(url,options);
    if(options.method==='POST'&&new URL(url).pathname.endsWith('/payment'))throw new Error('lost allocation response');
    return response;
  };
  await assert.rejects(executeFunnelQuickBooksCredit(f),/lost allocation/);
  f.fetcher=real;assert.equal((await executeFunnelQuickBooksCredit(f)).status,'complete');
  assert.equal(f.calls.filter(c=>c==='credit POST').length,1);
  assert.equal(f.calls.filter(c=>c==='payment POST').length,1);
});
test('a credit applied to a different invoice is never reported as a successful refund',async()=>{
  const f=fixture(),real=f.fetcher;
  await executeFunnelQuickBooksCredit(f);
  f.state.note.RemainingCredit=0;
  f.state.payment={Id:'unrelated-payment',CustomerRef:{value:'customer'},CurrencyRef:{value:'GBP'},TotalAmt:0,UnappliedAmt:0,
    Line:[{Amount:12,LinkedTxn:[{TxnId:'different-invoice',TxnType:'Invoice'},{TxnId:'credit',TxnType:'CreditMemo'}]}]};
  f.fetcher=real;
  await assert.rejects(executeFunnelQuickBooksCredit(f),/outside its original invoice/);
  assert.equal(f.calls.filter(c=>c==='credit POST').length,1);
  assert.equal(f.calls.filter(c=>c==='payment POST').length,0);
});
