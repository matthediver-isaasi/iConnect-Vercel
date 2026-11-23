import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export async function exerciseFunnelTrainingRefund({db,connect,sql}) {
  await db.query(await sql('202701230027_event_funnel_training_refunds.sql'));
  const row=(await db.query(`SELECT b.*,f.organization_id FROM event_funnel_order_booking b
    JOIN event_funnel_training_reservation f ON f.order_id=b.order_id AND f.tenant_id=b.tenant_id
    JOIN event_funnel_order o ON o.id=b.order_id WHERE f.state='committed' AND b.training_fund_minor>0
      AND o.payment_method='free' LIMIT 1`)).rows[0];
  assert.ok(row);
  const id=randomUUID(),items=[{source:row.booking_source,id:row.booking_id,cardMinor:0,invoiceMinor:0,
    trainingFundMinor:Number(row.training_fund_minor),voucherMinor:0}];
  await db.query('SELECT event_funnel_reversal_reserve($1,$2,$3,$4)',[row.tenant_id,row.order_id,id,JSON.stringify(items)]);
  const refund=client=>client.query('SELECT event_funnel_reversal_training($1,$2,$3) r',[row.tenant_id,row.order_id,id]);
  await assert.rejects(refund(db),{code:'PT409'});
  // Fixture only: model the separate authorized cancellation boundary. The
  // refund function itself must never bypass the production financial guard.
  assert.equal(row.booking_source,'booking');
  await db.query('ALTER TABLE booking DISABLE TRIGGER event_funnel_financial_guard');
  try {await db.query(`UPDATE booking SET status='cancelled' WHERE id=$1`,[row.booking_id]);}
  finally {await db.query('ALTER TABLE booking ENABLE TRIGGER event_funnel_financial_guard');}
  const balance=async()=>Number((await db.query('SELECT training_fund_balance FROM organization WHERE id=$1',[row.organization_id])).rows[0].training_fund_balance);
  const before=await balance();
  await db.query(`CREATE FUNCTION fixture_refund_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'refund audit unavailable';END $$;
    CREATE TRIGGER fixture_refund_failure BEFORE INSERT ON training_fund_transaction
    FOR EACH ROW EXECUTE FUNCTION fixture_refund_failure();`);
  await assert.rejects(refund(db),/refund audit unavailable/);assert.equal(await balance(),before);
  await db.query('DROP TRIGGER fixture_refund_failure ON training_fund_transaction; DROP FUNCTION fixture_refund_failure();');
  const peer=await connect();const results=await Promise.all([refund(db),refund(peer)]);
  assert.deepEqual(results[0].rows,results[1].rows);
  assert.equal(await balance(),before+Number(row.training_fund_minor)/100);
  await db.query('SET ROLE service_role');await refund(db);await db.query('RESET ROLE');
  for(const role of ['anon','authenticated']) {
    await db.query(`SET ROLE ${role}`);await assert.rejects(refund(db),{code:'42501'});await db.query('RESET ROLE');
  }
}
