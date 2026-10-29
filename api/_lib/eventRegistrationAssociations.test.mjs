import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeRegistrationAssociationConfig,resolveRegistrationAssociations} from './eventRegistrationAssociations.js';
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
