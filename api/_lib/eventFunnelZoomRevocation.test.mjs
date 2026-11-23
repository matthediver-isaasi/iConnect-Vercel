import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverFunnelZoomRevocation} from './eventFunnelZoomRevocation.js';
const context={order:{tenant_id:'tenant',id:'order'},operation:{id:'reversal',lease_id:'lease'}};
function fixture(){
  let state='pending';let put=0;let present=true;
  const original={authorityHash:'hash',kind:'meetings',numericId:'123456789',email:'fixture@example.test',registrantId:'registrant'};
  const f={context,getAuthority:async()=>({token:'secret-fixture',authorityHash:'hash'}),
    readSettings:async()=>({numericId:original.numericId,type:2}),
    list:async()=>new Map(present?[[original.email,{id:original.registrantId,status:'approved'}]]:[]),
    db:{rpc:async(name,args)=>{
      assert.equal(name,'event_funnel_zoom_revoke');
      if(args.p_action==='read')return {data:{jobs:[{id:'registration',epoch:'epoch',status:state,snapshot:original}]}};
      if(args.p_action==='begin'){if(state!=='pending')return {data:{write:false}};state='writing';return {data:{write:true}};}
      if(args.p_action==='complete'){state='complete';return {data:{status:'complete'}};}
    }},
    request:async(token,path,options)=>{put++;assert.equal(options.method,'PUT');assert.equal(JSON.parse(options.body).action,'cancel');present=false;},
    puts:()=>put,absent:()=>{present=false;},writing:()=>{state='writing';}};
  return f;
}
test('final personal access is cancelled once behind a durable barrier',async()=>{
  const f=fixture();assert.equal((await recoverFunnelZoomRevocation(f)).status,'complete');
  await recoverFunnelZoomRevocation(f);assert.equal(f.puts(),1);
});
test('an unknown cancellation never repeats PUT; exhaustive absence reconciles it',async()=>{
  const f=fixture();let writes=0;f.request=async()=>{writes++;throw new Error('Response lost');};
  assert.equal((await recoverFunnelZoomRevocation(f)).status,'retry');
  assert.equal((await recoverFunnelZoomRevocation(f)).status,'retry');assert.equal(writes,1);
  f.absent();assert.equal((await recoverFunnelZoomRevocation(f)).status,'complete');assert.equal(writes,1);
});
test('changed authority, recurring settings or foreign registrant cannot be revoked',async()=>{
  for(const override of [{getAuthority:async()=>({authorityHash:'other'})},
    {readSettings:async()=>({numericId:'123456789',type:8})},
    {list:async()=>new Map([['fixture@example.test',{id:'foreign',status:'approved'}]])}]){
    const f=fixture();assert.equal((await recoverFunnelZoomRevocation({...f,...override})).status,'needs_review');
    assert.equal(f.puts(),0);
  }
});
