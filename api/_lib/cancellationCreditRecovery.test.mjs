import test from 'node:test';
import assert from 'node:assert/strict';
import {processCancellationCredit,creditRecoveryMessage} from './cancellationCreditRecovery.js';
import {executeCancellationCredit} from './xeroCancellationRecovery.js';

const initial=()=>({id:'op',tenant_id:'tenant',company_id:'company',state:'pending',attempts:0,updated_at:'2026-01-01',
  next_attempt_at:'2026-01-01',booking_source:'booking',booking_ids:['booking'],invoice_id:'invoice',amount:200});
function database(row){
  const tables={cancellation_credit_operation:[row],booking:[{id:'booking',tenant_id:'tenant',xero_invoice_id:'invoice'}],
    booking_reversal_evidence:[],accounting_request_binding:[{provider:'xero',company_id:'company',cooldown_until:'2020-01-01'}]};
  return {tables,from(table){
    let filters=[],patch,insert,single=false;
    const q={select(){return q;},update(p){patch=p;return q;},upsert(p){insert=p;return q;},
      eq(k,v){filters.push(r=>r[k]===v);return q;},in(k,v){filters.push(r=>v.includes(r[k]));return q;},
      lt(k,v){filters.push(r=>r[k]<v);return q;},single(){single=true;return q;},maybeSingle(){single=true;return q;},
      then(resolve,reject){return Promise.resolve().then(()=>{
        if(insert){tables[table].push(insert);return {data:null,error:null};}
        const selected=tables[table].filter(r=>filters.every(f=>f(r)));
        if(patch)selected.forEach(r=>Object.assign(r,patch));
        return {data:single?structuredClone(selected[0]??null):structuredClone(selected),error:null};
      }).then(resolve,reject);}};return q;}};
}
test('concurrent attempts have one owner; completed retry cannot repeat the provider write',async()=>{
  const row=initial(),db=database({...row});let calls=0;
  const execute=async()=>{calls++;return {creditNoteId:'credit',creditNoteNumber:'CN-1',currency:'GBP',amount:200,status:'AUTHORISED',allocated:true};};
  await Promise.all([processCancellationCredit({db,row,execute}),processCancellationCredit({db,row,execute})]);
  assert.equal(calls,1);
  const saved=db.tables.cancellation_credit_operation[0];
  assert.equal(saved.state,'complete');
  assert.equal(db.tables.booking[0].xero_credit_note_id,'credit');
  await processCancellationCredit({db,row:saved,execute});assert.equal(calls,1);
});
test('rate-limited pre-write failures persist retry, uncertain writes require review',async()=>{
  for(const safeRetry of [true,false]){
    const row=initial(),db=database({...row});
    const saved=await processCancellationCredit({db,row,execute:async()=>{throw Object.assign(new Error('provider failure'),{safeRetry,retryAfter:900});}});
    assert.equal(saved.state,safeRetry?'retry':'review');assert.equal(saved.result,undefined);
  }
});
test('changed invoice ownership prevents provider calls',async()=>{
  const row=initial(),db=database({...row});db.tables.booking[0].xero_invoice_id='changed';
  const saved=await processCancellationCredit({db,row,execute:async()=>assert.fail('must not write')});
  assert.equal(saved.state,'review');
});
test('Xero cooldown and company binding are enforced before requests',async()=>{
  const row=initial(),db=database({...row});
  db.tables.accounting_request_binding[0].cooldown_until='2099-01-01';
  await assert.rejects(executeCancellationCredit(db,row,{
    loadToken:async()=>({tenantId:'company'}),fetcher:async()=>assert.fail('must not call'),
  }),e=>e.safeRetry===true);
  await assert.rejects(executeCancellationCredit(db,row,{loadToken:async()=>({tenantId:'different'})}),/connection changed/);
});
test('429 before write retries; network loss during write cannot retry blindly',async()=>{
  for(const mode of ['429','network']){
    const row=initial(),db=database({...row});
    await assert.rejects(executeCancellationCredit(db,row,{
      loadToken:async()=>({tenantId:'company'}),
      fetcher:async()=>{if(mode==='network')throw Error('lost response');return new Response('',{status:429,headers:{'retry-after':'600'}});},
      create:async(args,{fetcher})=>fetcher('https://api.xero.com/test',{method:mode==='network'?'POST':'GET'}),
    }),e=>e.safeRetry===(mode==='429'));
  }
});
test('completed but unallocated credit is not presented as fully reconciled',()=>{
  assert.match(creditRecoveryMessage({state:'complete',result:{allocated:false}}),/review/);
});
