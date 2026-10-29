import test from 'node:test';
import assert from 'node:assert/strict';
import { consentHash, issueEventRegistrationConsent, recoverEventRegistrationConsent } from './eventRegistrationConsent.js';
import { createEventRegistrationConsentHandler } from '../public/event-registration-consent.js';
import { createEventRegistrationCommunicationHandler } from '../admin/event-registration-communication.js';

const token = 'a'.repeat(43);
test('guest names are normalized snapshots and recovery cannot replace them', async () => {
  for (const eventKind of ['simple','complex']) {
    const db=fixture();
    db.tables.event_registration_consent=[];
    db.tables.event_registration_communication[0].event_kind=eventKind;
    const input={tenantId:'tenant',eventKind,eventId:'event',purchaseReference:'new',
      guestIdentity:{email:' Booker@example.test ',first_name:'  Jo ',last_name:' Booker '},
      recoveryNonce:'b'.repeat(64)};
    const issued=await issueEventRegistrationConsent(db,input);
    const row=db.tables.event_registration_consent[0];
    assert.equal(row.email,'booker@example.test');
    assert.equal(row.first_name,'Jo');assert.equal(row.last_name,'Booker');
    row.expires_at=new Date(Date.now()+60000).toISOString();
    assert.deepEqual(await recoverEventRegistrationConsent(db,{...input,guestIdentity:{email:'attendee@example.test',first_name:'Attendee'}}),issued);
    assert.equal(row.first_name,'Jo');
    assert.deepEqual(Object.keys(issued).sort(),['id','token']);
    await issueEventRegistrationConsent(db,{...input,guestIdentity:null,guestEmail:'old@example.test'});
    assert.equal(db.tables.event_registration_consent.at(-1).first_name,null);
  }
});
test('completion ignores editable identity and uses only stored capability',async()=>{
  const db=fixture();const row=db.tables.event_registration_consent[0];
  row.member_id=null;row.email='booker@example.test';row.first_name='Booker';
  const res=await call(db,{action:'subscribe',category_ids:['open'],first_name:'Attendee',email:'other@example.test'},null);
  assert.equal(res.code,200);
  assert.deepEqual(Object.keys(db.calls[0].args).sort(),['p_category_ids','p_id','p_member_id','p_token_hash']);
});
const member = { id:'member',tenant_id:'tenant',email:'member@example.test',role_id:'role',login_enabled:true };
function fixture() {
  const tables = {
    event:[{id:'event',tenant_id:'tenant'}],
    event_registration_consent:[{
      id:'offer',tenant_id:'tenant',event_kind:'simple',event_id:'event',member_id:'member',
      email:member.email,token_hash:consentHash(token),expires_at:new Date(Date.now()+60000).toISOString(),completed_at:null,
      purchase_reference:'purchase',recovery_hash:consentHash('b'.repeat(64)),
    }],
    event_registration_communication:[{tenant_id:'tenant',event_kind:'simple',event_id:'event',category_ids:['open','role','public','inactive','job','subscribed']}],
    member:[member],communication_category:[
      ...['open','role','public','inactive','job','subscribed'].map(id=>({
        id,name:id,tenant_id:'tenant',is_active:id!=='inactive',is_public:true,member_enabled:id!=='public',system_key:id==='job'?'job_postings':null,
      })),
      {id:'foreign',tenant_id:'foreign',is_active:true,is_public:true},
    ],
    communication_category_role:[{tenant_id:'tenant',category_id:'role',role_id:'other'}],
    member_communication_preference:[{tenant_id:'tenant',member_id:'member',category_id:'subscribed',is_subscribed:true}],
    email_subscriber:[],email_unsubscribe:[],job_alert_settings:[{tenant_id:'tenant',enabled:false}],
  };
  const calls = [];
  const db = { tables,calls, failTable:null,
    from(table) {
      const filters=[];let single=false,insert=null,update=null;
      const q={
        select(){return q;},order(){return q;},limit(){return q;},
        eq(key,value){filters.push(row=>row[key]===value);return q;},
        is(key,value){filters.push(row=>row[key]===value);return q;},
        in(key,values){filters.push(row=>values.includes(row[key]));return q;},
        ilike(key,value){filters.push(row=>String(row[key]).toLowerCase()===value.replace(/\\([%_\\])/g,'$1').toLowerCase());return q;},
        filter(key,op,value){assert.equal(op,'imatch');filters.push(row=>new RegExp(value.replaceAll('[[:space:]]','\\s'),'i').test(row[key]));return q;},
        maybeSingle(){single=true;return q;},single(){single=true;return q;},
        insert(value){insert=value;return q;},update(value){update=value;return q;},
        then(resolve,reject){
          if(db.failTable===table)return Promise.resolve({error:new Error('Unavailable')}).then(resolve,reject);
          if(insert) { tables[table].push({id:'new',...insert}); }
          const rows=(tables[table]||[]).filter(row=>filters.every(f=>f(row)));
          if(update)rows.forEach(row=>Object.assign(row,update));
          return Promise.resolve({data:single?rows.at(-1)||null:rows,error:null}).then(resolve,reject);
        },
      };return q;
    },
    async rpc(name,args){calls.push({name,args});return {data:null,error:null};},
  };return db;
}
function response(){return {code:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};}
async function call(db, body={}, who=member, tenant='tenant') {
  const handler=createEventRegistrationConsentHandler({db,sessionMember:async()=>who,resolveTenant:async()=>({id:tenant})});
  const res=response();await handler({method:'POST',body:{id:'offer',token,action:'choices',...body}},res);return res;
}
test('member offerings intersect config, role, audience, activity, special policy and explicit preferences',async()=>{
  const db=fixture();
  assert.deepEqual((await call(db)).body.categories.map(c=>c.id),['open']);
  db.tables.member[0]={...member,communications_opted_out_all:true};
  assert.deepEqual((await call(db)).body.categories,[]);
});
test('guest collisions, global suppression and role restrictions never create member authority',async()=>{
  const db=fixture(),offer=db.tables.event_registration_consent[0];offer.member_id=null;
  assert.deepEqual((await call(db,{},null)).body.categories,[]);
  offer.email='external@example.test';
  assert.deepEqual((await call(db,{},null)).body.categories.map(c=>c.id),['open','public','subscribed']);
  db.tables.email_unsubscribe.push({tenant_id:'tenant',email:offer.email,unsubscribe_type:'all'});
  assert.deepEqual((await call(db,{},null)).body.categories,[]);
  assert.equal(db.calls.length,0);
});
test('capabilities require matching tenant, token, expiry and current authenticated purchaser',async()=>{
  for(const [body,who,tenant,code] of [
    [{token:'wrong'},member,'tenant',400],
    [{token:'z'.repeat(43)},member,'tenant',410],
    [{},null,'tenant',403],
    [{},{...member,id:'attendee'},'tenant',403],
    [{},member,'other',410],
  ]) assert.equal((await call(fixture(),body,who,tenant)).code,code);
  const db=fixture();db.tables.event_registration_consent[0].expires_at='2000-01-01';
  assert.equal((await call(db)).code,410);
  db.tables.event_registration_consent[0].member_id=null;
  assert.equal(db.calls.length,0);
});
test('submit rechecks changed configuration, rejects unselected/private choices and only writes selected IDs',async()=>{
  const db=fixture();
  assert.equal((await call(db,{action:'subscribe',category_ids:['role']})).code,409);
  assert.equal((await call(db,{action:'subscribe',category_ids:[]})).code,409);
  db.tables.event_registration_communication[0].category_ids=[];
  assert.equal((await call(db,{action:'subscribe',category_ids:['open']})).code,409);
  assert.equal(db.calls.length,0);
  db.tables.event_registration_communication[0].category_ids=['open'];
  assert.equal((await call(db,{action:'subscribe',category_ids:['open']})).code,200);
  assert.deepEqual(db.calls[0].args.p_category_ids,['open']);
  assert.equal(db.calls[0].args.p_member_id,'member');
  assert.equal((await call(db,{action:'dismiss',category_ids:['role']})).code,200);
  assert.deepEqual(db.calls[1].args.p_category_ids,[]);
});
test('completed/replayed offers are empty and database failures remain explicit',async()=>{
  const db=fixture();db.tables.event_registration_consent[0].completed_at='now';
  assert.deepEqual((await call(db)).body,{completed:true,categories:[]});
  db.failTable='event_registration_consent';
  assert.equal((await call(db)).code,503);
});
test('issuance excludes attendee allocation claims; recovery needs original nonce and same purchaser',async()=>{
  const db=fixture();
  const input={tenantId:'tenant',eventKind:'simple',eventId:'event',purchaseReference:'purchase',purchaser:member,recoveryNonce:'b'.repeat(64)};
  db.tables.event_registration_consent=[];
  const issued=await issueEventRegistrationConsent(db,input);
  db.tables.event_registration_consent[0].expires_at=new Date(Date.now()+60000).toISOString();
  assert.equal(await issueEventRegistrationConsent(db,{...input,allocation:{}}),null);
  assert.equal(await recoverEventRegistrationConsent(db,{...input,recoveryNonce:'c'.repeat(64)}),null);
  assert.equal(await recoverEventRegistrationConsent(db,{...input,purchaser:null}),null);
  assert.equal(await recoverEventRegistrationConsent(db,{...input,purchaseReference:'historical'}),null);
  const recovered=await recoverEventRegistrationConsent(db,input);
  assert.deepEqual(recovered,issued);
  db.tables.event_registration_consent[0].completed_at='now';
  assert.equal(await recoverEventRegistrationConsent(db,input),null);
});
test('admin settings reject foreign tenant IDs, non-admin and mismatched tenant sessions',async()=>{
  for(const kind of ['simple','complex']){
    const db=fixture();db.tables.complex_event=db.tables.event;
    let admin=true, mismatch=false;
    const handler=createEventRegistrationCommunicationHandler({db,adminAccess:async()=>admin,
      tenantContext:async()=>({isAuthenticated:true,tenantId:'tenant',tenantMismatch:mismatch})});
    const run=async ids=>{const res=response();await handler({method:'PUT',body:{event_id:'event',event_kind:kind,category_ids:ids}},res);return res;};
    assert.equal((await run(['foreign'])).code,400);
    assert.equal((await run(['inactive'])).code,400);
    assert.equal((await run(['open'])).code,200);
    assert.deepEqual(db.calls[0].args.p_category_ids,['open']);
    admin=false;assert.equal((await run(['open'])).code,403);
    admin=true;mismatch=true;assert.equal((await run(['open'])).code,403);
  }
});
