import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {exerciseFunnelInventoryEvidence} from './eventFunnelInventoryEvidence.postgres.scenarios.mjs';
import {runFunnelReversalWorker} from './eventFunnelReversalWorker.js';
import {approveFunnelCancellation} from './eventFunnelCancellationApproval.js';

export async function exerciseFunnelCancelledDelivery({db,sql,connect,tenant,member}){
  await db.query(await sql('202701230040_event_funnel_cancelled_delivery.sql'));
  const [mail,zoom]=await exerciseFunnelInventoryEvidence({db,sql,tenant,member,install:false,
    variants:['total','legacy_unchanged'],bookingCount:2});
  const lease=async(scope,kind)=>{
    const token=randomUUID();
    await db.query(`UPDATE event_funnel_delivery SET state='running',lease_token=$3,lease_until=now()+interval '2 minutes'
      WHERE tenant_id=$1 AND order_id=$2 AND kind=$4`,[tenant,scope.order,token,kind]);
    return token;
  };
  const integration=async(scope,token,action='read',id=null,rows=null)=>(await db.query(
    'SELECT event_funnel_integration_operation($1,$2,$3,$4,$5,$6) r',
    [tenant,scope.order,token,action,id,rows===null?null:JSON.stringify(rows)])).rows[0].r;
  const provider=async(scope,token,step,action,id=null,payload=null)=>(await db.query(
    'SELECT event_funnel_zoom_operation($1,$2,$3,$4,$5,$6,$7) r',
    [tenant,scope.order,token,step,action,id,payload===null?null:JSON.stringify(payload)])).rows[0].r;
  const request=async(scope)=>{
    const id=randomUUID(),operation=randomUUID();
    await db.query('INSERT INTO booking_cancellation_request(id,tenant_id,booking_id) VALUES($1,$2,$3)',
      [id,tenant,scope.bookingIds[0]]);
    return client=>client.query('SELECT event_funnel_approve_cancellation($1,$2,$3,$4,$5,$6,$7)',
      [tenant,scope.order,operation,[id],JSON.stringify([{source:'booking',id:scope.bookingIds[0],
        cardMinor:0,invoiceMinor:0,trainingFundMinor:0,voucherMinor:0}]),{},
        {actor:`user:${member}`,reviewer:'Isolated reviewer',suppressEmails:true}]);
  };
  const integrationToken=await lease(mail,'integrations');
  const steps=(await integration(mail,integrationToken)).jobs;
  for(const step of steps){
    if(step.step==='providers')await provider(mail,integrationToken,step.id,'plan',null,[]);
    await integration(mail,integrationToken,'finish',step.id,step.step==='notifications'?[]:null);
  }
  assert.equal((await integration(mail,integrationToken)).status,'delivered');
  await db.query(`SELECT event_funnel_delivery_finish($1,$2,'integrations',$3,'delivered')`,
    [tenant,mail.order,integrationToken]);
  for(let i=0;i<2;i++)await db.query(`INSERT INTO event_email VALUES($1,$2,$3,'confirmation',true,'Fixture','Fixture',NULL)`,
    [randomUUID(),tenant,mail.event]);
  const mailToken=await lease(mail,'confirmations');
  const confirmation=async(client,action='read',id=null,payload=null)=>(await client.query(
    'SELECT event_funnel_confirmation_operation($1,$2,$3,$4,$5,$6) r',
    [tenant,mail.order,mailToken,action,id,payload])).rows[0].r;
  const jobs=(await confirmation(db)).jobs;assert.equal(jobs.length,4);
  const targets=jobs.filter(j=>j.booking_id===mail.bookingIds[0]),envelope={tenantId:tenant,to:'fixture@example.test'};
  assert.equal((await confirmation(db,'begin',targets[0].id,envelope)).status,'send');
  const approve=await request(mail);
  const reminder=randomUUID(),foreignTemplate=randomUUID();
  await db.query(`INSERT INTO event_email VALUES($1,$2,$3,'reminder',true,'Fixture','Fixture',NULL),
    ($4,$5,$3,'reminder',true,'Foreign fixture','Foreign fixture',NULL)`,
    [reminder,tenant,mail.event,foreignTemplate,randomUUID()]);
  const scheduled=[];
  for(const [bookingId,status,template,source] of [
    [mail.bookingIds[0],'pending',reminder,null],
    [mail.bookingIds[0],'failed',reminder,null],
    [mail.bookingIds[0],'sent',reminder,null],
    [mail.bookingIds[1],'pending',reminder,null],
    [mail.bookingIds[0],'pending',foreignTemplate,null],
    [mail.bookingIds[0],'pending',reminder,'complex_event_booking'],
  ]){
    const id=randomUUID();scheduled.push(id);
    await db.query(`INSERT INTO scheduled_email(id,event_email_id,booking_id,status,follow_up_booking_table,
      follow_up_target_key,scheduled_send_time) VALUES($1::uuid,$2,$3,$4,$5,($1::uuid)::text,now())`,
      [id,template,bookingId,status,source]);
  }
  await db.query(`CREATE FUNCTION fixture_suppression_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.state='cancelled' THEN RAISE EXCEPTION 'suppression unavailable';END IF;RETURN NEW;END $$;
    CREATE TRIGGER fixture_suppression_failure BEFORE UPDATE ON event_funnel_confirmation
      FOR EACH ROW EXECUTE FUNCTION fixture_suppression_failure()`);
  await assert.rejects(approve(db),/suppression unavailable/);
  assert.equal((await db.query('SELECT status FROM booking WHERE id=$1',[mail.bookingIds[0]])).rows[0].status,'confirmed');
  await db.query('DROP TRIGGER fixture_suppression_failure ON event_funnel_confirmation;DROP FUNCTION fixture_suppression_failure()');
  await db.query('BEGIN');await approve(db);
  const peer=await connect();await peer.query('SET ROLE service_role');
  const lateBegin=confirmation(peer,'begin',targets[1].id,envelope);
  await new Promise(resolve=>setTimeout(resolve,20));await db.query('COMMIT');
  assert.notEqual((await lateBegin).status,'send');
  const reminderStates=(await db.query('SELECT id,status FROM scheduled_email WHERE id=ANY($1)',[scheduled])).rows;
  assert.deepEqual(scheduled.map(id=>reminderStates.find(row=>row.id===id).status),
    ['cancelled','failed','sent','pending','pending','pending']);
  const states=(await db.query('SELECT id,state FROM event_funnel_confirmation WHERE order_id=$1',[mail.order])).rows;
  assert.equal(states.find(c=>c.id===targets[0].id).state,'writing','Do not erase an admitted send');
  assert.equal(states.find(c=>c.id===targets[1].id).state,'cancelled');
  assert.equal((await confirmation(db)).jobs.length,2,'The other registration still receives its messages');
  await confirmation(db,'finish',targets[0].id,{outcome:'not_submitted'});
  await confirmation(db);
  assert.equal((await db.query('SELECT state FROM event_funnel_confirmation WHERE id=$1',[targets[0].id])).rows[0].state,'cancelled');

  const zoomToken=await lease(zoom,'integrations'),zoomSteps=(await integration(zoom,zoomToken)).jobs;
  const step=zoomSteps.find(s=>s.booking_id===zoom.bookingIds[0]&&s.step==='providers');
  const local=randomUUID(),numeric='12345678901';
  await db.query('INSERT INTO zoom_meeting(id,tenant_id,zoom_meeting_id) VALUES($1,$2,$3)',[local,tenant,numeric]);
  await db.query('UPDATE event SET zoom_meeting_id=$1 WHERE id=$2',[local,zoom.event]);
  const target={localId:local,kind:'meetings',numericId:numeric,authorityHash:'c'.repeat(64)};
  const plan=await provider(zoom,zoomToken,step.id,'plan',null,[target]);
  const registration=plan.jobs[0];assert.ok(registration);
  assert.equal((await provider(zoom,zoomToken,step.id,'begin',registration.id)).write,true);
  await (await request(zoom))(db);
  await assert.rejects(provider(zoom,zoomToken,step.id,'begin',registration.id),{code:'PT409'});
  await assert.rejects(provider(zoom,zoomToken,step.id,'plan',null,[target]),{code:'PT409'});
  await provider(zoom,zoomToken,step.id,'observed',registration.id,{outcome:'approved',registrantId:'late-fixture-registrant'});
  assert.equal((await db.query('SELECT registrant_id FROM event_funnel_zoom_registration WHERE id=$1',[registration.id])).rows[0].registrant_id,
    'late-fixture-registrant','Keep late receipts for access revocation');
  assert.deepEqual(await integration(zoom,zoomToken,'finish',step.id),{saved:true,cancelled:true});
  const remaining=await integration(zoom,zoomToken);
  assert.equal(remaining.jobs.length,3);
  assert.ok(remaining.jobs.every(s=>s.booking_id===zoom.bookingIds[1]));
  // No caller can use the private suppression primitive to bypass approval.
  for(const role of ['anon','authenticated','service_role']){
    await db.query(`SET ROLE ${role}`);
    await assert.rejects(db.query('SELECT event_funnel_suppress_cancelled_delivery($1,$2)',[tenant,zoom.order]),{code:'42501'});
    await db.query('RESET ROLE');
  }
  await db.query(await sql('202701230041_event_funnel_cleanup_completion.sql'));
  await db.query(await sql('202701230042_event_funnel_cancellation_notifications.sql'));
  await db.query(await sql('202701230043_event_funnel_shared_zoom_cleanup.sql'));
  await db.query(await sql('202701230044_event_funnel_zoom_revocation.sql'));
  await db.query(await sql('202701230045_event_funnel_credit_emails.sql'));
  const reversal=(await db.query('SELECT id FROM event_funnel_reversal WHERE order_id=$1',[mail.order])).rows[0].id;
  await db.query('SET ROLE service_role');
  const claim=(await db.query('SELECT event_funnel_reversal_claim($1,$2) r',[tenant,reversal])).rows[0].r;
  const quiet=async(token=claim.lease_id)=>(await db.query(
    'SELECT event_funnel_cancellation_cleanup_quiet($1,$2,$3,$4) r',
    [tenant,mail.order,reversal,token])).rows[0].r;
  assert.equal((await quiet()).reason,'delivery_reconciliation_required');
  await assert.rejects(quiet(randomUUID()),{code:'PT409'});
  await db.query('RESET ROLE');
  // This row was deliberately seeded as unknown above; no message was sent.
  // Model reconciliation of that synthetic attempt, not a production override.
  await db.query(`UPDATE scheduled_email SET status='cancelled' WHERE id=$1`,[scheduled[1]]);
  await db.query('SET ROLE service_role');
  const cleaned=await quiet();assert.equal(cleaned.status,'complete');
  assert.equal(cleaned.receipt.providers,'verified_absent');
  assert.deepEqual(await quiet(),cleaned);
  await db.query('RESET ROLE');
  await db.query(`UPDATE event_funnel_reversal SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`,[reversal]);
  const adapter={rpc:async(name,args)=>{
    const keys={
      event_funnel_reversal_claim:['p_tenant','p_id'],
      event_funnel_reversal_context:['p_tenant','p_order'],
      event_funnel_reversal_training:['p_tenant','p_order','p_id'],
      event_funnel_cancellation_cleanup_quiet:['p_tenant','p_order','p_id','p_lease'],
      event_funnel_cancellation_message_operation:['p_tenant','p_order','p_id','p_lease','p_action','p_message','p_payload'],
      event_funnel_zoom_revoke:['p_tenant','p_order','p_reversal','p_lease','p_action','p_registration','p_epoch'],
      event_funnel_credit_email_operation:['p_tenant','p_order','p_reversal','p_lease','p_action','p_message','p_payload'],
      event_funnel_reversal_finish:['p_tenant','p_order','p_id','p_lease','p_outcomes'],
      event_funnel_consume_limit:['p_tenant','p_actor'],
      event_funnel_invoice_report:['p_tenant','p_bookings'],
      event_funnel_approve_cancellation:['p_tenant','p_order','p_id','p_requests','p_items','p_options','p_authority'],
    }[name];
    assert.ok(keys,`Unexpected cleanup RPC ${name}`);
    try{return {data:(await db.query(`SELECT to_jsonb(${name}(${keys.map((_,i)=>`$${i+1}`).join(',')})) r`,
      keys.map(key=>['p_bookings','p_items'].includes(key)?JSON.stringify(args[key]):args[key]))).rows[0].r};}catch(error){return {error};}
  }};
  await db.query('SET ROLE service_role');
  const recovered=await runFunnelReversalWorker({db:adapter,tenantId:tenant,operationId:reversal});
  assert.equal(recovered.status,'complete');assert.equal(recovered.outcomes.cleanup,'complete');
  await assert.rejects(quiet(),{code:'PT409'});
  await db.query('RESET ROLE');
  assert.equal((await db.query('SELECT status FROM booking WHERE id=$1',[mail.bookingIds[1]])).rows[0].status,'confirmed');
  const zoomReversal=(await db.query('SELECT id FROM event_funnel_reversal WHERE order_id=$1',[zoom.order])).rows[0].id;
  await db.query('SET ROLE service_role');
  const zoomClaim=(await db.query('SELECT event_funnel_reversal_claim($1,$2) r',[tenant,zoomReversal])).rows[0].r;
  const unresolved=(await db.query('SELECT event_funnel_cancellation_cleanup_quiet($1,$2,$3,$4) r',
    [tenant,zoom.order,zoomReversal,zoomClaim.lease_id])).rows[0].r;
  assert.equal(unresolved.status,'needs_review');assert.equal(unresolved.reason,'provider_receipts_required');
  await db.query('RESET ROLE');
  for(const role of ['anon','authenticated']){
    await db.query(`SET ROLE ${role}`);await assert.rejects(quiet(),{code:'42501'});await db.query('RESET ROLE');
  }
  const [notificationScope]=await exerciseFunnelInventoryEvidence({db,sql,tenant,member,install:false,variants:['total']});
  const notificationRequest=randomUUID(),notificationOperation=randomUUID();
  await db.query('INSERT INTO booking_cancellation_request(id,tenant_id,booking_id) VALUES($1,$2,$3)',
    [notificationRequest,tenant,notificationScope.bookingIds[0]]);
  await db.query('SELECT event_funnel_approve_cancellation($1,$2,$3,$4,$5,$6,$7)',
    [tenant,notificationScope.order,notificationOperation,[notificationRequest],JSON.stringify([{
      source:'booking',id:notificationScope.bookingIds[0],cardMinor:0,invoiceMinor:0,trainingFundMinor:0,voucherMinor:0}]),{},
      {actor:`user:${member}`,reviewer:'Fixture reviewer',suppressEmails:false}]);
  await db.query('SET ROLE service_role');
  const messageClaim=(await db.query('SELECT event_funnel_reversal_claim($1,$2) r',[tenant,notificationOperation])).rows[0].r;
  const messageCall=async(action,id=null,payload=null,token=messageClaim.lease_id)=>(await db.query(
    'SELECT event_funnel_cancellation_message_operation($1,$2,$3,$4,$5,$6,$7) r',
    [tenant,notificationScope.order,notificationOperation,token,action,id,payload])).rows[0].r;
  const messages=await messageCall('read');assert.equal(messages.jobs.length,1,'Same attendee/purchaser email is deduplicated');
  const message=messages.jobs[0];assert.equal(message.recipient,'fixture@example.test');
  const payload={to:message.recipient,tenantId:tenant,subject:'Fixture',html:'Fixture'};
  await assert.rejects(messageCall('begin',message.id,{...payload,to:'foreign@example.test'}));
  await db.query('BEGIN');await db.query('SAVEPOINT uncertain_message');
  await messageCall('begin',message.id,payload);
  await messageCall('finish',message.id,{outcome:'unknown'});
  assert.equal((await messageCall('read')).status,'needs_review');
  assert.equal((await messageCall('begin',message.id,payload)).status,'needs_review');
  await db.query('ROLLBACK TO SAVEPOINT uncertain_message');await db.query('COMMIT');
  assert.equal((await messageCall('begin',message.id,payload)).status,'send');
  assert.equal((await messageCall('begin',message.id,payload)).status,'needs_review');
  await messageCall('finish',message.id,{outcome:'not_submitted'});
  const frozen=await messageCall('begin',message.id,{...payload,html:'Changed'});
  assert.equal(frozen.payload.html,'Fixture');
  await messageCall('finish',message.id,{outcome:'accepted',messageId:'fixture-message'});
  assert.equal((await messageCall('read')).status,'complete');
  assert.equal((await messageCall('begin',message.id,payload)).status,'complete');
  await assert.rejects(messageCall('read',null,null,randomUUID()),{code:'PT409'});
  await assert.rejects(db.query('SELECT * FROM event_funnel_cancellation_message'),{code:'42501'});
  await db.query('RESET ROLE');
  for(const role of ['anon','authenticated']){
    await db.query(`SET ROLE ${role}`);
    await assert.rejects(messageCall('read'),{code:'42501'});
    await db.query('RESET ROLE');
  }
  const otherStep=zoomSteps.find(s=>s.booking_id===zoom.bookingIds[1]&&s.step==='providers');
  await provider(zoom,zoomToken,otherStep.id,'plan',null,[target]);
  const retainedCleanup=async()=>(await db.query('SELECT event_funnel_cancellation_cleanup_quiet($1,$2,$3,$4) r',
    [tenant,zoom.order,zoomReversal,zoomClaim.lease_id])).rows[0].r;
  assert.equal((await retainedCleanup()).status,'needs_review','An unverified sibling link is insufficient');
  await provider(zoom,zoomToken,otherStep.id,'observed',registration.id,{outcome:'approved',registrantId:'late-fixture-registrant'});
  assert.equal((await retainedCleanup()).status,'needs_review','Incomplete sibling provisioning is insufficient');
  await integration(zoom,zoomToken,'finish',otherStep.id);
  const shared=await retainedCleanup();
  assert.equal(shared.status,'complete');
  assert.equal(shared.receipt.providers,'verified_provider_cleanup');
  assert.deepEqual(shared.receipt.providerReceipts,[{registrationId:registration.id,
    retainedFor:[{source:'booking',id:zoom.bookingIds[1]}]}]);
  assert.equal((await db.query('SELECT registrant_id FROM event_funnel_zoom_registration WHERE id=$1',[registration.id])).rows[0].registrant_id,
    'late-fixture-registrant','Retaining access does not revoke or rewrite the provider receipt');
  await (await request({...zoom,bookingIds:[zoom.bookingIds[1]]}))(db);
  const last=(await db.query('SELECT id FROM event_funnel_reversal WHERE order_id=$1 AND id<>$2',[zoom.order,zoomReversal])).rows[0].id;
  const lastClaim=(await db.query('SELECT event_funnel_reversal_claim($1,$2) r',[tenant,last])).rows[0].r;
  const lastResult=(await db.query('SELECT event_funnel_cancellation_cleanup_quiet($1,$2,$3,$4) r',
    [tenant,zoom.order,last,lastClaim.lease_id])).rows[0].r;
  assert.equal(lastResult.status,'needs_review','The last cancellation still requires actual provider revocation');
  assert.equal(lastResult.reason,'provider_receipts_required');
  for(const role of ['anon','authenticated','service_role']){
    await db.query(`SET ROLE ${role}`);
    await assert.rejects(db.query(`SELECT event_funnel_retained_provider_evidence($1,$2,'booking',$3)`,
      [tenant,zoom.order,zoom.bookingIds[0]]),{code:'42501'});
    await db.query('RESET ROLE');
  }
  const [approvalScope]=await exerciseFunnelInventoryEvidence({db,sql,tenant,member,install:false,variants:['total']});
  const serviceRequest=randomUUID();
  await db.query('INSERT INTO booking_cancellation_request(id,tenant_id,booking_id) VALUES($1,$2,$3)',
    [serviceRequest,tenant,approvalScope.bookingIds[0]]);
  const args={db:adapter,ctx:{isAuthenticated:true,tenantId:tenant,tenantUserId:member},
    req:{headers:{'content-type':'application/json',host:'fixture.test',origin:'https://fixture.test'}},
    requests:[{id:serviceRequest,tenant_id:tenant,booking_id:approvalScope.bookingIds[0]}],
    reviewerName:'Isolated reviewer',suppressEmails:true,
    amountsByRequest:{[serviceRequest]:{customRefundAmount:0}},
    hasAdminAccess:async()=>true,hasFeatureAccess:async()=>true,
    run:async()=>{throw new Error('Fixture recovery temporarily unavailable');}};
  await db.query('SET ROLE service_role');
  const approved=await approveFunnelCancellation(args);
  assert.equal(approved.recovery,'queued');
  assert.equal((await approveFunnelCancellation(args)).operationId,approved.operationId,'Exact request replay keeps one operation');
  await db.query('RESET ROLE');
  assert.equal((await db.query('SELECT status FROM booking_cancellation_request WHERE id=$1',[serviceRequest])).rows[0].status,'approved');
  assert.equal((await db.query('SELECT status FROM booking WHERE id=$1',[approvalScope.bookingIds[0]])).rows[0].status,'cancelled');
  assert.equal((await db.query('SELECT count(*)::int n FROM event_funnel_reversal WHERE order_id=$1',[approvalScope.order])).rows[0].n,1);
}
