import assert from 'node:assert/strict';
import { funnelPaymentRequest } from './eventFunnelPayment.js';

export async function exerciseFunnelTraining({db,connect,uuid,tenant,member,sql}) {
  await db.query(`ALTER TABLE member ADD organization_id uuid,ADD role_id uuid;
    CREATE TABLE organization(id uuid PRIMARY KEY,tenant_id uuid,training_fund_balance numeric,training_fund_allowed_role_ids jsonb);
    CREATE TABLE system_settings(tenant_id uuid,setting_key text,setting_value text);
    CREATE TABLE training_fund_transaction(tenant_id uuid,organization_id uuid,type text,amount numeric,balance_before numeric,balance_after numeric,reason text);`);
  await db.query(await sql('202701230008_event_funnel_training_reservations.sql'));
  const organization=uuid(200),role=uuid(201);
  await db.query(`INSERT INTO organization VALUES($1,$2,100,'[]')`,[organization,tenant]);
  await db.query('UPDATE member SET organization_id=$1,role_id=$2 WHERE id=$3',[organization,role,member]);
  const version=(await db.query('SELECT version_id FROM event_funnel_entry WHERE tenant_id=$1',[tenant])).rows[0].version_id;
  const sessions=[uuid(202),uuid(203),uuid(204)];
  for(const session of sessions) await db.query('SELECT event_funnel_create_session($1,$2,$3,$4,NULL)',[tenant,session,version,member]);
  // Exercise the reservation trigger independently; public checkout continues
  // rejecting funding until the pricing/finalization adapters are connected.
  const reserve=(client,session,id,amount)=>client.query(`INSERT INTO event_funnel_order
    (id,tenant_id,session_id,session_revision,version_id,payment_method,currency,payable_minor,snapshot)
    VALUES($1,$2,$3,1,$4,'free','GBP',0,jsonb_build_object('trainingFundMinor',$5::bigint)) RETURNING id`,
    [id,tenant,session,version,amount]);
  const peer=await connect();
  const race=await Promise.allSettled([reserve(db,sessions[0],uuid(210),6000),reserve(peer,sessions[1],uuid(211),6000)]);
  assert.equal(race.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(race.find(result=>result.status==='rejected').reason.code,'PT409');
  const order=race.find(result=>result.status==='fulfilled').value.rows[0].id;
  assert.equal((await db.query('SELECT training_fund_balance FROM organization WHERE id=$1',[organization])).rows[0].training_fund_balance,'100');
  assert.equal((await db.query('SELECT count(*)::int n FROM training_fund_transaction')).rows[0].n,0);
  await assert.rejects(db.query('UPDATE organization SET training_fund_balance=39 WHERE id=$1',[organization]),{code:'PT409'});
  await assert.rejects(db.query('DELETE FROM organization WHERE id=$1',[organization]),{code:'PT409'});
  await assert.rejects(db.query('UPDATE organization SET tenant_id=$2 WHERE id=$1',[organization,uuid(299)]),{code:'PT409'});
  await db.query('UPDATE organization SET training_fund_balance=80 WHERE id=$1',[organization]);
  // Changing eligibility after the payable boundary cannot reinterpret the
  // original promise. The committed debit uses its frozen organization.
  await db.query(`UPDATE organization SET training_fund_allowed_role_ids=$2 WHERE id=$1`,[organization,JSON.stringify([uuid(299)])]);
  await db.query(`UPDATE event_funnel_order SET state='confirmed' WHERE id=$1`,[order]);
  await db.query(`UPDATE event_funnel_order SET state='confirmed' WHERE id=$1`,[order]);
  assert.equal(Number((await db.query('SELECT training_fund_balance FROM organization WHERE id=$1',[organization])).rows[0].training_fund_balance),20);
  assert.equal((await db.query('SELECT count(*)::int n FROM training_fund_transaction')).rows[0].n,1);
  await assert.rejects(reserve(db,sessions[2],uuid(212),1000),{code:'42501'});
  await db.query(`UPDATE organization SET training_fund_allowed_role_ids='[]' WHERE id=$1`,[organization]);
  await reserve(db,sessions[2],uuid(212),2000);
  await assert.rejects(db.query('UPDATE organization SET training_fund_balance=0 WHERE id=$1',[organization]),{code:'PT409'});
  await db.query(`UPDATE event_funnel_order SET state='cancelled' WHERE id=$1`,[uuid(212)]);
  await db.query('UPDATE organization SET training_fund_balance=0 WHERE id=$1',[organization]);
  assert.equal((await db.query('SELECT count(*)::int n FROM training_fund_transaction')).rows[0].n,1);
  await db.query('SET ROLE service_role');
  await assert.rejects(db.query('SELECT * FROM event_funnel_training_reservation'),{code:'42501'});
  await db.query('RESET ROLE');
  // Run actual prepare -> funded registration commit, including rollback of
  // both registrations and the debit when its final audit write fails.
  await db.query('ALTER TABLE booking ADD training_fund_amount numeric');
  await db.query('UPDATE organization SET training_fund_balance=10 WHERE id=$1',[organization]);
  const graph=(await db.query('SELECT graph FROM event_funnel_version WHERE id=$1',[version])).rows[0].graph;
  const source=graph.nodes.find(node=>node.id===graph.entry);
  await db.query(`UPDATE event SET available_seats=20,pricing_config=jsonb_set(pricing_config,'{ticket_classes,0,available_count}','20') WHERE id=$1`,[source.event.id]);
  const session=uuid(205),booking=uuid(215);
  await db.query('SELECT event_funnel_create_session($1,$2,$3,$4,NULL)',[tenant,session,version,member]);
  const purchaser={first_name:'Funding',last_name:'Fixture',email:'funding@example.test'};
  const price={version:1,unitMinor:500,currency:'GBP',purchaser,paymentMethods:['card','account']};
  await db.query(`SELECT event_funnel_apply_journey($1,$2,$3,NULL,1,$4,'{"version":1,"decisions":{},"checkoutNow":true}')`,
    [tenant,session,member,JSON.stringify([{nodeId:source.id,ticketId:'A',quantity:1,priceSnapshot:price}])]);
  const terms={version:1,submissionAccepted:true,purchaser,invoiceMode:graph.invoiceMode,currency:'GBP',
    paymentMethod:'free',payableMinor:0,trainingFundMinor:500,
    lines:[{nodeId:source.id,ticketId:'A',eventId:source.event.id,eventKind:'simple',quantity:1,places:1,
      priceSnapshot:price,amountMinor:500,payableMinor:0,trainingFundMinor:500,
      registrations:[{id:booking,places:1,grossMinor:500,payableMinor:0,trainingFundMinor:500,
        row:{id:booking,tenant_id:tenant,event_id:source.event.id,member_id:member,organization_id:organization,
          ticket_class_id:'A',status:'confirmed',payment_method:'training_fund',training_fund_amount:5}}]}]};
  const funded=(await db.query('SELECT event_funnel_prepare_order($1,$2,$3,NULL,2,$4) r',[tenant,session,member,terms])).rows[0].r;
  assert.equal(Number(funded.payable_minor),0);
  assert.equal((await db.query('SELECT event_funnel_training_quote($1,$2,$3,NULL) r',[tenant,session,member])).rows[0].r.availableMinor,500);
  await db.query(`CREATE FUNCTION fixture_funding_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture funding failure'; END$$;
    CREATE TRIGGER fixture_funding_failure BEFORE INSERT ON training_fund_transaction FOR EACH ROW EXECUTE FUNCTION fixture_funding_failure();`);
  const finalize=()=>db.query(`SELECT event_funnel_finalize_order($1,$2,'{"method":"free"}') r`,[tenant,funded.id]);
  await assert.rejects(finalize(),/fixture funding failure/);
  assert.equal((await db.query('SELECT count(*)::int n FROM booking WHERE id=$1',[booking])).rows[0].n,0);
  assert.equal(Number((await db.query('SELECT training_fund_balance FROM organization WHERE id=$1',[organization])).rows[0].training_fund_balance),10);
  await db.query('DROP TRIGGER fixture_funding_failure ON training_fund_transaction');
  assert.equal((await finalize()).rows[0].r.state,'confirmed');
  await finalize();
  assert.equal(Number((await db.query('SELECT training_fund_balance FROM organization WHERE id=$1',[organization])).rows[0].training_fund_balance),5);
  assert.equal((await db.query('SELECT count(*)::int n FROM training_fund_transaction')).rows[0].n,2);
  assert.equal(Number((await db.query('SELECT training_fund_minor FROM event_funnel_order_booking WHERE order_id=$1',[funded.id])).rows[0].training_fund_minor),500);
  const partialSession=uuid(206),partialBooking=uuid(216);
  await db.query('SELECT event_funnel_create_session($1,$2,$3,$4,NULL)',[tenant,partialSession,version,member]);
  await db.query(`SELECT event_funnel_apply_journey($1,$2,$3,NULL,1,$4,'{"version":1,"decisions":{},"checkoutNow":true}')`,
    [tenant,partialSession,member,JSON.stringify([{nodeId:source.id,ticketId:'A',quantity:1,priceSnapshot:price}])]);
  const partial=structuredClone(terms);
  Object.assign(partial,{paymentMethod:'card',payableMinor:300,trainingFundMinor:200,
    paymentAuthority:{mode:'test',accountFingerprint:'fixture-account'}});
  Object.assign(partial.lines[0],{payableMinor:300,trainingFundMinor:200});
  Object.assign(partial.lines[0].registrations[0],{id:partialBooking,payableMinor:300,trainingFundMinor:200});
  Object.assign(partial.lines[0].registrations[0].row,{id:partialBooking,payment_method:'card',training_fund_amount:2});
  const mixed=(await db.query('SELECT event_funnel_prepare_order($1,$2,$3,NULL,2,$4) r',[tenant,partialSession,member,partial])).rows[0].r;
  assert.equal(funnelPaymentRequest(mixed).amount,300);
  await db.query('SELECT event_funnel_payment_request($1,$2,$3)',[tenant,mixed.id,funnelPaymentRequest(mixed)]);
  await db.query(`SELECT event_funnel_payment_bind($1,$2,'pi_training')`,[tenant,mixed.id]);
  const proof={id:'pi_training',status:'succeeded',amount:300,amountReceived:300,currency:'GBP',livemode:false};
  await db.query('SELECT event_funnel_record_payment($1,$2,$3)',[tenant,mixed.id,proof]);
  await db.query('SELECT event_funnel_finalize_order($1,$2,$3)',[tenant,mixed.id,{method:'card',payment:proof}]);
  assert.equal(Number((await db.query('SELECT training_fund_balance FROM organization WHERE id=$1',[organization])).rows[0].training_fund_balance),3);
  assert.deepEqual((await db.query('SELECT gross_minor,payable_minor,training_fund_minor FROM event_funnel_order_booking WHERE booking_id=$1',
    [partialBooking])).rows[0],{gross_minor:'500',payable_minor:'300',training_fund_minor:'200'});
}
