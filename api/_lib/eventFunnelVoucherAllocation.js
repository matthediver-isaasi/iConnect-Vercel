import { orderVoucherIdsForRedemption } from './voucherOrdering.js';
import { FunnelJourneyError } from '../../shared/eventFunnelJourney.mjs';

const fail=message=>{throw new FunnelJourneyError(message,'INVALID_VOUCHER_ALLOCATION',409);};
export const funnelVoucherLineKey=line=>JSON.stringify([line.nodeId,line.ticketId]);

export function validateFunnelVoucherAllocations(lines,allocations,expectedMinor) {
  if(!Array.isArray(lines) || lines.some(line=>!Number.isSafeInteger(line.remainingMinor)||line.remainingMinor<0)
    || new Set(lines.map(funnelVoucherLineKey)).size!==lines.length) fail('Invalid voucher destination lines.');
  if(!Array.isArray(allocations) || allocations.length>100 || !Number.isSafeInteger(expectedMinor) || expectedMinor<0) fail('Voucher allocation evidence is required.');
  const amounts=lines.map(()=>0),indices=new Map(lines.map((line,index)=>[funnelVoucherLineKey(line),index]));
  const ids=new Set();
  let total=0;
  for(const allocation of allocations) {
    if(!allocation || typeof allocation.voucherId!=='string' || !allocation.voucherId || ids.has(allocation.voucherId)
      || !Number.isSafeInteger(allocation.amountMinor) || allocation.amountMinor<0 || !Array.isArray(allocation.lines)) fail('Invalid voucher allocation evidence.');
    ids.add(allocation.voucherId);
    const seen=new Set();let voucherTotal=0;
    for(const line of allocation.lines) {
      const key=funnelVoucherLineKey(line),index=indices.get(key);
      if(index===undefined || seen.has(key) || !Number.isSafeInteger(line.amountMinor) || line.amountMinor<=0) fail('Invalid voucher ticket allocation.');
      seen.add(key);amounts[index]+=line.amountMinor;voucherTotal+=line.amountMinor;
      if(!Number.isSafeInteger(amounts[index]) || amounts[index]>lines[index].remainingMinor) fail('Voucher credit exceeds its ticket amount.');
    }
    if(voucherTotal!==allocation.amountMinor) fail('Voucher allocation total changed.');
    total+=voucherTotal;
  }
  if(total!==expectedMinor) fail('Voucher total changed.');
  return amounts;
}

/**
 * Allocate validated credit only to eligible event lines. The caller supplies
 * server-verified eligibility, never a browser-authored matrix. This is pure:
 * balances are not reserved or consumed here. The transaction must reserve the
 * exact per-voucher total, not the whole basket once for each voucher.
 */
export function allocateEventFunnelVouchers({lines,vouchers,requestedIds,eligibleLines}) {
  if(!Array.isArray(lines) || !lines.length || !Array.isArray(vouchers) || !Array.isArray(requestedIds)
    || requestedIds.length>100 || new Set(requestedIds).size!==requestedIds.length
    || requestedIds.some(id=>typeof id!=='string'||!id) || !(eligibleLines instanceof Map)) fail('Invalid voucher selection.');
  const keys=lines.map(funnelVoucherLineKey);
  if(new Set(keys).size!==keys.length || lines.some(line=>!Number.isSafeInteger(line.remainingMinor)||line.remainingMinor<0)) {
    fail('Invalid remaining ticket amounts.');
  }
  const total=lines.reduce((sum,line)=>sum+line.remainingMinor,0);
  if(!Number.isSafeInteger(total)) fail('The selected ticket total is too large.');
  const byId=new Map(vouchers.map(voucher=>[String(voucher.id),voucher]));
  if(byId.size!==vouchers.length) fail('Duplicate voucher evidence.');
  for(const id of requestedIds) {
    const voucher=byId.get(id),eligible=eligibleLines.get(id);
    if(!voucher || !Number.isSafeInteger(voucher.availableMinor) || voucher.availableMinor<0
      || !(eligible instanceof Set) || [...eligible].some(key=>!keys.includes(key))) fail('Voucher eligibility is incomplete.');
  }
  const {orderedIds}=orderVoucherIdsForRedemption(requestedIds,Object.fromEntries(byId),false);
  const remaining=lines.map(line=>line.remainingMinor),lineAmounts=lines.map(()=>0),allocations=[];
  for(const id of orderedIds) {
    const voucher=byId.get(id),eligible=eligibleLines.get(id);
    let available=voucher.availableMinor;
    const applied=[];
    // Earlier route lines receive eligible credit first. FEFO orders vouchers;
    // a voucher barred from a later event cannot leak into it via proration.
    for(let index=0;index<lines.length && available>0;index++) {
      if(!eligible.has(keys[index])) continue;
      const amountMinor=Math.min(available,remaining[index]);
      if(!amountMinor) continue;
      applied.push({nodeId:lines[index].nodeId,ticketId:lines[index].ticketId,amountMinor});
      remaining[index]-=amountMinor;available-=amountMinor;lineAmounts[index]+=amountMinor;
    }
    allocations.push({voucherId:id,amountMinor:applied.reduce((sum,line)=>sum+line.amountMinor,0),lines:applied});
  }
  const voucherMinor=lineAmounts.reduce((sum,value)=>sum+value,0);
  return {voucherMinor,payableMinor:total-voucherMinor,lineAmounts,allocations};
}
