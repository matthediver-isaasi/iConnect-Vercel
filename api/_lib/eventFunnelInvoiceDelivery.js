import { prepareFunnelInvoices } from './eventFunnelInvoicePreparation.js';
import { processEventInvoiceRecovery } from './eventInvoiceRecovery.js';
import { deliverFunnelQuickBooks } from './eventFunnelQuickBooks.js';
import { recordFunnelIssuedInvoice } from './eventFunnelIssuedInvoice.js';

// Reuse the battle-tested provider ambiguity/tax/settlement algorithm, but never
// put aggregate charges in the legacy one-payment-one-event ownership table.
export function funnelInvoiceRecoveryDatabase(db) {
  return {
    from:(...args)=>db.from(...args),
    rpc(name,args) {
      const prefix='event_invoice_recovery_';
      if(!name.startsWith(prefix)) return db.rpc(name,args);
      return db.rpc('event_funnel_invoice_operation',{p_action:name.slice(prefix.length),p_args:args});
    },
  };
}

export async function deliverFunnelInvoices({db,job,deadlineAt=Date.now()+20000,
  processInvoice=processEventInvoiceRecovery,processQuickBooks=deliverFunnelQuickBooks,providerFactory,now=Date.now}) {
  await prepareFunnelInvoices({db,job});
  const scope={p_tenant:job.tenant_id,p_order:job.order_id,p_token:job.lease_token};
  const enqueue=await db.rpc('event_funnel_invoice_enqueue',scope);
  if(enqueue.error||!Array.isArray(enqueue.data)||!enqueue.data.length) throw new Error('Invoice delivery journal unavailable');
  const outcomes=[];
  for(const invoice of enqueue.data) {
    if(['complete','not_applicable'].includes(invoice.status)) {outcomes.push('complete');continue;}
    if(invoice.status==='needs_review') {outcomes.push('needs_review');continue;}
    if(now()>=deadlineAt-1000) {outcomes.push('retry');continue;}
    if(invoice.provider==='quickbooks') {
      const result=await processQuickBooks({db,job,key:invoice.key,deadlineAt});
      outcomes.push(['complete','not_applicable'].includes(result.status)?'complete':
        result.status==='needs_review'?'needs_review':'retry');
      continue;
    }
    if(invoice.provider!=='xero') {outcomes.push('needs_review');continue;}
    const result=await processInvoice({db:funnelInvoiceRecoveryDatabase(db),tenantId:job.tenant_id,
      source:'event_funnel',bookingGroupReference:invoice.key,deadlineAt,providerFactory,now,
      onVerifiedInvoice:({row,invoice})=>recordFunnelIssuedInvoice({db,row,invoice})});
    outcomes.push(result.status==='complete'?'complete':result.status==='needs_review'?'needs_review':'retry');
  }
  // A review on one invoice must not strand other retryable invoices.
  return {status:outcomes.includes('retry')?'retry':outcomes.includes('needs_review')?'needs_review':'delivered'};
}
