import test from 'node:test';
import assert from 'node:assert/strict';
import { lifecyclePrivacyPlan } from './memberLifecyclePrivacyPlan.js';
const fields = [
  {name:'id',hasValue:true},{name:'email',hasValue:true},{name:'legal_reference',hasValue:true},
  {name:'first_name',hasValue:true},{name:'optional_empty',hasValue:false},
];
test('minimisation removes known profile data and requires explicit unknown-field policy',()=>{
  const plan=lifecyclePrivacyPlan(fields);
  assert.deepEqual(plan.fieldsRemoved,['email','first_name']);
  assert.deepEqual(plan.blockers,['retention_decision_required:legal_reference']);
  const reviewed=lifecyclePrivacyPlan(fields,{legal_reference:{disposition:'retain',reason:'Applicable documented retention obligation'}});
  assert.equal(reviewed.blockers.length,0);
  assert.equal(reviewed.fieldsRetained[1].field,'legal_reference');
});
test('protected keys, unsupported fields and undocumented retention cannot be smuggled into a plan',()=>{
  for(const decisions of [{id:{disposition:'remove',reason:'try'}},{invented:{disposition:'retain',reason:'test'}},
    {email:{disposition:'retain',reason:''}}]) assert.throws(()=>lifecyclePrivacyPlan(fields,decisions));
});
