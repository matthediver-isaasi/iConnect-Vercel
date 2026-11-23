import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverFunnelInvoiceCredits} from './eventFunnelCreditRecovery.js';
function fixture(){
  const context={order:{id:'order',tenant_id:'tenant'},operation:{id:'operation',tenant_id:'tenant',order_id:'order',
    allocations:[{invoiceMinor:100},{invoiceMinor:200}]}};
  const jobs=[100,200].map((amount,index)=>({id:`job-${index}`,tenant_id:'tenant',order_id:'order',reversal_id:'operation',
    selected:[{amountMinor:amount}]}));
  return {context,jobs,db:{rpc:async()=>({data:jobs})}};
}
test('all invoice jobs must cover the original cancellation before execution',async()=>{
  const f=fixture();f.jobs.pop();let calls=0;
  await assert.rejects(recoverFunnelInvoiceCredits({...f,execute:async()=>{calls++;}}),/cover/);
  assert.equal(calls,0);
});
test('one accounting outage does not prevent another participating invoice recovering',async()=>{
  const f=fixture(),seen=[];
  const result=await recoverFunnelInvoiceCredits({...f,execute:async({job})=>{
    seen.push(job.id);if(job.id==='job-0')throw new Error('Outage');return {status:'complete'};
  }});
  assert.equal(result.status,'retry');assert.deepEqual(seen,['job-0','job-1']);
});
test('foreign job scope cannot reach a provider',async()=>{
  const f=fixture();f.jobs[0].tenant_id='other';
  await assert.rejects(recoverFunnelInvoiceCredits({...f,execute:async()=>assert.fail('Provider must not execute')}),/scope/);
});
