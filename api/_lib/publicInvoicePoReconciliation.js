// Provider reads only: never create payments or change member entitlement.
export function publicPoInvoiceState(row,invoice){
 const xero=row.provider==='xero';
 const id=xero?invoice?.InvoiceID:invoice?.Id;
 const total=Number(xero?invoice?.Total:invoice?.TotalAmt);
 const due=Number(xero?invoice?.AmountDue:invoice?.Balance);
 const currency=xero?invoice?.CurrencyCode:invoice?.CurrencyRef?.value;
 if(String(id)!==row.invoice_id||!Number.isFinite(total)||Math.round(total*100)!==Math.round(Number(row.amount)*100)
   ||!Number.isFinite(due)||due<0||due>total||currency!==row.currency)throw new Error('Invoice evidence changed; manual review required');
 const voided=xero&&['VOIDED','DELETED'].includes(invoice.Status);
 return {invoice_status:xero?invoice.Status:'AUTHORISED',payment_status:voided?'voided':due===0?'paid':due<total?'partial':'unpaid',
   amount_due:due,invoice_date:(xero?invoice.DateString:invoice.TxnDate)?.slice(0,10)||null};
}
export async function reconcilePublicPoInvoices({db,deadlineAt=Date.now()+15000,readInvoice}={}){
 const {data,error}=await db.from('public_invoice_po_billing').select('*')
 .not('payment_status','in','(paid,voided)').order('checked_at',{ascending:true,nullsFirst:true}).order('id').limit(20);
 if(error){if(error.code==='42P01'||error.code==='PGRST205')return;throw error;}
 for(const row of data||[]){
  if(Date.now()>=deadlineAt-3000)break;
  try{
   let id=row.invoice_id,number=row.invoice_number;
   if(!id){
    const r=await db.from(row.source).select('accounting_invoice_id,accounting_invoice_number,xero_invoice_id,xero_invoice_number,invoice_recovery_status')
      .eq('tenant_id',row.tenant_id).eq('booking_group_reference',row.booking_group_reference).limit(1001);
    if(r.error||!r.data?.length||r.data.length>1000)throw new Error('Booking invoice linkage unavailable');
    const ids=[...new Set(r.data.map(b=>b.accounting_invoice_id||b.xero_invoice_id).filter(Boolean))];
    if(ids.length>1)throw new Error('Conflicting booking invoice links');
    id=ids[0];number=r.data.find(b=>b.accounting_invoice_number||b.xero_invoice_number);
    number=number?.accounting_invoice_number||number?.xero_invoice_number||null;
    if(!id){
     const update=await db.from('public_invoice_po_billing').update({invoice_status:r.data[0].invoice_recovery_status||'pending',checked_at:new Date().toISOString()}).eq('id',row.id).eq('tenant_id',row.tenant_id);
     if(update.error)throw update.error;continue;
    }
   }
   let invoice;
   if(readInvoice)invoice=await readInvoice(row,id);
   else if(row.provider==='xero'){
    const provider=await import('./xero.js');
    const binding=await provider.getValidXeroAccessToken(row.tenant_id);
    if(binding.tenantId!==row.provider_snapshot?.provider?.xeroTenantId)throw new Error('Accounting company changed');
    invoice=await provider.getXeroInvoice(id,row.tenant_id);
   }else{
    const provider=await import('./quickbooks.js');
    const binding=await provider.getQuickBooksTokenRow(row.tenant_id);
    if(binding?.realm_id!==row.provider_snapshot?.approvalProvider?.realmId
      ||binding?.environment!==row.provider_snapshot?.environment)throw new Error('Accounting company changed');
    invoice=await provider.getQuickBooksInvoice(row.tenant_id,id);
   }
   const state=publicPoInvoiceState({...row,invoice_id:id},invoice);
   const update=await db.from('public_invoice_po_billing').update({...state,invoice_id:id,invoice_number:number,check_error:null,checked_at:new Date().toISOString()}).eq('id',row.id).eq('tenant_id',row.tenant_id);
   if(update.error)throw update.error;
  }catch{
   const saved=await db.from('public_invoice_po_billing').update({check_error:'Invoice status could not be verified. It will be checked again.',checked_at:new Date().toISOString()}).eq('id',row.id).eq('tenant_id',row.tenant_id);
   if(saved.error)throw saved.error;
  }
 }
}
