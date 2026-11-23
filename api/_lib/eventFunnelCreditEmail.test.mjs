import test from 'node:test';
import assert from 'node:assert/strict';
import {loadFunnelCreditPdf,deliverFunnelCreditEmails} from './eventFunnelCreditEmail.js';
const context={order:{tenant_id:'tenant',id:'order'},operation:{id:'reversal',lease_id:'lease'}};
function job(provider='xero'){
  return {id:'email',credit_id:'credit',tenant_id:'tenant',order_id:'order',reversal_id:'reversal',
    recipient:'fixture@example.test',snapshot:{provider,invoice_id:'invoice',company_id:'company',environment:'sandbox',
      receipt:{provider,creditNoteId:'credit',invoiceId:'invoice'}}};
}
test('PDF downloads are pinned to the issued credit company for both providers',async()=>{
  for(const provider of ['xero','quickbooks']){
    let requested;
    const pdf=await loadFunnelCreditPdf({job:job(provider),deadlineAt:Date.now()+20000,
      loadToken:async()=>({accessToken:'fixture',tenantId:'company',realmId:'company',environment:'sandbox'}),
      fetcher:async(url,options)=>{
        requested=url;assert.equal(options.redirect,'error');assert.equal(options.headers.Accept,'application/pdf');
        return new Response('%PDF-1.4\nFixture');
      }});
    assert.match(pdf.toString(),/^%PDF-/);assert.match(requested,provider==='xero'?/CreditNotes\/credit/:/company\/company\/creditmemo\/credit\/pdf/);
    let reads=0;
    await assert.rejects(loadFunnelCreditPdf({job:job(provider),deadlineAt:Date.now()+20000,
      loadToken:async()=>({accessToken:'fixture',tenantId:'other',realmId:'other',environment:'sandbox'}),
      fetcher:async()=>{reads++;}}));
    assert.equal(reads,0);
  }
});
test('non-PDF and oversized downloads cannot be sent',async()=>{
  for(const response of [new Response('not a PDF'),new Response('%PDF-1.4',{headers:{'content-length':'9000000'}})]){
    await assert.rejects(loadFunnelCreditPdf({job:job(),deadlineAt:Date.now()+20000,
      loadToken:async()=>({accessToken:'fixture',tenantId:'company'}),fetcher:async()=>response}));
  }
});
function fixture(){
  let state='pending',payload;const current=job();let downloads=0,sends=0;
  return {context,db:{rpc:async(name,args)=>{
    assert.equal(name,'event_funnel_credit_email_operation');
    if(args.p_action==='read')return {data:{status:state==='delivered'?'complete':state==='pending'?'retry':'needs_review',
      jobs:state==='pending'?[{...current,payload}]:[]}};
    if(args.p_action==='begin'){state='writing';payload||=args.p_payload;return {data:{status:'send',payload}};}
    state=args.p_payload.outcome==='accepted'?'delivered':args.p_payload.outcome==='not_submitted'?'pending':'needs_review';
    return {data:{status:state}};
  }},loadPdf:async()=>{downloads++;return Buffer.from('%PDF-1.4\nFixture');},
  send:async envelope=>{sends++;assert.equal(envelope.to,current.recipient);
    assert.ok(Buffer.isBuffer(envelope.attachments[0].data));return {success:true,messageId:'accepted'};},
  count:()=>({downloads,sends})};
}
test('accepted credit emails are not resent and the PDF envelope is frozen for known non-submission',async()=>{
  const f=fixture();
  assert.equal((await deliverFunnelCreditEmails({...f,send:async()=>({notSubmitted:true})})).status,'retry');
  assert.equal((await deliverFunnelCreditEmails(f)).status,'complete');
  await deliverFunnelCreditEmails(f);
  assert.deepEqual(f.count(),{downloads:1,sends:1});
});
test('a lost mail response requires reconciliation, never a second send',async()=>{
  const f=fixture();let writes=0;
  const send=async()=>{writes++;throw new Error('Response lost');};
  assert.equal((await deliverFunnelCreditEmails({...f,send})).status,'needs_review');
  await deliverFunnelCreditEmails({...f,send});assert.equal(writes,1);
});
