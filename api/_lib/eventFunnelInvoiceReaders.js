const unavailable = (status=503) => Object.assign(new Error('The original checkout invoice is not available.'),{status});
const missing = error => ['42883','PGRST202'].includes(error?.code);

export async function readFunnelInvoiceDownload({db,tenantId,groupRef,memberId,isAdmin}) {
  const result=await db.rpc('event_funnel_invoice_download',{
    p_tenant:tenantId,p_group:groupRef,p_member:memberId||null,p_admin:isAdmin===true,
  });
  // Only a genuinely absent staged function permits the unchanged legacy path.
  if(missing(result.error)) return null;
  if(result.error) throw unavailable(result.error.code==='PT403'?403:result.error.code==='PT409'?409:503);
  if(result.data===null) return null;
  if(!result.data?.invoiceId || !['xero','quickbooks'].includes(result.data.provider)
    || !result.data.companyId || !result.data.connectionId) throw unavailable();
  return result.data;
}

export async function addFunnelInvoiceReportStatus(db,tenantId,groups) {
  const entries=groups.flatMap(group=>(group.attendees||[]).map(attendee=>({
    id:attendee.id,source:group.bookingSource,
  })));
  const rows=[];
  for(let offset=0;offset<entries.length;offset+=1000) {
    const result=await db.rpc('event_funnel_invoice_report',{p_tenant:tenantId,p_bookings:entries.slice(offset,offset+1000)});
    if(missing(result.error)) return;
    if(result.error||!Array.isArray(result.data)) throw unavailable();
    rows.push(...result.data);
  }
  const byBooking=new Map(rows.map(row=>[`${row.bookingSource}:${row.bookingId}`,row]));
  for(const group of groups) {
    const matched=(group.attendees||[]).map(a=>byBooking.get(`${group.bookingSource}:${a.id}`)).filter(Boolean);
    if(!matched.length) continue;
    const first=matched[0],payment=group.groupPayment;
    if(matched.some(row=>row.orderId!==first.orderId||row.invoiceId!==first.invoiceId)) throw unavailable();
    group.sharedCheckout={orderId:first.orderId,invoiceMode:first.invoiceMode,
      eventPayableMinor:matched.reduce((sum,row)=>sum+Number(row.payableMinor),0)};
    payment.sharedCheckout=group.sharedCheckout;
    payment.accountingProvider=first.provider||null;
    payment.accountingInvoiceId=first.invoiceId||null;
    payment.accountingInvoiceNumber=first.invoiceNumber||null;
    payment.invoiceRecoveryStatus=first.status==='delivered'?'complete':
      ['running','processing','retry'].includes(first.status)?'pending':first.status;
    payment.invoiceRecoveryNextAttemptAt=first.nextAttemptAt||null;
    // Never set legacy payment intent/full-charge totals from aggregate data.
  }
}

async function loadInvoiceBinding({db,tenantId,link}) {
  const read=async()=>{
    const result=await db.from(link.provider==='xero'?'xero_token':'quickbooks_token')
      .select('*').eq('app_tenant_id',tenantId).eq('id',link.connectionId).maybeSingle();
    if(result.error||!result.data) throw unavailable();
    const token=result.data;
    return {connectionId:String(token.id),companyId:String(link.provider==='xero'?token.tenant_id:token.realm_id),
      environment:token.environment||'production',accessToken:token.access_token,expiresAt:token.expires_at};
  };
  let binding=await read();
  if(binding.companyId!==link.companyId || (link.provider==='quickbooks' && binding.environment!==link.environment)) throw unavailable();
  if(!binding.accessToken||!(Date.parse(binding.expiresAt)>Date.now()+30000)) {
    const refresh=link.provider==='xero'?(await import('./xero.js')).getValidXeroAccessToken:
      (await import('./quickbooks.js')).getValidQuickBooksAccessToken;
    await refresh(tenantId,{timeoutMs:10000,deadlineAt:Date.now()+12000});
    binding=await read();
  }
  return binding;
}

export async function fetchFunnelInvoicePdf({db,tenantId,link},{loadBinding=loadInvoiceBinding,fetchImpl=fetch}={}) {
  if(!['xero','quickbooks'].includes(link?.provider)||!link.invoiceId||!link.connectionId||!link.companyId) throw unavailable();
  const binding=await loadBinding({db,tenantId,link});
  if(binding.connectionId!==link.connectionId || binding.companyId!==link.companyId || !binding.accessToken
    || !(Date.parse(binding.expiresAt)>Date.now())
    || (link.provider==='quickbooks' && (!['production','sandbox'].includes(link.environment)
      || binding.environment!==link.environment))) throw unavailable();
  const url=link.provider==='xero'
    ?`https://api.xero.com/api.xro/2.0/Invoices/${encodeURIComponent(link.invoiceId)}`
    :`https://${link.environment==='sandbox'?'sandbox-':''}quickbooks.api.intuit.com/v3/company/${encodeURIComponent(link.companyId)}/invoice/${encodeURIComponent(link.invoiceId)}/pdf`;
  const response=await fetchImpl(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(15000),
    headers:{Authorization:`Bearer ${binding.accessToken}`,Accept:'application/pdf',
      ...(link.provider==='xero'?{'xero-tenant-id':binding.companyId}:{})}});
  if(!response.ok) throw unavailable();
  const limit=20*1024*1024;
  if(Number(response.headers.get('content-length'))>limit || !response.body) {
    await response.body?.cancel();throw unavailable();
  }
  const reader=response.body.getReader(),chunks=[];let size=0;
  try {
    while(true) {
      const {done,value}=await reader.read();if(done) break;
      size+=value.byteLength;
      if(size>limit) {await reader.cancel();throw unavailable();}
      chunks.push(Buffer.from(value));
    }
  } finally {reader.releaseLock();}
  const buffer=Buffer.concat(chunks,size);
  if(buffer.subarray(0,5).toString()!=='%PDF-') throw unavailable();
  return buffer;
}
