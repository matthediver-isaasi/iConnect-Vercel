import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWaitingRequest, waitingListAccess } from './eventWaitingList.js';
import { __setRoleAccessOverlayForTests } from './roleVisibility.js';
import { activeWaitingEmails, campaignWaitingIds, waitingAudienceChunk } from './eventWaitingAudience.js';
__setRoleAccessOverlayForTests([]);
const id='10000000-0000-4000-8000-000000000001';
const payload=()=>({event_id:id,event_kind:'simple',idempotency_key:id,attendees:[{first_name:'A',last_name:'B',email:'A@example.invalid',ticket_class_id:'default'}]});
test('request validates, normalizes, ignores client prices and identity claims',()=>{
  const input=payload(); input.attendees[0].member_id=id; input.attendees[0].advertised_price=1;
  const parsed=normalizeWaitingRequest(input);
  assert.equal(parsed.attendees[0].email,'a@example.invalid');
  assert.equal(parsed.attendees[0].member_id,undefined);
  assert.equal(parsed.attendees[0].advertised_price,undefined);
  assert.equal(parsed.request_hash,normalizeWaitingRequest(payload()).request_hash);
});
test('rejects missing names, malformed sessions, duplicates and unbounded payloads',()=>{
  for(const mutate of [
    p=>p.attendees[0].first_name='',p=>p.attendees[0].email='no',
    p=>p.attendees[0].session_ids=['bad'],p=>p.attendees.push(p.attendees[0]),
    p=>p.attendees=Array(101).fill(p.attendees[0]),p=>p.event_kind='booking',
  ]) {const p=payload();mutate(p);assert.throws(()=>normalizeWaitingRequest(p));}
});
function dbFixture(tables) {
  return {from(table){
    let source=tables[table]||[],cap=Infinity;
    const q={select(){return q;},eq(k,v){source=source.filter(r=>r[k]===v);return q;},
      in(k,v){source=source.filter(r=>v.includes(r[k]));return q;},
      gt(k,v){source=source.filter(r=>r[k]>v);return q;},order(){return q;},limit(n){cap=n;return q;},
      maybeSingle(){return Promise.resolve({data:source[0]||null});},
      then(resolve){return Promise.resolve({data:source.slice(0,cap)}).then(resolve);}};
    return q;
  },rpc(){return Promise.resolve({data:[]});}};
}
test('My Tickets hierarchy and missing role fail closed',async()=>{
  const m={id,tenant_id:id,role_id:id};
  for(const excluded of [['events'],['events.my-tickets'],['page_MyTickets']]) {
    assert.equal(await waitingListAccess(dbFixture({role:[{id,tenant_id:id,excluded_features:excluded}]}),m),null);
  }
  assert.deepEqual(await waitingListAccess(dbFixture({role:[{id,tenant_id:id,excluded_features:[]}]}),m),[]);
  assert.equal(await waitingListAccess(dbFixture({}),m),null);
});
test('campaign withdrawal is checked against active tenant-scoped entries',async()=>{
  const campaign={target_type:'event_waiting_list',target_ids:[id]};
  const db=dbFixture({event_waiting_entry:[
    {id:'1',tenant_id:id,event_id:id,status:'active',email:'one@example.invalid'},
    {id:'2',tenant_id:id,event_id:id,status:'withdrawn',email:'two@example.invalid'},
    {id:'3',tenant_id:'other',event_id:id,status:'active',email:'two@example.invalid'},
  ]});
  assert.deepEqual([...await activeWaitingEmails(db,id,campaign,['one@example.invalid','two@example.invalid'])],['one@example.invalid']);
  assert.equal(await activeWaitingEmails(db,id,{target_type:'all_members'},[]),null);
  assert.throws(()=>campaignWaitingIds({...campaign,target_audiences:[{type:'all_members'}]}));
  const chunk=await waitingAudienceChunk(db,id,{ids:[id]});
  assert.equal(chunk.candidates.length,1);
  assert.equal(chunk.candidates[0].email,'one@example.invalid');
});
