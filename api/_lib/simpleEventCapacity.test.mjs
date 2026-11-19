import test from 'node:test';
import assert from 'node:assert/strict';
import { projectSimpleEventCapacity } from './simpleEventCapacity.js';
import { hasUnlimitedEventCapacity } from '../../shared/simpleEventCapacity.js';

test('all readers receive the same aggregate remaining places; legacy remains untouched', async () => {
  const event = {id:'event',capacity_mode:'total',total_capacity:146,available_seats:null};
  const db = {rpc:async (name,args)=>{
    assert.equal(name,'simple_event_capacity'); assert.equal(args.p_event_id,'event');
    return {data:{total:146,confirmed:118,commercial_unused:0,used:118,remaining:28}};
  }};
  const [projected] = await projectSimpleEventCapacity(db,[event]);
  assert.equal(projected.available_seats,28);
  assert.equal(projected.capacity_booked,118);
  assert.equal(hasUnlimitedEventCapacity(projected),false);
  const legacy = {id:'old',available_seats:146};
  assert.equal((await projectSimpleEventCapacity({rpc:()=>assert.fail()},[legacy]))[0],legacy);
});

test('zero total is sold out; null total is unlimited; errors never turn into zero usage', async () => {
  assert.equal(hasUnlimitedEventCapacity({capacity_mode:'total',total_capacity:0,available_seats:0}),false);
  assert.equal(hasUnlimitedEventCapacity({capacity_mode:'total',total_capacity:null}),true);
  assert.equal(hasUnlimitedEventCapacity({is_complex:true,available_seats:0}),true);
  const event = {id:'event',capacity_mode:'total',total_capacity:146};
  await assert.rejects(projectSimpleEventCapacity({rpc:async()=>({error:{message:'unavailable'}})},[event]),/temporarily unavailable/);
  await assert.rejects(projectSimpleEventCapacity({rpc:async()=>({data:null})},[event]),/temporarily unavailable/);
});
