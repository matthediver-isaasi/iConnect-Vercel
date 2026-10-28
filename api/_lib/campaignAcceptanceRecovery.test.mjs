import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptedCampaignEvidence } from './campaignAcceptanceRecovery.js';
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
