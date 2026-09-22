import test from 'node:test';
import assert from 'node:assert/strict';
import { attestedManifest } from './prepare-bnms-attested-current.mjs';
import { validateManifest } from './bnms-non-dd-apply.mjs';
import { TENANT } from './audit-bnms-non-dd-pilot.mjs';

function fixture(){
  const candidate={id:'11111111-1111-4111-8111-111111111111',category:'requires_term_and_invoice_review',
    expiry:'2026-09-29',preferences:{ym_membership_type:'Full Membership UK',ym_date_membership_expires:'29/09/2026'}};
  const sourceHash='a'.repeat(64);
  return {snapshot:{sourceHash,candidates:[candidate]},
    report:{writes:0,selected:1,manifest:{sourceHash,tenantId:TENANT,asOf:'2026-09-22',rows:[]},
      reviews:[{memberId:candidate.id,state:'invoice_term_unconfirmed'}]}};
}
test('attested current records never invent amounts, invoices or commencement',()=>{
  const {snapshot,report}=fixture();
  const row=attestedManifest(snapshot,report).rows[0];
  assert.equal(row.payment_status,'paid');
  assert.equal(row.membership_year,'2025/2026');
  for(const key of ['final_cost','total_with_vat','xero_invoice_id','accounting_invoice_id','term_start_date','config_id'])assert.equal(row[key],null);
  assert.equal(JSON.parse(row.notes).invoiceAuthority,'unresolved_not_linked');
});
test('partial reviews, failed lookups, source drift and future expiries cannot establish membership',()=>{
  for(const change of [
    f=>f.report.selected=2,
    f=>f.report.reviews[0].state='provider_error',
    f=>f.report.manifest.sourceHash='b'.repeat(64),
    f=>f.snapshot.candidates[0].expiry='2027-01-01',
    f=>f.snapshot.candidates[0].category='direct_debit_excluded',
  ]){
    const f=fixture();change(f);assert.throws(()=>attestedManifest(f.snapshot,f.report));
  }
});
test('unlinked historical price and forged paid provenance fail validation',()=>{
  const f=fixture(),manifest=attestedManifest(f.snapshot,f.report);
  manifest.rows[0].final_cost=0;manifest.rows[0].total_with_vat=0;
  assert.throws(()=>validateManifest(manifest),/attestation/);
});