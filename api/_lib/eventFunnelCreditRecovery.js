import {createFunnelCreditStore} from './eventFunnelCreditStore.js';
import {executeFunnelXeroCredit} from './eventFunnelXeroCredit.js';
import {executeFunnelQuickBooksCredit} from './eventFunnelQuickBooksCredit.js';

export async function recoverFunnelInvoiceCredits({db,context,deadlineAt=Date.now()+35000,
  execute=options=>options.job.provider==='quickbooks'?executeFunnelQuickBooksCredit(options):executeFunnelXeroCredit(options)}) {
  const {order,operation}=context||{};
  if(!order?.id||!order.tenant_id||operation?.order_id!==order.id||operation.tenant_id!==order.tenant_id)
    throw new Error('Original credit scope missing');
  const result=await db.rpc('event_funnel_credit_prepare',{p_tenant:order.tenant_id,p_order:order.id,p_reversal:operation.id});
  if(result.error||!Array.isArray(result.data))throw new Error('Original invoice credit evidence requires recovery');
  if(Array.isArray(operation.allocations)){
    const requested=operation.allocations.reduce((sum,item)=>sum+item.invoiceMinor,0);
    const planned=result.data.reduce((sum,job)=>sum+(Array.isArray(job.selected)?
      job.selected.reduce((value,item)=>value+item.amountMinor,0):NaN),0);
    if(!Number.isSafeInteger(requested)||requested<0||!Number.isSafeInteger(planned)||planned!==requested)
      throw new Error('Credit jobs do not cover the accepted cancellation');
  }
  const outcomes=[];
  for(const job of result.data){
    if(Date.now()+1500>=deadlineAt){outcomes.push({status:'retry'});break;}
    if(job.tenant_id!==order.tenant_id||job.order_id!==order.id||job.reversal_id!==operation.id)
      throw new Error('Credit job scope changed');
    try {
      outcomes.push(await execute({job,deadlineAt,store:createFunnelCreditStore({db,tenantId:order.tenant_id,orderId:order.id,jobId:job.id})}));
    } catch(error) {
      outcomes.push({status:error.code==='FUNNEL_CREDIT_REVIEW'?'needs_review':'retry',jobId:job.id});
    }
  }
  return {status:outcomes.some(o=>o.status==='retry')?'retry':outcomes.some(o=>o.status==='needs_review')?'needs_review':'complete',outcomes};
}
