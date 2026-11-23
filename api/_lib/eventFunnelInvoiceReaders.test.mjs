import test from 'node:test';
import assert from 'node:assert/strict';
import {readFunnelInvoiceDownload,addFunnelInvoiceReportStatus,fetchFunnelInvoicePdf} from './eventFunnelInvoiceReaders.js';

const scope={tenantId:'tenant',groupRef:'group',memberId:'original',isAdmin:false};
const link={provider:'quickbooks',invoiceId:'invoice',invoiceNumber:'INV1',connectionId:'connection',companyId:'company',environment:'production'};
test('invoice download sends only server-resolved purchaser and tenant authority',async()=>{
  const result=await readFunnelInvoiceDownload({...scope,db:{rpc:async(name,args)=>{
    assert.equal(name,'event_funnel_invoice_download');
    assert.deepEqual(args,{p_tenant:'tenant',p_group:'group',p_member:'original',p_admin:false});
    return {data:link};
  }}});
  assert.deepEqual(result,link);
});
test('only missing staged RPC or explicit non-funnel result allows legacy download',async()=>{
  for(const code of ['42883','PGRST202']) assert.equal(await readFunnelInvoiceDownload({...scope,
    db:{rpc:async()=>({error:{code}})}}),null);
  assert.equal(await readFunnelInvoiceDownload({...scope,db:{rpc:async()=>({data:null})}}),null);
  for(const [code,status] of [['PT403',403],['PT409',409],['42501',503],['NETWORK',503]]) {
    await assert.rejects(readFunnelInvoiceDownload({...scope,db:{rpc:async()=>({error:{code}})}}),{status});
  }
  await assert.rejects(readFunnelInvoiceDownload({...scope,db:{rpc:async()=>({data:{invoiceId:'unverified'}})}}),{status:503});
});
test('report adds shared invoice references without copying full payment or changing event totals',async()=>{
  const groups=[{bookingSource:'booking',attendees:[{id:'a'},{id:'b'}],
    groupPayment:{totalCost:14,stripePaymentIntentId:null}},{bookingSource:'complex_event_booking',
    attendees:[{id:'a'}],groupPayment:{totalCost:99}}];
  await addFunnelInvoiceReportStatus({rpc:async(_name,args)=>{
    assert.equal(args.p_tenant,'tenant');
    return {data:['a','b'].map(id=>({bookingId:id,bookingSource:'booking',orderId:'order',invoiceMode:'consolidated',
      payableMinor:700,provider:'quickbooks',invoiceId:'invoice',invoiceNumber:'INV1',status:'complete'}))};
  }},'tenant',groups);
  assert.equal(groups[0].groupPayment.accountingInvoiceId,'invoice');
  assert.equal(groups[0].sharedCheckout.eventPayableMinor,1400);
  assert.equal(groups[0].groupPayment.totalCost,14);
  assert.equal(groups[0].groupPayment.stripePaymentIntentId,null);
  assert.deepEqual(groups[1].groupPayment,{totalCost:99});
});
test('report errors never impersonate empty accounting authority and batches stay bounded',async()=>{
  const groups=[{bookingSource:'booking',attendees:Array.from({length:1001},(_,id)=>({id:String(id)})),groupPayment:{}}];
  const sizes=[];
  await addFunnelInvoiceReportStatus({rpc:async(_name,args)=>{sizes.push(args.p_bookings.length);return {data:[]};}},'tenant',groups);
  assert.deepEqual(sizes,[1000,1]);
  await assert.rejects(addFunnelInvoiceReportStatus({rpc:async()=>({error:{code:'NETWORK'}})},'tenant',groups),{status:503});
});
test('PDF uses the captured company, connection and environment even after active-provider changes',async()=>{
  for(const provider of ['xero','quickbooks']) {
    const invoice={...link,provider},calls=[];
    const pdf=await fetchFunnelInvoicePdf({tenantId:'tenant',link:invoice},{
      loadBinding:async()=>({...invoice,accessToken:'fixture-token',expiresAt:new Date(Date.now()+60000).toISOString()}),
      fetchImpl:async(url,init)=>{calls.push([url,init]);return new Response('%PDF-1.4 fixture');},
    });
    assert.match(pdf.toString(),/^%PDF/);assert.equal(calls.length,1);
    assert.equal(calls[0][1].redirect,'error');
    if(provider==='xero') assert.equal(calls[0][1].headers['xero-tenant-id'],'company');
    else assert.match(calls[0][0],/\/company\/company\/invoice\/invoice\/pdf$/);
  }
});
test('changed companies, connections and environments fail before invoice requests',async()=>{
  for(const changed of [{companyId:'other'},{connectionId:'other'},{environment:'sandbox'},{expiresAt:'2020-01-01'}]) {
    await assert.rejects(fetchFunnelInvoicePdf({tenantId:'tenant',link},{
      loadBinding:async()=>({...link,accessToken:'fixture',expiresAt:new Date(Date.now()+60000).toISOString(),...changed}),
      fetchImpl:()=>assert.fail('must not fetch wrong invoice'),
    }),{status:503});
  }
});
test('provider failures and non-PDF or oversized documents are not delivered',async()=>{
  for(const response of [new Response('failure',{status:503}),new Response('<html>not an invoice</html>'),
    new Response('%PDF-oversized',{headers:{'content-length':String(21*1024*1024)}})]) {
    await assert.rejects(fetchFunnelInvoicePdf({tenantId:'tenant',link},{
      loadBinding:async()=>({...link,accessToken:'fixture',expiresAt:new Date(Date.now()+60000).toISOString()}),
      fetchImpl:async()=>response,
    }),{status:503});
  }
});
