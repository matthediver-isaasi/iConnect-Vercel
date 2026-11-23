import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export async function exerciseFunnelInventoryEvidence({db,sql,tenant,member,install=true,
  variants=['legacy','total','legacy_unchanged'],bookingCount=1,email='fixture@example.test'}) {
  if(install)await db.query(await sql('202701230025_event_funnel_inventory_evidence.sql'));
  const created=[];
  const base=(await db.query(`SELECT v.graph FROM event_funnel_version v JOIN event_funnel_entry e ON e.version_id=v.id
    WHERE e.tenant_id=$1 LIMIT 1`,[tenant])).rows[0].graph;
  const original=base.nodes.find(n=>n.id===base.entry);
  for(const variant of variants) {
    const mode=variant==='legacy_unchanged'?'legacy':variant;
    const event=randomUUID(),definition=randomUUID(),session=randomUUID(),booking=randomUUID();
    const bookingIds=[booking,...Array.from({length:bookingCount-1},()=>randomUUID())];
    await db.query(`INSERT INTO event SELECT (jsonb_populate_record(NULL::event,to_jsonb(e)||$2::jsonb)).*
      FROM event e WHERE e.id=$1`,[original.event.id,JSON.stringify({id:event,capacity_mode:mode,total_capacity:10,
      available_seats:10,is_unlimited_registration:false,pricing_config:{ticket_classes:[{id:'A',capacity:20}]}})]);
    const graph=structuredClone(base);graph.nodes.find(n=>n.id===graph.entry).event.id=event;
    await db.query(`SELECT event_funnel_save_definition($1,$2,'fixture',0,'Evidence fixture',$3,'{"positions":{}}')`,[tenant,definition,graph]);
    const version=(await db.query(`INSERT INTO event_funnel_version(tenant_id,definition_id,definition_revision,graph,commercial_snapshot)
      VALUES($1,$2,1,$3,'{}') RETURNING id`,[tenant,definition,graph])).rows[0].id;
    await db.query(`UPDATE event_funnel_definition SET published_version_id=$1 WHERE id=$2`,[version,definition]);
    await db.query('SELECT event_funnel_create_session($1,$2,$3,$4,NULL)',[tenant,session,version,member]);
    const purchaser={first_name:'Fixture',last_name:'Buyer',email};
    const price={version:1,unitMinor:0,currency:'GBP',purchaser,paymentMethods:['free']};
    await db.query(`SELECT event_funnel_apply_journey($1,$2,$3,NULL,1,$4,'{"version":1,"decisions":{},"checkoutNow":true}')`,
      [tenant,session,member,JSON.stringify([{nodeId:graph.entry,ticketId:'A',quantity:bookingCount,priceSnapshot:price}])]);
    const terms={version:1,submissionAccepted:true,purchaser,invoiceMode:graph.invoiceMode,currency:'GBP',paymentMethod:'free',
      payableMinor:0,trainingFundMinor:0,voucherMinor:0,lines:[{nodeId:graph.entry,ticketId:'A',eventId:event,eventKind:'simple',
        quantity:bookingCount,places:bookingCount,amountMinor:0,payableMinor:0,trainingFundMinor:0,voucherMinor:0,priceSnapshot:price,
        registrations:bookingIds.map(id=>({id,places:1,grossMinor:0,payableMinor:0,trainingFundMinor:0,voucherMinor:0,
          row:{id,tenant_id:tenant,event_id:event,member_id:member,ticket_class_id:'A',attendee_email:purchaser.email,
            status:'confirmed',payment_method:'free'}}))}]};
    const order=(await db.query('SELECT event_funnel_prepare_order($1,$2,$3,NULL,2,$4) r',[tenant,session,member,terms])).rows[0].r;
    const before=(await db.query('SELECT available_seats FROM event WHERE id=$1',[event])).rows[0].available_seats;
    await db.query(`CREATE FUNCTION fixture_inventory_rollback() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'inventory evidence rollback'; END $$;
      CREATE TRIGGER fixture_inventory_rollback BEFORE INSERT ON event_funnel_delivery
        FOR EACH ROW EXECUTE FUNCTION fixture_inventory_rollback();`);
    await assert.rejects(db.query(`SELECT event_funnel_finalize_order($1,$2,'{"method":"free"}')`,[tenant,order.id]),/inventory evidence rollback/);
    assert.equal((await db.query('SELECT count(*)::int n FROM event_funnel_inventory_evidence WHERE order_id=$1',[order.id])).rows[0].n,0);
    assert.equal((await db.query('SELECT available_seats FROM event WHERE id=$1',[event])).rows[0].available_seats,before);
    assert.equal((await db.query('SELECT count(*)::int n FROM booking WHERE id=$1',[booking])).rows[0].n,0);
    await db.query('DROP TRIGGER fixture_inventory_rollback ON event_funnel_delivery; DROP FUNCTION fixture_inventory_rollback();');
    await db.query(`SELECT event_funnel_finalize_order($1,$2,'{"method":"free"}')`,[tenant,order.id]);
    await db.query(`SELECT event_funnel_finalize_order($1,$2,'{"method":"free"}')`,[tenant,order.id]);
    const rows=(await db.query('SELECT * FROM event_funnel_inventory_evidence WHERE order_id=$1',[order.id])).rows;
    assert.equal(rows.length,1);assert.equal(rows[0].legacy_debit_places,mode==='legacy'?String(bookingCount):'0');
    assert.equal((await db.query('SELECT available_seats FROM event WHERE id=$1',[event])).rows[0].available_seats,
      mode==='legacy'?before-bookingCount:before);
    assert.equal(rows[0].restored_places,'0');
    if(variant==='legacy')await db.query(`UPDATE event SET capacity_mode='total' WHERE id=$1`,[event]);
    else if(mode==='total') {
      await assert.rejects(db.query(`UPDATE event SET capacity_mode='legacy' WHERE id=$1`,[event]),/cannot be converted/);
      await db.query('UPDATE event SET total_capacity=20 WHERE id=$1',[event]);
    }
    assert.equal((await db.query('SELECT legacy_debit_places FROM event_funnel_inventory_evidence WHERE order_id=$1',[order.id])).rows[0].legacy_debit_places,
      mode==='legacy'?String(bookingCount):'0');
    created.push({tenant,order:order.id,event,bookingIds});
  }
  for(const role of ['anon','authenticated','service_role']) {
    await db.query(`SET ROLE ${role}`);await assert.rejects(db.query('SELECT * FROM event_funnel_inventory_evidence'),{code:'42501'});
    await assert.rejects(db.query('DELETE FROM event_funnel_inventory_evidence'),{code:'42501'});
    await db.query('RESET ROLE');
  }
  await db.query('RESET ROLE');
  return created;
}
