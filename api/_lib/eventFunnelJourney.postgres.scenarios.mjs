import assert from 'node:assert/strict';
import { createEventFunnelJourneyService } from './eventFunnelJourney.js';

// Called with disposable local PostgreSQL only. Commercial resolution is a
// deterministic fixture; routing, revision fencing, drafts and stock use real RPCs.
export async function exerciseFunnelJourney({ db, connect, uuid, tenant, member, sql }) {
  await db.query(await sql('202701230004_event_funnel_journey.sql'));
  const source=uuid(30), other=uuid(31), admission=uuid(32), lunch=uuid(33), definition=uuid(34), session=uuid(35);
  await db.query(`INSERT INTO event(id,tenant_id,capacity_mode,total_capacity,pricing_config)
    VALUES($1,$2,'total',100,'{"ticket_classes":[{"id":"A","available_count":10},{"id":"B","available_count":10},
      {"id":"P","available_count":2},{"id":"D","available_count":2}]}')`,[source,tenant]);
  await db.query('INSERT INTO complex_event(id,tenant_id,available_seats) VALUES($1,$2,100)',[other,tenant]);
  await db.query('INSERT INTO complex_event_ticket_class VALUES($1,$3,$4,10,false),($2,$3,$4,10,false)',[admission,lunch,tenant,other]);
  const simple={id:source,kind:'simple',tenantId:tenant}, complex={id:other,kind:'complex',tenantId:tenant};
  const graph={version:1,tenantId:tenant,entry:'source',reservationSeconds:900,invoiceMode:'per_event',nodes:[
    {id:'source',type:'source',event:simple,ticketIds:['A','B'],requires:[],accept:'branch'},
    {id:'branch',type:'condition',rules:[{priority:1,match:'any',tests:[{event:simple,ticketId:'B',selected:true}],to:'dinner'}],fallback:'parking'},
    {id:'parking',type:'addon',event:simple,ticketIds:['P'],requires:['source'],accept:'other',skip:'other'},
    {id:'dinner',type:'addon',event:simple,ticketIds:['D'],requires:['source'],accept:'other',skip:'other'},
    {id:'other',type:'event',event:complex,ticketIds:[admission],requires:[],accept:'lunch',skip:'checkout'},
    {id:'lunch',type:'addon',event:complex,ticketIds:[lunch],requires:['other'],accept:'checkout',skip:'checkout'},
    {id:'checkout',type:'checkout'},
  ]};
  await db.query(`SELECT event_funnel_save_definition($1,$2,'fixture',0,'Branch fixture',$3,'{"positions":{}}')`,[tenant,definition,graph]);
  const version=(await db.query(`INSERT INTO event_funnel_version(tenant_id,definition_id,definition_revision,graph,commercial_snapshot)
    VALUES($1,$2,1,$3,'{}') RETURNING id`,[tenant,definition,graph])).rows[0].id;
  await db.query(`INSERT INTO event_funnel_session(id,tenant_id,version_id,member_id,access_expires_at,retain_until)
    VALUES($1,$2,$3,$4,now()+interval '1 day',now()+interval '7 days')`,[session,tenant,version,member]);
  let price=1000, rejectQuote=false, rejectNode=null, calls=0;
  const resolver=async({tickets,node})=>{
    calls++;
    if(rejectQuote || rejectNode===node.id) throw new Error('Fixture optional offer unavailable');
    return tickets.map(t=>({ticketId:t.id,priceSnapshot:{unitMinor:price,currency:'GBP'}}));
  };
  const bridge=client=>({rpc:async(name,args)=>{
    assert.ok(['event_funnel_read_session','event_funnel_apply_journey'].includes(name));
    const keys=Object.keys(args);
    try {
      return {data:(await client.query(`SELECT public.${name}(${keys.map((k,i)=>`${k}=>$${i+1}`).join(',')}) result`,
        keys.map(k=>typeof args[k]==='object'&&args[k]!==null?JSON.stringify(args[k]):args[k]))).rows[0].result};
    } catch(error) {return {error:{code:error.code,message:error.message}};}
  }});
  const service=client=>createEventFunnelJourneyService({db:bridge(client),resolveSelection:resolver});
  const owned={tenantId:tenant,sessionId:session,memberId:member};
  const api=service(db);
  let snapshot=await api.read(owned);
  const select=(nodeId,id,quantity=1,answers)=>({
    type:'select',expectedRevision:snapshot.session.revision,nodeId,tickets:[{id,quantity}],...(answers?{answers}:{}),
  });
  snapshot=await api.change(owned,select('source','A',1,{first_name:'Source fixture'}));
  const deadline=snapshot.session.expires_at;
  assert.equal(snapshot.session.revision,2);
  assert.equal(snapshot.drafts.source.first_name,'Source fixture');
  assert.equal(snapshot.route.currentNodeId,'parking');
  const beforeFailed=snapshot;
  await assert.rejects(api.change(owned,select('parking','P',3,{first_name:'Must roll back'})),{code:'CAPACITY_UNAVAILABLE'});
  snapshot=await api.read(owned);
  for(const key of ['session','holds','drafts']) assert.deepEqual(snapshot[key],beforeFailed[key]);
  snapshot=await api.change(owned,select('parking','P'));
  snapshot=await api.change(owned,select('other',admission,1,{first_name:'Shared event attendee'}));
  snapshot=await api.change(owned,select('lunch',lunch));
  assert.equal(snapshot.route.atCheckout,true);
  // A back edit reaches a different branch. The shared second event and lunch
  // remain held/pending, rather than being released and immediately reacquired.
  snapshot=await api.change(owned,select('source','B'));
  assert.deepEqual(snapshot.removed.map(r=>r.nodeId),['parking']);
  assert.deepEqual([...snapshot.route.pendingNodeIds].sort(),['lunch','other']);
  assert.equal(snapshot.route.currentNodeId,'dinner');
  assert.equal(snapshot.drafts.other.first_name,'Shared event attendee');
  assert.equal(snapshot.drafts.source.first_name,'Source fixture');
  assert.equal(snapshot.session.expires_at,deadline);
  assert.equal(snapshot.holds.length,3);
  const holdCount=(await db.query('SELECT event_funnel_inventory_projection($1,\'simple\',$2) r',[tenant,[source]])).rows[0].r;
  assert.deepEqual(holdCount,[{event_id:source,ticket_id:'B',places:1}]);
  const resumed=await api.read(owned);
  assert.deepEqual(resumed.route,snapshot.route);
  await assert.rejects(api.change(owned,select('other',admission)),{code:'OFFER_UNREACHABLE'});
  rejectQuote=true;
  await assert.rejects(api.change(owned,select('dinner','D')),/optional offer unavailable/);
  // Removing a disappeared optional event does not require that deleted row
  // to exist or discard the still-valid source reservation.
  await db.query('DELETE FROM complex_event WHERE id=$1',[other]);
  // Failed optional eligibility cannot prevent source-only completion and must
  // not reprice/revalidate any previously held, unchanged selection.
  const callsBefore=calls;
  snapshot=await api.change(owned,{type:'source_only',expectedRevision:snapshot.session.revision});
  assert.equal(calls,callsBefore);
  assert.equal(snapshot.holds.length,1);
  assert.equal(snapshot.route.atCheckout,true);
  assert.equal(snapshot.session.expires_at,deadline);
  await db.query('INSERT INTO complex_event(id,tenant_id,available_seats) VALUES($1,$2,100)',[other,tenant]);
  rejectQuote=false;
  snapshot=await api.change(owned,{type:'resume_offers',expectedRevision:snapshot.session.revision});
  assert.equal(snapshot.route.currentNodeId,'dinner');
  snapshot=await api.change(owned,{type:'skip',nodeId:'dinner',expectedRevision:snapshot.session.revision});
  assert.deepEqual((await api.read(owned)).session.journey.decisions,{dinner:'skip'});
  snapshot=await api.change(owned,select('other',admission));
  snapshot=await api.change(owned,select('lunch',lunch));
  snapshot=await api.change(owned,{type:'skip',nodeId:'other',expectedRevision:snapshot.session.revision});
  assert.deepEqual(snapshot.removed.map(r=>r.nodeId).sort(),['lunch','other']);
  assert.equal(snapshot.holds.length,1);
  assert.equal(snapshot.drafts.other.first_name,'Shared event attendee');
  // Admin price and capacity changes do not erase existing reservation terms.
  price=9999;
  await db.query(`UPDATE event SET total_capacity=0,
    pricing_config=jsonb_set(pricing_config,'{ticket_classes,1,available_count}','0') WHERE id=$1`,[source]);
  snapshot=await api.change(owned,{type:'source_only',expectedRevision:snapshot.session.revision});
  assert.equal(snapshot.holds[0].price_snapshot.unitMinor,1000);
  await assert.rejects(api.change(owned,select('source','B',2)),{code:'CAPACITY_UNAVAILABLE'});
  assert.equal((await api.read(owned)).session.revision,snapshot.session.revision);
  await db.query(`UPDATE event SET total_capacity=100,
    pricing_config=jsonb_set(jsonb_set(jsonb_set(pricing_config,'{ticket_classes,1,available_count}','10'),
      '{ticket_classes,1,is_group_ticket}','true'),'{ticket_classes,1,group_size}','2') WHERE id=$1`,[source]);
  snapshot=await api.change(owned,select('source','B',2));
  assert.equal(snapshot.holds[0].price_snapshot.unitMinor,1000);
  assert.equal(snapshot.holds[0].quantity,2);
  assert.equal(snapshot.holds[0].places,2); // Original per-ticket place count, not the admin's new group size.
  // Two independent connections/tabs share the same revision fence.
  const a=service(await connect()),b=service(await connect());
  const race=await Promise.allSettled([
    a.change(owned,select('source','B',1)),
    b.change(owned,select('source','B',3)),
  ]);
  assert.equal(race.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(race.find(r=>r.status==='rejected').reason.code,'REVISION_CONFLICT');
  snapshot=await api.read(owned);
  assert.equal(snapshot.session.expires_at,deadline);
  snapshot=await api.change(owned,{type:'resume_offers',expectedRevision:snapshot.session.revision});
  snapshot=await api.change(owned,{type:'skip',nodeId:'dinner',expectedRevision:snapshot.session.revision});
  snapshot=await api.change(owned,select('other',admission));
  snapshot=await api.change(owned,select('lunch',lunch));
  // Expired choices and answers survive, but a new reservation must use current
  // prices and pass capacity again; no ordinary edit silently extends the timer.
  await db.query(`UPDATE event_funnel_session SET state='expired' WHERE id=$1`,[session]);
  await db.query(`UPDATE event_funnel_session SET first_reserved_at=now()-interval '1 hour',expires_at=now()-interval '30 minutes' WHERE id=$1`,[session]);
  await assert.rejects(api.change(owned,select('source','B')),{code:'RESERVATION_EXPIRED'});
  rejectNode='other';
  await assert.rejects(api.change(owned,{type:'rereserve',expectedRevision:snapshot.session.revision}),/optional offer unavailable/);
  snapshot=await api.change(owned,{type:'source_only',expectedRevision:snapshot.session.revision});
  assert.equal(snapshot.session.state,'expired');
  assert.equal(snapshot.holds.length,1);
  assert.ok(Date.parse(snapshot.session.expires_at)<Date.parse(snapshot.serverNow));
  assert.deepEqual((await db.query('SELECT event_funnel_inventory_projection($1,\'simple\',$2) r',[tenant,[source]])).rows[0].r,[]);
  snapshot=await api.change(owned,{type:'rereserve',expectedRevision:snapshot.session.revision});
  assert.equal(snapshot.holds[0].price_snapshot.unitMinor,9999);
  assert.equal(snapshot.holds[0].places,snapshot.holds[0].quantity*2);
  assert.equal(snapshot.drafts.source.first_name,'Source fixture');
  assert.notEqual(snapshot.session.expires_at,deadline);
  await db.query('SET ROLE service_role');
  await assert.rejects(db.query('SELECT event_funnel_replace_holds($1,$2,$3,NULL,$4,\'[]\',false)',
    [tenant,session,member,snapshot.session.revision]),{code:'42501'});
  const serviceRead=await api.read(owned);
  assert.equal(serviceRead.session.id,session);
  await assert.rejects(api.read({...owned,memberId:uuid(99)}),{code:'JOURNEY_NOT_FOUND'});
  snapshot=await api.change(owned,{type:'source_only',expectedRevision:snapshot.session.revision});
  assert.equal(snapshot.route.atCheckout,true);
  await db.query('RESET ROLE');
  await db.query(`UPDATE event_funnel_session SET state='payable' WHERE id=$1`,[session]);
  await assert.rejects(db.query(`UPDATE event_funnel_session SET journey='{"version":1,"decisions":{},"checkoutNow":false}' WHERE id=$1`,[session]),{code:'23514'});
  await assert.rejects(api.change(owned,select('source','B')),{code:'CHECKOUT_FROZEN'});
}
