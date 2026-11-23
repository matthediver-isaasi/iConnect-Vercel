import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {prepareFunnelCancellation} from './eventFunnelCancellationPreparation.js';
export async function exerciseFunnelSelectedVoucherRefunds({db,sql}){
  await db.query(await sql('202701230038_event_funnel_selected_voucher_refunds.sql'));
  const booking=(await db.query(`SELECT b.* FROM event_funnel_order_booking b JOIN event_funnel_order o
    ON o.tenant_id=b.tenant_id AND o.id=b.order_id WHERE b.voucher_minor>0
      AND o.snapshot->>'voucherAttributionVersion'='1' LIMIT 1`)).rows[0];
  assert.ok(booking);
  const order=(await db.query('SELECT snapshot FROM event_funnel_order WHERE id=$1',[booking.order_id])).rows[0].snapshot;
  const original=order.lines.flatMap(line=>line.registrations).find(row=>row.id===booking.booking_id);
  assert.ok(original.voucherContributions.length>0);
  // Earlier tests recorded synthetic refund receipts without crediting wallets.
  // Start an isolated, unrefunded-plan fixture; restore that test history below.
  await db.query('BEGIN');
  try{
    await db.query(`UPDATE event_funnel_reversal SET state='released' WHERE tenant_id=$1 AND order_id=$2`,
      [booking.tenant_id,booking.order_id]);
    const voucher=original.voucherContributions.at(-1).voucherId,id=randomUUID();
    const base={source:booking.booking_source,id:booking.booking_id,cardMinor:0,invoiceMinor:0,trainingFundMinor:0};
    const items=[{...base,voucherMinor:1,voucherAmounts:{[voucher]:1}}];
    const reserve=async(key,value)=>{
      await db.query('SAVEPOINT attempted_selection');
      try{return (await db.query('SELECT event_funnel_reversal_reserve($1,$2,$3,$4) result',
        [booking.tenant_id,booking.order_id,key,JSON.stringify(value)])).rows[0].result;}
      catch(error){await db.query('ROLLBACK TO SAVEPOINT attempted_selection');throw error;}
    };
    await db.query('SET LOCAL ROLE service_role');
    const adapter={rpc:async(name,args)=>{
      assert.ok(['event_funnel_invoice_report','event_funnel_reversal_context'].includes(name));
      const values=name==='event_funnel_invoice_report'?[args.p_tenant,JSON.stringify(args.p_bookings)]:[args.p_tenant,args.p_order];
      try{return {data:(await db.query(`SELECT ${name}($1,$2) value`,values)).rows[0].value};}
      catch(error){return {error};}
    }};
    const prepared=await prepareFunnelCancellation({db:adapter,tenantId:booking.tenant_id,operationId:id,
      requests:[{id:randomUUID(),tenant_id:booking.tenant_id,booking_id:booking.booking_id,booking_source:booking.booking_source}]});
    assert.equal(prepared.kind,'funnel');assert.equal(prepared.orderId,booking.order_id);
    assert.equal(prepared.items[0].voucherMinor,Number(booking.voucher_minor));
    const result=await reserve(id,items);
    assert.equal(result.voucher_plan.length,1);assert.equal(result.voucher_plan[0].voucherId,voucher);
    assert.equal(result.voucher_plan[0].amountMinor,1);
    assert.deepEqual((await reserve(id,items)).allocations,result.allocations);
    await assert.rejects(reserve(id,[{...items[0],voucherAmounts:{[voucher]:0},voucherMinor:0}]),{code:'PT409'});
    await assert.rejects(reserve(randomUUID(),[{...base,voucherMinor:0,voucherAmounts:{[randomUUID()]:0}}]),{code:'PT409'});
    await assert.rejects(reserve(randomUUID(),[{...base,voucherMinor:2,voucherAmounts:{[voucher]:1}}]),{code:'22023'});
    await assert.rejects(reserve(randomUUID(),[{...base,voucherMinor:1,voucherAmounts:{[voucher]:'invalid'}}]),{code:'22023'});
    const tooMuch=original.voucherContributions.find(part=>part.voucherId===voucher).amountMinor;
    await assert.rejects(reserve(randomUUID(),[{...base,voucherMinor:tooMuch,voucherAmounts:{[voucher]:tooMuch}}]),{code:'PT409'});
  }finally{await db.query('ROLLBACK');}
}
