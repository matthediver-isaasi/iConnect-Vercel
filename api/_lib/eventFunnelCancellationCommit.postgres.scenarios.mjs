import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export async function exerciseFunnelCancellationCommit({db,connect,sql}) {
  // The inventory harness models commercial capacity without its booking-link
  // table. Supply that boundary here; this is not a full baseline rehearsal.
  await db.query('CREATE TABLE sales_commercial_allocation_booking(tenant_id uuid,booking_id uuid,booking_kind text)');
  await db.query(await sql('202701230029_event_funnel_cancellation_commit.sql'));
  const rows=(await db.query(`SELECT b.*,e.capacity_mode,e.available_seats FROM event_funnel_order_booking b
    JOIN event_funnel_inventory_evidence i ON i.order_id=b.order_id AND i.event_id=b.event_id
    JOIN event e ON e.id=b.event_id WHERE i.legacy_debit_places>0 ORDER BY e.capacity_mode`)).rows;
  assert.equal(rows.length,2);
  for(const row of rows) {
    const id=randomUUID(),items=[{source:row.booking_source,id:row.booking_id,cardMinor:0,invoiceMinor:0,trainingFundMinor:0,voucherMinor:0}];
    await db.query('SELECT event_funnel_reversal_reserve($1,$2,$3,$4)',[row.tenant_id,row.order_id,id,JSON.stringify(items)]);
    const cancel=client=>client.query('SELECT event_funnel_reversal_cancel($1,$2,$3) r',[row.tenant_id,row.order_id,id]);
    assert.equal((await db.query(`SELECT event_funnel_reversal_card($1,$2,$3,'begin') ok`,[row.tenant_id,row.order_id,id])).rows[0].ok,false);
    await db.query(`CREATE FUNCTION fixture_cancellation_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'cancellation checkpoint unavailable';END $$;
      CREATE TRIGGER fixture_cancellation_failure AFTER UPDATE ON booking
      FOR EACH ROW EXECUTE FUNCTION fixture_cancellation_failure();`);
    await assert.rejects(cancel(db),/cancellation checkpoint unavailable/);
    await db.query('DROP TRIGGER fixture_cancellation_failure ON booking; DROP FUNCTION fixture_cancellation_failure();');
    assert.equal((await db.query('SELECT status FROM booking WHERE id=$1',[row.booking_id])).rows[0].status,'confirmed');
    const peer=await connect();const result=await Promise.all([cancel(db),cancel(peer)]);
    assert.deepEqual(result[0].rows,result[1].rows);
    assert.equal(result[0].rows[0].r[0].counterIncrement,row.capacity_mode==='legacy'?1:0);
    const event=(await db.query('SELECT available_seats FROM event WHERE id=$1',[row.event_id])).rows[0];
    assert.equal(event.available_seats,row.capacity_mode==='legacy'?row.available_seats+1:null);
    await assert.rejects(db.query(`UPDATE booking SET status='confirmed' WHERE id=$1`,[row.booking_id]),{code:'PT409'});
    await db.query('SET ROLE service_role');await cancel(db);await db.query('RESET ROLE');
    for(const role of ['anon','authenticated']) {
      await db.query(`SET ROLE ${role}`);await assert.rejects(cancel(db),{code:'42501'});await db.query('RESET ROLE');
    }
  }
}
