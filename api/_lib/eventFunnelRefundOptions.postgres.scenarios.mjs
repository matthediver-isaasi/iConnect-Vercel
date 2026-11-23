import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export async function exerciseFunnelRefundOptions({db,sql,connect}){
  await db.query(await sql('202701230036_event_funnel_refund_options.sql'));
  const row=(await db.query(`SELECT * FROM event_funnel_reversal
    WHERE jsonb_array_length(voucher_plan)>0 AND cancelled_at IS NULL AND state='reserved' LIMIT 1`)).rows[0];
  assert.ok(row);
  const options={voucherReplacements:row.voucher_plan.map(p=>p.voucherId)
    .filter((value,index,array)=>array.indexOf(value)===index).map(voucherId=>({voucherId,newExpiryDate:'2100-01-01'}))};
  const call=(client,value,tenant=row.tenant_id)=>client.query(
    'SELECT event_funnel_reversal_authorize($1,$2,$3,$4,$5) result',
    [tenant,row.order_id,row.id,JSON.stringify(row.allocations),value]);
  await db.query('SET ROLE service_role');
  assert.deepEqual((await call(db,options)).rows[0].result.refund_options,options);
  const peer=await connect();await peer.query('SET ROLE service_role');
  const changed=structuredClone(options);changed.voucherReplacements[0].newExpiryDate='2101-01-01';
  const raced=await Promise.allSettled([call(db,options),call(peer,changed)]);
  assert.equal(raced[0].status,'fulfilled');assert.equal(raced[1].reason.code,'PT409');
  await assert.rejects(call(db,options,randomUUID()));
  await assert.rejects(call(db,{unapproved:true}),{code:'22023'});
  await assert.rejects(call(db,{voucherReplacements:[{voucherId:randomUUID(),newExpiryDate:'2100-01-01'}]}),{code:'PT409'});
  await db.query('RESET ROLE');
  for(const role of ['anon','authenticated']){
    await db.query(`SET ROLE ${role}`);await assert.rejects(call(db,options),{code:'42501'});await db.query('RESET ROLE');
  }
  const started=(await db.query(`SELECT * FROM event_funnel_reversal
    WHERE cancelled_at IS NOT NULL AND refund_options IS NULL LIMIT 1`)).rows[0];
  assert.ok(started);
  await assert.rejects(db.query('SELECT event_funnel_reversal_authorize($1,$2,$3,$4,$5)',
    [started.tenant_id,started.order_id,started.id,JSON.stringify(started.allocations),{}]),{code:'PT409'});
}
