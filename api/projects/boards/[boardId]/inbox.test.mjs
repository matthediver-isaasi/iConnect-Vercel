import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectInboxHandler } from './inbox.js';
const boardId='10000000-0000-0000-0000-000000000001';
const id='20000000-0000-0000-0000-000000000001';
function fixture({member=true,session=true,error=null,card=true,mentionPages=[[]]}={}) {
  const calls=[];
  const db={from(table){
    const call={table,filters:[]};calls.push(call);
    const chain={
      select(){return chain;},update(patch){call.patch=patch;return chain;},
      eq(key,value){call.filters.push([key,value]);return chain;},
      is(key,value){call.filters.push([key,value]);return chain;},
      in(key,value){call.filters.push([key,value]);return chain;},
      order(){return chain;},range(from,to){call.range=[from,to];return chain;},limit(){return chain;},
      maybeSingle(){return chain;},
      then(resolve){return Promise.resolve({error,data:table==='project_board_member'?(member?{role:'viewer'}:null):table==='project_board'?{is_archived:false}:table==='project_card'?(card?{id}:null):(mentionPages[Math.floor((call.range?.[0] || 0)/500)] || []),count:0}).then(resolve);}
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
test('card summary includes all pages, deduplicates cards and scopes unread visible mentions to self',async()=>{
  const other='30000000-0000-0000-0000-000000000001';
  const f=fixture({mentionPages:[Array.from({length:500},()=>({card_id:id})),[{card_id:other}]]});
  await f.handler({method:'GET',query:{boardId,summary:'true'}},f.res);
  assert.deepEqual(f.res.body,{unreadCardIds:[id,other]});
  const reads=f.calls.filter(c=>c.table==='project_mention_inbox');
  assert.deepEqual(reads.map(c=>c.range),[[0,499],[500,999]]);
  for(const read of reads) {
    for(const filter of [['board_id',boardId],['recipient_id','self'],['is_archived',false],['read_at',null],['card.is_archived',false],['card.board_id',boardId]]) {
      assert.ok(read.filters.some(([k,v])=>k===filter[0]&&v===filter[1]));
    }
  }
});
test('opening a card marks only its current recipient unread mentions in the shared inbox table',async()=>{
  const f=fixture();
  await f.handler({method:'PATCH',query:{boardId},body:{cardId:id,read:true,recipient_id:'other'}},f.res);
  assert.equal(f.res.statusCode,200);
  const lookup=f.calls.find(c=>c.table==='project_card');
  assert.deepEqual(lookup.filters,[['id',id],['board_id',boardId],['is_archived',false]]);
  const write=f.calls.find(c=>c.patch);
  assert.equal(write.table,'project_mention_inbox');
  assert.deepEqual(write.filters,[['board_id',boardId],['recipient_id','self'],['is_archived',false],['card_id',id],['read_at',null]]);
  assert.ok(Number.isFinite(Date.parse(write.patch.read_at)));
});
test('card read rejects unavailable cards, revoked access and ambiguous or unsupported actions',async()=>{
  for(const [options,body,status] of [
    [{card:false},{cardId:id,read:true},404],
    [{member:false},{cardId:id,read:true},403],
    [{},{cardId:'bad',read:true},400],
    [{},{cardId:id,read:false},400],
    [{},{cardId:id,pinned:true},400],
    [{},{cardId:id,read:true,all:true},400],
    [{},{cardId:id,read:true,ids:[id]},400],
  ]) {
    const f=fixture(options);
    await f.handler({method:'PATCH',query:{boardId},body},f.res);
    assert.equal(f.res.statusCode,status);
    assert.ok(!f.calls.some(c=>c.patch));
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
