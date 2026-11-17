import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileZoomSpeakers, resolveCreatedZoomPanelist } from './zoomSpeakerSync.js';

test('successful add acknowledgements without identities use a read-back, never another invitation',async()=>{
  const person={name:'Speaker',email:'speaker@example.test'};
  const saved={...person,id:'provider-id'};
  let reads=0;
  for(const response of [{},null,{panelists:[{name:'Speaker'}]}]) {
    assert.deepEqual(await resolveCreatedZoomPanelist(response,person,async()=>{reads++;return [saved];}),saved);
  }
  assert.equal(reads,3);
  assert.deepEqual(await resolveCreatedZoomPanelist({panelists:[saved]},person,async()=>assert.fail('no read needed')),saved);
  for(const found of [[],[saved,{...saved,id:'other'}]]) {
    await assert.rejects(resolveCreatedZoomPanelist({},person,async()=>found),/could not be verified/);
  }
});

function setup() {
  const job = { managed:{}, desired:[{id:'s',found:true,name:'Speaker',email:'speaker@example.test'}],
    webinar_status:'scheduled',start_time:new Date(Date.now()+86400000).toISOString() };
  const people = new Map();
  const calls = [];
  const io = {
    fence:async()=>true, expired:()=>false,
    save:async patch=>Object.assign(job,structuredClone(patch)),
    list:async()=>[...people.values()],
    add:async person=>{const p={...person,id:`p${calls.length}`};calls.push(['add',person.email]);people.set(p.id,p);return p;},
    remove:async id=>{calls.push(['remove',id]);people.delete(id);},
  };
  return {job,io,people,calls,run:()=>reconcileZoomSpeakers(structuredClone(job),io)};
}
test('attach copied event adds speakers once and mirrors subsequent selection removals',async()=>{
  const f=setup();await f.run();assert.equal(f.job.status,'completed');assert.equal(f.calls.length,1);
  await f.run();assert.equal(f.calls.length,1);
  f.job.desired=[];await f.run();assert.equal(f.people.size,0);assert.equal(f.calls.length,2);
});
test('manually added provider panelists are never adopted or deleted',async()=>{
  const f=setup();f.people.set('manual',{id:'manual',name:'Speaker',email:'speaker@example.test'});
  f.people.set('host',{id:'host',name:'Host',email:'host@example.test'});
  await f.run();assert.deepEqual(f.job.managed,{});
  f.job.desired=[];await f.run();assert.equal(f.calls.length,0);assert.equal(f.people.size,2);
});
test('email replacement adds new and removes only our old identity',async()=>{
  const f=setup();await f.run();f.job.desired[0].email='new@example.test';await f.run();
  assert.equal(f.people.size,1);assert.equal([...f.people.values()][0].email,'new@example.test');
});
test('missing speaker/email retains managed panelists and exposes attention',async()=>{
  const f=setup();await f.run();f.job.desired=[{found:false,id:'missing'}];await f.run();
  assert.equal(f.people.size,1);assert.equal(f.job.status,'attention');assert.equal(f.calls.length,1);
});
test('generation change fences all provider mutations',async()=>{
  const f=setup();f.io.fence=async()=>false;await f.run();assert.equal(f.calls.length,0);assert.equal(f.job.status,'pending');
});
test('lost provider response reconciles without resending or assuming deletion authority',async()=>{
  const f=setup();const add=f.io.add;f.io.add=async p=>{await add(p);throw new Error('lost response');};
  await f.run();assert.equal(f.job.status,'pending');
  await f.run();assert.equal(f.calls.length,1);assert.equal(f.job.status,'attention');
  f.job.desired=[];await f.run();assert.equal(f.people.size,1);
});
test('failed list never removes anyone; duplicate provider emails fail closed',async()=>{
  const f=setup();await f.run();f.job.desired=[];f.io.list=async()=>{throw new Error('offline');};
  await f.run();assert.equal(f.calls.length,1);
  f.io.list=async()=>[{id:'a',email:'same@example.test'},{id:'b',email:'same@example.test'}];
  await f.run();assert.equal(f.calls.length,1);
});
test('budget exhaustion requeues and started webinars require attention',async()=>{
  const f=setup();f.io.expired=()=>true;await f.run();assert.equal(f.calls.length,0);assert.equal(f.job.status,'pending');
  f.job.start_time=new Date(0).toISOString();await f.run();assert.equal(f.job.status,'attention');
});
test('shared desired identity is deduplicated and retained while any source selects it',async()=>{
  const f=setup();f.job.desired.push({...f.job.desired[0],id:'s2'});
  await f.run();f.job.desired.shift();await f.run();assert.equal(f.calls.length,1);
});
test('name changes replace managed panelists, not manually created panelists',async()=>{
  const f=setup();await f.run();f.job.desired[0].name='New name';await f.run();
  assert.equal([...f.people.values()][0].name,'New name');assert.equal(f.calls.length,3);
});
