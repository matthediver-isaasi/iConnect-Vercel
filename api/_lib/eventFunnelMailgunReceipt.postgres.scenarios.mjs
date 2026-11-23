import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export async function exerciseFunnelMailgunReceipt({db,sql}) {
  await db.query(await sql('202701230024_event_funnel_confirmation_receipts.sql'));
  const row=(await db.query(`SELECT * FROM event_funnel_confirmation WHERE redacted_at IS NULL AND payload IS NOT NULL LIMIT 1`)).rows[0];
  assert.ok(row);const lease=randomUUID();
  await db.query(`UPDATE event_funnel_confirmation SET state='writing',attempt_token=$2,message_id=NULL,delivered_at=NULL WHERE id=$1`,[row.id,lease]);
  await db.query(`UPDATE event_funnel_delivery SET state='running',lease_token=$3,lease_until=now()+interval '2 minutes'
    WHERE tenant_id=$1 AND order_id=$2 AND kind='confirmations'`,[row.tenant_id,row.order_id,lease]);
  const receive=async({nonce=row.receipt_token,recipient=row.payload.to,event='accepted',at='2027-01-01T00:00:00Z',message='fixture-message'}={})=>
    (await db.query(`SELECT event_funnel_confirmation_receipt($1,$2,$3,$4,$5,$6) saved`,
      [row.id,nonce,recipient,message,event,at])).rows[0].saved;
  await db.query('SET ROLE service_role');
  assert.equal(await receive({nonce:randomUUID()}),false);
  assert.equal(await receive({recipient:'other@example.test'}),false);
  assert.equal(await receive(),true);assert.equal(await receive(),true);
  // A webhook may win the race against the sender's synchronous finish.
  await db.query(`SELECT event_funnel_confirmation_operation($1,$2,$3,'finish',$4,'{\"outcome\":\"unknown\"}')`,
    [row.tenant_id,row.order_id,lease,row.id]);
  assert.equal(await receive({message:'different-message'}),false);
  assert.equal(await receive({event:'failed',at:'2027-01-02T00:00:00Z'}),true);
  assert.equal(await receive(),true); // older acceptance cannot erase a failure
  await db.query('RESET ROLE');
  let saved=(await db.query('SELECT * FROM event_funnel_confirmation WHERE id=$1',[row.id])).rows[0];
  assert.equal(saved.state,'needs_review');assert.equal(saved.provider_delivery_state,'failed');
  await db.query('SET ROLE service_role');
  assert.equal(await receive({event:'delivered',at:'2027-01-03T00:00:00Z'}),true);
  for(const role of ['anon','authenticated']){
    await db.query(`SET ROLE ${role}`);await assert.rejects(receive(),{code:'42501'});
  }
  await db.query('RESET ROLE');
  saved=(await db.query('SELECT * FROM event_funnel_confirmation WHERE id=$1',[row.id])).rows[0];
  assert.equal(saved.state,'delivered');assert.equal(saved.provider_delivery_state,'delivered');
}
