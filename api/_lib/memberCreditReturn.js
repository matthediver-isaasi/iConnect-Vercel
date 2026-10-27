// Provider cash-refund authority belongs to the caller. This separately proves
// restoration of the credit liability before the local owner receives value.
export async function returnBackedMemberCredit(db,input,{finance}={}){
 const args={p_tenant_id:input.tenantId,p_allocation_id:input.allocationId,
  p_refund_key:input.refundKey,p_cumulative_minor:input.cumulativeMinor};
 const response=await db.rpc('member_credit_return_context',args);
 if(['PGRST202','42883'].includes(response.error?.code)){
  const proofs=await db.rpc('member_credit_funding_proofs',{
   p_tenant_id:input.tenantId,p_allocation_ids:[input.allocationId],
  });
  if(!proofs.error&&Array.isArray(proofs.data)&&!proofs.data.length)return {applicable:false};
  if(['PGRST202','42883'].includes(proofs.error?.code)){
   const existing=await db.from('voucher').select('id').eq('tenant_id',input.tenantId)
    .eq('funding_source','membership_change').limit(1);
   if(!existing.error&&Array.isArray(existing.data)&&!existing.data.length)return {applicable:false};
  }
 }
 if(response.error||typeof response.data?.applicable!=='boolean')
  throw new Error('Member-credit return accounting context is unavailable.');
 const context=response.data;
 if(!context.applicable)return context;
 if(context.alreadyApplied)return {applicable:true,result:context.result};
 if(context.amendment?.tenant_id!==input.tenantId||context.settlement?.tenant_id!==input.tenantId)
  throw new Error('Member-credit return ownership could not be verified.');
 if(!finance){
  const {getAccountingProviderByName}=await import('./accountingProvider.js');
  finance=(await import('./memberAmendmentFinance.js')).createMemberAmendmentFinance({
   providerForTenant:async()=>getAccountingProviderByName('xero'),
  });
 }
 const backing=await finance.inspect(context.amendment,context.settlement);
 if(backing.state!=='settled'||backing.evidence?.kind!=='member_credit_backed'
  ||backing.evidence.liabilityAccountId!==context.binding?.accountId)
  throw new Error('Original member-credit backing needs financial review.');
 const evidence=await finance.verifyCreditReturn(input.tenantId,context.binding,context.entries,context.expectedActiveMinor);
 if(evidence?.verified!==true||evidence.activeMinor!==context.expectedActiveMinor)
  throw new Error('Member-credit liability restoration was not verified.');
 const result=await db.rpc('apply_verified_member_credit_return',{
  ...args,p_verified_active_minor:evidence.activeMinor,p_reversal_options:input.reversalOptions||{},
 });
 if(result.error||!result.data)throw new Error('Credit return needs recovery; recheck accounting before retrying.');
 return {applicable:true,result:result.data};
}
