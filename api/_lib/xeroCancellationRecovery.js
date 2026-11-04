import { createXeroCreditNote, getValidXeroAccessToken } from './xero.js';
import { xeroRateLimitedFetch } from './xeroRateLimit.js';

export async function executeCancellationCredit(db, row, {
  loadToken=getValidXeroAccessToken, fetcher=xeroRateLimitedFetch, create=createXeroCreditNote,
}={}) {
  let wrote=false;
  const token=await loadToken(row.tenant_id);
  if(token.tenantId!==row.company_id)throw new Error('Accounting connection changed; review required');
  const deadline=Date.now()+40000;
  const transport=async(url,options={})=>{
    const writing=!['GET','HEAD'].includes(options.method||'GET');
    if(Date.now()>deadline)throw Object.assign(new Error('Accounting operation time budget exhausted'),{safeRetry:!wrote});
    let response;
    try {
      response=await fetcher(url,{...options,signal:AbortSignal.timeout(12000)});
    }catch(error){
      const safeRetry=!wrote && (!writing || error.definitelyNotWritten===true);
      throw Object.assign(new Error(safeRetry?'Xero unavailable; retry queued':'Xero outcome uncertain; review required'),{safeRetry});
    }
    if(response.status===429){
      const header=response.headers.get('retry-after');
      const delay=Math.max(60,Number(header)||Math.ceil((Date.parse(header)-Date.now())/1000)||300);
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
