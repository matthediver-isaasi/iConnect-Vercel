export async function verifyMemberCreditRedemption(db,tenantId,allocations,provider,options={}){
 const ids=[...new Set((allocations||[]).map(a=>a.id))];
 if(!ids.length)return;
 const {data,error}=await db.rpc('member_credit_funding_proofs',{p_tenant_id:tenantId,p_allocation_ids:ids});
 // During code-before-schema rollout, legacy voucher payments may continue
 // only after establishing that this tenant has no generated membership credit.
 // A missing proof function must never bypass protection for existing credit.
 if(['PGRST202','42883'].includes(error?.code)){
  const existing=await db.from('voucher').select('id').eq('tenant_id',tenantId)
   .eq('funding_source','membership_change').limit(1);
  if(!existing.error&&Array.isArray(existing.data)&&existing.data.length===0)return;
 }
 if(error||!Array.isArray(data))throw new Error('Membership credit accounting proof could not be loaded; no funding payment was posted.');
 if(!data.length)return;
 const setting=await db.from('system_settings').select('setting_value')
  .eq('tenant_id',tenantId).eq('setting_key','xero_voucher_clearing_account_code').maybeSingle();
 if(setting.error||!setting.data?.setting_value)throw new Error('Membership credit liability mapping is unavailable.');
 const providerName=options.providerName||provider.name;
 if(providerName!=='xero')throw new Error('Membership credit cannot move to another accounting provider.');
 const concrete=provider.name?provider:provider.getAccountingProviderByName('xero');
 const finance=options.finance||(await import('./memberAmendmentFinance.js')).createMemberAmendmentFinance({
  providerForTenant:async()=>concrete,
 });
 for(const proof of data){
  if(!proof.allocationId)throw new Error('Member credit redemption evidence migration is required before funding.');
  if(proof.amendment?.tenant_id!==tenantId||proof.settlement?.tenant_id!==tenantId
    ||proof.binding?.accountCode!==setting.data.setting_value){
    throw new Error('Membership credit must redeem against its original accounting liability.');
  }
  const evidence=await finance.inspect(proof.amendment,proof.settlement);
  if(evidence.state!=='settled'||evidence.evidence?.kind!=='member_credit_backed'
    ||evidence.evidence.liabilityAccountId!==proof.binding.accountId){
    throw new Error('Membership credit backing has changed; finance review is required.');
  }
 }
 return data;
}
