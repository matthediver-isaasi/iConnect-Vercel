import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {runFunnelReversalWorker} from './eventFunnelReversalWorker.js';
export async function exerciseFunnelCancellationApproval({db,sql,connect}){
  // Existing application table: the isolated inventory fixture did not need it
  // before approval tests. This is not a representative baseline rehearsal.
  await db.query(`CREATE TABLE booking_cancellation_request(
    id uuid PRIMARY KEY,tenant_id uuid,booking_id uuid,booking_source text,status text DEFAULT 'pending',
    reviewed_by text,reviewed_at timestamptz,review_notes text)`);
  await db.query(await sql('202701230039_event_funnel_cancellation_approval.sql'));
  const b=(await db.query(`SELECT b.* FROM event_funnel_order_booking b
    JOIN booking r ON r.id=b.booking_id AND r.tenant_id=b.tenant_id AND r.status='confirmed'
    JOIN event_funnel_inventory_evidence i ON i.order_id=b.order_id AND i.event_id=b.event_id
    WHERE b.booking_source='booking' AND b.payable_minor=0 AND b.training_fund_minor=0 AND b.voucher_minor=0
      AND NOT EXISTS(SELECT 1 FROM event_funnel_reversal x WHERE x.order_id=b.order_id) LIMIT 1`)).rows[0];
  assert.ok(b,'An unused committed registration with real inventory evidence is required');
  const request=randomUUID(),id=randomUUID(),actor=randomUUID();
  const items=[{source:b.booking_source,id:b.booking_id,cardMinor:0,invoiceMinor:0,trainingFundMinor:0,voucherMinor:0}];
  const authority={actor:`user:${actor}`,reviewer:'Isolated reviewer',reviewNotes:null,suppressEmails:true};
  await db.query('INSERT INTO booking_cancellation_request(id,tenant_id,booking_id) VALUES($1,$2,$3)',
    [request,b.tenant_id,b.booking_id]);
  const approve=(client,override={})=>client.query(
    'SELECT event_funnel_approve_cancellation($1,$2,$3,$4,$5,$6,$7) result',
    [override.tenant||b.tenant_id,b.order_id,override.id||id,[request],JSON.stringify(items),{},override.authority||authority]);
  await assert.rejects(db.query(`UPDATE booking_cancellation_request SET status='approved' WHERE id=$1`,[request]),{code:'PT409'});
  await assert.rejects(approve(db,{tenant:randomUUID()}),{code:'PT404'});
  const standalone=randomUUID();
  await db.query('INSERT INTO booking_cancellation_request(id,tenant_id,booking_id) VALUES($1,$2,$3)',
    [standalone,b.tenant_id,randomUUID()]);
  await db.query(`UPDATE booking_cancellation_request SET status='approved' WHERE id=$1`,[standalone]);
  await db.query(`CREATE FUNCTION fixture_approval_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'cleanup checkpoint unavailable';END $$;
    CREATE TRIGGER fixture_approval_failure BEFORE INSERT ON event_funnel_cancellation_cleanup
      FOR EACH ROW EXECUTE FUNCTION fixture_approval_failure()`);
  await assert.rejects(approve(db),/cleanup checkpoint/);
  await db.query('DROP TRIGGER fixture_approval_failure ON event_funnel_cancellation_cleanup; DROP FUNCTION fixture_approval_failure()');
  assert.equal((await db.query('SELECT status FROM booking WHERE id=$1',[b.booking_id])).rows[0].status,'confirmed');
  assert.equal((await db.query('SELECT status FROM booking_cancellation_request WHERE id=$1',[request])).rows[0].status,'pending');
  assert.equal((await db.query('SELECT count(*)::int n FROM event_funnel_reversal WHERE id=$1',[id])).rows[0].n,0);
  for(const role of ['anon','authenticated']){
    await db.query(`SET ROLE ${role}`);await assert.rejects(approve(db),{code:'42501'});await db.query('RESET ROLE');
  }
  const peer=await connect();
  await db.query('BEGIN');await db.query('SET LOCAL ROLE service_role');
  const accepted=(await approve(db)).rows[0].result;
  assert.equal(accepted.requires_cleanup,true);assert.ok(accepted.cancelled_at);
  // Reproduce a legacy reviewer whose unconditional rejection waits behind
  // approval. It must see the new binding after the row lock becomes available.
  const rejection=assert.rejects(peer.query(`UPDATE booking_cancellation_request SET status='rejected' WHERE id=$1`,[request]),{code:'PT409'});
  await new Promise(resolve=>setTimeout(resolve,20));
  await db.query('COMMIT');await rejection;
  await db.query('SET ROLE service_role');
  const replay=(await approve(db)).rows[0].result;assert.equal(replay.id,id);
  await assert.rejects(approve(db,{id:randomUUID()}),{code:'PT409'});
  await assert.rejects(approve(db,{authority:{...authority,suppressEmails:false}}),{code:'PT409'});
  const claimed=(await db.query('SELECT event_funnel_reversal_claim($1,$2) job',[b.tenant_id,id])).rows[0].job;
  const complete={card:'not_applicable',training:'not_applicable',voucher:'not_applicable',credit:'not_applicable',cleanup:'complete'};
  await assert.rejects(db.query('SELECT event_funnel_reversal_finish($1,$2,$3,$4,$5)',
    [b.tenant_id,b.order_id,id,claimed.lease_id,complete]),{code:'PT409'});
  await db.query('RESET ROLE');
  await db.query(`UPDATE event_funnel_reversal SET lease_until=now()-interval '1 second' WHERE id=$1`,[id]);
  const adapter={rpc:async(name,args)=>{
    const keys={
      event_funnel_reversal_claim:['p_tenant','p_id'],
      event_funnel_reversal_context:['p_tenant','p_order'],
      event_funnel_cancellation_cleanup_quiet:['p_tenant','p_order','p_id','p_lease'],
      event_funnel_cancellation_message_operation:['p_tenant','p_order','p_id','p_lease','p_action','p_message','p_payload'],
      event_funnel_zoom_revoke:['p_tenant','p_order','p_reversal','p_lease','p_action','p_registration','p_epoch'],
      event_funnel_credit_email_operation:['p_tenant','p_order','p_reversal','p_lease','p_action','p_message','p_payload'],
      event_funnel_reversal_training:['p_tenant','p_order','p_id'],
      event_funnel_reversal_finish:['p_tenant','p_order','p_id','p_lease','p_outcomes'],
    }[name];
    assert.ok(keys,`Unexpected recovery call ${name}`);
    try{return {data:(await db.query(`SELECT to_jsonb(${name}(${keys.map((_,index)=>`$${index+1}`).join(',')})) result`,
      keys.map(key=>args[key]))).rows[0].result};}catch(error){return {error};}
  }};
  await db.query('SET ROLE service_role');
  const recovery=await runFunnelReversalWorker({db:adapter,tenantId:b.tenant_id,operationId:id});
  assert.equal(recovery.status,'needs_review');assert.equal(recovery.outcomes.cleanup,'needs_review');
  await db.query('RESET ROLE');
  assert.equal((await db.query('SELECT status FROM booking_cancellation_request WHERE id=$1',[request])).rows[0].status,'approved');
  assert.equal((await db.query('SELECT state FROM event_funnel_cancellation_cleanup WHERE reversal_id=$1',[id])).rows[0].state,'pending');
  await assert.rejects(db.query('DELETE FROM booking_cancellation_request WHERE id=$1',[request]),{code:'PT409'});
  await db.query('SET ROLE service_role');
  for(const table of ['event_funnel_cancellation_cleanup','event_funnel_cancellation_approval'])
    await assert.rejects(db.query(`SELECT * FROM ${table}`),{code:'42501'});
  await db.query('RESET ROLE');
}
