import { buildFunnelInvoiceSnapshots } from './eventFunnelInvoiceSnapshot.js';

/** Durable preparation is not accounting delivery. Caller keeps outbox pending. */
export async function prepareFunnelInvoices({db,job}) {
  const scope={p_tenant:job.tenant_id,p_order:job.order_id,p_token:job.lease_token};
  const input=await db.rpc('event_funnel_invoice_input',scope);
  if(input.error||!input.data?.order||!Array.isArray(input.data.allocations)) {
    throw new Error('Original invoice evidence is unavailable');
  }
  // Exact persisted instructions win on retries; never rebuild an accepted
  // invoice using newly deployed preparation code.
  if(Array.isArray(input.data.prepared)) return input.data.prepared;
  const prepared=buildFunnelInvoiceSnapshots(input.data);
  const saved=await db.rpc('event_funnel_invoice_capture',{...scope,p_prepared:prepared});
  if(saved.error||!Array.isArray(saved.data)) throw new Error('Invoice preparation requires retry');
  return saved.data;
}

export async function prepareFunnelInvoiceDelivery({db,job}) {
  const prepared=await prepareFunnelInvoices({db,job});
  if(!prepared.length) throw new Error('Invoice preparation is empty');
  if(prepared.every(item=>item.status==='not_applicable')) return {status:'delivered'};
  if(prepared.some(item=>item.status==='needs_review')) return {status:'needs_review'};
  // Preparing immutable payloads is not delivery. Never consume the outbox
  // until provider delivery and all booking links have been durably confirmed.
  return {status:'retry'};
}
