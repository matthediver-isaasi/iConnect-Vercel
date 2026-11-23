import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export async function exerciseFunnelReversalLedger({db,connect,sql}) {
  await db.query(await sql('202701230026_event_funnel_reversal_ledger.sql'));
  const row=(await db.query(`SELECT b.*,o.currency FROM event_funnel_order_booking b JOIN event_funnel_order o
    ON o.id=b.order_id AND o.tenant_id=b.tenant_id WHERE o.state='confirmed' AND o.payment_method='card' AND b.payable_minor>0 LIMIT 1`)).rows[0];
  assert.ok(row);
  const items=[{source:row.booking_source,id:row.booking_id,cardMinor:Number(row.payable_minor),invoiceMinor:0,trainingFundMinor:0,voucherMinor:0}];
  const peer=await connect(),ids=[randomUUID(),randomUUID()];
  const reserve=(client,id,values=items)=>client.query('SELECT event_funnel_reversal_reserve($1,$2,$3,$4) r',
    [row.tenant_id,row.order_id,id,JSON.stringify(values)]);
  await assert.rejects(reserve(db,randomUUID(),[items[0],{...items[0],id:row.booking_id.replaceAll('-','')}]),{code:'22023'});
  const results=await Promise.allSettled([reserve(db,ids[0]),reserve(peer,ids[1])]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const id=ids[results.findIndex(r=>r.status==='fulfilled')];
  assert.equal((await reserve(db,id)).rows[0].r.id,id);
  await assert.rejects(reserve(db,id,[{...items[0],cardMinor:0}]),{code:'PT409'});
  const action=(client,verb,receipt=null)=>client.query('SELECT event_funnel_reversal_card($1,$2,$3,$4,$5) ok',
    [row.tenant_id,row.order_id,id,verb,receipt]);
  const started=await Promise.all([action(db,'begin'),action(peer,'begin')]);
  assert.equal(started.filter(r=>r.rows[0].ok).length,1);
  // An uncertain write continues fencing the entire selected allocation.
  await assert.rejects(reserve(db,randomUUID()),{code:'PT409'});
  const receipt={id:'re_fixture',amountMinor:Number(row.payable_minor),currency:row.currency};
  await assert.rejects(action(db,'complete',{...receipt,amountMinor:receipt.amountMinor+1}),{code:'PT409'});
  assert.equal((await action(db,'complete',receipt)).rows[0].ok,true);
  assert.equal((await action(db,'complete',receipt)).rows[0].ok,true);
  assert.equal((await action(db,'complete',{...receipt,id:'other'})).rows[0].ok,false);
  for(const role of ['anon','authenticated','service_role']) {
    await db.query(`SET ROLE ${role}`);
    await assert.rejects(db.query('SELECT * FROM event_funnel_reversal'),{code:'42501'});
    if(role!=='service_role')await assert.rejects(reserve(db,id),{code:'42501'});
    else assert.equal((await reserve(db,id)).rows[0].r.id,id);
    await db.query('RESET ROLE');
  }
}
