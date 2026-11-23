import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export async function exerciseFunnelReversalRecovery({db,sql}) {
  await db.query(await sql('202701230030_event_funnel_reversal_recovery.sql'));
  const row=(await db.query(`SELECT * FROM event_funnel_reversal WHERE jsonb_array_length(voucher_plan)>0 LIMIT 1`)).rows[0];
  assert.ok(row);
  const part=row.voucher_plan[0],receipt={voucherId:part.voucherId,cumulativeMinor:part.amountMinor,amountMinor:part.amountMinor};
  const save=value=>db.query('SELECT event_funnel_reversal_voucher_receipt($1,$2,$3,$4,$5) ok',
    [row.tenant_id,row.order_id,row.id,part.allocationId,value]);
  await assert.rejects(save(receipt),{code:'PT409'});
  // Seed accepted authority for this receipt-unit test. The cancellation
  // transaction itself is covered separately, not bypassed in application code.
  await db.query('UPDATE event_funnel_reversal SET cancelled_at=now() WHERE id=$1',[row.id]);
  await db.query('SET ROLE service_role');
  const context=(await db.query('SELECT event_funnel_reversal_context($1,$2) r',[row.tenant_id,row.order_id])).rows[0].r;
  assert.equal(context.order.id,row.order_id);assert.ok(context.history.some(r=>r.id===row.id));
  await assert.rejects(db.query('SELECT event_funnel_reversal_context($1,$2)',[randomUUID(),row.order_id]),{code:'PT404'});
  await assert.rejects(save({...receipt,cumulativeMinor:receipt.cumulativeMinor+1}),{code:'PT409'});
  assert.equal((await save(receipt)).rows[0].ok,true);
  assert.equal((await save(receipt)).rows[0].ok,true);
  assert.equal((await save({...receipt,voucherId:randomUUID()})).rows[0].ok,false);
  await db.query('RESET ROLE');
  for(const role of ['anon','authenticated']){
    await db.query(`SET ROLE ${role}`);
    await assert.rejects(save(receipt),{code:'42501'});
    await assert.rejects(db.query('SELECT event_funnel_reversal_context($1,$2)',[row.tenant_id,row.order_id]),{code:'42501'});
    await db.query('RESET ROLE');
  }
}
