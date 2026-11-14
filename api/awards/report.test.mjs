import test from 'node:test';
import assert from 'node:assert/strict';
process.env.ROLE_ACCESS_OVERLAY_SKIP_PRIME='1';
const {__setRoleAccessOverlayForTests}=await import('../_lib/roleVisibility.js');
__setRoleAccessOverlayForTests([]);
const {default:handler}=await import('./report.js');
const tenant='11111111-1111-4111-8111-111111111111',round='22222222-2222-4222-8222-222222222222';
const evidence={
  round:{id:round,name:'Final',required_judges:1,require_all:false},
  application:{id:'application',reference:'=FORMULA()',eligibility:'eligible'},
  moderation:null,assessments:[
    {assignmentId:'one',appointmentId:'private-judge-id',revisionId:'revision',criteriaVersionId:'criteria',
      state:'submitted',included:true,recused:false,revision:1,score:{numerator:'80',denominator:'1'},answers:{essay:{value:'Submitted answer'}}},
    {assignmentId:'two',appointmentId:'other-private-judge-id',state:'draft',included:true,recused:false,score:null,answers:{essay:{value:'CONFIDENTIAL DRAFT'}}},
  ],
};
async function run(format='json',{exclusions=[],error=null}={}){
  const calls=[],res={headers:{},statusCode:200,setHeader(k,v){this.headers[k]=v;},status(v){this.statusCode=v;return this;},
    json(body){this.body=body;return this;},send(body){this.body=body;return this;}};
  await handler({method:'GET',headers:{},query:{roundId:round,format}},res,{
    getTenantContext:async()=>({isAuthenticated:true,tenantId:tenant,roleId:tenant,memberId:tenant}),
    supabase:{
      from(){const q={select(){return q;},eq(){return q;},maybeSingle:async()=>({data:{excluded_features:exclusions}})};return q;},
      async rpc(name,args){calls.push({name,args});return{error,data:{round:evidence.round,total:1,entries:[{evidence,fingerprint:'fingerprint'}]}};},
    },
  });
  return{res,calls};
}
test('reports are tenant-scoped and never expose draft answers or raw judge identities',async()=>{
  const {res,calls}=await run();
  assert.equal(res.statusCode,200);assert.equal(calls[0].args.p_tenant,tenant);
  assert.equal(res.body.matrix.length,1);
  assert.equal(JSON.stringify(res.body).includes('CONFIDENTIAL DRAFT'),false);
  assert.equal(JSON.stringify(res.body).includes('private-judge-id'),false);
});
test('CSV has real headers and formula-safe application references',async()=>{
  const {res}=await run('csv');
  assert.equal(res.statusCode,200);
  assert.match(res.body,/Application,Eligibility,Complete,Score/);
  assert.match(res.body,/'=FORMULA\(\)/);
});
test('excluded reporting permission and incomplete backend reads cannot produce exports',async()=>{
  const denied=await run('csv',{exclusions:['awards.management.report']});
  assert.equal(denied.res.statusCode,403);assert.equal(denied.calls.length,0);
  const failed=await run('csv',{error:{code:'57014'}});
  assert.equal(failed.res.statusCode,503);
  assert.equal(failed.res.headers['Content-Disposition'],undefined);
});
