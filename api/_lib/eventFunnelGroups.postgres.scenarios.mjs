import assert from 'node:assert/strict';

export async function exerciseFunnelGroups({db,connect,uuid,tenant,member,sql}) {
  await db.query(`CREATE TABLE event_group_booking(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,event_id uuid,
    ticket_class_id text,booker_email text,booker_first_name text,booker_last_name text,token text UNIQUE,status text,
    group_size integer,booking_reference text,payment_method text,total_cost numeric);
    CREATE TABLE event_group_booking_participant(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,
      group_booking_id uuid REFERENCES event_group_booking(id),email text);
    ALTER TABLE booking ADD booking_reference text;`);
  await db.query(await sql('202701230010_event_funnel_group_fulfillment.sql'));
  const event=uuid(400),definition=uuid(401),session=uuid(402),booking=uuid(403);
  await db.query(`INSERT INTO event(id,tenant_id,capacity_mode,total_capacity,pricing_config) VALUES($1,$2,'total',4,
    '{"ticket_classes":[{"id":"G","available_count":3,"is_group_ticket":true,"group_size":3}]}')`,[event,tenant]);
  const graph={version:1,tenantId:tenant,entry:'source',reservationSeconds:900,invoiceMode:'per_event',nodes:[
    {id:'source',type:'source',event:{id:event,kind:'simple',tenantId:tenant},ticketIds:['G'],requires:[],accept:'checkout'},
    {id:'checkout',type:'checkout'},
  ]};
  await db.query(`SELECT event_funnel_save_definition($1,$2,'fixture',0,'Group fixture',$3,'{"positions":{}}')`,[tenant,definition,graph]);
  const version=(await db.query(`INSERT INTO event_funnel_version(tenant_id,definition_id,definition_revision,graph,commercial_snapshot)
    VALUES($1,$2,1,$3,'{}') RETURNING id`,[tenant,definition,graph])).rows[0].id;
  await db.query(`INSERT INTO event_funnel_session(id,tenant_id,version_id,member_id,access_expires_at,retain_until)
    VALUES($1,$2,$3,$4,now()+interval '1 day',now()+interval '7 days')`,[session,tenant,version,member]);
  const purchaser={first_name:'Group',last_name:'Fixture',email:'group@example.test'};
  const price={version:1,unitMinor:0,currency:'GBP',purchaser,paymentMethods:['card']};
  await db.query(`SELECT event_funnel_apply_journey($1,$2,$3,NULL,1,$4,'{"version":1,"decisions":{},"checkoutNow":true}')`,
    [tenant,session,member,JSON.stringify([{nodeId:'source',ticketId:'G',quantity:1,priceSnapshot:price}])]);
  const terms={version:1,submissionAccepted:true,purchaser,invoiceMode:'per_event',currency:'GBP',paymentMethod:'free',payableMinor:0,
    lines:[{nodeId:'source',ticketId:'G',eventId:event,eventKind:'simple',quantity:1,places:3,priceSnapshot:price,amountMinor:0,payableMinor:0,
      registrations:[{id:booking,places:3,grossMinor:0,payableMinor:0,row:{id:booking,tenant_id:tenant,event_id:event,
        member_id:member,ticket_class_id:'G',status:'confirmed',payment_method:'free',booking_reference:'EF-group'}}]}]};
  const order=(await db.query('SELECT event_funnel_prepare_order($1,$2,$3,NULL,2,$4) r',[tenant,session,member,terms])).rows[0].r;
  await db.query(`SELECT event_funnel_finalize_order($1,$2,'{"method":"free"}')`,[tenant,order.id]);
  await db.query(`SELECT event_funnel_finalize_order($1,$2,'{"method":"free"}')`,[tenant,order.id]);
  const groups=(await db.query('SELECT * FROM event_group_booking WHERE event_id=$1',[event])).rows;
  assert.equal(groups.length,1);assert.equal(groups[0].group_size,3);assert.match(groups[0].token,/^[a-f0-9]{64}$/);
  assert.equal(groups[0].booker_email,purchaser.email);
  assert.equal((await db.query('SELECT count(*)::int n FROM booking WHERE event_id=$1',[event])).rows[0].n,1);
  const capacity=(await db.query(`SELECT sales_capacity_state('simple',$1,'G') r`,[event])).rows[0].r;
  assert.equal(capacity.confirmed,3);assert.equal(capacity.remaining,0);
  assert.equal((await db.query('SELECT simple_event_capacity($1) r',[event])).rows[0].r.remaining,1);
  assert.equal((await db.query(`SELECT check_oneoff_ticket_capacity($1,'G',1,NULL) r`,[event])).rows[0].r.ok,false);
  assert.equal((await db.query(`SELECT check_oneoff_ticket_capacity($1,'G',1,$2) r`,[event,[booking]])).rows[0].r.ok,true);
  await assert.rejects(db.query('UPDATE event_group_booking SET group_size=9 WHERE id=$1',[groups[0].id]),{code:'PT409'});
  const add=(client,n)=>client.query('INSERT INTO event_group_booking_participant(tenant_id,group_booking_id,email) VALUES($1,$2,$3)',
    [tenant,groups[0].id,`participant${n}@example.test`]);
  await add(db,1);await add(db,2);
  const peer=await connect();
  const race=await Promise.allSettled([add(db,3),add(peer,4)]);
  assert.equal(race.filter(result=>result.status==='fulfilled').length,1);
  assert.equal((await db.query(`SELECT sales_capacity_state('simple',$1,'G') r`,[event])).rows[0].r.confirmed,3);
  await db.query(`UPDATE booking SET status='cancelled' WHERE id=$1`,[booking]);
  assert.equal((await db.query('SELECT status FROM event_group_booking WHERE id=$1',[groups[0].id])).rows[0].status,'cancelled');
  assert.equal((await db.query(`SELECT sales_capacity_state('simple',$1,'G') r`,[event])).rows[0].r.remaining,3);
  await assert.rejects(add(db,5),{code:'PT409'});
  await assert.rejects(db.query(`UPDATE event_group_booking SET status='active' WHERE id=$1`,[groups[0].id]),{code:'PT409'});
}
