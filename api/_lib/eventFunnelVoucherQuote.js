import { FunnelJourneyError } from '../../shared/eventFunnelJourney.mjs';
import { resolveEventPaymentPolicy } from '../../shared/eventPaymentPolicy.js';
import { assertVoucherEligible } from './voucherCreditService.js';
import { isVoucherUsableForEventDate } from './voucherExpiryPolicy.js';
import { normalizeRequestedVoucherIds } from './complexEventCreditQuote.js';
import { funnelLineTotal } from './eventFunnelCommercial.js';
import { allocateEventFunnelVouchers,funnelVoucherLineKey } from './eventFunnelVoucherAllocation.js';

const fail=(message,status=409)=>{throw new FunnelJourneyError(message,'VOUCHER_QUOTE_UNAVAILABLE',status);};
async function checked(query) {
  const result=await query;
  if(result.error || result.data==null) fail('Voucher eligibility could not be checked.',503);
  return result.data;
}

/** Read-only preflight. Exact allocation amounts must still be reserved in SQL. */
export async function quoteEventFunnelVouchers({db,owner,snapshot,requestedIds,lines,now=Date.now()}) {
  const ids=normalizeRequestedVoucherIds(requestedIds);
  if(ids.length>100 || ids.some(id=>!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))) fail('Invalid voucher selection.',400);
  if(!owner.memberId || owner.memberId!==snapshot.session.member_id || owner.tenantId!==snapshot.session.tenant_id
    || owner.sessionId!==snapshot.session.id) fail('Sign in as the original purchaser to use vouchers.',403);
  const held=new Map(snapshot.holds.map(hold=>[JSON.stringify([hold.node_id,hold.ticket_id]),hold]));
  if(!Array.isArray(lines) || lines.length!==held.size || lines.some(line=>{
    const hold=held.get(funnelVoucherLineKey(line));
    return !hold || !Number.isSafeInteger(line.remainingMinor) || line.remainingMinor<0
      || line.remainingMinor>funnelLineTotal(hold.price_snapshot,hold.quantity);
  })) fail('The selected ticket amounts changed.');
  const [member,settings,vouchers]=await Promise.all([
    checked(db.from('member').select('*').eq('tenant_id',owner.tenantId).eq('id',owner.memberId).maybeSingle()),
    checked(db.from('system_settings').select('setting_key,setting_value').eq('tenant_id',owner.tenantId)
      .in('setting_key',['individual_vouchers_enabled','event_allow_voucher_payment','allow_voucher_use_after_expiry'])),
    ids.length ? checked(db.from('voucher').select('*').eq('tenant_id',owner.tenantId).in('id',ids)) : [],
  ]);
  if(vouchers.length!==ids.length) fail('A selected voucher is unavailable.',403);
  if(!resolveEventPaymentPolicy(settings).allowVoucherPayment && ids.length) fail('Voucher payment is not enabled for events.',403);
  const organization=member.organization_id && vouchers.some(voucher=>voucher.organization_id) ? await checked(db.from('organization').select('*')
    .eq('tenant_id',owner.tenantId).eq('id',member.organization_id).maybeSingle()) : null;
  const currency=snapshot.holds[0]?.price_snapshot.currency;
  for(const voucher of vouchers) {
    assertVoucherEligible(voucher,{tenantId:owner.tenantId,memberId:owner.memberId,organizationId:member.organization_id,
      organization,isAuthenticated:true,roleId:member.role_id,settings,currency,now});
  }
  const eventKeys=[...new Set(snapshot.holds.map(hold=>JSON.stringify([hold.event_kind,hold.event_id])))];
  const dates=new Map();
  for(let offset=0;offset<eventKeys.length;offset+=4) {
    await Promise.all(eventKeys.slice(offset,offset+4).map(async key=>{
      const [kind,id]=JSON.parse(key);
      const event=await checked(db.from(kind==='simple'?'event':'complex_event').select('*').eq('tenant_id',owner.tenantId).eq('id',id).maybeSingle());
      let start=event.start_date || null;
      if(kind==='complex' && !start) {
        const sessions=await checked(db.from('complex_event_session').select('start_time')
          .eq('complex_event_id',id).order('start_time',{ascending:true}).limit(1));
        start=sessions[0]?.start_time || null;
      }
      dates.set(key,start);
    }));
  }
  const allowAfterExpiry=settings.find(row=>row.setting_key==='allow_voucher_use_after_expiry')?.setting_value!=='false';
  const eligibleLines=new Map();
  for(const voucher of vouchers) {
    const eligible=new Set();
    for(const line of lines) {
      const hold=held.get(funnelVoucherLineKey(line));
      if(isVoucherUsableForEventDate(voucher,dates.get(JSON.stringify([hold.event_kind,hold.event_id])),allowAfterExpiry)) {
        eligible.add(funnelVoucherLineKey(line));
      }
    }
    if(!eligible.size) fail('A selected voucher expires before every selected event.');
    eligibleLines.set(voucher.id,eligible);
  }
  const result=allocateEventFunnelVouchers({lines,requestedIds:ids,eligibleLines,
    vouchers:vouchers.map(voucher=>({...voucher,availableMinor:Math.round(Number(voucher.value)*100)}))});
  return {...result,requestedIds:ids,eventDates:Object.fromEntries(dates)};
}
