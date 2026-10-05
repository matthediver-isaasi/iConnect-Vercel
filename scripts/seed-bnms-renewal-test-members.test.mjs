import test from 'node:test';
import assert from 'node:assert/strict';
import {buildManifest, fixtureId, hash, safetySignature, TENANT, CLASSES} from './seed-bnms-renewal-test-members.mjs';
import {classifyAnnualRenewal} from '../api/_lib/annualRenewalPolicy.js';
import {assessFormMembershipRenewalEvidence} from '../api/_lib/formMembershipRenewalEvidence.js';

const configs = () => CLASSES.map((value,i) => ({
  id:fixtureId(`test-config:${value}`), tenant_id:TENANT, name:value, structure_match_value:value,
  structure_field_id:'87f120ff-92e6-4d52-944b-9ba9d7b1fac0', structure_scope_type:'member',
  start_mode:'immediate', billing_period:'annual', pricing_model:'flat', flat_cost:[156,128,61,0,71][i],
  flat_vat_rate:null, currency:'GBP', is_active:true, renewal_open_days:90, renewal_grace_days:90,
  effective_from:'2026-09-01', effective_to:null,
}));
test('exactly five deterministic synthetic identities and complete distinct annual commitments', () => {
  const plan=buildManifest(configs(),'2026-10-05');
  assert.equal(hash(plan),hash(buildManifest(configs(),'2026-10-05')));
  assert.equal(plan.fixtures.length,5);
  assert.equal(new Set(plan.fixtures.map(f=>f.member.id)).size,5);
  assert.equal(new Set(plan.fixtures.map(f=>f.member.email)).size,5);
  for(const f of plan.fixtures) {
    assert.match(f.member.first_name,/^TEST_/);assert.match(f.member.last_name,/^TEST_/);
    assert.match(f.member.email,/@example\.invalid$/);
    assert.equal(f.member.login_enabled,false);assert.equal(f.member.role_id,null);
    assert.equal(f.history.paid_at,null);assert.equal(f.history.previous_term_id,null);
    assert.match(f.history.notes,/NO provider settlement/);
    assert.equal(f.history.total_with_vat,f.history.commitment_snapshot.amounts.total_with_vat);
    assert.equal(f.history.tier_label,'Flat Rate');
    assert.equal(classifyAnnualRenewal({previousRecord:f.history,config:f.history.commitment_snapshot.config,
      now:new Date(plan.asOf)}).state,'open');
    assert.equal(assessFormMembershipRenewalEvidence({tenantId:TENANT,memberId:f.member.id,histories:[f.history],
      agreements:[],successorConfig:f.history.commitment_snapshot.config,now:new Date(plan.asOf)}).state,'eligible_renewal');
    const days=(Date.parse(f.history.membership_renewal_date)-Date.parse(plan.asOf))/86400000;
    assert.ok(days>=1 && days<=60);
    assert.equal(Date.parse(f.history.membership_renewal_date)-Date.parse(f.history.term_end_date),86400000);
  }
});
test('reject stale execution date, ambiguous or changed price/scope/selectors', () => {
  assert.throws(()=>buildManifest(configs(),'2026-10-06'));
  const duplicate=configs();duplicate.push(duplicate[0]);assert.throws(()=>buildManifest(duplicate,'2026-10-05'));
  for(const [key,value] of [['flat_cost',1],['flat_vat_rate','VAT'],['tenant_id','other'],
    ['structure_field_id','invented'],['billing_period','monthly'],['start_mode','fixed_date']]) {
    const changed=configs();changed[0][key]=value;
    assert.throws(()=>buildManifest(changed,'2026-10-05'));
  }
});
test('safety evidence is insensitive to database row order but detects policy changes', () => {
  const one={groups:[{filters:[{value:'A'}]},{filters:[{value:'B'}]}],guards:[{name:'guard'}]};
  const two={...one,groups:[...one.groups].reverse()};
  assert.equal(safetySignature(one),safetySignature(two));
  two.groups[0]={filters:[{value:'C'}]};
  assert.notEqual(safetySignature(one),safetySignature(two));
});
