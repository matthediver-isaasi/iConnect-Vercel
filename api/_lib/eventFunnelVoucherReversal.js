import {refundVoucherAllocation} from './voucherCreditService.js';
/** Reuse original-owner and backed-credit accounting rules, never direct
 * voucher balance updates. The original refund key makes lost receipts safe.
 */
export async function recoverFunnelVoucherReversal({db,operation,refund=refundVoucherAllocation}) {
  const op=operation;
  if(!op?.id||!op.tenant_id||!op.order_id||!op.cancelled_at||op.state==='released'
    ||!Array.isArray(op.allocations)||!Array.isArray(op.voucher_plan))
    throw new Error('Accepted voucher reversal authority is required');
  const groups=new Map();let total=0;
  for(const part of op.voucher_plan) {
    if(!part.allocationId||!part.voucherId||!Number.isSafeInteger(part.amountMinor)||part.amountMinor<=0)
      throw new Error('Invalid original voucher refund plan');
    const group=groups.get(part.allocationId)||{voucherId:part.voucherId,amount:0};
    if(group.voucherId!==part.voucherId)throw new Error('Voucher allocation identity changed');
    group.amount+=part.amountMinor;total+=part.amountMinor;
    if(!Number.isSafeInteger(group.amount)||!Number.isSafeInteger(total))throw new Error('Invalid voucher total');
    groups.set(part.allocationId,group);
  }
  const expected=op.allocations.reduce((sum,item)=>{
    if(!Number.isSafeInteger(item.voucherMinor)||item.voucherMinor<0)throw new Error('Invalid voucher allocation');
    return sum+item.voucherMinor;
  },0);
  if(!Number.isSafeInteger(expected)||total!==expected)throw new Error('Original voucher refund evidence is incomplete');
  if(expected>0&&(!op.refund_options||typeof op.refund_options!=='object'||Array.isArray(op.refund_options)))
    throw new Error('Original approved voucher refund options are missing');
  for(const [allocationId,group] of groups) {
    const old=op.voucher_receipts?.[allocationId];
    if(old){
      if(old.voucherId!==group.voucherId||old.cumulativeMinor!==group.amount)throw new Error('Stored voucher receipt conflicts with its plan');
      continue;
    }
    const receipt=await refund(db,{tenantId:op.tenant_id,allocationId,
      refundKey:`event-funnel-reversal:${op.id}:${allocationId}`,cumulativeMinor:group.amount,reversalOptions:op.refund_options||{}});
    if(receipt?.voucherId!==group.voucherId||receipt.cumulativeMinor!==group.amount)
      throw new Error('Original voucher refund needs reconciliation');
    const saved=await db.rpc('event_funnel_reversal_voucher_receipt',{p_tenant:op.tenant_id,p_order:op.order_id,
      p_id:op.id,p_allocation:allocationId,p_receipt:receipt});
    if(saved.error||saved.data!==true)throw new Error('Voucher refund receipt requires recovery');
  }
  return {status:'complete',amountMinor:total};
}
