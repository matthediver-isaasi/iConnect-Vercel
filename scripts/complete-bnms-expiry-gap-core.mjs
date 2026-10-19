import assert from 'node:assert/strict';
import {buildRollingCommitment} from '../api/_lib/rollingMembershipCommitment.js';
import {buildRollingTerm} from '../shared/rollingMembershipTerm.js';
export function completeRecord(before, config, evidence, payment, evidenceHash) {
  assert.equal(JSON.parse(before.notes).source,'bnms_2027_expiry_gap_correction');
  assert.equal(before.term_start_date,null);
  assert.equal(config.structure_match_value,before.field_value);
  assert.equal(config.billing_period,'annual');
  assert.equal(config.start_mode,'immediate');
  assert.equal(config.structure_scope_type,'member');
  assert.equal(before.term_end_date,evidence.term_end_date);
  const term=buildRollingTerm({startDate:evidence.proposedStart,billingPeriod:'annual'});
  assert.equal(term.term_end_date,before.term_end_date);
  const trusted=evidence.emailMatches&&!evidence.explicitAccountConflict&&payment?.verified
    && payment.invoiceId===evidence.invoiceId
    && evidence.xeroStatus==='PAID'&&evidence.currency==='GBP'&&evidence.due===0
    && !evidence.credited;
  const lines=evidence.lines.filter(l=>/\bmembership\b/i.test(l.description||'')
    && !/\bevent|attend|conference|meeting|ticket|party|dinner|discount/i.test(l.description||''));
  const priced=trusted&&lines.length===1&&lines[0].quantity===1&&lines[0].tax===0
    && lines[0].lineAmount>0;
  const amounts=priced?{annual_cost:lines[0].lineAmount,final_cost:lines[0].lineAmount,
    vat_amount:0,total_with_vat:lines[0].lineAmount,currency:'GBP'}:
    {annual_cost:null,final_cost:null,vat_amount:null,total_with_vat:null,currency:'GBP'};
  // Unknown price is NOT a rolling financial commitment. Retain a dated,
  // structure-attributed legacy entitlement without weakening commitment guards.
  const commitment=priced?buildRollingCommitment({config,startDate:evidence.proposedStart,
    paymentMethod:'upfront',paymentFrequency:'upfront',amounts,
    pricingSnapshot:{...amounts,provenance:'verified_xero_membership_line'}}):
    {term_start_date:term.term_start_date,term_end_date:term.term_end_date,
      term_key:null,membership_renewal_date:null,term_duration_months:null,
      term_anchor_date:null,previous_term_id:null,commitment_snapshot:null};
  const patch={...commitment,...amounts,membership_year:priced?commitment.term_key:before.membership_year,
    config_id:config.id,tier_label:before.field_value,
    field_value:before.field_value,renewal_policy_snapshot:null,
    accounting_provider:trusted?'xero':null,accounting_invoice_id:trusted?evidence.invoiceId:null,
    accounting_invoice_number:trusted?evidence.invoice_number:null,
    xero_invoice_id:trusted?evidence.invoiceId:null,xero_invoice_number:trusted?evidence.invoice_number:null,
    paid_at:trusted?new Date(Math.max(...payment.payments.map(p=>{
      const ms=/\/Date\((\d+)/.exec(p.Date)?.[1];assert.ok(ms);return Number(ms);
    }))).toISOString():null,
    notes:JSON.stringify({source:'bnms_expiry_gap_reconstruction',version:1,
      approval:'owner_approved_repair_as_much_as_possible_2026_10_19',evidenceHash,
      previousProvenance:JSON.parse(before.notes),expiryAuthority:'unchanged_imported_expiry',
      termAuthority:'owner_approved_annual_start_derived_from_retained_expiry',
      structureAuthority:'current_member_class_mapping_not_original_purchase_configuration',
      reconstructedStructureName:config.name,
      paymentAuthority:trusted?'xero_authorised_payments':'imported_paid_invoice_identity_unresolved',
      amountAuthority:priced?'verified_membership_line':trusted?'included_package_price_not_allocated':'unresolved_not_inferred',
      paymentIds:trusted?payment.payments.map(p=>p.PaymentID):[],
      futureCollectionConsent:false,renewalPolicyAuthority:false,providerWrites:0})};
  return {patch,priced,linked:!!trusted};
}
