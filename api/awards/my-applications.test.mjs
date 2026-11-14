import test from 'node:test';
import assert from 'node:assert/strict';
import handler from './my-applications.js';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function fixture(){
  const calls=[];
  const db={
    from(table){calls.push(table);const q={select(){return q;},eq(){return q;},single:async()=>({
      data:{form_snapshot:{fields:[{id:'research',type:'text'}],review_field_ids:['research']},answer_snapshot:{research:'Updated'}},
    })};return q;},
    async rpc(name,args){calls.push({name,args});if(name==='awards_amendment_choice_changes')return{data:[]};return{data:name==='awards_prepare_amendment'
      ?{form:{fields:[{id:'research',type:'text',required:true}],visibility_rules:[]},answers:args.p_answers,replayed:false}
      :{id:id(6),applicationVersionId:id(7),replayed:false}};},
  };
  const res={statusCode:200,setHeader(){},status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
  const req={method:'POST',headers:{'x-awards-request':'1','content-type':'application/json'},body:{
    command:'amend',applicationId:id(1),requestId:id(2),version:1,reason:'Correct evidence',answers:{research:'Updated'},
  }};
  const dependencies={supabase:db,resolveTenant:async()=>({id:id(3)}),getMember:async()=>({id:id(4),tenant_id:id(3)})};
  return{calls,req,res,dependencies};
}
test('member amendments validate and retain evidence without invoking ordinary form actions',async()=>{
  const f=fixture();await handler(f.req,f.res,f.dependencies);
  assert.equal(f.res.statusCode,200);assert.equal(f.res.body.effects,'review_evidence_only');
  assert.equal(f.res.body.judgeAdoption,'unchanged');
  assert.deepEqual(f.calls.filter(c=>c.name).map(c=>c.name),['awards_prepare_amendment','awards_amendment_choice_changes','awards_record_amendment']);
  assert.ok(f.calls.filter(c=>typeof c==='string').every(c=>c==='awards_intake_capture'));
});
test('a submitted access flag cannot authorize private linked-answer changes',async()=>{
  const f=fixture(),rpc=f.dependencies.supabase.rpc;
  f.req.body.p_existing_choice_access=true;
  f.dependencies.supabase.rpc=async(name,args)=>name==='awards_amendment_choice_changes'?{data:['organisation']}:rpc(name,args);
  f.dependencies.supabase.from=table=>{
    assert.equal(table,'form');
    const q={select(){return q;},eq(){return q;},async maybeSingle(){return{data:{is_active:true,access_policy:{version:1}}};}};return q;
  };
  f.dependencies.resolveFormAccess=async()=>({allowed:false});
  await handler(f.req,f.res,f.dependencies);
  assert.equal(f.res.statusCode,403);
  assert.equal(f.calls.some(c=>c.name==='awards_record_amendment'),false);
});
test('invalid answers do not finalise evidence, and cross-tenant members never prepare it',async()=>{
  const f=fixture();f.req.body.answers={};await handler(f.req,f.res,f.dependencies);
  assert.equal(f.res.statusCode,400);
  assert.equal(f.calls.some(c=>c.name==='awards_record_amendment'),false);
  const other=fixture();other.dependencies.getMember=async()=>({id:id(4),tenant_id:id(5)});
  await handler(other.req,other.res,other.dependencies);assert.equal(other.res.statusCode,401);assert.equal(other.calls.length,0);
});
