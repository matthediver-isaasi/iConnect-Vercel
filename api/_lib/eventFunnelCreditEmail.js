import {getIntuitEndpoints} from './quickbooksCredentials.js';
const fail=()=>{throw Object.assign(new Error('Original credit-note PDF authority unavailable'),{code:'FUNNEL_CREDIT_REVIEW'});};
export async function loadFunnelCreditPdf({job,deadlineAt,loadToken,fetcher=fetch}){
  const plan=job.snapshot,receipt=plan?.receipt;
  if(!['xero','quickbooks'].includes(plan?.provider)||receipt?.provider!==plan.provider
    ||!receipt.creditNoteId||receipt.invoiceId!==plan.invoice_id||!plan.company_id
    ||!/^[a-z0-9-]+$/i.test(receipt.creditNoteId))fail();
  const token=loadToken?await loadToken(job.tenant_id,plan.provider):plan.provider==='xero'
    ?await (await import('./xero.js')).getValidXeroAccessToken(job.tenant_id)
    :await (await import('./quickbooks.js')).getValidQuickBooksAccessToken(job.tenant_id);
  let url,headers={Authorization:`Bearer ${token?.accessToken}`,Accept:'application/pdf'};
  if(!token?.accessToken)fail();
  if(plan.provider==='xero'){
    if(token.tenantId!==plan.company_id)fail();
    url=`https://api.xero.com/api.xro/2.0/CreditNotes/${encodeURIComponent(receipt.creditNoteId)}`;
    headers['xero-tenant-id']=plan.company_id;
  }else{
    if(String(token.realmId)!==plan.company_id||token.environment!==plan.environment
      ||!['production','sandbox'].includes(plan.environment))fail();
    url=`${getIntuitEndpoints(plan.environment).apiBaseUrl}/v3/company/${encodeURIComponent(plan.company_id)}/creditmemo/${encodeURIComponent(receipt.creditNoteId)}/pdf?minorversion=70`;
  }
  const remaining=deadlineAt-Date.now();if(remaining<1000)throw new Error('Credit PDF deadline reached');
  const response=await fetcher(url,{headers,redirect:'error',signal:AbortSignal.timeout(Math.min(12000,remaining))});
  if(!response.ok||Number(response.headers?.get('content-length'))>5000000)fail();
  const chunks=[];let length=0;
  for await(const chunk of response.body){
    length+=chunk.length;if(length>5000000)fail();chunks.push(Buffer.from(chunk));
  }
  const pdf=Buffer.concat(chunks);
  if(pdf.subarray(0,5).toString()!=='%PDF-')fail();
  return pdf;
}
export async function deliverFunnelCreditEmails({db,context,deadlineAt=Date.now()+30000,
  loadPdf=loadFunnelCreditPdf,send,now=()=>Date.now()}){
  const {order,operation}=context;
  const call=async(action,id=null,payload=null)=>{
    const result=await db.rpc('event_funnel_credit_email_operation',{p_tenant:order.tenant_id,p_order:order.id,
      p_reversal:operation.id,p_lease:operation.lease_id,p_action:action,p_message:id,p_payload:payload});
    if(['42883','PGRST202'].includes(result.error?.code))return {status:'needs_review',jobs:[]};
    if(result.error||!result.data)throw new Error('Credit email journal unavailable');return result.data;
  };
  const plan=await call('read');if(!Array.isArray(plan.jobs))throw new Error('Credit email plan missing');
  for(const job of plan.jobs){
    if(deadlineAt-now()<10000)break;
    if(job.tenant_id!==order.tenant_id||job.order_id!==order.id||job.reversal_id!==operation.id)
      throw new Error('Credit email scope changed');
    let envelope=job.payload;
    if(!envelope){
      const pdf=await loadPdf({job,deadlineAt});
      envelope={tenantId:order.tenant_id,to:job.recipient,subject:'Your credit note',
        html:'<p>Please find attached the credit note for your approved cancellation.</p>',
        attachments:[{filename:`credit-note-${job.credit_id}.pdf`,base64:pdf.toString('base64'),contentType:'application/pdf'}]};
    }
    if(deadlineAt-now()<8000)break;
    const begun=await call('begin',job.id,envelope);if(begun.status!=='send')continue;
    if(begun.payload?.tenantId!==order.tenant_id||begun.payload?.to!==job.recipient)throw new Error('Credit email envelope changed');
    let result;
    try{
      if(deadlineAt-now()<8000)result={notSubmitted:true};
      else result=await (send||(await import('./emailService.js')).sendEmail)({...begun.payload,deadlineAt,
        confidentialDiagnostics:true,attachments:begun.payload.attachments.map(a=>({
          filename:a.filename,data:Buffer.from(a.base64,'base64'),contentType:a.contentType}))});
    }catch{result={success:false};}
    await call('finish',job.id,{outcome:result?.success===true?'accepted':result?.notSubmitted===true?'not_submitted':'unknown',
      messageId:result?.messageId||null});
  }
  return {status:(await call('read')).status};
}
