import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectInboxHandler } from './inbox.js';
const boardId='10000000-0000-0000-0000-000000000001';
const id='20000000-0000-0000-0000-000000000001';
function fixture({member=true,session=true,error=null}={}) {
  const calls=[];
  const db={from(table){
    const call={table,filters:[]};calls.push(call);
    const chain={
      select(){return chain;},update(patch){call.patch=patch;return chain;},
      eq(key,value){call.filters.push([key,value]);return chain;},
      is(key,value){call.filters.push([key,value]);return chain;},
      in(key,value){call.filters.push([key,value]);return chain;},
      order(){return chain;},range(){return chain;},limit(){return chain;},
      maybeSingle(){return chain;},
      then(resolve){return Promise.resolve({error,data:table==='project_board_member'?(member?{role:'viewer'}:null):table==='project_board'?{is_archived:false}:[],count:0}).then(resolve);}
    };return chain;
  }};
  const handler=createProjectInboxHandler({db,sessionFor:async()=>session?{data:{identityId:'self'}}:null});
  const res={statusCode:200,setHeader(){},status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}};
  return {calls,res,handler};
}
test('personal list and unread count both scope to authenticated recipient and board',async()=>{
  const f=fixture();await f.handler({method:'GET',query:{boardId}},f.res);
  assert.equal(f.res.statusCode,200);
  const reads=f.calls.filter(c=>c.table==='project_mention_inbox');
  assert.equal(reads.length,2);
  for(const read of reads) {
    assert.ok(read.filters.some(([k,v])=>k==='recipient_id'&&v==='self'));
    assert.ok(read.filters.some(([k,v])=>k==='board_id'&&v===boardId));
    assert.ok(read.filters.some(([k,v])=>k==='card.is_archived'&&v===false));
    assert.ok(read.filters.some(([k,v])=>k==='is_archived'&&v===false));
  }
});
test('read, pin, unpin and bulk actions cannot target other recipients, even with forged body',async()=>{
  for(const body of [{ids:[id],read:true},{ids:[id],read:false},{ids:[id],pinned:true},{ids:[id],pinned:false},{all:true,read:true}]) {
    const f=fixture();await f.handler({method:'PATCH',query:{boardId},body:{...body,recipient_id:'other',board_id:'other'}},f.res);
    assert.equal(f.res.statusCode,200);
    const write=f.calls.find(c=>c.patch);
    assert.deepEqual(write.filters.slice(0,2),[['board_id',boardId],['recipient_id','self']]);
    assert.ok(write.filters.some(([k,v])=>k==='is_archived'&&v===false));
    assert.deepEqual(Object.keys(write.patch),['read' in body?'read_at':'pinned_at']);
    if(body.read===false||body.pinned===false) assert.equal(Object.values(write.patch)[0],null);
  }
});
test('missing sessions, revoked membership, malformed mutations and backend failures fail closed',async()=>{
  for(const [options,body,status] of [
    [{session:false},{ids:[id],read:true},401],
    [{member:false},{ids:[id],read:true},403],
    [{},{all:true,pinned:true},400],
    [{},{ids:[id],read:'true'},400],
    [{},{ids:[],read:true},400],
    [{error:{code:'db_fail'}},{ids:[id],read:true},500],
  ]) {
    const f=fixture(options);await f.handler({method:'PATCH',query:{boardId},body},f.res);
    assert.equal(f.res.statusCode,status);assert.ok(!f.calls.some(c=>c.patch));
  }
});
