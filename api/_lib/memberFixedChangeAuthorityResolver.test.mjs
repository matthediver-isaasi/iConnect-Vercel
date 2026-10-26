import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveMemberFixedChangeAuthority} from './memberFixedChangeAuthorityResolver.js';
import {readMemberFixedMonthlyFunding} from './memberFixedMonthlyFunding.js';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('fixed monthly authority uses verified receipt accounting and quotes only the retained future obligation',async()=>{
 const amounts={final_cost:120,vat_amount:0,total_with_vat:120};
 const context={tenantId:id(1),memberId:id(2),actorId:id(9),actorKind:'admin'};
 const source={id:id(3),tenant_id:id(1),member_id:id(2),config_id:id(4),...amounts,
   commitment_snapshot:{payment_frequency:'monthly',amounts},term_start_date:'2024-01-01',membership_renewal_date:'2025-01-01'};
 const target={id:id(5),tenant_id:id(1),structure_scope_type:'member',billing_period:'annual',
   start_mode:'immediate',effective_from:'2024-01-01',is_active:true,currency:'GBP',
   pricing_model:'flat',flat_cost:240,flat_vat_rate:'NONE'};
 const dates=Array.from({length:12},(_,i)=>`2024-${String(i+1).padStart(2,'0')}-02`);
 const base={tenantId:id(1),memberId:id(2),effectiveDate:'2024-07-02',amendmentId:'preview',
   purchase:source,agreement:{id:id(6),metadata:{card:{plan_total:120,monthly_amount_minor:1000}}},
   plan:{id:id(7)},authority:{pricingBasis:'annual_instalments',provider:'stripe',currency:'GBP',collectionDates:dates}};
 const funding={sourceRecordId:source.id,planId:base.plan.id,agreementId:base.agreement.id,currency:'GBP',provider:'stripe',
   pendingGrossMinor:0,settledGrossMinor:6000,payments:dates.slice(0,6).map((date,i)=>({id:`p${i}`,date,amountMinor:1000,settled:true}))};
 const rows=funding.payments.map(p=>({external_payment_id:p.id,provider:'stripe',billing_agreement_id:id(6),
   accounting_provider:'xero',accounting_invoice_id:`inv${p.id}`,amount_minor:1000,currency:'GBP'}));
 const data={membership_tier_config:[{id:id(4),tenant_id:id(1),start_mode:'immediate',membership_change_behaviour:'retain_term'},target],
   membership_tier_discount:[],membership_tier_vat_override:[],membership_change_policy:[],
   system_settings:[{setting_value:JSON.stringify({rates:[{taxType:'NONE',effectiveRate:0}]})}],membership_instalment_invoices:rows};
 const db={from(table){let selected=data[table]||[];return {
   select(){return this},eq(k,v){selected=selected.filter(r=>r[k]===undefined||r[k]===v);return this},order(){return this},
   async maybeSingle(){return {data:selected[0]||null}},async limit(n){return {data:selected.slice(0,n)}},
   async range(a,b){return {data:selected.slice(a,b+1)}}};}};
 const proof=await readMemberFixedMonthlyFunding({db,input:base,funding,
   readInvoice:async(_,invoiceId)=>({InvoiceID:invoiceId,Type:'ACCREC',Status:'PAID',CurrencyCode:'GBP',
     Contact:{ContactID:'contact'},LineItems:[{}],SubTotal:10,TotalTax:0,Total:10})});
 let providerTarget;
 const purchases={async reconcileFunding(request){providerTarget=request.target;
   return {...proof,input:base,prepared:{funding,quote:{amountMinor:2000,collectionDates:dates.slice(6)}}};}};
 const selection={configId:target.id,effectiveDate:'2024-07-02',reason:'Approved upgrade'};
 const result=await resolveMemberFixedChangeAuthority({db,purchases,context,selection,base});
 assert.equal(providerTarget.termTotalMinor,18000);
 assert.equal(providerTarget.createInlinePrice,true);
 assert.equal(result.calculation.futureObligationMinor,12000);
 assert.equal(result.calculation.finance.available.grossMinor,0);
 assert.equal(result.monthlyExecution.providerFunding.settledGrossMinor,6000);
 funding.settledGrossMinor=7000;
 await assert.rejects(resolveMemberFixedChangeAuthority({db,purchases,context,selection,base}),/received cash changed/);
});
