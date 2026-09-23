import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewIdentityEnrichment} from './bnms-dd-alpha-identity-binding-review.mjs';
import {TENANT_ID} from './bnms-dd-beta-invoices.mjs';

const fixture=()=>({
  member:{id:'member',tenant_id:TENANT_ID,email:'Same@Example.test',identity_id:'identity'},
  previous:{id:'member',email:'same@example.test',identity_id:null},
  source:{memberId:'member',email:'same@example.test'},
  binding:{member_id:'member',identity_id:'identity',identity_email:'same@example.test',
    email_identity_count:1,owner_count:1,memberships:[{member_id:'member',identity_id:'identity',
      tenant_id:TENANT_ID,membership_type:'member',role:'member',status:'active'}]},
});
test('same-person ordinary identity enrichment is not automatically drift',()=>{
  const result=reviewIdentityEnrichment(fixture());
  assert.equal(result.verifiedOrdinaryProfileEnrichment,true);
  assert.deepEqual(result.blockers,[]);
  assert.equal(result.providerOwnershipRevalidated,false);
});
test('owner authority is not neutralized by membership_type member',()=>{
  const input=fixture();input.binding.memberships[0].role='owner';
  assert.deepEqual(reviewIdentityEnrichment(input).warnings,['new_binding_has_application_admin_authority']);
  assert.deepEqual(reviewIdentityEnrichment(input).blockers,[]);
});
test('admin authority remains a separate security warning, not payer mismatch',()=>{
  const input=fixture();input.binding.memberships[0].role='admin';
  assert.equal(reviewIdentityEnrichment(input).verifiedOrdinaryProfileEnrichment,true);
  assert.deepEqual(reviewIdentityEnrichment(input).warnings,['new_binding_has_application_admin_authority']);
});
for(const [name,mutate,blocker] of [
  ['wrong tenant',x=>x.member.tenant_id='other','member_scope_mismatch'],
  ['email changed',x=>x.binding.identity_email='other@example.test','identity_source_email_mismatch'],
  ['duplicate identity',x=>x.binding.email_identity_count=2,'identity_ownership_not_unique'],
  ['shared owner',x=>x.binding.owner_count=2,'identity_ownership_not_unique'],
  ['wrong membership owner',x=>x.binding.memberships[0].member_id='other','tenant_member_binding_mismatch'],
  ['wrong membership tenant',x=>x.binding.memberships[0].tenant_id='other','tenant_member_binding_mismatch'],
  ['prior nonnull binding replaced',x=>x.previous.identity_id='old','existing_binding_changed_or_removed'],
  ['binding removed',x=>x.member.identity_id=null,'existing_binding_changed_or_removed'],
]){
  test(`rejects ${name}`,()=>{
    const input=fixture();mutate(input);
    assert.ok(reviewIdentityEnrichment(input).blockers.includes(blocker));
  });
}