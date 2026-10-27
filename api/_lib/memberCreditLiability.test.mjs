import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyMemberCreditLiability} from './memberCreditLiability.js';
import {createMemberChangeAuthorityResolver} from './memberChangeAuthorityResolver.js';
import {MEMBERSHIP_CHANGE_POLICY_DEFAULTS} from './membershipChangePolicy.js';
function fixture(){
 const account={AccountID:'liability',Code:'850',Type:'CURRENTLIABILITY',Status:'ACTIVE',EnablePaymentsToAccount:true};
 const organisation={BaseCurrency:'GBP'};
 const calls=[];
 const args={providerTenantId:'books',accountCode:'850',currency:'GBP',
   request:async path=>{calls.push(path);return path==='Organisation'?{Organisations:[organisation]}:{Accounts:[account]};}};
 return {account,organisation,args,calls};
}
test('credit readiness pins the same liability account used by voucher redemption without writing',async()=>{
 const f=fixture(),result=await verifyMemberCreditLiability(f.args);
 assert.equal(result.accountId,'liability');
 assert.equal(result.settingKey,'xero_voucher_clearing_account_code');
 assert.equal(result.providerTenantId,'books');
 assert.deepEqual(f.calls,['Accounts?where=Code%3D%3D%22850%22','Organisation']);
});
test('bank, revenue, archived, system and non-payment accounts cannot back member credit',async()=>{
 for(const patch of [{Type:'BANK'},{Type:'REVENUE'},{Status:'ARCHIVED'},{EnablePaymentsToAccount:false},
   {SystemAccount:'ACCOUNTSRECEIVABLE'},{CurrencyCode:'USD'},{Code:'999'}]){
   const f=fixture();Object.assign(f.account,patch);
   await assert.rejects(verifyMemberCreditLiability(f.args),{code:'member_credit_liability_required'});
 }
});
test('missing settings, ambiguous accounts and foreign base currencies fail closed',async()=>{
 const f=fixture();
 await assert.rejects(verifyMemberCreditLiability({...f.args,accountCode:null}),{code:'member_credit_liability_required'});
 assert.equal(f.calls.length,0);
 await assert.rejects(verifyMemberCreditLiability({...f.args,request:async()=>({Accounts:[f.account,f.account]})}),
   {code:'member_credit_liability_required'});
 f.organisation.BaseCurrency='USD';
 await assert.rejects(verifyMemberCreditLiability(f.args),{code:'member_credit_liability_required'});
});

test('surplus preview pins accounting readiness and refuses another accounting organisation',async()=>{
 const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
 const context={tenantId:id(1),memberId:id(2),actorId:id(9),actorKind:'admin'};
 const source={id:id(3),tenant_id:id(1),member_id:id(2),config_id:id(4)};
 const original={netMinor:10000,vatMinor:0,grossMinor:10000};
 const quote={sourceSnapshot:source,targetSnapshot:{config:{id:id(5)},band:null},
   originalFullTerm:original,targetFullTerm:{netMinor:5000,vatMinor:0,grossMinor:5000},
   currency:'GBP',effectiveDate:'2026-07-01',
   term:{startDate:'2026-01-01',renewalDate:'2027-01-01'},
   fundingEvidence:{provider:'xero',providerTenantId:'books',sourceInvoiceId:'invoice',paymentIds:['paid'],paidMinor:10000}};
  let creditExpiryDays=null;
  const db={from(table){return {select(){return this},eq(){return this},async maybeSingle(){
   return {data:table==='membership_tier_config'?{id:id(4),tenant_id:id(1)}:
     table==='system_settings'?{setting_value:'850'}:
      table==='membership_change_policy'?{policy:{...MEMBERSHIP_CHANGE_POLICY_DEFAULTS,surplusHandling:'credit',creditExpiryDays},revision:1}:null};
 }}}};
 let books='books',reads=0;
 const resolve=createMemberChangeAuthorityResolver({db,amendments:{preview:async()=>({canCreate:true,quote})},
   creditLiability:async(tenant,input)=>{
     reads++;assert.equal(tenant,id(1));assert.deepEqual(input,{accountCode:'850',currency:'GBP'});
     return {accountId:'liability',providerTenantId:books};
   }});
 const request={configId:id(5),effectiveDate:'2026-07-01',reason:'Change membership'};
 const authority=await resolve(context,request);
 assert.equal(reads,1);assert.equal(authority.creditLiabilityBinding.accountId,'liability');
  assert.equal(authority.settlement.creditExpiresAt,null);
  assert.equal(authority.settlement.creditExpiryLiabilityTreatment,'manual_review');
  creditExpiryDays=90;
  const expiring=await resolve(context,request);
  assert.equal(expiring.settlement.creditExpiresAt,'2026-09-29T00:00:00.000Z');
  assert.equal(expiring.settlement.creditExpiryLiabilityTreatment,'manual_review');
  assert.equal(expiring.settlement.moneyMoved,false);
  assert.equal(expiring.entitlementApplied,undefined);
  assert.equal(expiring.executionEnabled,false);
 books='other-books';
 await assert.rejects(resolve(context,request),/different accounting organisations/);
});
