import test from 'node:test';
import assert from 'node:assert/strict';
import { MAPPING, TENANT, planRoles, roleBlockers, main } from './audit-bnms-member-class-roles.mjs';
const role = (id,name) => ({id,name,tenant_id:TENANT,is_admin:false,is_tenant_admin:false,excluded_features:['admin'],max_members:null});
const roles = [role('member','Member'),role('full','Full member')];
const member = {id:'m',role_id:'member',tenant_id:TENANT,member_excluded_features:['keep']};
test('exact twenty mappings; primary replacement preserves original state',()=>{
  assert.equal(Object.keys(MAPPING).length,20);
  const plan=planRoles([member],[{member_id:'m',value:'Full'}],roles,'member');
  assert.equal(plan[0].action,'change');assert.equal(plan[0].targetRoleId,'full');
  assert.deepEqual(plan[0].original,member);assert.equal(member.role_id,'member');
});
test('Member mappings are no-ops',()=>{
  for(const value of ['Honorary','Former','Department contact','CPD Guest'])
    assert.equal(planRoles([member],[{member_id:'m',value}],roles,'member')[0].action,'unchanged');
});
test('missing, unknown, duplicate values and unresolved roles block',()=>{
  for(const values of [[],[{member_id:'m',value:'full'}],[{member_id:'m',value:'Full'},{member_id:'m',value:'Full'}]])
    assert.equal(planRoles([member],values,roles,'member')[0].action,'blocked');
  for(const definitions of [roles.slice(0,1),[...roles,roles[1]],[roles[0],{...roles[1],tenant_id:'foreign'}],[roles[0],{...roles[1],excluded_features:[]}]])
    assert.equal(planRoles([member],[{member_id:'m',value:'Full'}],definitions,'member')[0].action,'blocked');
});
test('privilege, capacity, effective dates and secondary-only states require review',()=>{
  for(const change of [{is_admin:true},{is_tenant_admin:true},{max_members:1},{requires_effective_from_date:true}])
    assert.ok(roleBlockers({...roles[1],...change}).length);
  assert.equal(planRoles([{...member,role_id:'other'}],[{member_id:'m',value:'Full'}],roles,'member')[0].action,'blocked');
});
test('no apply mode or arbitrary arguments',async()=>{
  await assert.rejects(main(['--apply']),/not supported/);
  await assert.rejects(main(['--tenant=other']),/not supported/);
});