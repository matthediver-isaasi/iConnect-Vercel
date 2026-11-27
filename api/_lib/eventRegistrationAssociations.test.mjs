import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeRegistrationAssociationConfig,resolveRegistrationAssociations,validateRegistrationAssociationConfig} from './eventRegistrationAssociations.js';
import {buildPublicTicketMemberSnapshot,preflightPublicTicketMembers} from './publicTicketMemberCreation.js';
const tenant='00000000-0000-4000-8000-000000000001';
const id='00000000-0000-4000-8000-000000000002';
const role={id:'00000000-0000-4000-8000-000000000003',tenant_id:tenant};
const person=email=>({first_name:'Example',last_name:'Person',organization:'Typed business',email});
const buyer=person('buyer@example.invalid');
const selected={...person('attendee@example.invalid'),registration_association:{kind:'group',id}};
const ticket={id:'standard',visibility_mode:'members_and_public',create_member_records:false};
test('configuration defaults off and enabled accounts require a role',()=>{
 assert.equal(normalizeRegistrationAssociationConfig(null),null);
 assert.throws(()=>normalizeRegistrationAssociationConfig({groups:{enabled:true}}),/role/);
 assert.throws(()=>normalizeRegistrationAssociationConfig({role_id:role.id,groups:{enabled:true,field_id:id,value:''}}),/filter value/);
});
test('multi-value contract preserves booleans, legacy values, commas and independent sources',()=>{
 const config=normalizeRegistrationAssociationConfig({role_id:role.id,
   organizations:{enabled:true,field_id:id,values:['North','South','North','Research, education']},
   groups:{enabled:true,field_id:id,value:false}});
 assert.deepEqual(config.organizations.values,['North','South','Research, education']);
 assert.deepEqual(config.groups.values,['false']);
 assert.deepEqual(normalizeRegistrationAssociationConfig(config),config);
 for(const values of [[],[' '],{},'North',[{}],[['North']],null,Array(1).fill('a'.repeat(1001))]){
   assert.throws(()=>normalizeRegistrationAssociationConfig({role_id:role.id,groups:{enabled:true,field_id:id,values}}),/filter value/);
 }
 assert.throws(()=>normalizeRegistrationAssociationConfig({role_id:role.id,groups:{enabled:true,field_id:id,values:[],value:'legacy'}}),/filter value/);
 assert.deepEqual(normalizeRegistrationAssociationConfig({groups:{enabled:false,field_id:id,values:[]}}).groups.values,[]);
});
test('save validation retains role authorization and field ownership for both sources',async()=>{
 const config={role_id:role.id,organizations:{enabled:true,field_id:id,values:['North','South']},
   groups:{enabled:true,field_id:role.id,values:[true,false]}};
 let wrongScope=false;
 const db={from(table){const filters={};return {select(){return this;},eq(k,v){filters[k]=v;return this;},
   async maybeSingle(){assert.equal(filters.tenant_id,tenant);return {data:table==='role'?role:
     {id:filters.id,entity_scope:wrongScope?'member':filters.id===id?'organization':'organization_group'}};}};}};
 await assert.rejects(validateRegistrationAssociationConfig(db,tenant,config,false),/administrator access/);
 assert.deepEqual((await validateRegistrationAssociationConfig(db,tenant,config,true)).groups.values,['true','false']);
 wrongScope=true;
 await assert.rejects(validateRegistrationAssociationConfig(db,tenant,config,true),/record type/);
});
test('save validation checks option-backed values and keeps free-text single-valued',async()=>{
 let field={id,entity_scope:'organization',field_type:'boolean'};
 const db={from(table){return {select(){return this;},eq(){return this;},
   async maybeSingle(){return {data:table==='role'?role:field};}};}};
 const save=values=>validateRegistrationAssociationConfig(db,tenant,{
   role_id:role.id,organizations:{enabled:true,field_id:id,values}},true);
 assert.deepEqual((await save([false,true])).organizations.values,['false','true']);
 await assert.rejects(save(['No']),/valid custom-field/);
 field={...field,field_type:'select',options:[{value:'a',label:'Alpha'},'b']};
 assert.deepEqual((await save(['a','b'])).organizations.values,['a','b']);
 await assert.rejects(save(['forged']),/valid custom-field/);
 field={...field,field_type:'text',options:[]};
 await assert.rejects(save(['a','b']),/single/);
 assert.deepEqual((await save(['a,b'])).organizations.values,['a,b']);
});
test('only selected people receive accounts; Other keeps the existing policy',()=>{
 const snapshot=buildPublicTicketMemberSnapshot({tenantId:tenant,purchaser:buyer,items:[{ticket,attendees:[selected,person('other@example.invalid')]}],roles:[],associationRole:role});
 assert.equal(snapshot.people.length,1);
 assert.equal(snapshot.people[0].identity.email,selected.email);
 assert.deepEqual(snapshot.people[0].association,selected.registration_association);
 assert.equal(snapshot.people[0].role_id,role.id);
 assert.equal(snapshot.people[0].links[0].index,0);
 assert.equal(snapshot.booking_items[0].attendees.length,2);
 assert.equal(snapshot.ticket_policies[0].create_member_records,false);
 assert.equal(buildPublicTicketMemberSnapshot({tenantId:tenant,purchaser:buyer,items:[{ticket,attendees:[buyer]}],roles:[]}),null);
});
test('known attendee emails require authentication even when their choice is Other',async()=>{
 const items=[{ticket,attendees:[selected,person('known@example.invalid')]}];
 const db={rpc:async(name,args)=>{assert.ok(args.p_emails.includes('known@example.invalid'));return {data:[{normalized_email:'known@example.invalid'}],error:null};}};
 await assert.rejects(preflightPublicTicketMembers({db,tenantId:tenant,purchaser:buyer,items,roles:[],associationRole:role}),/already has a record/);
});
test('selections are resolved server-side, rejecting forged IDs and names',async()=>{
 const config={role_id:role.id,organizations:{enabled:false},groups:{enabled:true}};
 const db={from(table){return {select(){return this;},eq(){return this;},async maybeSingle(){return {data:table==='role'?role:{registration_association_config:config},error:null};}};},
  async rpc(name,args){assert.equal(args.p_tenant,tenant);assert.equal(args.p_id,id);return {data:{options:[{kind:'group',id,name:'Canonical group'}]},error:null};}};
 const input={db,tenantId:tenant,eventId:id,eventKind:'simple',purchaser:buyer,items:[{ticket,attendees:[selected]}]};
 const result=await resolveRegistrationAssociations(input);
 assert.equal(result.items[0].attendees[0].organization,'Canonical group');
 db.rpc=async()=>({data:{options:[]},error:null});
 await assert.rejects(resolveRegistrationAssociations(input),/no longer available/);
 assert.equal(await resolveRegistrationAssociations({...input,authenticatedMember:{tenant_id:tenant}}),null);
});
