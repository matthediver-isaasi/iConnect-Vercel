export async function claimMemberCreditFunding(db,{tenantId,allocation,proofs,invoiceId,reference}){
 const proof=proofs?.find(p=>p.allocationId===allocation.id);
 if(!proof)return;
 const context={provider:'xero',providerTenantId:proof.binding.providerTenantId,accountId:proof.binding.accountId,
  invoiceId,reference,amountMinor:allocation.amountMinor};
 const claimed=await db.rpc('claim_member_credit_funding',{
  p_tenant_id:tenantId,p_allocation_id:allocation.id,p_context:context,
 });
 if(claimed.error||!claimed.data?.context)
  throw new Error('Member-credit funding could not be claimed; no accounting payment was posted.');
 for(const key of Object.keys(context)){
  if(claimed.data.context[key]!==context[key])throw new Error('Frozen member-credit funding context differs.');
 }
 if(typeof claimed.data.existing!=='boolean')throw new Error('Funding claim outcome is uncertain; reconcile before continuing.');
 if(Number(claimed.data.retryAfter)>0)throw throttleError(Number(claimed.data.retryAfter));
 return {existing:claimed.data.existing,proof,context,attempt:claimed.data.attempt||'initial'};
}

function throttleError(seconds){
 return Object.assign(new Error(`Accounting rate limit; retry after ${seconds} seconds. No additional funding payment was authorised.`),
  {status:429,retry:true,retryAfter:seconds});
}

export async function postMemberCreditFunding({db,tenantId,allocation,claim,post}){
 if(!claim)return post(undefined);
 const observer={state:'not_sent'};
 let result,error;
 try{result=await post(observer);}catch(e){error=e;}
 // A pre-payment throttle or the payment POST's documented 429 rejection
 // permits retry. A later GET throttle or uncertain POST never resets a claim.
 if(observer.state==='rate_limited'||(observer.state==='not_sent'&&error?.status===429)){
  const seconds=Math.min(86400,Math.max(1,Math.ceil(Number(observer.retryAfter||error?.retryAfter)||60)));
  const saved=await db.rpc('record_member_credit_funding_throttle',{
   p_tenant_id:tenantId,p_allocation_id:allocation.id,p_reference:claim.context.reference,
   p_attempt:claim.attempt,p_delay_seconds:seconds,
  });
  if(saved.error||!saved.data)throw new Error('Funding throttle evidence needs reconciliation; no repeat payment is authorised.');
  throw throttleError(seconds);
 }
 if(error)throw error;
 return result;
}

export async function recoverMemberCreditFunding({tenantId,claim,provider}){
 const concrete=provider.name?provider:await provider.getAccountingProviderByName('xero');
 const finance=(await import('./memberAmendmentFinance.js')).createMemberAmendmentFinance({
  providerForTenant:async()=>concrete,
 });
 return finance.findCreditFundingPayment(tenantId,claim.proof.binding,claim.context);
}

export async function recordMemberCreditRedemption(db,{tenantId,allocation,proofs,invoiceId,reference,result,provider,verifyPayment}){
 const proof=proofs?.find(p=>p.allocationId===allocation.id);
 if(!proof)return;
 if(!result?.payment_recorded||!result.payment_id)throw new Error('Verified accounting payment identity is required for member credit.');
 const evidence={invoiceId,reference,paymentId:result.payment_id,amountMinor:allocation.amountMinor};
 if(!verifyPayment){
  const concrete=provider.name?provider:await provider.getAccountingProviderByName('xero');
  const finance=(await import('./memberAmendmentFinance.js')).createMemberAmendmentFinance({
   providerForTenant:async()=>concrete,
  });
  verifyPayment=(...args)=>finance.verifyCreditFundingPayment(...args);
 }
 const verified=await verifyPayment(tenantId,proof.binding,evidence);
 if(verified?.verified!==true||verified.activeMinor!==allocation.amountMinor)
  throw new Error('Member-credit funding payment was not independently verified.');
 const saved=await db.rpc('record_member_credit_redemption',{
  p_tenant_id:tenantId,p_allocation_id:allocation.id,p_evidence:{
   provider:'xero',providerTenantId:proof.binding.providerTenantId,accountId:proof.binding.accountId,
   ...evidence,
  },
 });
 if(saved.error||!saved.data)throw new Error('Funding payment was posted but its member-credit evidence needs recovery; retry the original accounting operation.');
}
