// A reconnection never changes purchased terms or the frozen queue authority.
// Approval is per request; browser/app roles cannot create approvals.
export async function authorizeAccountingReconnect({db,row,binding}) {
  const deny=()=>{
    throw Object.assign(new Error('ACCOUNTING_QUEUE_BINDING_CHANGED'),
      {code:'ACCOUNTING_QUEUE_BINDING_CHANGED',permanent:true,definitelyNotWritten:true});
  };
  if(binding.tenantId!==row.tenant_id || binding.provider!==row.provider
    || binding.companyId!==row.company_id)deny();
  if(binding.connectionId===row.connection_id)return binding;
  if(row.provider!=='xero'||!row.id)deny();
  const {data,error}=await db.from('accounting_reconnect_approval').select('request_id')
    .eq('request_id',row.id).eq('tenant_id',row.tenant_id).eq('provider',row.provider)
    .eq('company_id',row.company_id).eq('previous_connection_id',row.connection_id)
    .eq('new_connection_id',binding.connectionId).is('revoked_at',null).maybeSingle();
  if(error||!data)deny();
  return {...binding,connectionId:row.connection_id};
}
