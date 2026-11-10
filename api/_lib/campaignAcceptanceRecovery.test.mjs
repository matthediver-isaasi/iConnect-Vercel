import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptedCampaignEvidence, recoverCampaignAcceptance } from './campaignAcceptanceRecovery.js';
const campaign={id:'campaign',sent_at:'2026-10-26T13:30:00Z'};
const recipient={email:'recipient@example.test',delivery_is_test:false};
const event={id:'event',event:'accepted',recipient:recipient.email,
 'user-variables':{iconn_campaign_id:'campaign'},flags:{'is-test-mode':false},
 timestamp:Date.parse('2026-10-26T14:00:00Z')/1000,
 message:{headers:{'message-id':'<message>'}}};
test('only exact provider acceptance recovers a processing recipient',()=>{
 assert.equal(acceptedCampaignEvidence([event],campaign,recipient),event);
 for(const change of [
  {event:'delivered'},{recipient:'other@example.test'},
  {'user-variables':{iconn_campaign_id:'other'}},{flags:{'is-test-mode':true}},
  {flags:{}},{id:null},{timestamp:0},
  {message:{headers:{}}},
 ])assert.equal(acceptedCampaignEvidence([{...event,...change}],campaign,recipient),null);
 assert.equal(acceptedCampaignEvidence([],campaign,recipient),null);
 assert.equal(acceptedCampaignEvidence([event],campaign,{...recipient,delivery_is_test:null}),null);
 assert.equal(acceptedCampaignEvidence([event],campaign,{...recipient,mailgun_message_id:'other'}),null);
});
test('multiple provider message identities require manual review',()=>{
 assert.equal(acceptedCampaignEvidence([event,{...event,id:'second',message:{headers:{'message-id':'second'}}}],campaign,recipient),null);
});

test('resync records evidence and only updates confirmed processing recipients; it never queues a resend', async () => {
 const writes=[], audits=[];
 const rows=[{...recipient,id:'confirmed'},{...recipient,id:'uncertain',email:'unknown@example.test'}];
 const db={
  rpc:async()=>({data:rows,error:null}),
  from(table){
   if(table==='campaign_acceptance_check')return {upsert:async value=>{audits.push(value);return {error:null};}};
   assert.equal(table,'email_campaign_recipient');
   return {update(value){
    writes.push(value);
    const guards=[];
    const q={eq:(...args)=>{guards.push(args);return q;},is:(...args)=>{guards.push(args);return q;},
     select:async()=>{assert.ok(guards.some(([k,v])=>k==='status'&&v==='processing'));
      assert.ok(guards.some(([k,v])=>k==='campaign_id'&&v==='campaign'));
      assert.ok(guards.some(([k,v])=>k==='mailgun_message_id'&&v===null));
      return {data:[{id:'confirmed'}],error:null};}};
    return q;
   }};
  },
 };
 const result=await recoverCampaignAcceptance(db,{...campaign,tenant_id:'tenant'},'example.test',
  async(_domain,params)=>({items:params.recipient===recipient.email?[event]:[]}),Date.now()+30000,{detailed:true});
 assert.deepEqual(result,{checked:2,recovered:1,batchIncomplete:false});
 assert.equal(audits.length,2);assert.equal(writes.length,1);assert.equal(writes[0].status,'sent');
 assert.equal(writes[0].mailgun_message_id,'<message>');
});

test('provider rejection never changes recipient state or fabricates acceptance', async () => {
 const db={rpc:async()=>({data:[{...recipient,id:'r'}]}),from:()=>{throw Error('must not write');}};
 await assert.rejects(recoverCampaignAcceptance(db,campaign,'example.test',async()=>{throw Error('unauthorized');},
  Date.now()+30000),/unauthorized/);
});
