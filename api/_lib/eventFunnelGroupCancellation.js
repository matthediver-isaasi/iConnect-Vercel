const fail=()=>{throw Object.assign(new Error('Invalid group refund allocation'),{status:400});};
const minor=value=>{
  if(!['number','string'].includes(typeof value)||!/^\d+(?:\.\d{1,2})?$/.test(String(value)))fail();
  const amount=Math.round(Number(value)*100);if(!Number.isSafeInteger(amount)||amount<0)fail();return amount;
};
const major=value=>`${Math.floor(value/100)}.${String(value%100).padStart(2,'0')}`;
/** Proportional integer allocation, stable tie order, exact totals and original
 * per-registration caps. Never round each attendee independently. */
export function splitFunnelRefund(total,caps){
  if(!Number.isSafeInteger(total)||total<0||caps.some(n=>!Number.isSafeInteger(n)||n<0))fail();
  const sum=caps.reduce((a,b)=>a+BigInt(b),0n),requested=BigInt(total);
  if(requested>sum)fail();if(sum===0n)return caps.map(()=>0);
  const parts=caps.map((cap,index)=>({index,amount:Number(requested*BigInt(cap)/sum),
    remainder:requested*BigInt(cap)%sum}));
  let left=total-parts.reduce((a,p)=>a+p.amount,0);
  for(const part of [...parts].sort((a,b)=>a.remainder===b.remainder?a.index-b.index:a.remainder>b.remainder?-1:1)){
    if(left===0)break;if(part.amount<caps[part.index]){part.amount++;left--;}
  }
  if(left)fail();return parts.map(p=>p.amount);
}
export function groupFunnelAmountChoices({plan,requests,refundAllocation={},customRefundAmount=null}){
  if(!refundAllocation||Array.isArray(refundAllocation)||typeof refundAllocation!=='object'
    ||Object.keys(refundAllocation).some(k=>!['stripeAmount','invoiceAmount','trainingFundAmount','vouchers'].includes(k)))fail();
  const rows=[...requests].sort((a,b)=>a.id.localeCompare(b.id)).map(request=>{
    const item=plan.items.find(i=>i.id===request.booking_id&&i.source===(request.booking_source||'booking'));
    if(!item)fail();return {request,item,choices:{refundAllocation:{}}};
  });
  const card=customRefundAmount??refundAllocation.stripeAmount;
  const fields=[['stripeAmount','cardMinor',card],['invoiceAmount','invoiceMinor',
    refundAllocation.invoiceAmount??(card!=null&&rows.some(r=>r.item.invoiceMinor>0)?card:null)],
    ['trainingFundAmount','trainingFundMinor',refundAllocation.trainingFundAmount]];
  for(const [key,field,value] of fields)if(value!=null){
    const parts=splitFunnelRefund(minor(value),rows.map(r=>r.item[field]));
    rows.forEach((row,i)=>{row.choices.refundAllocation[key]=major(parts[i]);});
  }
  if(refundAllocation.vouchers!=null){
    const vouchers=refundAllocation.vouchers;
    if(typeof vouchers!=='object'||Array.isArray(vouchers))fail();
    for(const [id,value] of Object.entries(vouchers)){
      if(!rows.some(r=>Object.hasOwn(r.item.voucherAmounts||{},id)))fail();
      const parts=splitFunnelRefund(minor(value),rows.map(r=>r.item.voucherAmounts?.[id]||0));
      rows.forEach((row,i)=>{if(Object.hasOwn(row.item.voucherAmounts||{},id)){
        (row.choices.refundAllocation.vouchers||={})[id]=major(parts[i]);
      }});
    }
  }
  return Object.fromEntries(rows.map(r=>[r.request.id,r.choices]));
}
