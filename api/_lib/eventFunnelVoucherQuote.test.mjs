import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteEventFunnelVouchers } from './eventFunnelVoucherQuote.js';
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function fixture() {
  const owner={tenantId:uuid(1),memberId:uuid(2),sessionId:uuid(3)};
  const rows={
    member:[{id:owner.memberId,tenant_id:owner.tenantId,organization_id:null}],
    system_settings:[{tenant_id:owner.tenantId,setting_key:'individual_vouchers_enabled',setting_value:'true'},
      {tenant_id:owner.tenantId,setting_key:'allow_voucher_use_after_expiry',setting_value:'false'}],
    voucher:[{id:uuid(6),tenant_id:owner.tenantId,member_id:owner.memberId,value:6,currency:'GBP',status:'active',expires_at:'2028-01-01',issued_at:'2026-01-01'},
      {id:uuid(7),tenant_id:owner.tenantId,member_id:owner.memberId,value:3,currency:'GBP',status:'active',expires_at:'2032-01-01',issued_at:'2026-01-01'}],
    event:[{id:uuid(4),tenant_id:owner.tenantId,start_date:'2027-06-01'}],
    complex_event:[{id:uuid(5),tenant_id:owner.tenantId}],
    complex_event_session:[{complex_event_id:uuid(5),start_time:'2030-06-01'}],
  };
  const db={from(table){
    const filters=[];let single=false,limit=Infinity;
    const query={select(){return this;},eq(key,value){filters.push(row=>row[key]===value);return this;},
      in(key,values){filters.push(row=>values.includes(row[key]));return this;},order(){return this;},
      limit(value){limit=value;return this;},maybeSingle(){single=true;return this;},
      then(resolve,reject){const matches=(rows[table]||[]).filter(row=>filters.every(filter=>filter(row))).slice(0,limit);
        return Promise.resolve({data:single?matches[0]||null:matches}).then(resolve,reject);}};
    return query;
  }};
  const snapshot={session:{tenant_id:owner.tenantId,member_id:owner.memberId,id:owner.sessionId},
    holds:[['source','simple',uuid(4)],['later','complex',uuid(5)]].map(([node,kind,id])=>({
      node_id:node,event_kind:kind,event_id:id,ticket_id:'A',quantity:1,
      price_snapshot:{version:1,unitMinor:500,unitAmount:5,currency:'GBP'},
    }))};
  const input={db,owner,snapshot,requestedIds:[uuid(7),uuid(6)],now:Date.parse('2026-06-01'),
    lines:[{nodeId:'source',ticketId:'A',remainingMinor:500},{nodeId:'later',ticketId:'A',remainingMinor:500}]};
  return {input,rows};
}
test('verified voucher preflight respects both simple and complex event dates',async()=>{
  const {input}=fixture();
  const quote=await quoteEventFunnelVouchers(input);
  assert.equal(quote.voucherMinor,800);
  assert.equal(quote.payableMinor,200);
  assert.deepEqual(quote.lineAmounts,[500,300]);
  assert.equal(quote.allocations[0].voucherId,uuid(6));
});
test('guest, cross-owner, disabled, membership-only and wrong-currency credit cannot enter event checkout',async()=>{
  for(const mutate of [
    f=>{f.input.owner.memberId=null;},
    f=>{f.rows.voucher[0].member_id=uuid(99);},
    f=>{f.rows.voucher[0].funding_source='membership_change';},
    f=>{f.rows.voucher[0].currency='EUR';},
    f=>{f.rows.system_settings[0].setting_value='false';},
    f=>{f.rows.system_settings.push({tenant_id:uuid(1),setting_key:'event_allow_voucher_payment',setting_value:'false'});},
  ]){const f=fixture();mutate(f);await assert.rejects(quoteEventFunnelVouchers(f.input));}
});
test('unavailable settings do not silently broaden voucher eligibility',async()=>{
  const {input}=fixture();const from=input.db.from.bind(input.db);
  input.db.from=table=>table==='system_settings'?{select(){return this;},eq(){return this;},in(){return Promise.resolve({error:{code:'fixture'}});}}:from(table);
  await assert.rejects(quoteEventFunnelVouchers(input),{code:'VOUCHER_QUOTE_UNAVAILABLE',status:503});
});
test('client prices above held economics and vouchers outside this tenant fail closed',async()=>{
  let f=fixture();f.input.lines[0].remainingMinor=501;
  await assert.rejects(quoteEventFunnelVouchers(f.input));
  f=fixture();f.rows.voucher[0].tenant_id=uuid(99);
  await assert.rejects(quoteEventFunnelVouchers(f.input));
});
