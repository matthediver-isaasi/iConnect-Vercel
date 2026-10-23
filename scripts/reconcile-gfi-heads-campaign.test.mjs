import test from 'node:test';
import assert from 'node:assert/strict';
import { matchAcceptance } from './reconcile-gfi-heads-campaign.mjs';
const row = { id:'r', email:'member@example.invalid', delivery_is_test:false };
const event = { id:'e', event:'accepted', recipient:row.email, timestamp:1792756935,
  flags:{'is-test-mode':false}, 'user-variables':{iconn_campaign_id:'c'},
  message:{headers:{'message-id':'<m>'}} };
test('matches exact live acceptance, including engagement before local persistence', () => {
  assert.equal(matchAcceptance([{...row,status:'clicked'}],[event],'c')[0].messageId,'m');
});
test('refuses missing, unrelated and ambiguous acceptance', () => {
  assert.throws(()=>matchAcceptance([row],[],'c'));
  assert.throws(()=>matchAcceptance([row],[event],'other'));
  assert.throws(()=>matchAcceptance([row],[event,{...event,message:{headers:{'message-id':'different'}}}],'c'));
});
test('refuses test, unknown provenance and conflicting local provider identity', () => {
  assert.throws(()=>matchAcceptance([row],[{...event,flags:{}}],'c'));
  assert.throws(()=>matchAcceptance([{...row,delivery_is_test:true}],[event],'c'));
  assert.throws(()=>matchAcceptance([{...row,mailgun_message_id:'other'}],[event],'c'));
});
test('requires exact unique audience and complete evidence', () => {
  assert.throws(()=>matchAcceptance([row,row],[event],'c'));
  assert.throws(()=>matchAcceptance([row],[{...event,id:null}],'c'));
  assert.throws(()=>matchAcceptance([row],[event,{...event,recipient:'extra@example.invalid'}],'c'));
});
