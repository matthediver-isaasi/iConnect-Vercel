import test from 'node:test';
import assert from 'node:assert/strict';
import panel from './panel.js';
import decline from './decline.js';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const response=()=>({statusCode:200,setHeader(){},status(value){this.statusCode=value;return this;},json(value){this.body=value;return this;}});
const headers={'x-judging-request':'1','content-type':'application/json','sec-fetch-site':'same-origin'};
function fixture(memberTenant=id(1)){
  const calls=[];
  const evidence={application:{id:id(3),reference:'AW-1'},round:{required_judges:1,require_all:true},
    assessments:[{assignmentId:id(4),appointmentId:id(5),revisionId:id(6),state:'submitted',included:true,recused:false,
      score:{numerator:'80',denominator:'1'},answers:{quality:{value:4}}}],moderation:null};
  const payload={evidence,criteria:{definition:{}},capabilities:{message:true,propose:true,approve:false,reopen:false},messages:[],history:[]};
  const db={rpc:async(name,args)=>{calls.push({name,args});return{data:name==='assessment_panel_evidence'?payload:{state:'declined'}};}};
  const deps={supabase:db,resolveTenant:async()=>({id:id(1)}),getMember:async()=>({id:id(2),tenant_id:memberTenant})};
  return{calls,payload,deps};
}
test('appointed panel response aliases judge identity without requiring administrator access',async()=>{
  const f=fixture(),res=response();
  await panel({method:'GET',headers,query:{roundId:id(7),applicationId:id(3)}},res,f.deps);
  assert.equal(res.statusCode,200);
  assert.equal(res.body.assessments[0].appointmentId,undefined);
  assert.match(res.body.assessments[0].judgeAlias,/^Judge [A-F0-9]{8}$/);
  assert.equal(f.calls[0].args.p_member,id(2));
});
test('panel capability denial prevents approval writes',async()=>{
  const f=fixture(),res=response();
  await panel({method:'POST',headers,body:{roundId:id(7),applicationId:id(3),command:'approve',version:1,reason:'Review'}},res,f.deps);
  assert.equal(res.statusCode,403);
  assert.deepEqual(f.calls.map(x=>x.name),['assessment_panel_evidence']);
});
test('foreign tenant members cannot read panels or decline assignments',async()=>{
  for(const handler of [panel,decline]){
    const f=fixture(id(9)),res=response();
    await handler({method:'POST',headers,body:{assignmentId:id(4),version:1,reason:'Unavailable'}},res,f.deps);
    assert.equal(res.statusCode,403);assert.equal(f.calls.length,0);
  }
});
test('cross-site decline is denied before domain writes',async()=>{
  const f=fixture(),res=response();
  await decline({method:'POST',headers:{...headers,'sec-fetch-site':'cross-site'},body:{assignmentId:id(4),version:1,reason:'Unavailable'}},res,f.deps);
  assert.equal(res.statusCode,403);assert.equal(f.calls.length,0);
});
test('decline forwards the verified owner and exact optimistic version',async()=>{
  const f=fixture(),res=response();
  await decline({method:'POST',headers,body:{assignmentId:id(4),version:5,reason:'Unavailable',memberId:id(9)}},res,f.deps);
  assert.equal(res.statusCode,200);
  assert.equal(f.calls[0].name,'assessment_decline_assignment');
  assert.equal(f.calls[0].args.p_member,id(2));
  assert.equal(f.calls[0].args.p_version,5);
});
