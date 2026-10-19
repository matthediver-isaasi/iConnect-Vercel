import test from 'node:test';
import assert from 'node:assert/strict';
import {assess,TENANT} from './bnms-2027-expiry-gap-core.mjs';
import {shapeLegacyCurrentMembership} from '../api/membership/member-membership.js';
import {projectNmcReport, NMC_FIELDS} from '../api/_lib/nmcMembershipReport.js';
const source={id:'09497721-3f4b-482b-916b-b877dbff3d5b',history_count:0,dd_evidence:false,duplicate_fields:false,
  preferences:{membership_status:'Active',ym_membership_type:'Full Membership UK',member_class:'Full',
    ym_web_site_member_id:'test',ym_date_membership_expires:'29/04/2027'}};
const member={status:'active',membership_paused:false,is_guest:false};
const invoice={id:'invoice-fixture',status:'paid',invoice_date:'2026-04-30',description:'Full Membership UK'};
const configs=[{name:'Full member',structure_match_value:'Full',is_active:true,effective_from:'2020-01-01'}];
const make=(s=source,m=member,ii=[invoice],cc=configs,conflict=false)=>assess(s,m,ii,cc,conflict);
test('2027 correction is current without invented dates, amounts or accounting links',()=>{
  const {record}=make();assert.ok(record);
  const display=shapeLegacyCurrentMembership({...record,membership_source:'personal'},TENANT,new Date('2026-10-19'));
  assert.equal(display.endDate,'2027-04-29');assert.equal(display.startDate,null);
  assert.equal(display.paidAmount,null);assert.equal(display.tierLabel,'Full member');
  assert.equal(display.renewalDate,null);assert.equal(record.accounting_invoice_id,undefined);
});
test('paid bundled membership never copies event cost',()=>{
  const {record}=make(source,member,[{...invoice,amount_minor:'56300',description:"Event including 1 year's full membership"}]);
  assert.equal(record.final_cost,null);assert.equal(record.total_with_vat,null);
});
test('excludes all current financial and access conflicts',()=>{
  for(const change of [{history_count:1},{dd_evidence:true},{duplicate_fields:true}])assert.ok(!make({...source,...change}).record);
  assert.ok(!make(source,{...member,membership_paused:true}).record);
  assert.ok(!make(source,member,[invoice],configs,true).record);
  assert.ok(!make(source,member,[{...invoice,description:'Full Membership DD'}]).record);
});
test('students, former members, missing payment evidence and ambiguous structures stay out',()=>{
  for(const cls of ['Student','Former'])assert.ok(!make({...source,preferences:{...source.preferences,member_class:cls}}).record);
  assert.ok(!make(source,member,[{...invoice,status:'unpaid'}]).record);
  assert.ok(!make(source,member,[invoice],[...configs,...configs]).record);
  assert.ok(!make(source,member,[{...invoice,accounting_payment_status:'unpaid'}]).record);
});
test('2026 legacy contract is not widened and correction provenance is required',()=>{
  const {record}=make(); const r={...record,membership_source:'personal'};
  for(const change of [{tenant_id:'other'},{notes:JSON.stringify({source:'bnms_non_dd_current_backfill'})},
    {final_cost:156},{term_end_date:'2028-04-29'},{payment_status:'pending'},{term_start_date:'2026-04-30'}])
    assert.equal(shapeLegacyCurrentMembership({...r,...change},TENANT,new Date('2026-10-19')),null);
  assert.equal(shapeLegacyCurrentMembership(r,TENANT,new Date('2027-04-30')),null);
});
test('NMC recognises the corrected membership without inventing print entitlement',()=>{
  const {record}=make();
  const fields=NMC_FIELDS.map(name=>({id:name,name,tenant_id:TENANT,entity_scope:'member',is_active:true,
    options:name==='member_class'?[{value:'Full'}]:null}));
  const report=projectNmcReport({reportDate:'2026-10-19',members:[{id:source.id,tenant_id:TENANT}],
    fields,preferences:[{member_id:source.id,field_id:'member_class',value:'Full'}],
    history:[record],organizations:[{id:'primary',tenant_id:TENANT,name:'BNMS',is_primary:true}],agreements:[]});
  assert.equal(report.total,1);assert.deepEqual(report.reviewCounts,{});
  assert.equal(report.rows[0].sheet,'Online-only');
});
