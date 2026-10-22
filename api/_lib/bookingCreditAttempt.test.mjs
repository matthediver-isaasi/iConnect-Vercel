import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const fixture = '__bookingCreditAttemptFixture';
const bundle = await build({
  entryPoints: ['api/_lib/bookingCreditAttempt.js'], bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{
    name: 'isolated-auth',
    setup(b) {
      b.onResolve({ filter: /^\.\/(session|tenantResolver|eventInvoiceProducer)\.js$/ }, a=>({path:a.path,namespace:'fixture'}));
      b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:a.path.includes('eventInvoiceProducer')
        ? `export const enqueueCheckoutEventInvoice=async(input)=>{globalThis.${fixture}.invoiceInput=input;return {queued:true};}; export const simpleEventInvoiceLines=()=>[]; export const complexEventInvoiceLines=()=>[];`
        : a.path.includes('session')
        ? `export const getSessionMember=async()=>globalThis.${fixture}.member;`
        : `export const resolveTenantFromRequest=async()=>globalThis.${fixture}.tenant;`,loader:'js'}));
    },
  }],
});
const api=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const body={purchase_request_id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',selectedVoucherIds:['v'],eventId:'e'};
function dbFor(state) {
  const calls=[];
  return {calls,
    rpc: async(name,args)=>{
      calls.push({name,args});
      if(name==='booking_credit_begin') return {data:state.cached?{response:state.cached}:{}};
      if(name==='booking_credit_finish') return {data:state.committed || args.p_response};
      return {data:{}};
    },
    from() {
      const q={select(){return q;},eq(){return q;},single(){return Promise.resolve({
        data:{state:'committed',invoice_state:'complete',response:state.cached || state.committed || {success:true}},error:null,
      });}};
      return q;
    },
  };
}
test.beforeEach(()=>{globalThis[fixture]={tenant:{id:'t'},member:{id:'m'}};});
test('stable canonical fingerprint detects changed funding but not object key order',()=>{
  assert.equal(api.bookingAttemptFingerprint({a:1,b:2}),api.bookingAttemptFingerprint({b:2,a:1}));
  assert.notEqual(api.bookingAttemptFingerprint(body),api.bookingAttemptFingerprint({...body,selectedVoucherIds:['other']}));
});
test('non-card request obtains stable identity and a new execution fence',async()=>{
  const db=dbFor({});
  for(let i=0;i<2;i++) await api.runBookingCreditAttempt({db,req:{},body,source:'booking',
    work:async()=>({success:false,error:'Validation requires correction'})});
  assert.equal(db.calls[0].args.p_purchase_key,db.calls[2].args.p_purchase_key);
  assert.notEqual(db.calls[0].args.p_fence,db.calls[2].args.p_fence);
});
test('committed retry returns original success without booking or spending again',async()=>{
  const db=dbFor({cached:{success:true,bookings:[{id:'original'}]}});
  const response=await api.runBookingCreditAttempt({db,req:{},body,source:'booking',
    work:async()=>{throw new Error('must not run');}});
  assert.equal(response.bookings[0].id,'original');
  assert.equal(db.calls.length,1);
});
test('ambiguous post-commit failure resolves original committed result',async()=>{
  const db=dbFor({committed:{success:true,bookings:[{id:'original'}]}});
  const response=await api.runBookingCreditAttempt({db,req:{},body,source:'booking',
    work:async()=>{throw new Error('Connection lost after transaction');}});
  assert.equal(response.success,true);
});
test('missing identity, missing stable key and fake card bypass are rejected before writes',async()=>{
  const db=dbFor({});
  await assert.rejects(api.runBookingCreditAttempt({db,req:{},body:{...body,purchase_request_id:null},source:'booking',work:async()=>({})}));
  await assert.rejects(api.runBookingCreditAttempt({db,req:{},body:{...body,_testMode:true},source:'booking',work:async()=>({})}));
  globalThis[fixture].member=null;
  await assert.rejects(api.runBookingCreditAttempt({db,req:{},body,source:'booking',work:async()=>({})}));
  assert.equal(db.calls.length,0);
});
test('durable invoice evidence excludes Stripe client secret and member credentials',()=>{
  const input=api.bookingCreditInvoiceInput({paymentIntent:{id:'pi',client_secret:'secret'},booker:{id:'m',email:'a@example.invalid',password_hash:'sensitive'}});
  assert.equal(input.paymentIntent.client_secret,undefined);
  assert.equal(input.booker.password_hash,undefined);
});
test('committed invoice outbox resumes with original funding and marks completion',async()=>{
  let update;
  const row={state:'committed',invoice_state:'pending',source:'booking',created_at:'2026-01-01T00:00:00Z',
    response:{success:true,bookings:[{id:'b'}]},funding:{voucherFunding:[{ownerType:'member',displayName:'Personal Credit',amountMinor:300}],
      invoiceInput:{amount:7,currency:'GBP',lineInput:{totalCost:10},paymentIntent:{id:'pi'}}}};
  const db={from(){
    const q={select(){return q;},eq(){return q;},single(){return Promise.resolve({data:row});},
      update(value){update=value;return q;},then(resolve,reject){return Promise.resolve({error:null}).then(resolve,reject);}};
    return q;
  }};
  const result=await api.continueBookingCreditInvoice(db,'t','purchase');
  assert.equal(result.success,true);
  assert.equal(update.invoice_state,'complete');
  assert.equal(globalThis[fixture].invoiceInput.bookingGroupReference,'purchase');
  assert.equal(globalThis[fixture].invoiceInput.amount,7);
  assert.equal(globalThis[fixture].invoiceInput.now.toISOString(),row.created_at.replace('Z','.000Z'));
});
test('stale execution fence is never evidence to refund a newer attempt payment',async()=>{
  const db={rpc:async()=>({error:{code:'P0001',message:'Booking attempt fence expired'}})};
  await assert.rejects(api.finalizeBookingCredit(db,{p_tenant_id:'t',key:'k',p_fence:'old'},
    {eventId:'e',rows:[],funding:{}}),error=>error.definitiveRollback===false);
});
