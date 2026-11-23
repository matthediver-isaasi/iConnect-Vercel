import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export async function exerciseFunnelConfirmationRetention({db,connect,sql}) {
  await db.query(await sql('202701230021_event_funnel_confirmation_retention.sql'));
  const original=(await db.query(`SELECT c.*,o.session_id FROM event_funnel_confirmation c
    JOIN event_funnel_order o ON o.tenant_id=c.tenant_id AND o.id=c.order_id WHERE c.state='delivered' LIMIT 1`)).rows[0];
  assert.ok(original);
  const session=randomUUID(),order=randomUUID(),booking=randomUUID();
  // Make a separate expired fixture, rather than modifying immutable live-style
  // session dates or disabling any identity/financial guard.
  await db.query(`INSERT INTO event_funnel_session SELECT (jsonb_populate_record(NULL::event_funnel_session,
    to_jsonb(s)||jsonb_build_object('id',$2::uuid,'created_at',now()-interval '4 days',
      'access_expires_at',now()-interval '3 days','retain_until',now()-interval '2 days',
      'first_reserved_at',NULL,'expires_at',NULL))).*
    FROM event_funnel_session s WHERE s.id=$1`,[original.session_id,session]);
  await db.query(`INSERT INTO event_funnel_order SELECT (jsonb_populate_record(NULL::event_funnel_order,
    to_jsonb(o)||jsonb_build_object('id',$2::uuid,'session_id',$3::uuid,'payment_intent_id',NULL))).*
    FROM event_funnel_order o WHERE o.id=$1`,[original.order_id,order,session]);
  await db.query(`INSERT INTO event_funnel_order_booking SELECT (jsonb_populate_record(NULL::event_funnel_order_booking,
    to_jsonb(b)||jsonb_build_object('order_id',$2::uuid,'booking_id',$3::uuid))).*
    FROM event_funnel_order_booking b WHERE tenant_id=$4 AND booking_source=$5 AND booking_id=$1`,
  [original.booking_id,order,booking,original.tenant_id,original.booking_source]);
  const candidates=[];
  for(const state of ['delivered','delivered','pending','writing','needs_review']) {
    const id=randomUUID();candidates.push({id,state});
    await db.query(`INSERT INTO event_funnel_confirmation SELECT (jsonb_populate_record(NULL::event_funnel_confirmation,
      to_jsonb(c)||jsonb_build_object('id',$2::uuid,'order_id',$3::uuid,'booking_id',$4::uuid,
        'template_id',$5::uuid,'state',$6::text,'delivered_at',CASE WHEN $6='delivered' THEN now()-interval '3 days' ELSE NULL END))).*
      FROM event_funnel_confirmation c WHERE id=$1`,[original.id,id,order,booking,randomUUID(),state]);
  }
  const before=(await db.query('SELECT snapshot FROM event_funnel_order WHERE id=$1',[order])).rows[0].snapshot;
  const peer=await connect();await peer.query('BEGIN');
  await peer.query('SELECT id FROM event_funnel_confirmation WHERE id=$1 FOR UPDATE',[candidates[0].id]);
  await db.query('SET ROLE service_role');
  // SKIP LOCKED lets concurrent maintenance make progress on the other row.
  assert.equal((await db.query('SELECT event_funnel_confirmation_prune(1) n')).rows[0].n,1);
  assert.equal((await db.query('SELECT event_funnel_confirmation_prune(100) n')).rows[0].n,0);
  await peer.query('COMMIT');
  assert.equal((await db.query('SELECT event_funnel_confirmation_prune(100) n')).rows[0].n,1);
  assert.equal((await db.query('SELECT event_funnel_confirmation_prune(100) n')).rows[0].n,0);
  for(const limit of [0,501,null]) await assert.rejects(db.query('SELECT event_funnel_confirmation_prune($1)',[limit]),{code:'22023'});
  await db.query('RESET ROLE');
  const rows=(await db.query('SELECT * FROM event_funnel_confirmation WHERE order_id=$1',[order])).rows;
  for(const row of rows) {
    if(row.state==='delivered') {
      assert.deepEqual(row.booking,{});assert.deepEqual(row.template,{});
      assert.equal(row.payload,null);assert.ok(row.redacted_at);assert.ok(row.delivered_at);
      assert.equal(row.message_id,original.message_id);
    } else {
      assert.deepEqual(row.payload,original.payload);assert.equal(row.redacted_at,null);
      assert.deepEqual(row.booking,original.booking);
    }
  }
  const unexpired=(await db.query('SELECT * FROM event_funnel_confirmation WHERE id=$1',[original.id])).rows[0];
  assert.equal(unexpired.redacted_at,null);assert.deepEqual(unexpired.payload,original.payload);
  assert.deepEqual((await db.query('SELECT snapshot FROM event_funnel_order WHERE id=$1',[order])).rows[0].snapshot,before);
  const lease=randomUUID();
  await db.query(`INSERT INTO event_funnel_delivery(tenant_id,order_id,kind,state,evidence,lease_token,lease_until)
    VALUES($1,$2,'integrations','delivered','{}',NULL,NULL),
      ($1,$2,'confirmations','running','{}',$3,now()+interval '2 minutes')`,[original.tenant_id,order,lease]);
  await db.query('SET ROLE service_role');
  assert.deepEqual((await db.query(`SELECT event_funnel_confirmation_operation($1,$2,$3,'begin',$4,'{}') r`,
    [original.tenant_id,order,lease,candidates[0].id])).rows[0].r,{status:'delivered'});
  for(const role of ['anon','authenticated']) {
    await db.query(`SET ROLE ${role}`);
    await assert.rejects(db.query('SELECT event_funnel_confirmation_prune(100)'),{code:'42501'});
  }
  await db.query('RESET ROLE');
}
