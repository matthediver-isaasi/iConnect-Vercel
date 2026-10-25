import test from 'node:test';
import assert from 'node:assert/strict';
import { validateManualAward, sanitizeManualMessage, resolveManualCertificate } from './manualCpdAwards.js';
import { createManualCpdAwardsHandler } from '../admin/manual-cpd-awards.js';
const id='10000000-0000-4000-8000-000000000001';
const input={template_id:id,points_value:'2.5',activity_title:' Training ',activity_date:'2026-10-25'};
test('manual award requires precise positive points and a real date',()=>{
 assert.equal(validateManualAward(input).activity_title,'Training');
 for(const points_value of ['0','-1','NaN','1e2','1.1234567','100000000000000']) assert.throws(()=>validateManualAward({...input,points_value}));
 assert.throws(()=>validateManualAward({...input,activity_date:'2026-02-30'}));
});
test('custom email preserves basic formatting and strips active HTML',()=>{
 const html=sanitizeManualMessage('<p>Hello <strong>member</strong></p><script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">link</a>');
 assert.match(html,/<strong>member<\/strong>/);assert.doesNotMatch(html,/script|onerror|javascript:|<img/);
});
test('manual certificate cannot escape tenant/member storage prefix',async()=>{
 const row={entry_kind:'manual_award',member_id:id,manual_certificate:{path:`wrong/manual-cpd/${id}/a.pdf`,sha256:'a'.repeat(64)}};
 assert.equal((await resolveManualCertificate({}, {tenantId:id,memberCertificateId:id,row})).available,false);
 row.manual_certificate.path=`${id}/manual-cpd/${id}/a.pdf`;
 assert.equal((await resolveManualCertificate({}, {tenantId:id,memberCertificateId:id,row})).available,true);
});
function response(){return {statusCode:200,setHeader(){},status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}};}
test('unprivileged member cannot create an award or enumerate templates',async()=>{
 const handler=createManualCpdAwardsHandler({db:{from(){throw Error('must not query');}},getTenantContext:async()=>({isAuthenticated:true,tenantId:id,roleId:id}),hasAdminAccess:async()=>false});
 for(const method of ['GET','POST']){const res=response();await handler({method,query:{member_id:id},body:{member_id:id}},res);assert.equal(res.statusCode,403);}
});
test('tenant mismatch fails closed',async()=>{
 const handler=createManualCpdAwardsHandler({getTenantContext:async()=>({isAuthenticated:true,tenantId:id,tenantUserId:id,tenantMismatch:true})});
 const res=response();await handler({method:'POST'},res);assert.equal(res.statusCode,401);
});
test('preview has no effects; saving and email retries never duplicate points or delivery',async()=>{
 let award=null,delivery=null,rpcCalls=0,uploads=0,sends=0;
 const db={
  from(table){
   let operation='read',value,filters={};
   const chain={select(){return this;},eq(k,v){filters[k]=v;return this;},order(){return this;},
    insert(v){operation='insert';value=v;return this;},update(v){operation='update';value=v;return this;},
    maybeSingle(){return Promise.resolve(result());},single(){return Promise.resolve(result());},
    then(resolve,reject){return Promise.resolve(result()).then(resolve,reject);}};
   function result(){
    assert.equal(filters.tenant_id || value?.tenant_id,id);
    if(table==='member')return {data:{id,first_name:'Test',last_name:'Member',email:'member@example.test'}};
    if(table==='member_cpd_points_ledger')return {data:award};
    if(table==='manual_cpd_email_delivery'){
     if(operation==='insert'){if(delivery)return {error:{code:'23505'}};delivery={...value};return {data:null};}
     if(operation==='update'){if(filters.status!==delivery.status)return {data:[]};Object.assign(delivery,value);return {data:[{ledger_entry_id:id}]};}
     return {data:delivery};
    }
    throw Error(table);
   }
   return chain;
  },
  async rpc(name,args){rpcCalls++;assert.equal(name,'record_manual_cpd_award');assert.equal(args.p_tenant_id,id);
   award={id,member_id:id,created_by:`tenant_user:${id}`,entry_kind:'manual_award',manual_certificate:args.p_certificate};return {data:award};}
 };
 const handler=createManualCpdAwardsHandler({db,getTenantContext:async()=>({isAuthenticated:true,tenantId:id,tenantUserId:id}),
  prepareManualCertificate:async()=>({pdf:Buffer.from('%PDF-preview')}),
  storeManualCertificate:async(db,t,m,p,input)=>{uploads++;return {input,path:`${id}/manual-cpd/${id}/a.pdf`,sha256:'a'.repeat(64)};},
  renderAttendeeCertificate:async()=>Buffer.from('%PDF-saved'),
  sendEmail:async mail=>{sends++;assert.equal(mail.to,'member@example.test');assert.equal(mail.attachments.length,1);return {success:true,id:'test-provider-id'};}
 });
 const call=async body=>{const res=response();res.send=function(v){this.body=v;return this;};await handler({method:'POST',body:{member_id:id,...body}},res);return res;};
 assert.equal((await call({action:'preview',...input})).statusCode,200);assert.equal(rpcCalls+uploads+sends,0);
 assert.equal((await call({action:'award',...input,idempotency_key:id})).statusCode,201);
 assert.equal((await call({action:'award',...input,idempotency_key:id})).statusCode,200);assert.equal(rpcCalls,1);assert.equal(uploads,1);
 assert.equal((await call({action:'award',...input,points_value:'3',idempotency_key:id})).statusCode,409);
 const email={action:'email',ledger_entry_id:id,idempotency_key:id,message_html:'<p>Well done</p>'};
 assert.equal((await call(email)).body.status,'sent');assert.equal((await call(email)).body.status,'sent');
 assert.equal(sends,1);assert.equal(rpcCalls,1);
});
