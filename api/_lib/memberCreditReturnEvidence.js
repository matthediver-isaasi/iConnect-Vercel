// Read-only accounting evidence. A cash refund alone cannot restore consumed
// liability-backed credit. Deleted funding payments and verified replacement
// payments must leave precisely the expected outstanding liability debit.
export function verifyMemberCreditReturnPayments({entries,payments,expectedActiveMinor,accountId}){
 const fail=()=>{throw new Error('Member-credit return requires reconciliation of the original liability payments.');};
 if(!Array.isArray(entries)||!entries.length||!Array.isArray(payments)
  ||!Number.isSafeInteger(expectedActiveMinor)||expectedActiveMinor<0||!accountId)fail();
 const references=new Map(),ids=new Set();
 for(const entry of entries){
  if(!entry.reference||!entry.invoiceId||!entry.paymentId
   ||!Number.isSafeInteger(entry.amountMinor)||entry.amountMinor<=0||references.has(entry.reference))fail();
  references.set(entry.reference,entry);
 }
 let activeMinor=0;
 for(const payment of payments){
  const entry=references.get(payment.Reference);
  if(!entry||!payment.PaymentID||ids.has(payment.PaymentID)
   ||payment.Invoice?.InvoiceID!==entry.invoiceId||payment.Account?.AccountID!==accountId
   ||payment.CreditNote||payment.Overpayment||payment.Prepayment
   ||(payment.CurrencyRate!=null&&Number(payment.CurrencyRate)!==1))fail();
  ids.add(payment.PaymentID);
  if(payment.Status==='DELETED')continue;
  const value=Number(payment.Amount),minor=Math.round(value*100);
  if(payment.Status!=='AUTHORISED'||payment.Amount==null||payment.Amount===''
   ||!['number','string'].includes(typeof payment.Amount)
   ||(typeof payment.Amount==='string'&&!/^\d+(?:\.\d{1,2})?$/.test(payment.Amount))
   ||!Number.isFinite(value)||!Number.isSafeInteger(minor)||minor<=0
   ||Math.abs(value*100-minor)>0.000001||minor>entry.amountMinor)fail();
  activeMinor+=minor;
 }
 if(!Number.isSafeInteger(activeMinor)||activeMinor!==expectedActiveMinor)fail();
 return {verified:true,activeMinor};
}

export async function readMemberCreditReturnPayments({entries,request}){
 if(!Array.isArray(entries)||!entries.length||entries.length>50)
  throw new Error('A bounded set of original funding entries is required.');
 const found=new Map();
 const financial=p=>JSON.stringify([p.PaymentID,p.Reference,p.Status,p.Amount,p.CurrencyRate??1,
  p.Invoice?.InvoiceID,p.Account?.AccountID,p.CreditNote,p.Overpayment,p.Prepayment]);
 const add=p=>{
  if(!p?.PaymentID)throw new Error('Payment identity is missing.');
  if(found.has(p.PaymentID)&&financial(found.get(p.PaymentID))!==financial(p))
   throw new Error('Accounting payments changed during verification; retry the read.');
  found.set(p.PaymentID,p);
 };
 // Query absence alone is not evidence that the original payment was deleted.
 for(const entry of entries){
  const rows=(await request(`Payments/${encodeURIComponent(entry.paymentId)}`))?.Payments;
  if(!Array.isArray(rows)||rows.length!==1||rows[0].PaymentID!==entry.paymentId)
   throw new Error('Original accounting payment could not be verified.');
  add(rows[0]);
 }
 // Include replacement payments sharing the original reference, not just the
 // now-deleted payment IDs. Incomplete/failed pagination must never mean zero.
 for(let offset=0;offset<entries.length;offset+=5){
  const where=entries.slice(offset,offset+5).map(e=>`Reference==${JSON.stringify(e.reference)}`).join('||');
  for(let page=1;;page++){
   if(page>10)throw new Error('Accounting payment result exceeded the verification limit.');
   const rows=(await request(`Payments?where=${encodeURIComponent(where)}&page=${page}&pageSize=100`))?.Payments;
   if(!Array.isArray(rows))throw new Error('Complete accounting payment results are required.');
   rows.forEach(add);
   if(rows.length<100)break;
  }
 }
 return [...found.values()];
}
