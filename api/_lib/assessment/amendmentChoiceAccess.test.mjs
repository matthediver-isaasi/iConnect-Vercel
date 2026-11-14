import test from 'node:test';
import assert from 'node:assert/strict';
import {amendmentChoiceAccess} from './amendmentChoiceAccess.js';
function fixture(form={id:'form',is_active:true},allowed=false){
  const scope=[],seen=[];
  const query={select(){return this;},eq(k,v){scope.push([k,v]);return this;},async maybeSingle(){return{data:form};}};
  return{scope,seen,args:{db:{from(name){assert.equal(name,'form');return query;}},req:{headers:{'x-awards-applicant':'private-capability',cookie:'ordinary-session'}},
    tenantId:'tenant',formId:'form',resolveAccess:async input=>{seen.push(input);return{allowed};}}};
}
test('application links cannot supply ordinary directory-choice authority',async()=>{
  const f=fixture();assert.equal(await amendmentChoiceAccess(f.args),false);
  assert.deepEqual(f.scope,[['tenant_id','tenant'],['id','form']]);
  assert.equal(f.seen[0].req.headers['x-awards-applicant'],undefined);
  assert.equal(f.seen[0].req.headers.cookie,'ordinary-session');
  assert.equal(f.args.req.headers['x-awards-applicant'],'private-capability');
});
test('only current ordinary form permissions enable choices',async()=>{
  assert.equal(await amendmentChoiceAccess(fixture(undefined,true).args),true);
  for(const form of [null,{is_active:false},{is_active:true,archived_at:'2020-01-01'},
    {is_active:true,deactivate_at:'2020-01-01'},{is_active:true,form_type:'survey'}]){
    const f=fixture(form,true);assert.equal(await amendmentChoiceAccess(f.args),false);assert.equal(f.seen.length,0);
  }
});
