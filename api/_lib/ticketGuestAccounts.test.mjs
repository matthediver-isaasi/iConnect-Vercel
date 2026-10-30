import test from 'node:test';
import assert from 'node:assert/strict';
import { publicTicketMemberPolicy } from '../../shared/publicTicketMemberPolicy.js';
import { buildPublicTicketMemberSnapshot, needsPublicTicketMemberCreation, validatePublicTicketMemberPolicyWrite } from './publicTicketMemberCreation.js';
import { gatePublicTicketMemberPolicy } from './publicTicketMemberReleaseGate.js';
const role={id:'role',tenant_id:'tenant'};
const person={first_name:'Guest',last_name:'Person',email:'guest@example.invalid',organization:'Typed hospital'};
const ticket={id:'ticket',visibility_mode:'members_and_public',auto_create_guest_accounts:true,new_member_role_id:role.id};
const snapshot=t=>buildPublicTicketMemberSnapshot({tenantId:'tenant',purchaser:person,items:[{ticket:t,attendees:[person]}],roles:[role]});
test('both public audiences opt in without creating an association or granting membership',()=>{
  for(const visibility_mode of ['public_only','members_and_public']){
    const result=snapshot({...ticket,visibility_mode});
    assert.equal(result.guest_accounts,true);
    assert.equal(result.people.length,1);
    assert.equal(result.people[0].guest_account,true);
    assert.equal(result.people[0].association,undefined);
    assert.equal(result.people[0].identity.organization,'Typed hospital');
  }
});
test('members-only and selected-member tickets cannot create accounts',()=>{
  for(const t of [{...ticket,visibility_mode:'members_only'},{...ticket,audience_mode:'selected_members'}]){
    assert.equal(publicTicketMemberPolicy(t).auto_create_guest_accounts,false);
    assert.equal(needsPublicTicketMemberCreation([t],null,'tenant'),false);
    assert.throws(()=>snapshot(t),/public tickets/);
  }
  assert.equal(needsPublicTicketMemberCreation([ticket],{tenant_id:'tenant'},'tenant'),false);
});
test('legacy contact policy remains contact-only; default is off',()=>{
  assert.equal(snapshot({...ticket,auto_create_guest_accounts:false}),null);
  const result=snapshot({...ticket,auto_create_guest_accounts:false,create_member_records:true});
  assert.equal(result.guest_accounts,undefined);
  assert.equal(result.people[0].guest_account,undefined);
});
test('known associations retain the event role while Other uses the ticket role',()=>{
  const associated={...person,email:'associated@example.invalid',registration_association:{kind:'group',id:'group'}};
  const eventRole={id:'event-role',tenant_id:'tenant'};
  const result=buildPublicTicketMemberSnapshot({tenantId:'tenant',purchaser:person,
    items:[{ticket,attendees:[person,associated]}],roles:[role],associationRole:eventRole});
  assert.equal(result.people.find(p=>p.identity.email===associated.email).role_id,eventRole.id);
  assert.equal(result.people.find(p=>p.identity.email===associated.email).association.kind,'group');
  assert.equal(result.people.find(p=>p.identity.email===person.email).role_id,role.id);
  assert.equal(result.people.find(p=>p.identity.email===person.email).association,undefined);
});
test('new policy requires role-management authority and migration readiness',async()=>{
  await assert.rejects(validatePublicTicketMemberPolicyWrite({tickets:[ticket],tenantId:'tenant',authorizedToAssignRoles:false}),/administrator/i);
  await assert.rejects(gatePublicTicketMemberPolicy('event',{pricing_config:{ticket_classes:[ticket]}},{rpc:async()=>({error:{code:'PGRST202'}})}),/migration/);
});
