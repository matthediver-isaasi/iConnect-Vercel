import test from 'node:test';
import assert from 'node:assert/strict';
import { createFormAlertToken, resolveFormAlertCapability } from './formAlertCapabilities.js';
import { scopedFormAlertAttachment } from './formAlertAttachments.js';

const {token,hash}=createFormAlertToken();
function fixture(overrides={}) {
  const tables={
    form_alert_delivery:[{tenant_id:'tenant',form_id:'form',submission_id:'response',
      token_hash:hash,status:'sent',expires_at:'2099-01-01',revoked_at:null,
      form_snapshot:{name:'Original form',fields:[{id:'a',label:'Original label',type:'text'}]}}],
    form:[{tenant_id:'tenant',id:'form',form_type:'standard'}],
    form_submission:[{tenant_id:'tenant',form_id:'form',id:'response',created_date:'2026-01-01T12:34:56Z',
      submission_data:{a:'Answer',secret:'Hidden'},is_anonymous:false}],
    ...overrides,
  };
  const calls=[];
  return {calls,from(table){
    calls.push(table);
    assert.ok(Object.hasOwn(tables,table),`Unexpected table ${table}`);
    let data=tables[table],count=false;
    const q={
      select(_,options){count=options?.count==='exact';return q;},
      eq(key,value){data=data.filter(row=>row[key]===value);return q;},
      neq(key,value){data=data.filter(row=>row[key]!==value);return q;},
      is(key,value){data=data.filter(row=>(row[key]??null)===value);return q;},
      maybeSingle(){return Promise.resolve({data:data[0]||null,error:null});},
      then(resolve){return Promise.resolve(count?{count:data.length,error:null}:{data,error:null}).then(resolve);},
    };return q;
  }};
}
test('capability returns only original definition labels and explicitly projected answers',async()=>{
  const db=fixture();const result=await resolveFormAlertCapability(db,'tenant',token);
  assert.equal(result.form_name,'Original form');
  assert.deepEqual(result.answers,[{label:'Original label',value:'Answer'}]);
  assert.deepEqual(result.attachments,[]);
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.ok(!JSON.stringify(result).includes(hash));
});
test('wrong token or tenant, absent target and revoked/expired/unsent deliveries fail closed',async()=>{
  assert.equal(await resolveFormAlertCapability(fixture(),'other',token),null);
  assert.equal(await resolveFormAlertCapability(fixture(),'tenant',createFormAlertToken().token),null);
  for(const table of ['form','form_submission','form_alert_delivery']) {
    assert.equal(await resolveFormAlertCapability(fixture({[table]:[]}),'tenant',token),null);
  }
  for(const changes of [{status:'sending'},{revoked_at:'2026-01-01'},{expires_at:'2000-01-01'},
    {expires_at:'invalid'},{form_id:'other'},{submission_id:'other'}]) {
    const db=fixture({form_alert_delivery:[{tenant_id:'tenant',form_id:'form',submission_id:'response',
      token_hash:hash,status:'sent',expires_at:'2099-01-01',...changes}]});
    assert.equal(await resolveFormAlertCapability(db,'tenant',token),null);
  }
});
test('published anonymous cohort policy controls projection and suppresses exact time without named lookups',async()=>{
  const row={tenant_id:'tenant',form_id:'form',id:'response',created_date:'2026-01-01T12:34:56Z',
    survey_version_id:'version',survey_assignment_id:'assignment',is_anonymous:true,
    submission_data:{a:'Feedback',email:'secret identity',file:'secret attachment'}};
  const version={tenant_id:'tenant',form_id:'form',id:'version',fields:[
    {id:'a',type:'text',label:'Published label'},{id:'email',type:'email'},{id:'file',type:'file'},
  ],survey_settings:{response_identity:'anonymous_dedupe',anonymity_threshold:3}};
  const build=n=>fixture({form:[{tenant_id:'tenant',id:'form',form_type:'survey'}],
    survey_version:[version],form_submission:Array.from({length:n},(_,i)=>({...row,id:i?`other${i}`:'response'}))});
  assert.equal(await resolveFormAlertCapability(build(2),'tenant',token),null);
  const db=build(3);const result=await resolveFormAlertCapability(db,'tenant',token);
  assert.deepEqual(result.answers,[{label:'Published label',value:'Feedback'}]);
  assert.equal(result.submitted_at,'2026-01-01');
  assert.ok(!db.calls.some(table=>/member|completion|receipt/.test(table)));
  const missing=fixture({form_submission:[row],survey_version:[]});
  assert.equal(await resolveFormAlertCapability(missing,'tenant',token),null);
});
test('attachments require an exact submission-owned private object; tenant/form-wide paths are not enough',()=>{
  const file={bucket:'private-uploads',storage_path:'tenant/form-submissions/response/file.pdf',file_name:'file.pdf'};
  assert.deepEqual(scopedFormAlertAttachment(file,'tenant','response'),
    {bucket:'private-uploads',path:file.storage_path,name:'file.pdf'});
  for(const value of [
    {...file,bucket:'public-assets'}, {...file,storage_path:'other/form-submissions/response/file.pdf'},
    {...file,storage_path:'tenant/form-submissions/other/file.pdf'},
    {...file,storage_path:'tenant/form-submissions/response/../file.pdf'},
    {...file,storage_path:'tenant/form-submissions/form/file.pdf'},'https://example.test/private',
  ]) assert.equal(scopedFormAlertAttachment(value,'tenant','response'),null);
});
