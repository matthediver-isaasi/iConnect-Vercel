import test from 'node:test';
import assert from 'node:assert/strict';
import { planMember,TENANT,FIELD,SUCCESSOR,stableId } from './reconstruct-bnms-student-terms.mjs';
const member={id:'00000000-0000-4000-8000-000000000001',first_name:'Example',last_name:'Student',
  email:'student@example.invalid',created_on:'2024-09-01T00:00:00Z'};
const field={id:FIELD,tenant_id:TENANT,entity_scope:'member',field_type:'date',is_active:true};
const config={id:SUCCESSOR,name:'2026-2027 Student',currency:'GBP',billing_period:'annual',renewal_grace_days:90};
const prefs=[{member_id:member.id,field_id:FIELD,value:'2028-06-30'}];
const plan=(m=member,h=[],p=prefs)=>planMember(m,h,p,field,config,'2026-11-11');
test('uses saved dates inclusively, zero price and saved renewal policy',()=>{
  const p=plan();assert.equal(p.outcome,'create');
  assert.equal(p.record.term_start_date,'2024-09-01');assert.equal(p.record.term_end_date,'2028-06-30');
  assert.equal(p.record.membership_renewal_date,'2028-07-01');assert.equal(p.record.final_cost,0);
  assert.deepEqual(p.record.renewal_policy_snapshot,config);assert.equal(p.record.term_duration_months,null);
  assert.equal(p.record.id,plan().record.id);
});
test('missing dates are held, not inferred',()=>{
  assert.equal(plan({...member,created_on:null}).reason,'Member since date missing');
  assert.equal(plan(member,[],[]).reason,'Course end date missing');
});
test('invalid and reversed end dates are held',()=>{
  for(const value of ['2024-02-30','2023-01-01','06/30/2028']){
    assert.equal(plan(member,[],[{...prefs[0],value}]).outcome,'held');
  }
});
test('deleted, paused and cancelled records are not reconstructed',()=>{
  assert.equal(plan({...member,email:'deleted_example@example.invalid'}).outcome,'excluded');
  for(const key of ['membership_paused','membership_cancelled'])assert.equal(plan({...member,[key]:true}).outcome,'held');
});
test('issued terms are preserved even when dates are available',()=>{
  assert.equal(plan(member,[{member_id:member.id,term_key:'rolling:2026-01-01'}]).outcome,'held');
});
test('only uncommitted known legacy evidence may be repaired',()=>{
  const old={id:stableId('history'),member_id:member.id,payment_status:'paid',
    notes:JSON.stringify({source:'bnms_non_dd_current_backfill'}),final_cost:null};
  const p=plan(member,[old]);assert.equal(p.outcome,'repair');assert.equal(p.record.id,old.id);
  assert.deepEqual(JSON.parse(p.record.notes).originalHistory,old);
  assert.equal(plan(member,[{...old,final_cost:0}]).outcome,'held');
  assert.equal(plan(member,[old,old]).outcome,'held');
});
test('past course-end stays expired rather than gaining a fresh year',()=>{
  const p=plan(member,[],[{...prefs[0],value:'2026-06-30'}]);
  assert.equal(p.record.status,'expired');assert.equal(p.record.membership_renewal_date,'2026-07-01');
});
