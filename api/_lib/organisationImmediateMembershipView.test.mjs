import test from 'node:test';
import assert from 'node:assert/strict';
import { organisationImmediateMembershipView as view } from './organisationImmediateMembershipView.js';
const config = {start_mode:'immediate',structure_scope_type:'organization',name:'Partner',currency:'GBP'};
const record = {id:'one',membership_year:'2026/2027',status:'active',payment_status:'paid',final_cost:'750.00'};
test('legacy paid organisation record stays visible without manufacturing dates',()=>{
  const before=structuredClone(record);
  const result=view(config,[record],'2026-11-24');
  assert.equal(result.state,'dates_missing');
  assert.equal(result.current.finalCost,'750.00');
  assert.equal(result.current.startDate,null);
  assert.equal(result.current.renewalDate,null);
  assert.deepEqual(record,before);
});
test('saved dates own current and next terms irrespective of calendar labels',()=>{
  const current={...record,term_start_date:'2026-08-04',term_end_date:'2027-08-03',membership_renewal_date:'2027-08-04'};
  const next={...current,id:'next',term_start_date:'2027-08-04',term_end_date:'2028-08-03'};
  const result=view(config,[next,current],'2026-11-24');
  assert.equal(result.state,'current');
  assert.equal(result.current.id,'one');
  assert.equal(result.scheduled.id,'next');
  assert.equal(result.current.renewalDate,'2027-08-04');
});
test('individual and fixed-year organisation memberships stay on their existing path',()=>{
  assert.equal(view({...config,structure_scope_type:'member'},[record]),null);
  assert.equal(view({...config,start_mode:'fixed_date'},[record]),null);
});
test('ambiguous, expired, future and absent records never invent current entitlement',()=>{
  assert.equal(view(config,[record,{...record,id:'other'}]).state,'review_required');
  assert.equal(view(config,[]).state,'not_recorded');
  assert.equal(view(config,[{...record,term_start_date:'2026-01-01',term_end_date:'2026-10-31'}],'2026-11-24').state,'past');
  assert.equal(view(config,[{...record,term_start_date:'2027-01-01',term_end_date:'2027-12-31'}],'2026-11-24').state,'scheduled');
});
