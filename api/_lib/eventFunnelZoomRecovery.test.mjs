import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverFunnelZoomRegistrations} from './eventFunnelZoomRecovery.js';
function fixture({lost=false,existing=false}={}) {
  let state='pending',posts=0;const records=new Map();
  const email='attendee@example.test',entry={id:'registrant',status:'approved',join_url:'https://zoom.us/j/123456?tk=fixture'};
  if(existing)records.set(email,entry);
  const db={from:()=>({select(){return this;},eq(){return this;},maybeSingle:async()=>({data:{zoom_meeting_id:'123456'}})}),
    rpc:async(_name,args)=>{
      if(args.p_action==='begin'){if(state!=='pending')return {data:{write:false}};state='writing';return {data:{write:true}};}
      if(args.p_action==='observed')state='ready';
      if(args.p_action==='not_submitted')state='pending';
      return {data:{ready:state==='ready',jobs:state==='ready'?[]:[{id:'registration',kind:'meetings',
        numeric_id:'123456',authority_hash:'authority',state}]}};
    }};
  const input={db,tenantId:'tenant',event:{},booking:{attendee_name:'Guest Person',attendee_email:email},
    source:'booking',job:{order_id:'order',lease_token:'lease'},stepId:'step',
    targetsFor:async()=>[{zoom_meeting_id:'local'}],getAuthority:async()=>({authorityHash:'authority',token:'fixture'}),
    readSettings:async()=>({numericId:'123456',registration_required:true,type:2}),
    list:async()=>records,resolverFor:()=>async()=>entry.join_url,
    request:async(_token,path,options)=>{
      assert.equal(options.method,'POST');assert.match(path,/meetings\/123456\/registrants$/);
      assert.equal(JSON.parse(options.body).email,email);assert.equal(state,'writing');posts++;
      records.set(email,entry);if(lost)throw new Error('Response lost');return entry;
    }};
  return {run:()=>recoverFunnelZoomRegistrations({...input,deadlineAt:Date.now()+10000}),input,records,
    posts:()=>posts,state:()=>state};
}
test('provider writes are journalled first and replay never registers twice',async()=>{
  const f=fixture();assert.equal(await f.run(),true);assert.equal(await f.run(),true);assert.equal(f.posts(),1);
});
test('a lost provider response is recovered by observation, never a second POST',async()=>{
  const f=fixture({lost:true});assert.equal(await f.run(),false);assert.equal(f.state(),'writing');
  assert.equal(await f.run(),true);assert.equal(f.posts(),1);
});
test('absence after an uncertain request does not authorize resubmission',async()=>{
  const f=fixture({lost:true});await f.run();f.records.clear();
  assert.equal(await f.run(),false);assert.equal(f.posts(),1);
});
test('existing approval is adopted and pending or recurring registration is not overwritten',async()=>{
  const f=fixture({existing:true});assert.equal(await f.run(),true);assert.equal(f.posts(),0);
  const pending=fixture({existing:true});pending.records.get('attendee@example.test').status='pending';
  assert.equal(await pending.run(),false);assert.equal(pending.posts(),0);
  const recurring=fixture();recurring.input.readSettings=async()=>({numericId:'123456',registration_required:true,type:8});
  assert.equal(await recurring.run(),false);assert.equal(recurring.posts(),0);
});
test('missing journal or changed authority stops before a provider write',async()=>{
  const missing=fixture();missing.input.db.rpc=async()=>({error:{code:'PGRST202'}});
  missing.input.getAuthority=()=>assert.fail('Schema must be verified first');
  await assert.rejects(missing.run(),/journal/);assert.equal(missing.posts(),0);
  const changed=fixture();changed.input.getAuthority=async()=>({token:'fixture',authorityHash:'different'});
  await assert.rejects(changed.run(),/authority changed/);assert.equal(changed.posts(),0);
  const incomplete=fixture();incomplete.input.readSettings=async()=>({numericId:'123456',join_url:'https://zoom.us/j/123456'});
  await assert.rejects(incomplete.run(),/requirements unavailable/);assert.equal(incomplete.posts(),0);
});
