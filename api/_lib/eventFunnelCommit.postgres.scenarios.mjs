import assert from 'node:assert/strict';
import { funnelPaymentRequest } from './eventFunnelPayment.js';

export async function exerciseFunnelCommit({ db, connect, uuid, tenant, member, sql }) {
  await db.query(await sql('202701230007_event_funnel_registration_commit.sql'));
  const session = uuid(71);
  const entry = (await db.query('SELECT * FROM event_funnel_entry WHERE tenant_id=$1', [tenant])).rows[0];
  const graph = (await db.query('SELECT graph FROM event_funnel_version WHERE id=$1', [entry.version_id])).rows[0].graph;
  const source = graph.nodes.find(node => node.id === graph.entry);
  const other = graph.nodes.find(node => node.id === 'other');
  await db.query('SELECT event_funnel_create_session($1,$2,$3,$4,NULL)', [tenant,session,entry.version_id,member]);
  const purchaser = { first_name: 'Fixture', last_name: 'Buyer', email: 'fixture@example.test' };
  const price = { version: 1, unitMinor: 500, currency: 'GBP', purchaser, paymentMethods: ['card'] };
  const freePrice = { ...price,unitMinor: 0 };
  await db.query(`SELECT event_funnel_apply_journey($1,$2,$3,NULL,1,$4,'{"version":1,"decisions":{},"checkoutNow":false}')`,
    [tenant,session,member,JSON.stringify([{ nodeId: source.id,ticketId: 'A',quantity: 1,priceSnapshot: price },
      { nodeId: other.id,ticketId: 'default',quantity: 1,priceSnapshot: freePrice }])]);
  const bookingId = uuid(72);
  const snapshot = { version: 1,submissionAccepted: true,purchaser,invoiceMode: graph.invoiceMode,currency: 'GBP',
    paymentMethod: 'card',payableMinor: 500,paymentAuthority: { accountFingerprint: 'fixture',mode: 'test' },
    lines: [{ nodeId: source.id,ticketId: 'A',eventId: source.event.id,eventKind: source.event.kind,
      quantity: 1,places: 1,amountMinor: 500,payableMinor: 500,priceSnapshot: price,
      registrations: [{ id: bookingId,places: 1,grossMinor: 500,payableMinor: 500,row: {
        id: bookingId,tenant_id: tenant,event_id: source.event.id,member_id: member,ticket_class_id: 'A',
        attendee_email: purchaser.email,attendee_first_name: purchaser.first_name,attendee_last_name: purchaser.last_name,
        status: 'confirmed',payment_method: 'card',
      } }] }] };
  const otherBookingId = uuid(73);
  snapshot.lines.push({ nodeId: other.id,ticketId: 'default',eventId: other.event.id,eventKind: other.event.kind,
    quantity: 1,places: 1,amountMinor: 0,payableMinor: 0,priceSnapshot: freePrice,
    registrations: [{ id: otherBookingId,places: 1,grossMinor: 0,payableMinor: 0,row: {
      ...snapshot.lines[0].registrations[0].row,id: otherBookingId,event_id: other.event.id,ticket_class_id: null,payment_method: 'free',
    } }] });
  snapshot.invoiceCustomer={name:'Fixture Buyer',provenance:{kind:'member',id:member}};
  snapshot.trainingFundMinor=0;snapshot.voucherMinor=0;
  for(const line of snapshot.lines) {
    line.trainingFundMinor=0;line.voucherMinor=0;
    for(const row of line.registrations) {row.trainingFundMinor=0;row.voucherMinor=0;}
  }
  const order = (await db.query('SELECT event_funnel_prepare_order($1,$2,$3,NULL,2,$4) r', [tenant,session,member,snapshot])).rows[0].r;
  await db.query('SELECT event_funnel_payment_request($1,$2,$3)', [tenant,order.id,funnelPaymentRequest(order)]);
  await db.query(`SELECT event_funnel_payment_bind($1,$2,'pi_commit')`, [tenant,order.id]);
  const evidence = { method: 'card',payment: { id: 'pi_commit',status: 'succeeded',amount: 500,amountReceived: 500,currency: 'GBP',livemode: false } };
  const finalize = (client,value=evidence) => client.query('SELECT event_funnel_finalize_order($1,$2,$3) r', [tenant,order.id,value]);
  await assert.rejects(finalize(db),{code:'PT409'});
  await db.query('SELECT event_funnel_record_payment($1,$2,$3)',[tenant,order.id,evidence.payment]);
  await assert.rejects(finalize(db,{ ...evidence,payment: { ...evidence.payment,amountReceived: 499 } }), { code: 'PT409' });
  // Inject a downstream write failure after the registration insert; all rows,
  // financial linkage and the hold conversion must roll back together.
  await db.query(`CREATE FUNCTION fixture_block_delivery() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture failure'; END$$;
    CREATE TRIGGER fixture_block_delivery BEFORE INSERT ON event_funnel_delivery FOR EACH ROW EXECUTE FUNCTION fixture_block_delivery();`);
  await assert.rejects(finalize(db), /fixture failure/);
  assert.equal((await db.query('SELECT count(*)::int n FROM booking WHERE id=$1',[bookingId])).rows[0].n, 0);
  assert.equal((await db.query('SELECT count(*)::int n FROM booking WHERE id=$1',[otherBookingId])).rows[0].n, 0);
  assert.equal((await db.query('SELECT state FROM event_funnel_session WHERE id=$1',[session])).rows[0].state, 'payable');
  assert.equal((await db.query('SELECT verified_payment FROM event_funnel_order WHERE id=$1',[order.id])).rows[0].verified_payment.amountReceived,500);
  await assert.rejects(db.query(`SELECT event_funnel_release_order($1,$2,'{"outcome":"cancelled","paymentIntentId":"pi_commit"}')`,
    [tenant,order.id]),{code:'PT409'});
  assert.equal((await db.query('SELECT count(*)::int n FROM event_funnel_order_booking WHERE order_id=$1',[order.id])).rows[0].n, 0);
  await db.query('DROP TRIGGER fixture_block_delivery ON event_funnel_delivery');
  const peer = await connect();
  const results = await Promise.all([finalize(db),finalize(peer)]);
  assert.deepEqual(results[0].rows[0].r,results[1].rows[0].r);
  assert.equal(results[0].rows[0].r.state, 'confirmed');
  assert.equal((await db.query('SELECT count(*)::int n FROM booking WHERE id=$1',[bookingId])).rows[0].n, 1);
  assert.equal((await db.query('SELECT count(*)::int n FROM booking WHERE id=$1',[otherBookingId])).rows[0].n, 1);
  assert.equal((await db.query('SELECT count(*)::int n FROM event_funnel_delivery WHERE order_id=$1',[order.id])).rows[0].n, 3);
  assert.equal((await db.query('SELECT sum(payable_minor) paid FROM event_funnel_order_booking WHERE order_id=$1',[order.id])).rows[0].paid, '500');
  for (const role of ['anon','authenticated']) {
    await db.query(`SET ROLE ${role}`);
    await assert.rejects(finalize(db), { code: '42501' });
    await db.query('RESET ROLE');
  }
  await db.query('SET ROLE service_role');
  await assert.rejects(db.query('SELECT * FROM event_funnel_delivery'), { code: '42501' });
  assert.equal((await finalize(db)).rows[0].r.state, 'confirmed');
  await db.query('RESET ROLE');
  const deliveryRace=await Promise.all([db,peer].map(client=>client.query(`SELECT event_funnel_delivery_claim('invoices',1) r`)));
  assert.equal(deliveryRace.reduce((sum,result)=>sum+result.rows[0].r.length,0),1);
  const delivery=deliveryRace.flatMap(result=>result.rows[0].r)[0];
  assert.equal((await db.query(`SELECT event_funnel_delivery_finish($1,$2,'invoices',$3,'delivered') ok`,
    [tenant,order.id,uuid(99)])).rows[0].ok,false);
  assert.equal((await db.query(`SELECT event_funnel_delivery_finish($1,$2,'invoices',$3,'delivered') ok`,
    [tenant,order.id,delivery.lease_token])).rows[0].ok,true);
  assert.deepEqual((await db.query(`SELECT event_funnel_delivery_claim('invoices',1) r`)).rows[0].r,[]);
  assert.equal((await db.query('SELECT state FROM event_funnel_order WHERE id=$1',[order.id])).rows[0].state,'confirmed');
  // Reopen the previously cancelled fixture's still-valid held selection.
  const reopen=(await db.query(`SELECT event_funnel_prepare_order($1,$2,$3,NULL,
    (SELECT revision FROM event_funnel_session WHERE id=$2),
    (SELECT snapshot FROM event_funnel_order WHERE session_id=$2 AND state='cancelled' LIMIT 1)) r`,
    [tenant,uuid(70),member])).rows[0].r;
  const recoveryRace=await Promise.all([db,peer].map(client=>client.query('SELECT event_funnel_recovery_claim(1) r')));
  assert.equal(recoveryRace.reduce((sum,result)=>sum+result.rows[0].r.length,0),1);
  const recovered=recoveryRace.flatMap(result=>result.rows[0].r)[0];
  assert.equal(recovered.id,reopen.id);
  assert.equal((await db.query('SELECT event_funnel_recovery_finish($1,$2,$3) ok',[tenant,reopen.id,uuid(99)])).rows[0].ok,false);
  assert.equal((await db.query('SELECT event_funnel_recovery_finish($1,$2,$3) ok',[tenant,reopen.id,recovered.lease_token])).rows[0].ok,true);
  assert.deepEqual((await db.query('SELECT event_funnel_recovery_claim(1) r')).rows[0].r,[]);
  await db.query('SET ROLE authenticated');
  await assert.rejects(db.query('SELECT event_funnel_recovery_claim(1)'),{code:'42501'});
  await assert.rejects(db.query(`SELECT event_funnel_delivery_claim('invoices',1)`),{code:'42501'});
  await db.query('RESET ROLE');
}
