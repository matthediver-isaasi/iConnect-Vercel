import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEventShoppingHolds, projectPublicShoppingAvailability } from './eventFunnelAvailability.js';
import { mergeTicketCommercialCapacity } from './eventCommercialCapacity.js';
import { hasUnlimitedEventCapacity } from '../../shared/simpleEventCapacity.js';

test('projection aggregates only quantities in bounded tenant-scoped requests', async () => {
  const calls=[];
  const db={rpc:async(name,args)=>{
    calls.push([name,args]);
    return {data:args.p_events.map(event_id=>({event_id,ticket_id:'A',places:2}))};
  }};
  const ids=Array.from({length:205},(_,i)=>`event-${i}`);
  const map=await loadEventShoppingHolds(db,'tenant','simple',ids);
  assert.equal(calls.length,3);
  assert.deepEqual(calls.map(c=>c[1].p_events.length),[100,100,5]);
  assert.equal(map.get('event-0').places,2);
  assert.equal(map.get('event-0').tickets.get('A'),2);
  assert.ok(calls.every(c=>c[1].p_tenant==='tenant'&&c[1].p_kind==='simple'));
});
test('missing staged schema is compatible; installed reader failures are not empty inventory', async () => {
  assert.equal((await loadEventShoppingHolds({rpc:async()=>({error:{code:'PGRST202'}})},'t','simple',['e'])).size,0);
  for(const result of [{error:{code:'57014'}},{data:null},{data:[{event_id:'forged',ticket_id:'A',places:1}]},
    {data:[{event_id:'e',ticket_id:'A',places:-1}]}]) {
    await assert.rejects(loadEventShoppingHolds({rpc:async()=>result},'t','simple',['e']));
  }
});
test('public residual counters subtract holds once; editor inputs and total-mode projections stay intact', async () => {
  const db={rpc:async()=>({data:[{event_id:'e',ticket_id:'A',places:2}]})};
  const raw={id:'e',available_seats:2};
  const [publicRow]=await projectPublicShoppingAvailability(db,'t','complex',[raw]);
  assert.equal(publicRow.available_seats,0);
  assert.equal(raw.available_seats,2);
  assert.equal(hasUnlimitedEventCapacity({...publicRow,is_complex:true}),false);
  assert.equal(hasUnlimitedEventCapacity({is_complex:true,available_seats:0}),true);
  const total={...raw,capacity_mode:'total',total_capacity:10};
  assert.equal((await projectPublicShoppingAvailability(db,'t','simple',[total]))[0],total);
});
test('shopping holds remain separate from confirmed commercial commitments', () => {
  const projection=mergeTicketCommercialCapacity({available_count:10},3,{
    allocated:4,named:1,reserved:0,released:0,cancelled:0,remaining:4,unused:3,shoppingHeld:2,
  },true);
  assert.equal(projection.true_available,2);
  assert.equal(projection.commercial_unused,3);
  assert.equal(projection.commercial_reserved,0);
});
