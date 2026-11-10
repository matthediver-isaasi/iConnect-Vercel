import test from 'node:test';
import assert from 'node:assert/strict';
import { planBnmsEntryForm, TENANT, CONTINUING, PAID_FORMS } from './bnms-membership-entry-plan.mjs';
const classId = '87f120ff-92e6-4d52-944b-9ba9d7b1fac0';
function fixture(id) {
  return { id, tenant_id:TENANT,is_active:true,archived_at:null,require_authentication:true,
    mutation_access_policy:{mode:'authenticated_owner'},due_diligence_required:true,
    fields:[{id:'class',type:'radio',options:['Full','Associate']},{id:'pay',type:'payment',label:'Membership payment'}],
    visibility_rules:[{actions:[{action_type:'membership_structure',resolve_mode:'auto',field_mappings:{[classId]:'class'}}]}],
    entity_pipelines:{members:[{role_id:'existing'}],organisations:[]}};
}
const configs = ['Full','Associate'].map(value=>({id:value,tenant_id:TENANT,is_active:true,
  structure_scope_type:'member',structure_field_id:classId,structure_match_value:value,
  start_mode:'immediate',billing_period:'annual',effective_from:'2026-01-01'}));
test('all paid copies retain questions and approval while selecting saved authenticated schedules',()=>{
  for(const id of PAID_FORMS) {
    const source=fixture(id), before=structuredClone(source);
    const next=planBnmsEntryForm(source,configs,'2026-11-10');
    assert.deepEqual(source,before);
    assert.equal(next.fields[1].type,'membership_payment');
    assert.equal(next.due_diligence_required,true);
    assert.deepEqual(next.entity_pipelines,source.entity_pipelines);
    assert.deepEqual(next.visibility_rules,source.visibility_rules);
    assert.deepEqual(next.fields[0],source.fields[0]);
    assert.deepEqual(next.fields[1].membership_schedule_mapping.entries,
      [{value:'Full',config_id:'Full'},{value:'Associate',config_id:'Associate'}]);
  }
});
test('entry becomes authenticated navigation without a signup role pipeline',()=>{
  const source={...fixture(CONTINUING),fields:[{type:'radio'}]};
  const next=planBnmsEntryForm(source,configs,'2026-11-10');
  assert.equal(next.require_authentication,true);
  assert.deepEqual(next.entity_pipelines.members,[]);
  assert.deepEqual(next.visibility_rules,source.visibility_rules);
});
test('ambiguous, expired, foreign schedules and other forms cannot be proposed',()=>{
  for(const rows of [[],[...configs,configs[0]],configs.map(c=>({...c,tenant_id:'other'})),
    configs.map(c=>({...c,effective_to:'2025-12-31'}))]) {
    assert.throws(()=>planBnmsEntryForm(fixture(PAID_FORMS[0]),rows,'2026-11-10'));
  }
  assert.throws(()=>planBnmsEntryForm(fixture('public-form'),configs,'2026-11-10'));
});
