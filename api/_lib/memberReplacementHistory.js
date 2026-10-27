import {randomUUID} from 'node:crypto';
import {buildRollingCommitment} from './rollingMembershipCommitment.js';

export function buildMemberReplacementHistory({execution,authority,settlement}){
 const p=execution.plan,c=authority.calculation,e=settlement.evidence;
 if(settlement.state!=='settled'||e?.verified!==true||e.kind!=='replacement_settled'
  ||e.currency!==p.currency||e.amount?.grossMinor!==p.targetFullPrice.grossMinor){
  throw new Error('Verified complete replacement settlement is required.');
 }
 const amounts={annual_cost:p.targetFullPrice.netMinor/100,final_cost:p.targetFullPrice.netMinor/100,
  vat_amount:p.targetFullPrice.vatMinor/100,total_with_vat:p.targetFullPrice.grossMinor/100,currency:p.currency};
 const term=buildRollingCommitment({config:authority.targetSnapshot,startDate:c.newTerm.startDate,
  paymentMethod:'invoice',paymentFrequency:'upfront',amounts,pricingSnapshot:authority.pricingSnapshot});
 if(term.membership_renewal_date!==c.newTerm.renewalDate)throw new Error('Replacement dates differ from the confirmed term.');
 return {id:randomUUID(),tenant_id:execution.tenant_id,member_id:execution.member_id,
  config_id:authority.targetSnapshot.id,band_id:authority.targetBandSnapshot?.id||null,
  // previous_term_id means an adjacent renewal in the rolling-term contract.
  // Replacement lineage belongs in the protected application, not that field.
  ...amounts,...term,previous_term_id:null,
  billing_period:'annual',billing_agreement_id:null,payment_method:'invoice',status:'active',payment_status:'paid',
  accounting_provider:'xero',accounting_invoice_id:e.invoiceId,accounting_invoice_number:e.invoiceNumber||null};
}
