import assert from 'node:assert/strict';
export async function exerciseFunnelReversalWorker({db,sql,connect}){
  await db.query(await sql('202701230037_event_funnel_reversal_worker.sql'));
  const row=(await db.query('SELECT * FROM event_funnel_reversal WHERE refund_options IS NOT NULL LIMIT 1')).rows[0];
  assert.ok(row);
  const peer=await connect();await peer.query('SET ROLE service_role');await db.query('SET ROLE service_role');
  const claim=client=>client.query('SELECT event_funnel_reversal_claim($1,$2) job',[row.tenant_id,row.id]);
  const race=await Promise.all([claim(db),claim(peer)]);
  const claimed=race.map(result=>result.rows[0].job).filter(Boolean);
  assert.equal(claimed.length,1);
  const first=claimed[0];
  await db.query('RESET ROLE');
  await db.query(`UPDATE event_funnel_reversal SET lease_until=now()-interval '1 second' WHERE id=$1`,[row.id]);
  await db.query('SET ROLE service_role');
  const second=(await claim(db)).rows[0].job;assert.notEqual(first.lease_id,second.lease_id);
  const finish=(lease,state)=>db.query('SELECT event_funnel_reversal_finish($1,$2,$3,$4,$5) ok',
    [row.tenant_id,row.order_id,row.id,lease,Object.fromEntries(['card','training','voucher','credit'].map(key=>[key,state]))]);
  assert.equal((await finish(first.lease_id,'retry')).rows[0].ok,false);
  await assert.rejects(finish(second.lease_id,'complete'),{code:'PT409'});
  assert.equal((await finish(second.lease_id,'retry')).rows[0].ok,true);
  assert.equal((await claim(db)).rows[0].job,null);
  await db.query('RESET ROLE');
  // Completion-gate fixture: accepted stock cancellation and individually
  // recorded voucher receipts, not a claim that live funds were transferred.
  await db.query(`UPDATE event_funnel_reversal SET cancelled_at=now(),stock_receipt='[]',
    next_attempt_at=now() WHERE id=$1`,[row.id]);
  await db.query('SET ROLE service_role');
  const groups=new Map();
  for(const part of row.voucher_plan){
    const group=groups.get(part.allocationId)||{voucherId:part.voucherId,amount:0};
    group.amount+=part.amountMinor;groups.set(part.allocationId,group);
  }
  for(const [allocationId,group] of groups)await db.query(
    'SELECT event_funnel_reversal_voucher_receipt($1,$2,$3,$4,$5)',
    [row.tenant_id,row.order_id,row.id,allocationId,
      {voucherId:group.voucherId,cumulativeMinor:group.amount,amountMinor:group.amount}]);
  const ready=(await claim(db)).rows[0].job;
  assert.equal((await finish(ready.lease_id,'complete')).rows[0].ok,true);
  assert.equal((await claim(db)).rows[0].job,null);
  await db.query('RESET ROLE');
  for(const role of ['anon','authenticated']){
    await db.query(`SET ROLE ${role}`);await assert.rejects(claim(db),{code:'42501'});await db.query('RESET ROLE');
  }
}
