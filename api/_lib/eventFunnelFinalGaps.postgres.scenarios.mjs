import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {exerciseFunnelInventoryEvidence} from './eventFunnelInventoryEvidence.postgres.scenarios.mjs';
import {approveFunnelCancellation} from './eventFunnelCancellationApproval.js';
import {recoverFunnelZoomRevocation} from './eventFunnelZoomRevocation.js';
export async function exerciseFunnelFinalGaps({db,sql,tenant,member,connect}){
  const [scope]=await exerciseFunnelInventoryEvidence({db,sql,tenant,member,install:false,
    variants:['total'],bookingCount:2,email:`${randomUUID()}@example.test`});
  const actor=randomUUID(),token=randomUUID(),local=randomUUID(),numeric='76543219876',hash='d'.repeat(64);
  await db.query('INSERT INTO zoom_meeting(id,tenant_id,zoom_meeting_id) VALUES($1,$2,$3)',[local,tenant,numeric]);
  await db.query('UPDATE event SET zoom_meeting_id=$1 WHERE id=$2',[local,scope.event]);
  await db.query(`UPDATE event_funnel_delivery SET state='running',lease_token=$3,lease_until=now()+interval '2 minutes'
    WHERE tenant_id=$1 AND order_id=$2 AND kind='integrations'`,[tenant,scope.order,token]);
  const steps=(await db.query(`SELECT event_funnel_integration_operation($1,$2,$3,'read') r`,
    [tenant,scope.order,token])).rows[0].r.jobs.filter(j=>j.step==='providers');
  const zoom=async(step,action,id=null,payload=null)=>(await db.query(
    'SELECT event_funnel_zoom_operation($1,$2,$3,$4,$5,$6,$7) r',
    [tenant,scope.order,token,step.id,action,id,payload===null?null:JSON.stringify(payload)])).rows[0].r;
  let registration;
  for(const step of steps){
    const plan=await zoom(step,'plan',null,[{kind:'meetings',localId:local,numericId:numeric,authorityHash:hash}]);
    registration=plan.jobs[0];
    if(registration.state==='pending')assert.equal((await zoom(step,'begin',registration.id)).write,true);
    await zoom(step,'observed',registration.id,{outcome:'approved',registrantId:'isolated-owned-registrant'});
    await db.query(`SELECT event_funnel_integration_operation($1,$2,$3,'finish',$4)`,[tenant,scope.order,token,step.id]);
  }
  assert.equal((await db.query('SELECT ownership FROM event_funnel_zoom_registration WHERE id=$1',[registration.id])).rows[0].ownership,'funnel');
  const requests=[];
  for(const booking of scope.bookingIds){
    const id=randomUUID();await db.query('INSERT INTO booking_cancellation_request(id,tenant_id,booking_id) VALUES($1,$2,$3)',[id,tenant,booking]);
    requests.push({id,tenant_id:tenant,booking_id:booking});
  }
  const keys={
    event_funnel_invoice_report:['p_tenant','p_bookings'],event_funnel_reversal_context:['p_tenant','p_order'],
    event_funnel_consume_limit:['p_tenant','p_actor'],
    event_funnel_approve_cancellation:['p_tenant','p_order','p_id','p_requests','p_items','p_options','p_authority'],
    event_funnel_zoom_revoke:['p_tenant','p_order','p_reversal','p_lease','p_action','p_registration','p_epoch'],
  };
  const adapter={rpc:async(name,args)=>{
    assert.ok(keys[name],`Unexpected RPC ${name}`);
    try{return {data:(await db.query(`SELECT to_jsonb(${name}(${keys[name].map((_,i)=>`$${i+1}`).join(',')})) r`,
      keys[name].map(key=>['p_bookings','p_items'].includes(key)?JSON.stringify(args[key]):args[key]))).rows[0].r};}
    catch(error){throw new Error(`Fixture RPC ${name}: ${error.message}`,{cause:error});}
  }};
  const args={db:adapter,ctx:{isAuthenticated:true,tenantId:tenant,tenantUserId:actor},
    req:{headers:{'content-type':'application/json',host:'fixture.test'}},requests,reviewerName:'Group reviewer',
    hasAdminAccess:async()=>true,hasFeatureAccess:async()=>true,suppressEmails:true,
    groupAmounts:{customRefundAmount:0,refundAllocation:{trainingFundAmount:0}},
    run:async()=>({status:'queued'})};
  const snapshot=(await db.query(`SELECT snapshot FROM event_funnel_order WHERE id=$1`,[scope.order])).rows[0].snapshot;
  await db.query('SET ROLE service_role');
  const approved=await approveFunnelCancellation(args);
  assert.equal((await approveFunnelCancellation({...args,requests:[...requests].reverse()})).operationId,approved.operationId);
  await db.query('RESET ROLE');
  assert.equal((await db.query(`SELECT count(*)::int n FROM booking_cancellation_request
    WHERE id=ANY($1) AND status='approved'`,[requests.map(r=>r.id)])).rows[0].n,2);
  const standalone=randomUUID();
  await db.query(`INSERT INTO booking SELECT (jsonb_populate_record(NULL::booking,
    to_jsonb(b)||jsonb_build_object('id',$2::uuid,'status','confirmed'))).*
    FROM booking b WHERE b.id=$1`,[scope.bookingIds[0],standalone]);
  const unrelatedEvent=randomUUID();
  await db.query(`INSERT INTO event SELECT (jsonb_populate_record(NULL::event,
    to_jsonb(e)||jsonb_build_object('id',$2::uuid,'zoom_meeting_id',NULL))).*
    FROM event e WHERE e.id=$1`,[scope.event,unrelatedEvent]);
  await db.query('SET ROLE service_role');
  const claim=(await db.query('SELECT event_funnel_reversal_claim($1,$2) r',[tenant,approved.operationId])).rows[0].r;
  const context={order:{tenant_id:tenant,id:scope.order},operation:claim};
  let calls=0,present=true;
  const options={db:adapter,context,getAuthority:async()=>({authorityHash:hash,token:'isolated'}),
    readSettings:async()=>({numericId:numeric,type:2}),
    list:async()=>new Map(present?[[registrationEmail(),{id:'isolated-owned-registrant',status:'approved'}]]:[]),
    request:async()=>{
      calls++;
      // The provider request has started. A new ordinary registration for
      // this person must not be committed while its outcome is unknown.
      const peer=await connect();
      await assert.rejects(peer.query(`INSERT INTO booking SELECT (jsonb_populate_record(NULL::booking,
        to_jsonb(b)||jsonb_build_object('id',$2::uuid,'status','confirmed'))).*
        FROM booking b WHERE b.id=$1`,[scope.bookingIds[0],randomUUID()]),{code:'PT409'});
      await peer.query(`INSERT INTO booking SELECT (jsonb_populate_record(NULL::booking,
        to_jsonb(b)||jsonb_build_object('id',$2::uuid,'event_id',$3::uuid,'status','confirmed'))).*
        FROM booking b WHERE b.id=$1`,[scope.bookingIds[0],randomUUID(),unrelatedEvent]);
      throw new Error('Fixture response lost');
    }};
  function registrationEmail(){return snapshot.purchaser.email;}
  assert.equal((await recoverFunnelZoomRevocation(options)).status,'complete');
  assert.equal(calls,0,'An ordinary registration for the same resource preserves access');
  await db.query('RESET ROLE');
  // This is an ordinary free fixture registration, with no provider mutation.
  await db.query(`UPDATE booking SET status='cancelled' WHERE id=$1`,[standalone]);
  await db.query('SET ROLE service_role');
  assert.equal((await recoverFunnelZoomRevocation(options)).status,'retry');
  assert.equal((await recoverFunnelZoomRevocation(options)).status,'retry');assert.equal(calls,1);
  present=false;
  assert.equal((await recoverFunnelZoomRevocation(options)).status,'complete');assert.equal(calls,1);
  const clean=(await db.query('SELECT event_funnel_cancellation_cleanup_quiet($1,$2,$3,$4) r',
    [tenant,scope.order,claim.id,claim.lease_id])).rows[0].r;
  assert.equal(clean.status,'complete');
  assert.ok(clean.receipt.providerReceipts.every(r=>r.revoked===true));
  await assert.rejects(db.query('SELECT * FROM event_funnel_zoom_revocation'),{code:'42501'});
  await db.query('RESET ROLE');
  const epoch=(await db.query('SELECT access_epoch FROM event_funnel_zoom_registration WHERE id=$1',[registration.id])).rows[0].access_epoch;
  const [next]=await exerciseFunnelInventoryEvidence({db,sql,tenant,member,install:false,
    variants:['total'],email:registrationEmail()});
  await db.query('UPDATE event SET zoom_meeting_id=$1 WHERE id=$2',[local,next.event]);
  const newToken=randomUUID();
  await db.query(`UPDATE event_funnel_delivery SET state='running',lease_token=$3,lease_until=now()+interval '2 minutes'
    WHERE tenant_id=$1 AND order_id=$2 AND kind='integrations'`,[tenant,next.order,newToken]);
  const nextSteps=(await db.query(`SELECT event_funnel_integration_operation($1,$2,$3,'read') r`,
    [tenant,next.order,newToken])).rows[0].r.jobs;
  const newPlan=(await db.query(`SELECT event_funnel_zoom_operation($1,$2,$3,$4,'plan',NULL,$5) r`,
    [tenant,next.order,newToken,nextSteps.find(s=>s.step==='providers').id,
      JSON.stringify([{kind:'meetings',localId:local,numericId:numeric,authorityHash:hash}])])).rows[0].r;
  assert.notEqual(newPlan.jobs[0].access_epoch,epoch);
  assert.equal(newPlan.jobs[0].state,'pending','A later purchase gets a new grant, not stale access');
  const oldReceipt=(await db.query('SELECT event_funnel_cancellation_cleanup_quiet($1,$2,$3,$4) r',
    [tenant,scope.order,claim.id,claim.lease_id])).rows[0].r;
  assert.equal(oldReceipt.status,'complete','A later grant cannot erase historical revocation evidence');
  const nextStep=nextSteps.find(s=>s.step==='providers');
  const nextZoom=async(action)=>(await db.query('SELECT event_funnel_zoom_operation($1,$2,$3,$4,$5,$6,$7) r',
    [tenant,next.order,newToken,nextStep.id,action,newPlan.jobs[0].id,
      action==='observed'?{outcome:'approved',registrantId:'external-fixture-grant'}:null])).rows[0].r;
  await nextZoom('begin');await nextZoom('not_submitted');
  assert.equal((await db.query('SELECT ownership FROM event_funnel_zoom_registration WHERE id=$1',[registration.id])).rows[0].ownership,'unknown');
  await nextZoom('observed');
  await db.query(`SELECT event_funnel_integration_operation($1,$2,$3,'finish',$4)`,[tenant,next.order,newToken,nextStep.id]);
  const externalRequest=randomUUID();
  await db.query('INSERT INTO booking_cancellation_request(id,tenant_id,booking_id) VALUES($1,$2,$3)',
    [externalRequest,tenant,next.bookingIds[0]]);
  await db.query('SET ROLE service_role');
  const externalApproved=await approveFunnelCancellation({...args,
    requests:[{id:externalRequest,tenant_id:tenant,booking_id:next.bookingIds[0]}]});
  const externalClaim=(await db.query('SELECT event_funnel_reversal_claim($1,$2) r',[tenant,externalApproved.operationId])).rows[0].r;
  assert.equal((await recoverFunnelZoomRevocation({...options,context:{order:{id:next.order,tenant_id:tenant},operation:externalClaim},
    getAuthority:async()=>{throw new Error('Pre-existing external access must not be revoked');}})).status,'complete');
  const externalCleanup=(await db.query('SELECT event_funnel_cancellation_cleanup_quiet($1,$2,$3,$4) r',
    [tenant,next.order,externalClaim.id,externalClaim.lease_id])).rows[0].r;
  assert.equal(externalCleanup.status,'complete');
  assert.equal(externalCleanup.receipt.providerReceipts[0].externalAccessRetained,true);
  await db.query('RESET ROLE');
}
