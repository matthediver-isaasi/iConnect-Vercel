import fs from 'node:fs';
import assert from 'node:assert/strict';
import {destinationTarget} from './apply-custom-object-relationship-deleted-members-migration.mjs';
destinationTarget(process.env);
process.env.SUPABASE_URL=process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY=process.env.DEST_SUPABASE_KEY;
const {getTenantGocardlessCredentials}=await import('../api/_lib/gocardlessCredentials.js');
const root='generated-artifacts/bnms-current-commitments';
const input=JSON.parse(fs.readFileSync(`${root}/recovery-dd.json`));
const auth=await getTenantGocardlessCredentials('ff2df806-b321-4254-b651-3af11fccf1db');
assert.equal(auth.environment,'live');assert.equal(auth.source,'tenant');
let requests=0;
const get=async path=>{
  assert.ok(++requests<=100,'Read budget exceeded');
  await new Promise(r=>setTimeout(r,300));
  const response=await fetch(`https://api.gocardless.com/${path}`,{method:'GET',redirect:'error',
    headers:{Authorization:`Bearer ${auth.accessToken}`,'GoCardless-Version':'2015-07-06',Accept:'application/json'},
    signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw Error(`GC_READ_${response.status}`);
  return response.json();
};
const results=[];
for(const id of input.ids){
  const discovered=input.discovery.filter(r=>r.matched_member_id===id&&r.environment==='live');
  const mandates=[];
  for(const mandateId of new Set(discovered.map(r=>r.gocardless_mandate_id))){
    const {mandates:mandate}=await get(`mandates/${mandateId}`);
    assert.equal(mandate.id,mandateId);
    const customerId=mandate.links?.customer||discovered.find(r=>r.gocardless_mandate_id===mandateId).gocardless_customer_id;
    const {customers:customer}=await get(`customers/${customerId}`);
    assert.equal(customer.id,customerId);
    const payments=[];let after=null;const cursors=new Set();
    do{
      const params=new URLSearchParams({mandate:mandateId,limit:'500'});if(after)params.set('after',after);
      const body=await get(`payments?${params}`);
      assert.ok(Array.isArray(body.payments)&&body.meta?.cursors&&Object.hasOwn(body.meta.cursors,'after'));
      assert.ok(body.payments.every(p=>p.links?.mandate===mandateId));
      payments.push(...body.payments);after=body.meta.cursors.after;
      if(after){assert.ok(!cursors.has(after));cursors.add(after);}
    }while(after);
    const subscriptions=[];after=null;const subscriptionCursors=new Set();
    do{
      const params=new URLSearchParams({mandate:mandateId,limit:'500'});if(after)params.set('after',after);
      const body=await get(`subscriptions?${params}`);
      assert.ok(Array.isArray(body.subscriptions)&&Object.hasOwn(body.meta?.cursors||{},'after'));
      assert.ok(body.subscriptions.every(s=>s.links?.mandate===mandateId));
      subscriptions.push(...body.subscriptions);after=body.meta.cursors.after;
      if(after){assert.ok(!subscriptionCursors.has(after));subscriptionCursors.add(after);}
    }while(after);
    mandates.push({mandate,customer:{id:customer.id,email:customer.email,given_name:customer.given_name,family_name:customer.family_name},payments,subscriptions});
  }
  results.push({memberId:id,mandates});
  fs.writeFileSync(`${root}/recovery-dd-live.json`,JSON.stringify({at:new Date().toISOString(),complete:results.length===input.ids.length,results,requests,providerWrites:0}),{mode:0o600});
  console.log(`GC_REVIEW ${results.length}/${input.ids.length}; GET requests=${requests}`);
}
