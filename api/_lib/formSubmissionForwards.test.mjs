import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../admin/form-submission-forwards.js';
import view from '../public/form-submission-forward-view.js';
import { createFormAlertToken } from './formAlertCapabilities.js';
import { resolveSubmissionForward, sanitizeForwardMessage, forwardDeliveryStatus } from './formSubmissionForwards.js';

const tenant='10000000-0000-4000-8000-000000000001';
const submission='10000000-0000-4000-8000-000000000002';
const member='10000000-0000-4000-8000-000000000003';
const form='10000000-0000-4000-8000-000000000004';
const key='10000000-0000-4000-8000-000000000005';
function response() {
  return {headers:{},statusCode:200,setHeader(k,v){this.headers[k]=v;},status(s){this.statusCode=s;return this;},
    json(body){this.body=body;return this;},send(body){this.body=body;return this;}};
}
function fixture() {
  const tables={
    form_submission:[{tenant_id:tenant,id:submission,form_id:form,submission_data:{q:'Real answer',hidden:'Secret'},
      created_date:'2026-10-25T12:00:00Z',is_anonymous:false}],
    member:[{tenant_id:tenant,id:member,first_name:'Example',last_name:'Member',email:'recipient@example.test',status:'active'}],
    form:[{tenant_id:tenant,id:form,name:'Example form',fields:[{id:'q',type:'text',label:'Question'}],form_type:'standard'}],
    tenant:[{id:tenant,slug:'example',domain:null}],
    form_alert_submission_snapshot:[],
    form_submission_forward:[],
  };
  const db={tables,from(table){
    assert.ok(tables[table],table);
    let filters=[],op='read',payload,fields='*';
    const result=()=>{
      let rows=tables[table].filter(row=>filters.every(fn=>fn(row)));
      if(op==='insert') {
        if(tables[table].some(row=>row.tenant_id===payload.tenant_id && row.idempotency_key===payload.idempotency_key))
          return {error:{code:'23505'}};
        rows=[{id:'10000000-0000-4000-8000-000000000009',created_at:new Date().toISOString(),...payload}];
        tables[table].push(...rows);
      } else if(op==='update') rows.forEach(row=>Object.assign(row,payload));
      return {data:rows.map(row=>fields==='*'?{...row}:Object.fromEntries(fields.split(',').map(k=>[k,row[k]]))),error:null};
    };
    const chain={
      select(value){fields=value;return this;},eq(k,v){filters.push(r=>r[k]===v);return this;},
      is(k,v){filters.push(r=>(r[k]??null)===v);return this;},
      in(k,v){filters.push(r=>v.includes(r[k]));return this;},order(){return this;},limit(){return this;},range(){return this;},
      insert(v){op='insert';payload=v;return this;},update(v){op='update';payload=v;return this;},
      maybeSingle(){const r=result();return Promise.resolve({...r,data:r.data?.[0]||null});},
      single(){return this.maybeSingle();},then(resolve,reject){return Promise.resolve(result()).then(resolve,reject);},
    };return chain;
  }};
  const sent=[];
  const deps={db,getTenantContext:async()=>({isAuthenticated:true,tenantId:tenant,tenantUserId:member}),
    authorize:async()=>null,sendEmail:async mail=>{sent.push(mail);return {success:true,id:'mail-id'};}};
  const call=async(body={},method='POST',query={})=>{
    const res=response();await handler({method,body,query},res,deps);return res;
  };
  return {db,tables,deps,sent,call};
}
const send={submission_id:submission,member_id:member,idempotency_key:key,message_html:'<p>Hello <strong>there</strong></p>'};
test('forward sanitizer preserves TipTap text and removes scripts and unsafe links',()=>{
  const clean=sanitizeForwardMessage('<p>Hi</p><script>bad()</script><img src=x onerror=bad()><a href="javascript:bad()">X</a>');
  assert.match(clean,/<p>Hi<\/p>/);assert.doesNotMatch(clean,/script|onerror|javascript|<img/);
  assert.throws(()=>sanitizeForwardMessage('a'.repeat(50001)));
});
test('provider outcomes never treat ambiguous acceptance as retry-safe',()=>{
  assert.equal(forwardDeliveryStatus({success:true}),'sent');
  assert.equal(forwardDeliveryStatus({status:400,ambiguousEffect:true}),'unknown');
  assert.equal(forwardDeliveryStatus({notSubmitted:true}),'failed');
  assert.equal(forwardDeliveryStatus({status:429}),'failed');
  assert.equal(forwardDeliveryStatus({status:503}),'unknown');
  assert.equal(forwardDeliveryStatus(null),'unknown');
});
test('send snapshots recipient, hides bearer from API, deduplicates retry and revokes public access',async()=>{
  const f=fixture();
  const res=await f.call(send);assert.equal(res.statusCode,201);assert.equal(res.body.forward.status,'sent');
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].to,'recipient@example.test');
  assert.equal(f.sent[0].disableTracking,true);assert.equal(f.sent[0].confidentialDiagnostics,true);
  assert.doesNotMatch(f.sent[0].html,/Real answer|Secret/);
  assert.doesNotMatch(JSON.stringify(res.body),/token_hash|form_snapshot|message_html/);
  const url=f.sent[0].html.match(/href="([^"]+)"/)[1];
  assert.match(url,/\/api\/public\/form-submission-forward-view#/);
  const token=new URL(url).hash.slice(1);
  const data=await resolveSubmissionForward(f.db,tenant,token);
  assert.deepEqual(data.answers,[{label:'Question',value:'Real answer'}]);
  assert.equal(await resolveSubmissionForward(f.db,'wrong-tenant',token),null);
  assert.equal((await f.call(send)).statusCode,200);assert.equal(f.sent.length,1);
  assert.equal((await f.call({...send,message_html:'Different'})).statusCode,409);
  const history=await f.call({},'GET',{submission_id:submission});
  assert.equal(history.body.forwards[0].recipient_name,'Example Member');
  const revoked=await f.call({action:'revoke',submission_id:submission,forward_id:res.body.forward.id});
  assert.equal(revoked.statusCode,200);assert.ok(revoked.body.forward.revoked_at);
  assert.equal(await resolveSubmissionForward(f.db,tenant,token),null);
});
test('unknown sends remain inert and exact retries do not send again',async()=>{
  const f=fixture();f.deps.sendEmail=async mail=>{f.sent.push(mail);throw Error('uncertain');};
  assert.equal((await f.call(send)).body.forward.status,'unknown');
  assert.equal(f.tables.form_submission_forward[0].token_hash,null);
  assert.equal((await f.call(send)).body.forward.status,'unknown');assert.equal(f.sent.length,1);
});
test('definitively failed sends can be retried once with the same immutable request',async()=>{
  const f=fixture();f.deps.sendEmail=async mail=>{f.sent.push(mail);return f.sent.length===1?{notSubmitted:true}:{success:true};};
  assert.equal((await f.call(send)).body.forward.status,'failed');
  assert.equal((await f.call(send)).body.forward.status,'sent');
  assert.equal(f.tables.form_submission_forward.length,1);
  assert.equal(f.sent.length,2);
  await f.call(send);assert.equal(f.sent.length,2);
});
test('permission, tenant, recipient and privacy failures prevent all sends',async()=>{
  for(const setup of [
    f=>{f.deps.getTenantContext=async()=>({isAuthenticated:false});},
    f=>{f.deps.getTenantContext=async()=>({isAuthenticated:true,tenantId:tenant,tenantMismatch:true});},
    f=>{f.deps.authorize=async()=>({status:403,error:'Denied'});},
    f=>{f.tables.member[0].tenant_id='other';},
    f=>{f.tables.member[0].status='deleted';},
    f=>{f.tables.form_submission[0].tenant_id='other';},
    f=>{f.deps.project=async()=>null;},
  ]) {
    const f=fixture();setup(f);const r=await f.call(send);assert.ok(r.statusCode>=400);
    assert.equal(f.sent.length,0);assert.equal(f.tables.form_submission_forward.length,0);
  }
});
test('public forwarding rejects expired, invalid, unsent and deleted targets',async()=>{
  for(const mutate of [
    row=>{row.status='sending';},row=>{row.status='unknown';},row=>{row.expires_at='2000-01-01';},
    row=>{row.expires_at='invalid';},row=>{row.revoked_at='2026-01-01';},
  ]) {
    const f=fixture();await f.call(send);const row=f.tables.form_submission_forward[0];mutate(row);
    const token=new URL(f.sent[0].html.match(/href="([^"]+)"/)[1]).hash.slice(1);
    assert.equal(await resolveSubmissionForward(f.db,tenant,token),null);
  }
  const f=fixture();await f.call(send);f.tables.form_submission=[];
  const token=new URL(f.sent[0].html.match(/href="([^"]+)"/)[1]).hash.slice(1);
  assert.equal(await resolveSubmissionForward(f.db,tenant,token),null);
  assert.equal(await resolveSubmissionForward(f.db,tenant,createFormAlertToken().token),null);
});
test('forwarding viewer uses its own response route and strips fragment without SPA analytics',()=>{
  const res=response();view({method:'GET'},res);
  assert.match(res.body,/const responsePath="\/api\/public\/form-submission-forward"/);
  assert.match(res.body,/history.replaceState/);assert.match(res.body,/fetch\(responsePath/);
  assert.equal(res.headers['Referrer-Policy'],'no-referrer');
  assert.match(res.headers['Content-Security-Policy'],/frame-ancestors 'none'/);
});
