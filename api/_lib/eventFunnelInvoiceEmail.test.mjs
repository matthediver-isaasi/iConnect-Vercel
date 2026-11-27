import test from 'node:test';
import assert from 'node:assert/strict';
import {composeFunnelInvoiceEmail,deliverFunnelInvoiceEmail} from './eventFunnelInvoiceEmail.js';

const job={tenant_id:'tenant',order_id:'order',lease_token:'lease'};
const plan={status:'pending',recipient:'finance@example.test',currency:'GBP',payableMinor:24000,
  events:['Spring Meeting'],invoices:[{id:'w1',invoiceNumber:'INV-1',provider:'xero'},{id:'w2',invoiceNumber:'INV-2',provider:'xero'}]};
function journal(read=plan,{finish='complete'}={}) {
  const calls=[];
  return {calls,db:{rpc:async(name,args)=>{
    assert.equal(name,'event_funnel_invoice_email_operation');
    assert.equal(args.p_token,'lease');calls.push(args);
    if(args.p_action==='read') return {data:read};
    if(args.p_action==='begin') return {data:{status:'send',payload:args.p_payload}};
    return {data:{status:args.p_payload.outcome==='accepted'?finish:args.p_payload.outcome==='not_submitted'?'pending':'needs_review'}};
  }}};
}
const pdf=Buffer.from('%PDF-1.4 fixture');

test('all invoices are attached to one email to the frozen recipient',async()=>{
  const j=journal(),sent=[];
  const result=await deliverFunnelInvoiceEmail({db:j.db,job,deadlineAt:60000,now:()=>0,loadPdf:async()=>pdf,
    send:async message=>{sent.push(message);return {success:true,messageId:'<m1>'};}});
  assert.deepEqual(result,{status:'complete'});
  assert.equal(sent.length,1);
  assert.equal(sent[0].to,'finance@example.test');assert.equal(sent[0].tenantId,'tenant');
  assert.deepEqual(sent[0].attachments.map(a=>a.filename),['INV-1.pdf','INV-2.pdf']);
  assert.match(sent[0].subject,/invoices for Spring Meeting/);
  assert.match(sent[0].html,/Your 2 invoices are attached/);
  assert.deepEqual(j.calls.at(-1).p_payload,{outcome:'accepted',messageId:'m1'});
});
test('a PDF failure retries without claiming a send',async()=>{
  const j=journal();
  const result=await deliverFunnelInvoiceEmail({db:j.db,job,deadlineAt:60000,now:()=>0,
    loadPdf:async()=>{throw new Error('provider');},send:()=>assert.fail('no send')});
  assert.deepEqual(result,{status:'retry'});
  assert.deepEqual(j.calls.map(c=>c.p_action),['read']);
});
test('an unknown send outcome goes to review and is never resent here',async()=>{
  const j=journal();
  const result=await deliverFunnelInvoiceEmail({db:j.db,job,deadlineAt:60000,now:()=>0,loadPdf:async()=>pdf,
    send:async()=>{throw new Error('socket');}});
  assert.deepEqual(result,{status:'needs_review'});
  assert.equal(j.calls.at(-1).p_payload.outcome,'unknown');
});
test('a pre-submission refusal is recorded as not submitted and retried',async()=>{
  const j=journal();
  const result=await deliverFunnelInvoiceEmail({db:j.db,job,deadlineAt:60000,now:()=>0,loadPdf:async()=>pdf,
    send:async()=>({success:false,error:'Worker deadline exhausted before Mailgun delivery'})});
  assert.deepEqual(result,{status:'retry'});
  assert.equal(j.calls.at(-1).p_payload.outcome,'not_submitted');
});
test('journal states map without sending',async()=>{
  for(const [status,expected] of [['complete','complete'],['waiting','waiting'],['needs_review','needs_review']]) {
    const j=journal({status});
    assert.deepEqual(await deliverFunnelInvoiceEmail({db:j.db,job,deadlineAt:60000,now:()=>0,
      loadPdf:()=>assert.fail('no pdf'),send:()=>assert.fail('no send')}),{status:expected});
  }
});
test('a missing journal function keeps the previous behaviour',async()=>{
  const db={rpc:async()=>({data:null,error:{code:'42883'}})};
  assert.deepEqual(await deliverFunnelInvoiceEmail({db,job,deadlineAt:60000,now:()=>0}),{status:'complete'});
});
test('the email copy escapes event titles and uses a single-invoice wording',()=>{
  const message=composeFunnelInvoiceEmail({...plan,events:['<b>A</b>'],invoices:[plan.invoices[0]]});
  assert.match(message.html,/&lt;b&gt;A&lt;\/b&gt;/);assert.match(message.html,/Your invoice is attached/);
  assert.deepEqual(Object.keys(message).sort(),['html','subject','to']);
});
