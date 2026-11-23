import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export async function exerciseFunnelVoucherRefundPlan({db,sql,connect}) {
  await db.query(await sql('202701230028_event_funnel_voucher_refund_plan.sql'));
  const row=(await db.query(`SELECT b.* FROM event_funnel_order_booking b JOIN event_funnel_order o ON o.id=b.order_id
    WHERE b.voucher_minor>0 AND o.state='confirmed' AND o.snapshot->>'voucherAttributionVersion'='1' LIMIT 1`)).rows[0];
  assert.ok(row);
  const reserve=(client,id,amount)=>client.query('SELECT event_funnel_reversal_reserve($1,$2,$3,$4) r',
    [row.tenant_id,row.order_id,id,JSON.stringify([{source:row.booking_source,id:row.booking_id,
      cardMinor:0,invoiceMinor:0,trainingFundMinor:0,voucherMinor:amount}])]);
  const first=(await reserve(db,randomUUID(),1)).rows[0].r;
  assert.equal(first.voucher_plan.reduce((sum,p)=>sum+p.amountMinor,0),1);
  assert.ok(first.voucher_plan.every(p=>p.allocationId&&p.bookingId===row.booking_id));
  const ids=[randomUUID(),randomUUID()],peer=await connect(),remaining=Number(row.voucher_minor)-1;
  const race=await Promise.allSettled([reserve(db,ids[0],remaining),reserve(peer,ids[1],remaining)]);
  assert.equal(race.filter(r=>r.status==='fulfilled').length,1);
  const won=race.find(r=>r.status==='fulfilled').value.rows[0].r;
  assert.equal(won.voucher_plan.reduce((sum,p)=>sum+p.amountMinor,0),remaining);
  assert.deepEqual((await reserve(db,won.id,remaining)).rows[0].r.voucher_plan,won.voucher_plan);
  await assert.rejects(reserve(db,randomUUID(),1),{code:'PT409'});
}
