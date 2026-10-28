import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemberAmendmentsHandler} from './member-amendments.js';
import {createMemberChangeFormSettings} from '../_lib/memberChangeFormSettings.js';
const formId='10000000-0000-4000-8000-000000000003';
test('form settings use finance-admin session authority, never posted tenant or actor',async()=>{
 let context={isAuthenticated:true,tenantId:'tenant',tenantUserId:'actor'},allow=true;
 const calls=[];
 const db={from(table){const q={select(){return this;},eq(k,v){calls.push([table,k,v]);return this;},
  order(){return this;},range:async()=>({data:[]}),
  maybeSingle:async()=>({data:table==='form'?{id:formId,require_authentication:true,is_active:true}:null})};return q;},
  rpc:async(name,args)=>{calls.push([name,args]);return {data:{}};}};
 const handler=createMemberAmendmentsHandler({db,getContext:async()=>context,isAdmin:async()=>allow,
  hasFinance:async()=>false,service:{}});
 async function invoke(method){
  const res={statusCode:200,setHeader(){},status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
  const params={action:'form_change_settings',formId,tenantId:'forged',actorId:'forged',enabled:false,targetConfigIds:[],revision:0};
  await handler({method,query:params,body:params},res);return res;
 }
 assert.equal((await invoke('GET')).body.executionEnabled,false);
 assert.equal((await invoke('POST')).statusCode,200);
 const write=calls.find(c=>c[0]==='save_membership_change_form')[1];
 assert.equal(write.p_tenant_id,'tenant');assert.equal(write.p_actor_id,'actor');
 const count=calls.length;allow=false;
 assert.equal((await invoke('POST')).statusCode,403);assert.equal(calls.length,count);
 allow=true;context={...context,roleId:'restricted'};
 assert.equal((await invoke('GET')).statusCode,403);assert.equal(calls.length,count);
});
test('configuration validation is distinct from a stale-save conflict',async()=>{
 let message='Target structures must be active member structures in this tenant';
 const service=createMemberChangeFormSettings({db:{rpc:async()=>({error:{code:'P0001',message}})}});
 const args=['tenant','actor',{formId,enabled:true,targetConfigIds:[],revision:0}];
 await assert.rejects(service.save(...args),e=>e.status===422&&e.message===message);
 message='Settings changed. Reload before saving';
 await assert.rejects(service.save(...args),e=>e.status===409);
  await assert.rejects(service.save('tenant','actor',{formId,enabled:true,
   targetConfigIds:[[formId]],revision:0}),e=>e.status===400);
});
