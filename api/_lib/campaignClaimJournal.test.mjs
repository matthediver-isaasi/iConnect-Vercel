import test from 'node:test';
import assert from 'node:assert/strict';
import { transitionCampaignClaims, recoverUnsubmittedCampaignClaims } from './campaignClaimJournal.js';
import { campaignDisplayStatus } from '../../shared/campaignDeliverySummary.js';
test('journal transitions require complete ownership and successful persistence',async()=>{
 let calls=0;
 const db={rpc:async()=>{calls++;return {data:2}}};
 await transitionCampaignClaims(db,[{},{}],'submit');assert.equal(calls,0);
 await assert.rejects(()=>transitionCampaignClaims(db,[{_claim_token:'a'},{}],'submit'),/Mixed/);
 await transitionCampaignClaims(db,[{_claim_token:'a'},{_claim_token:'b'}],'submit');
 await assert.rejects(()=>transitionCampaignClaims(db,[{_claim_token:'a'}],'submit'),/Incomplete/);
 await assert.rejects(()=>transitionCampaignClaims({rpc:async()=>({error:new Error('DB failed')})},[{_claim_token:'a'}],'submit'),/DB failed/);
});
test('recovery only tolerates a missing migration; database failure stays visible',async()=>{
 assert.equal(await recoverUnsubmittedCampaignClaims({rpc:async()=>({error:{code:'PGRST202'}})},'c'),0);
 await assert.rejects(()=>recoverUnsubmittedCampaignClaims({rpc:async()=>({error:new Error('DB failed')})},'c'),/DB failed/);
});
test('campaign badge does not describe unresolved sends as actively sending',()=>{
 assert.equal(campaignDisplayStatus({status:'sending',delivery_summary:{processing:145,reconciliationAlert:{count:145}}}),'needs_attention');
 assert.equal(campaignDisplayStatus({status:'sending',delivery_summary:{processing:2}}),'sending');
 assert.equal(campaignDisplayStatus({status:'sent',delivery_summary:{failed:1}}),'completed_with_failures');
 assert.equal(campaignDisplayStatus({status:'cancelled',delivery_summary:{reconciliationAlert:{}}}),'cancelled');
});
