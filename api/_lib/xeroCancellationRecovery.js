import { createXeroCreditNote, getValidXeroAccessToken } from './xero.js';

export async function executeCancellationCredit(db, row, {
  loadToken=getValidXeroAccessToken, fetcher=globalThis.fetch, create=createXeroCreditNote,
}={}) {
  let wrote=false;
  const token=await loadToken(row.tenant_id);
  if(token.tenantId!==row.company_id)throw new Error('Accounting connection changed; review required');
  const {data:binding,error}=await db.from('accounting_request_binding').select('cooldown_until')
    .eq('provider','xero').eq('company_id',token.tenantId).maybeSingle();
  if(error)throw new Error('Accounting cooldown could not be checked');
  const remaining=(new Date(binding?.cooldown_until)-Date.now())/1000;
  if(remaining>0)throw Object.assign(new Error('Xero rate limit: retry queued'),{safeRetry:true,retryAfter:Math.ceil(remaining)});
  const deadline=Date.now()+40000;
  const transport=async(url,options={})=>{
    const writing=!['GET','HEAD'].includes(options.method||'GET');
    if(Date.now()>deadline)throw Object.assign(new Error('Accounting operation time budget exhausted'),{safeRetry:!wrote});
    let response;
    try {
      response=await fetcher(url,{...options,signal:AbortSignal.timeout(12000)});
    }catch(error){
      throw Object.assign(new Error(writing||wrote?'Xero outcome uncertain; review required':'Xero unavailable; retry queued'),{safeRetry:!writing&&!wrote});
    }
    if(response.status===429){
      const header=response.headers.get('retry-after');
      const delay=Math.max(60,Number(header)||Math.ceil((Date.parse(header)-Date.now())/1000)||300);
      const until=new Date(Date.now()+delay*1000).toISOString();
      const {error:cooldownError}=await db.from('accounting_request_binding')
        .update({cooldown_until:until}).eq('provider','xero').eq('company_id',token.tenantId).lt('cooldown_until',until);
      if(cooldownError)throw new Error('Could not retain Xero cooldown; review required');
      throw Object.assign(new Error('Xero rate limit: retry queued'),{safeRetry:!wrote,retryAfter:delay});
    }
    if(writing)wrote=true;
    if(response.status>=500)throw Object.assign(new Error('Xero temporarily unavailable'),{safeRetry:!wrote});
    return response;
  };
  return create({
    appTenantId:row.tenant_id,invoiceId:row.invoice_id,creditAmount:Number(row.amount),
    description:row.description,reference:row.reference,recoveryKey:`cancellation-credit-${row.id}`,
  },{fetcher:transport,loadToken:async()=>token});
}
