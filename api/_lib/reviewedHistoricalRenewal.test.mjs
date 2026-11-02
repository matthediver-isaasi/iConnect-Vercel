import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewedHistoricalRenewalConfig as configFor } from './reviewedHistoricalRenewal.js';
import { canvasRenewalEligibility } from './canvasRenewalEligibility.js';
import { assessFormMembershipRenewalEvidence } from './formMembershipRenewalEvidence.js';
import { paymentReportGrace } from './membershipPaymentReportGrace.js';

function fixture() {
  const config = { id:'retired', tenant_id:'tenant', name:'Retired', structure_scope_type:'member',
    structure_field_id:'class',structure_match_value:'Retired',start_mode:'immediate',billing_period:'annual',
    renewal_open_days:90,renewal_grace_days:90 };
  const history={id:'history',tenant_id:'tenant',member_id:'member',membership_source:'personal',
    status:'expired',payment_status:'paid',payment_method:'direct_debit',billing_period:'annual',
    term_start_date:'2025-10-01',term_end_date:'2026-09-30',total_with_vat:156.48,
    tier_label:'Full with NMC',currency:'GBP',renewal_policy_snapshot:{...config,
      historical_settlement_renewal:{version:1,history_id:'history',member_id:'member',tenant_id:'tenant',
        approved_at:'2026-11-02',provider_verified_at:'2026-11-02',mandate_id:'old-mandate',
        mandate_status:'cancelled',start:'2025-10-01',end:'2026-09-30',cash_minor:9128,credit_minor:6520,currency:'GBP'}}};
  return {history,config};
}
test('reviewed historical instalments renew independently without rewriting old method or class',async()=>{
  const {history,config}=fixture(),before=structuredClone(history);
  assert.equal(configFor(history).id,'retired');
  const portal=canvasRenewalEligibility({record:history,history:[history],config,today:'2026-11-02'});
  assert.equal(portal.eligible,true);
  assert.equal(portal.graceEndDate,'2026-12-29');
  const form=assessFormMembershipRenewalEvidence({tenantId:'tenant',memberId:'member',
    histories:[history],agreements:[],successorConfig:config,now:new Date('2026-11-02')});
  assert.equal(form.eligible,true);
  assert.equal(form.successorStart,'2026-10-01');
  assert.equal(form.successorEnd,'2027-09-30');
  const warning=await paymentReportGrace(null,{row:{historyId:'history',memberId:'member',currentExpiryDate:'2026-09-30'},
    history:[history],configs:[],tenantId:'tenant',today:'2026-11-02'});
  assert.equal(warning.graceEndDate,'2026-12-29');
  assert.deepEqual(history,before);
});
for(const [name,change] of [
  ['unreviewed DD',h=>{delete h.renewal_policy_snapshot;}],
  ['live agreement',h=>{h.billing_agreement_id='active';}],
  ['another member',h=>{h.member_id='other';}],
  ['another tenant',h=>{h.tenant_id='other';}],
  ['changed amount',h=>{h.total_with_vat=200;}],
  ['changed expiry',h=>{h.term_end_date='2026-10-01';}],
  ['unpaid',h=>{h.payment_status='unpaid';}],
  ['uncancelled mandate',h=>{h.renewal_policy_snapshot.historical_settlement_renewal.mandate_status='active';}],
  ['missing verification',h=>{delete h.renewal_policy_snapshot.historical_settlement_renewal.provider_verified_at;}],
  ['negative credit',h=>{h.renewal_policy_snapshot.historical_settlement_renewal.credit_minor=-1;}],
  ['organisation record',h=>{h.organization_id='org';}],
])test(`does not authorize ${name}`,()=>{
  const {history}=fixture();change(history);assert.equal(configFor(history),null);
});
test('normal grace boundary and duplicate-successor protections remain in force',()=>{
  const {history,config}=fixture();
  assert.equal(canvasRenewalEligibility({record:history,history:[history],config,today:'2026-12-29'}).eligible,true);
  assert.equal(canvasRenewalEligibility({record:history,history:[history],config,today:'2026-12-30'}).eligible,false);
  assert.equal(canvasRenewalEligibility({record:history,config,today:'2026-11-02',
    history:[history,{...history,id:'pending',status:'pending',payment_status:'unpaid',term_start_date:'2026-10-01'}]}).eligible,false);
});
